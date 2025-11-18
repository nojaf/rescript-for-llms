import * as path from "bun:path";
import { stat } from "bun:fs/promises";
import { Database } from "bun:sqlite";
import { Glob } from "bun";
import crypto from "crypto";
import { Piscina } from "piscina";

const root = import.meta.dir;

async function getDbPath(projectRoot) {
  if (!projectRoot) {
    throw new Error("projectRoot parameter is required");
  }

  // Check if projectRoot exists and is a directory
  try {
    const s = await stat(projectRoot);
    if (!s.isDirectory()) {
      throw new Error(`Project directory is not a directory: ${projectRoot}`);
    }
  } catch {
    throw new Error(`Project directory does not exist: ${projectRoot}`);
  }

  // Check if rescript.json exists at projectRoot
  const rescriptJsonPath = path.resolve(projectRoot, "rescript.json");
  const rescriptJsonFile = Bun.file(rescriptJsonPath);
  if (!(await rescriptJsonFile.exists())) {
    throw new Error(
      `No rescript.json found at: ${projectRoot}. The projectRoot must point to a directory containing a top-level rescript.json file.`,
    );
  }

  return path.resolve(projectRoot, "rescript.db");
}

// Worker pool for parallel file processing
const pool = new Piscina({
  filename: new URL("./file-module-worker.js", import.meta.url).href,
  maxThreads: 12, // Using 12 of 16 available CPU cores
});

// ============================================================================
// Database Schema and Utilities
// ============================================================================

async function initDatabase(projectRoot) {
  const dbPath = await getDbPath(projectRoot);
  const db = new Database(dbPath, { create: true });

  db.run(`
    CREATE TABLE IF NOT EXISTS packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      path TEXT NOT NULL,
      rescript_json TEXT NOT NULL,
      config_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS modules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_id INTEGER NOT NULL,
      parent_module_id INTEGER,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL UNIQUE,
      source_file_path TEXT NOT NULL,
      compiled_file_path TEXT NOT NULL,
      file_hash TEXT,
      FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_module_id) REFERENCES modules(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      kind TEXT,
      signature TEXT,
      detail TEXT,
      FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS "values" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      return_type TEXT,
      param_count INTEGER DEFAULT 0,
      signature TEXT,
      detail TEXT,
      FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_module_id INTEGER NOT NULL,
      alias_name TEXT NOT NULL,
      alias_kind TEXT NOT NULL,
      target_qualified_name TEXT NOT NULL,
      docstrings TEXT,
      FOREIGN KEY (source_module_id) REFERENCES modules(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS type_references (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type_id INTEGER,
      source_value_id INTEGER,
      referenced_type_name TEXT NOT NULL,
      referenced_module_name TEXT,
      context TEXT NOT NULL,
      position INTEGER,
      FOREIGN KEY (source_type_id) REFERENCES types(id) ON DELETE CASCADE,
      FOREIGN KEY (source_value_id) REFERENCES "values"(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS generic_type_parameters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type_id INTEGER,
      value_id INTEGER,
      field_name TEXT,
      parameter_index INTEGER NOT NULL,
      base_type TEXT NOT NULL,
      base_module TEXT,
      parameter_signature TEXT NOT NULL,
      nesting_level INTEGER DEFAULT 0,
      FOREIGN KEY (type_id) REFERENCES types(id) ON DELETE CASCADE,
      FOREIGN KEY (value_id) REFERENCES "values"(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_modules_package ON modules(package_id);
    CREATE INDEX IF NOT EXISTS idx_modules_parent ON modules(parent_module_id);
    CREATE INDEX IF NOT EXISTS idx_modules_qualified ON modules(qualified_name);
    CREATE INDEX IF NOT EXISTS idx_modules_compiled_path ON modules(compiled_file_path);
    CREATE INDEX IF NOT EXISTS idx_types_module ON types(module_id);
    CREATE INDEX IF NOT EXISTS idx_values_module ON "values"(module_id);
    CREATE INDEX IF NOT EXISTS idx_aliases_name ON aliases(alias_name);
    CREATE INDEX IF NOT EXISTS idx_aliases_source ON aliases(source_module_id);
    CREATE INDEX IF NOT EXISTS idx_type_references_source_type ON type_references(source_type_id);
    CREATE INDEX IF NOT EXISTS idx_type_references_source_value ON type_references(source_value_id);
    CREATE INDEX IF NOT EXISTS idx_type_references_referenced ON type_references(referenced_type_name);
    CREATE INDEX IF NOT EXISTS idx_generic_type_parameters_type ON generic_type_parameters(type_id);
    CREATE INDEX IF NOT EXISTS idx_generic_type_parameters_value ON generic_type_parameters(value_id);
    CREATE INDEX IF NOT EXISTS idx_generic_type_parameters_base ON generic_type_parameters(base_type);
  `);

  // Migration: Add is_auto_opened column if it doesn't exist
  try {
    db.run(`ALTER TABLE modules ADD COLUMN is_auto_opened INTEGER DEFAULT 0`);
  } catch (ex) {
    // Column already exists, ignore error
  }

  // Migration: Add is_auto_opened index if it doesn't exist
  try {
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_modules_auto_opened ON modules(is_auto_opened)`,
    );
  } catch (ex) {
    // Index already exists, ignore error
  }

  return db;
}

async function ensureDatabaseInitialized(projectRoot) {
  try {
    const dbPath = await getDbPath(projectRoot);

    // Check if database exists
    try {
      await stat(dbPath);
      // Database exists, return it
      return new Database(dbPath, { readonly: true });
    } catch (error) {
      // Database doesn't exist, need to initialize
      console.error(
        `Database not found at ${dbPath}. Initializing new database (this may take 10-30 seconds)...`,
      );

      // Compile ReScript first
      console.error("Compiling ReScript...");
      const compileResult = Bun.spawnSync(["bunx", "rescript"], {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (compileResult.exitCode !== 0) {
        const stderr =
          compileResult.stderr?.toString() || "Unknown compilation error";
        throw new Error(
          `ReScript compilation failed. Ensure 'bunx rescript' works in ${projectRoot}\n\nError: ${stderr}`,
        );
      }

      // Now sync the database
      const db = await syncDatabase(projectRoot, false);

      // Return the newly created database
      return db;
    }
  } catch (error) {
    if (
      error.message.includes("projectRoot parameter is required") ||
      error.message.includes("Project directory does not exist") ||
      error.message.includes("No rescript.json found")
    ) {
      throw error; // Re-throw validation errors as-is
    }
    throw new Error(
      `Database sync failed. Check that ${projectRoot} is a valid ReScript project\n\nError: ${error.message}`,
    );
  }
}

// ============================================================================
// Hash Utilities
// ============================================================================

async function getPackageConfigHash(packagePath) {
  try {
    const compilerInfoPath = path.resolve(
      packagePath,
      "lib/bs/compiler-info.json",
    );
    const compilerInfo = await Bun.file(compilerInfoPath).json();
    return compilerInfo.rescript_config_hash || null;
  } catch (ex) {
    // No compiler-info.json or no hash available
    return null;
  }
}

async function hashFileContent(filePath) {
  try {
    const content = await Bun.file(filePath).text();
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch (ex) {
    return null;
  }
}

// ============================================================================
// Generic Type Parser
// ============================================================================

/**
 * Parse a ReScript type signature and extract all type references and generic parameters
 * @param {string} signature - The type signature to parse
 * @param {string} context - Context where this signature appears (e.g., "parameter 0", "return type", "field body")
 * @returns {Object} - Parsed result with type references and generic parameters
 */
function parseTypeSignature(signature, context = "unknown") {
  if (!signature || typeof signature !== "string") {
    return { typeReferences: [], genericParameters: [] };
  }

  const typeReferences = [];
  const genericParameters = [];

  // Remove leading/trailing whitespace
  const trimmed = signature.trim();

  // Handle function types: (param1, param2) => returnType
  if (trimmed.includes("=>")) {
    const parts = trimmed.split("=>");
    if (parts.length >= 2) {
      // Parse parameters (everything before the last =>)
      const paramPart = parts.slice(0, -1).join("=>").trim();
      const returnPart = parts[parts.length - 1].trim();

      // Parse parameters
      if (paramPart.startsWith("(") && paramPart.endsWith(")")) {
        const paramContent = paramPart.slice(1, -1).trim();
        if (paramContent) {
          const params = parseParameterList(paramContent);
          params.forEach((param, index) => {
            const paramResult = parseTypeSignature(param, `parameter ${index}`);
            typeReferences.push(...paramResult.typeReferences);
            genericParameters.push(...paramResult.genericParameters);
          });
        }
      } else {
        // Single parameter
        const paramResult = parseTypeSignature(paramPart, "parameter 0");
        typeReferences.push(...paramResult.typeReferences);
        genericParameters.push(...paramResult.genericParameters);
      }

      // Parse return type
      const returnResult = parseTypeSignature(returnPart, "return type");
      typeReferences.push(...returnResult.typeReferences);
      genericParameters.push(...returnResult.genericParameters);
    }
    return { typeReferences, genericParameters };
  }

  // Handle generic types: Type<Param1, Param2>
  const genericMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_.]*)\s*<(.+)>$/);
  if (genericMatch) {
    const [, baseType, paramString] = genericMatch;

    // Extract module name if present (e.g., "WebAPI.FileAPI.readableStream")
    const moduleMatch = baseType.match(
      /^([A-Za-z_][A-Za-z0-9_.]*\.)?([A-Za-z_][A-Za-z0-9_]*)$/,
    );
    const moduleName = moduleMatch ? moduleMatch[1]?.slice(0, -1) : null;
    const typeName = moduleMatch ? moduleMatch[2] : baseType;

    // Add base type reference
    typeReferences.push({
      typeName,
      moduleName,
      context,
      isGeneric: true,
    });

    // Parse generic parameters
    const params = parseGenericParameters(paramString);
    params.forEach((param, index) => {
      const paramResult = parseTypeSignature(
        param,
        `${context} generic param ${index}`,
      );
      typeReferences.push(...paramResult.typeReferences);
      genericParameters.push(...paramResult.genericParameters);

      // Add to generic parameters structure
      genericParameters.push({
        baseType,
        baseModule: moduleName,
        parameterIndex: index,
        parameterSignature: param,
        nestingLevel: 0,
        context,
      });
    });

    return { typeReferences, genericParameters };
  }

  // Handle tuples: (Type1, Type2, Type3)
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    const content = trimmed.slice(1, -1).trim();
    if (content) {
      const tupleTypes = parseParameterList(content);
      tupleTypes.forEach((type, index) => {
        const result = parseTypeSignature(
          type,
          `${context} tuple element ${index}`,
        );
        typeReferences.push(...result.typeReferences);
        genericParameters.push(...result.genericParameters);
      });
    }
    return { typeReferences, genericParameters };
  }

  // Handle records: {field1: Type1, field2: Type2}
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const content = trimmed.slice(1, -1).trim();
    if (content) {
      const fields = parseRecordFields(content);
      fields.forEach(({ name, type }) => {
        const result = parseTypeSignature(type, `${context} field ${name}`);
        typeReferences.push(...result.typeReferences);
        genericParameters.push(...result.genericParameters);
      });
    }
    return { typeReferences, genericParameters };
  }

  // Handle variants: | Constructor1(Type1) | Constructor2
  if (trimmed.includes("|")) {
    const constructors = trimmed
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c);
    constructors.forEach((constructor, index) => {
      const parenMatch = constructor.match(
        /^([A-Za-z_][A-Za-z0-9_]*)\s*\((.+)\)$/,
      );
      if (parenMatch) {
        const [, name, paramString] = parenMatch;
        const params = parseParameterList(paramString);
        params.forEach((param, paramIndex) => {
          const result = parseTypeSignature(
            param,
            `${context} constructor ${name} param ${paramIndex}`,
          );
          typeReferences.push(...result.typeReferences);
          genericParameters.push(...result.genericParameters);
        });
      }
    });
    return { typeReferences, genericParameters };
  }

  // Handle simple type references
  const simpleTypeMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_.]*)$/);
  if (simpleTypeMatch) {
    const fullType = simpleTypeMatch[1];
    const moduleMatch = fullType.match(
      /^([A-Za-z_][A-Za-z0-9_.]*\.)?([A-Za-z_][A-Za-z0-9_]*)$/,
    );
    const moduleName = moduleMatch ? moduleMatch[1]?.slice(0, -1) : null;
    const typeName = moduleMatch ? moduleMatch[2] : fullType;

    typeReferences.push({
      typeName,
      moduleName,
      context,
      isGeneric: false,
    });
  }

  return { typeReferences, genericParameters };
}

/**
 * Parse a comma-separated parameter list, handling nested parentheses
 */
function parseParameterList(paramString) {
  const params = [];
  let current = "";
  let depth = 0;

  for (let i = 0; i < paramString.length; i++) {
    const char = paramString[i];

    if (char === "(" || char === "<" || char === "{") {
      depth++;
      current += char;
    } else if (char === ")" || char === ">" || char === "}") {
      depth--;
      current += char;
    } else if (char === "," && depth === 0) {
      params.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    params.push(current.trim());
  }

  return params;
}

/**
 * Parse generic parameters, handling nested generics
 */
function parseGenericParameters(paramString) {
  return parseParameterList(paramString);
}

/**
 * Parse record fields: {field1: Type1, field2: Type2}
 */
function parseRecordFields(fieldString) {
  const fields = [];
  let current = "";
  let depth = 0;
  let currentField = "";
  let currentType = "";
  let inFieldName = true;

  for (let i = 0; i < fieldString.length; i++) {
    const char = fieldString[i];

    if (char === ":" && depth === 0 && inFieldName) {
      currentField = current.trim();
      current = "";
      inFieldName = false;
    } else if (char === "," && depth === 0 && !inFieldName) {
      currentType = current.trim();
      fields.push({ name: currentField, type: currentType });
      current = "";
      currentField = "";
      currentType = "";
      inFieldName = true;
    } else if (char === "(" || char === "<" || char === "{") {
      depth++;
      current += char;
    } else if (char === ")" || char === ">" || char === "}") {
      depth--;
      current += char;
    } else {
      current += char;
    }
  }

  if (current.trim() && currentField) {
    currentType = current.trim();
    fields.push({ name: currentField, type: currentType });
  }

  return fields;
}

// ============================================================================
// ReScript File Discovery
// ============================================================================

// Memoize rescript.json parsing to avoid reading the same file multiple times
const rescriptJsonCache = new Map();

async function parseRescriptJson(packagePath) {
  if (rescriptJsonCache.has(packagePath)) {
    return rescriptJsonCache.get(packagePath);
  }

  try {
    const rescriptJsonPath = path.resolve(packagePath, "rescript.json");
    const rescriptJson = await Bun.file(rescriptJsonPath).json();
    rescriptJsonCache.set(packagePath, rescriptJson);
    return rescriptJson;
  } catch (error) {
    const fallback = { sources: ["src"] };
    rescriptJsonCache.set(packagePath, fallback);
    return fallback;
  }
}

async function findSourceFile(compiledFilePath, packagePath) {
  // Extract the file name from the compiled path
  const fileName = path.basename(compiledFilePath);

  // For @rescript/runtime, the source files are in the same directory structure
  if (compiledFilePath.includes("@rescript/runtime")) {
    return compiledFilePath;
  }

  // For other packages, look in the source directories defined in rescript.json
  const rescriptJson = await parseRescriptJson(packagePath);

  // Parse sources according to the ReScript schema
  const sources = rescriptJson.sources || ["src"];
  const sourceDirs = [];

  // Handle different source formats from the schema
  if (typeof sources === "string") {
    // Simple string: "src"
    sourceDirs.push(sources);
  } else if (Array.isArray(sources)) {
    // Array of strings or objects
    for (const source of sources) {
      if (typeof source === "string") {
        // String in array: ["src", "test"]
        sourceDirs.push(source);
      } else if (typeof source === "object" && source.dir) {
        // Object with dir property: {"dir": "src", ...}
        sourceDirs.push(source.dir);
      }
    }
  } else if (typeof sources === "object" && sources.dir) {
    // Single object: {"dir": "src", ...}
    sourceDirs.push(sources.dir);
  }

  // Use recursive Glob search for each source directory
  for (const sourceDir of sourceDirs) {
    const sourceDirPath = path.resolve(packagePath, sourceDir);

    try {
      // Use recursive glob to find the file anywhere in the source directory tree
      const globPattern = `**/${fileName}`;
      const glob = new Glob(globPattern);

      for await (const filePath of glob.scan({
        cwd: sourceDirPath,
        absolute: true,
        onlyFiles: true,
      })) {
        // Found the file, now prioritize .resi over .res like the worker does
        let prioritizedSourceFile = filePath;
        if (filePath.endsWith(".res")) {
          const resiFile = filePath.replace(/\.res$/, ".resi");
          try {
            await stat(resiFile);
            prioritizedSourceFile = resiFile;
          } catch {
            // .resi file doesn't exist, use the .res file
            prioritizedSourceFile = filePath;
          }
        }
        return prioritizedSourceFile; // This is now an absolute path
      }
    } catch {
      // Directory doesn't exist or isn't accessible, continue to next source dir
      continue;
    }
  }

  // If not found in any source directory, fallback to the compiled path
  return compiledFilePath;
}

const resGlob = new Glob("*.{res,resi}");

async function getReScriptFiles(directory) {
  const files = [];
  const isRuntime = directory.endsWith("@rescript/runtime");

  // For @rescript/runtime, use the standard glob to get all modules
  // This includes Array, String, Belt modules, etc.
  const g = resGlob;
  const ocamlDir = path.resolve(directory, "lib/ocaml");

  try {
    for await (const file of g.scan({
      cwd: ocamlDir,
      absolute: true,
      onlyFiles: true,
    })) {
      files.push(file);
    }
  } catch (ex) {
    // Directory doesn't exist or isn't accessible
    return files;
  }

  // Filter out .res files that have corresponding .resi files
  // Since we process .resi files and they contain the interface definitions,
  // we should skip the .res files when .resi files exist
  const filteredFiles = [];
  const resiFiles = new Set();

  // First pass: collect all .resi files
  for (const file of files) {
    if (file.endsWith(".resi")) {
      resiFiles.add(file);
    }
  }

  // Second pass: only include .res files that don't have corresponding .resi files
  for (const file of files) {
    if (file.endsWith(".res")) {
      const resiFile = file.replace(/\.res$/, ".resi");
      if (!resiFiles.has(resiFile)) {
        filteredFiles.push(file);
      }
      // Skip .res files that have corresponding .resi files
    } else {
      // Include all .resi files
      filteredFiles.push(file);
    }
  }

  return filteredFiles;
}

async function findReScriptProjects(startDir) {
  const projects = [];
  const glob = new Glob("**/rescript.json");

  for await (const file of glob.scan({
    cwd: startDir,
    absolute: true,
    onlyFiles: true,
  })) {
    // Skip node_modules in discovery
    if (file.includes("node_modules")) continue;

    try {
      const content = await Bun.file(file).json();
      const projectDir = path.resolve(file, "..");
      projects.push({
        path: projectDir,
        name: content.name,
        dependencies: content.dependencies || [],
        rescriptJson: content,
      });
    } catch (ex) {
      console.error(`Failed to parse ${file}:`, ex.message);
    }
  }

  return projects;
}

async function resolvePackage(packageName, projectRoot) {
  try {
    const rescriptJsonPath = Bun.resolveSync(
      `${packageName}/${packageName === "@rescript/runtime" ? "package.json" : "rescript.json"}`,
      projectRoot,
    );
    const packageDir = path.resolve(rescriptJsonPath, "..");

    let rescriptJson = {};
    if (packageName === "@rescript/runtime") {
      rescriptJson = { name: packageName };
    } else {
      rescriptJson = await Bun.file(
        path.resolve(packageDir, "rescript.json"),
      ).json();
    }

    return {
      path: packageDir,
      name: packageName,
      rescriptJson,
    };
  } catch (ex) {
    console.error(`Could not resolve package ${packageName}:`, ex.message);
    return null;
  }
}

// ============================================================================
// ReScript Documentation Extraction
// ============================================================================

// Note: parseModuleDocumentation and extractDocumentationForFile are now in the worker
// to enable parallel processing. See file-module-worker.js

// ============================================================================
// Auto-Opened Module Detection
// ============================================================================

async function detectAndMarkAutoOpenedModules(
  pkg,
  packageId,
  updateModuleAutoOpened,
  insertType,
  db,
) {
  // Always mark Stdlib and Pervasives as auto-opened for @rescript/runtime
  if (pkg.name === "@rescript/runtime") {
    updateModuleAutoOpened.run(1, "Stdlib");
    updateModuleAutoOpened.run(1, "Pervasives");

    // Add builtin types to Pervasives module (these are compiler builtins not in source files)
    // Source: https://github.com/nojaf/rescript/blob/master/compiler/ml/predef.ml
    const pervasivesModule = db
      .prepare(
        "SELECT id FROM modules WHERE qualified_name = 'Pervasives' AND package_id = ?",
      )
      .get(packageId);
    if (pervasivesModule) {
      const builtinTypes = [
        { name: "int", kind: "unknown", signature: "type int" },
        { name: "char", kind: "unknown", signature: "type char" },
        { name: "float", kind: "unknown", signature: "type float" },
        { name: "bool", kind: "unknown", signature: "type bool" },
        { name: "unit", kind: "unknown", signature: "type unit" },
        { name: "string", kind: "unknown", signature: "type string" },
        { name: "bigint", kind: "unknown", signature: "type bigint" },
        { name: "unknown", kind: "unknown", signature: "type unknown" },
        { name: "exn", kind: "unknown", signature: "type exn" },
        { name: "array", kind: "unknown", signature: "type array<'a>" },
        { name: "list", kind: "unknown", signature: "type list<'a>" },
        { name: "option", kind: "unknown", signature: "type option<'a>" },
        { name: "result", kind: "unknown", signature: "type result<'a, 'b>" },
        { name: "dict", kind: "unknown", signature: "type dict<'a>" },
        { name: "promise", kind: "unknown", signature: "type promise<'a>" },
        {
          name: "extension_constructor",
          kind: "unknown",
          signature: "type extension_constructor",
        },
      ];

      for (const builtinType of builtinTypes) {
        // Check if this builtin type already exists
        const existingType = db
          .prepare(
            "SELECT id FROM types WHERE module_id = ? AND name = ? AND signature = ?",
          )
          .get(pervasivesModule.id, builtinType.name, builtinType.signature);

        if (!existingType) {
          insertType.run(
            pervasivesModule.id,
            builtinType.name,
            builtinType.kind,
            builtinType.signature,
            JSON.stringify({ builtin: true, source: "compiler" }),
          );
        }
      }
    }
    return;
  }

  // Parse compiler-flags for -open directives
  const compilerFlags = pkg.rescriptJson["compiler-flags"] || [];
  const openedModules = compilerFlags
    .filter((flag) => flag.startsWith("-open "))
    .map((flag) => flag.replace("-open ", "").trim());

  // Mark each opened module as auto-opened
  for (const moduleName of openedModules) {
    updateModuleAutoOpened.run(1, moduleName);
  }
}

// ============================================================================
// Sync Command Implementation
// ============================================================================

async function syncDatabase(projectRoot, shouldCloseDb = true) {
  const startTime = performance.now();
  console.error("Starting ReScript database sync...");

  let db;
  try {
    const dbPath = await getDbPath(projectRoot);
    db = await initDatabase(projectRoot);

    // Check if this is a fresh database (no modules exist yet)
    const initialModuleCount = db
      .prepare("SELECT COUNT(*) as count FROM modules")
      .get();
    const isFreshDatabase = initialModuleCount.count === 0;

    console.error("Checking for changes...");

    // Phase 1: Discover all projects
    console.error("Discovering ReScript projects...");
    const projects = await findReScriptProjects(projectRoot);
    console.error(`Found ${projects.length} project(s)`);

    if (projects.length === 0) {
      throw new Error(
        `No ReScript packages found in ${projectRoot}. Ensure rescript.json is properly configured.`,
      );
    }

    // Phase 2: Collect all packages (projects + dependencies)
    console.error("Resolving dependencies...");
    const packageMap = new Map();

    // Always include @rescript/runtime (built-in to ReScript)
    const runtimePackage = await resolvePackage(
      "@rescript/runtime",
      projectRoot,
    );
    if (runtimePackage) {
      packageMap.set("@rescript/runtime", runtimePackage);
    }

    for (const project of projects) {
      packageMap.set(project.name, project);

      for (const dep of project.dependencies) {
        if (!packageMap.has(dep)) {
          const resolved = await resolvePackage(dep, projectRoot);
          if (resolved) {
            packageMap.set(dep, resolved);
          }
        }
      }
    }

    console.error(`Total packages to index: ${packageMap.size}`);

    // Phase 3: Process each package
    const upsertPackage = db.prepare(`
      INSERT INTO packages (name, path, rescript_json, config_hash)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        path = excluded.path,
        rescript_json = excluded.rescript_json,
        config_hash = excluded.config_hash
      RETURNING id, config_hash
    `);
    const getExistingPackageHash = db.prepare(
      "SELECT id, config_hash FROM packages WHERE name = ?",
    );
    const insertModule = db.prepare(
      "INSERT INTO modules (package_id, parent_module_id, name, qualified_name, source_file_path, compiled_file_path, file_hash, is_auto_opened) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    );
    const getExistingModuleHash = db.prepare(
      "SELECT id, file_hash FROM modules WHERE qualified_name = ?",
    );
    const getModulesByCompiledFile = db.prepare(
      "SELECT id, qualified_name, file_hash, source_file_path FROM modules WHERE compiled_file_path = ?",
    );
    const deleteModule = db.prepare("DELETE FROM modules WHERE id = ?");
    const deleteModuleValues = db.prepare(
      'DELETE FROM "values" WHERE module_id = ?',
    );
    const deleteModuleTypes = db.prepare(
      "DELETE FROM types WHERE module_id = ?",
    );
    const insertType = db.prepare(
      "INSERT INTO types (module_id, name, kind, signature, detail) VALUES (?, ?, ?, ?, ?)",
    );
    const insertValue = db.prepare(
      'INSERT INTO "values" (module_id, name, return_type, param_count, signature, detail) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insertAlias = db.prepare(
      "INSERT INTO aliases (source_module_id, alias_name, alias_kind, target_qualified_name, docstrings) VALUES (?, ?, ?, ?, ?)",
    );
    const updateModuleAutoOpened = db.prepare(
      "UPDATE modules SET is_auto_opened = ? WHERE qualified_name = ?",
    );

    // New prepared statements for type relationships
    const insertTypeReference = db.prepare(
      "INSERT INTO type_references (source_type_id, source_value_id, referenced_type_name, referenced_module_name, context, position) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertGenericTypeParameter = db.prepare(
      "INSERT INTO generic_type_parameters (type_id, value_id, field_name, parameter_index, base_type, base_module, parameter_signature, nesting_level) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const getAllModules = db.prepare("SELECT id, qualified_name FROM modules");
    const getAllTypes = db.prepare(
      "SELECT t.id, t.name, t.signature, t.detail, m.qualified_name as module_name FROM types t JOIN modules m ON t.module_id = m.id",
    );
    const getAllValues = db.prepare(
      'SELECT v.id, v.name, v.signature, m.qualified_name as module_name FROM "values" v JOIN modules m ON v.module_id = m.id',
    );

    let packagesProcessed = 0;
    let packagesSkipped = 0;
    let filesProcessed = 0;
    let filesSkipped = 0;

    for (const [packageName, pkg] of packageMap) {
      console.error(`Processing package: ${packageName}`);

      // Get config hash for this package
      const configHash = await getPackageConfigHash(pkg.path);

      // Upsert package (always update to ensure it exists)
      const packageResult = upsertPackage.get(
        pkg.name,
        pkg.path,
        JSON.stringify(pkg.rescriptJson),
        configHash,
      );
      const packageId = packageResult.id;

      // Check if package config changed
      const existingPkg = getExistingPackageHash.get(pkg.name);
      // Only consider changed if:
      // - Package is new (!existingPkg)
      // - Hash changed (existingPkg.config_hash !== configHash)
      // - But NOT if both are null (packages without compiler-info.json)
      const packageConfigChanged =
        !existingPkg ||
        (existingPkg.config_hash !== configHash &&
          !(existingPkg.config_hash === null && configHash === null));

      // Get all ReScript files
      const resFiles = await getReScriptFiles(pkg.path);
      console.error(`  Found ${resFiles.length} ReScript file(s)`);

      let packageFilesProcessed = 0;
      let packageFilesSkipped = 0;

      // Phase 1: Quick hash check to determine which files need processing
      const filesToProcess = [];
      const sourceFileGroups = new Map(); // Group files by their source files

      for (const resFile of resFiles) {
        // Query by compiled file path (the lib/ocaml path we're actually reading)
        let existingModulesInFile = getModulesByCompiledFile.all(resFile);

        if (!packageConfigChanged && existingModulesInFile.length > 0) {
          // Find the actual source file using ReScript configuration
          const sourceFilePath = await findSourceFile(resFile, pkg.path);

          const sourceFileHash = await hashFileContent(sourceFilePath);

          if (sourceFileHash) {
            const unchangedModules = existingModulesInFile.filter(
              (m) => m.file_hash === sourceFileHash,
            );
            const changedModules = existingModulesInFile.filter(
              (m) => m.file_hash !== sourceFileHash,
            );

            if (changedModules.length === 0) {
              packageFilesSkipped += existingModulesInFile.length;
              filesSkipped += existingModulesInFile.length;
              continue;
            } else {
              // Group files by their source file path to avoid duplicate processing
              if (!sourceFileGroups.has(sourceFilePath)) {
                sourceFileGroups.set(sourceFilePath, []);
              }
              sourceFileGroups.get(sourceFilePath).push({
                resFile,
                changedModules,
                unchangedModules,
                sourceFileHash,
              });
            }
          } else {
            console.error(
              `  📝 File ${resFile} needs sync: could not hash source file ${sourceFilePath}`,
            );
            filesToProcess.push(resFile);
          }
        } else {
          // Log why file needs processing
          let reason = "";
          if (packageConfigChanged) {
            reason = "package config changed";
          } else if (existingModulesInFile.length === 0) {
            reason = "no existing modules found";
          }

          // Only show the log if this is not a fresh database start
          if (!isFreshDatabase) {
            console.error(`  📝 File ${resFile} needs sync: ${reason}`);
          }
          filesToProcess.push(resFile);
        }
      }

      // Process each source file group only once
      for (const [sourceFilePath, fileGroup] of sourceFileGroups) {
        const totalChanged = fileGroup.reduce(
          (sum, f) => sum + f.changedModules.length,
          0,
        );
        const totalUnchanged = fileGroup.reduce(
          (sum, f) => sum + f.unchangedModules.length,
          0,
        );

        console.error(`📝 Source file ${sourceFilePath} needs sync:`);
        console.error(`  - Modules unchanged: ${totalUnchanged}`);
        console.error(`  - Modules changed: ${totalChanged}`);

        // Add all files in this group to processing
        for (const fileInfo of fileGroup) {
          filesToProcess.push(fileInfo.resFile);
        }
      }

      // Phase 2: Process files in parallel using worker pool
      if (filesToProcess.length > 0) {
        const results = await Promise.all(
          filesToProcess.map((filePath) =>
            pool.run({ filePath, packageDir: pkg.path }),
          ),
        );

        // Phase 3: Write results to database sequentially
        for (const result of results) {
          const { compiledFilePath, fileHash, modules } = result;

          for (const module of modules) {
            const existingModule = getExistingModuleHash.get(
              module.qualifiedName,
            );

            filesProcessed++;
            packageFilesProcessed++;

            // If module exists, delete old data first
            if (existingModule) {
              deleteModuleValues.run(existingModule.id);
              deleteModuleTypes.run(existingModule.id);
            }

            await insertModuleRecursive(
              module,
              packageId,
              null,
              compiledFilePath,
              fileHash,
              insertModule,
              insertType,
              insertValue,
              insertAlias,
              getExistingModuleHash,
            );
          }
        }
      }

      if (packageFilesProcessed > 0) {
        packagesProcessed++;
        console.error(
          `  Processed ${packageFilesProcessed} file(s), skipped ${packageFilesSkipped}`,
        );
      } else {
        packagesSkipped++;
        console.error(`  All files unchanged (${packageFilesSkipped} skipped)`);
      }

      // Detect and mark auto-opened modules for this package
      await detectAndMarkAutoOpenedModules(
        pkg,
        packageId,
        updateModuleAutoOpened,
        insertType,
        db,
      );
    }

    // Phase 4: Parse type relationships (Second Pass)
    // Only run if we actually processed any files (i.e., there were changes)
    if (filesProcessed > 0) {
      console.error("Parsing type relationships...");

      // Clear existing relationship data
      db.run("DELETE FROM type_references");
      db.run("DELETE FROM generic_type_parameters");

      // Build module lookup map for efficient resolution
      const moduleMap = new Map();
      const allModules = getAllModules.all();
      for (const module of allModules) {
        moduleMap.set(module.qualified_name, module.id);
      }

      // Process all types
      const allTypes = getAllTypes.all();
      console.error(
        `  Processing ${allTypes.length} types for relationships...`,
      );

      for (const type of allTypes) {
        try {
          // Parse type signature
          if (type.signature) {
            const result = parseTypeSignature(type.signature, "type signature");
            for (const ref of result.typeReferences) {
              insertTypeReference.run(
                type.id,
                null,
                ref.typeName,
                ref.moduleName,
                ref.context,
                null,
              );
            }
            for (const param of result.genericParameters) {
              insertGenericTypeParameter.run(
                type.id,
                null,
                null,
                param.parameterIndex,
                param.baseType,
                param.baseModule,
                param.parameterSignature,
                param.nestingLevel,
              );
            }
          }

          // Parse type detail (record fields, variant constructors)
          if (type.detail) {
            const detail = JSON.parse(type.detail);
            if (detail.items && Array.isArray(detail.items)) {
              for (const item of detail.items) {
                if (item.signature) {
                  const result = parseTypeSignature(
                    item.signature,
                    `field ${item.name}`,
                  );
                  for (const ref of result.typeReferences) {
                    insertTypeReference.run(
                      type.id,
                      null,
                      ref.typeName,
                      ref.moduleName,
                      ref.context,
                      null,
                    );
                  }
                  for (const param of result.genericParameters) {
                    insertGenericTypeParameter.run(
                      type.id,
                      null,
                      item.name,
                      param.parameterIndex,
                      param.baseType,
                      param.baseModule,
                      param.parameterSignature,
                      param.nestingLevel,
                    );
                  }
                }
              }
            }
          }
        } catch (ex) {
          console.error(
            `  Error parsing type ${type.module_name}.${type.name}: ${ex.message}`,
          );
        }
      }

      // Process all values
      const allValues = getAllValues.all();
      console.error(
        `  Processing ${allValues.length} values for relationships...`,
      );

      for (const value of allValues) {
        try {
          if (value.signature) {
            const result = parseTypeSignature(
              value.signature,
              "function signature",
            );
            for (const ref of result.typeReferences) {
              insertTypeReference.run(
                null,
                value.id,
                ref.typeName,
                ref.moduleName,
                ref.context,
                null,
              );
            }
            for (const param of result.genericParameters) {
              insertGenericTypeParameter.run(
                null,
                value.id,
                null,
                param.parameterIndex,
                param.baseType,
                param.baseModule,
                param.parameterSignature,
                param.nestingLevel,
              );
            }
          }
        } catch (ex) {
          console.error(
            `  Error parsing value ${value.module_name}.${value.name}: ${ex.message}`,
          );
        }
      }

      console.error("Type relationship parsing completed.");
    } else {
      console.error("No changes detected, skipping type relationship parsing.");
    }

    // Print statistics
    const stats = {
      packages: db.query("SELECT COUNT(*) as count FROM packages").get().count,
      modules: db.query("SELECT COUNT(*) as count FROM modules").get().count,
      types: db.query("SELECT COUNT(*) as count FROM types").get().count,
      values: db.query('SELECT COUNT(*) as count FROM "values"').get().count,
      typeReferences: db
        .query("SELECT COUNT(*) as count FROM type_references")
        .get().count,
      genericParameters: db
        .query("SELECT COUNT(*) as count FROM generic_type_parameters")
        .get().count,
    };

    const duration = ((performance.now() - startTime) / 1000).toFixed(2);

    console.error("\nSync completed successfully!");
    console.error(`  Duration: ${duration}s`);
    console.error(
      `  Packages: ${stats.packages} (${packagesProcessed} processed, ${packagesSkipped} skipped)`,
    );
    console.error(
      `  Modules: ${stats.modules} (${filesProcessed} processed, ${filesSkipped} skipped)`,
    );
    console.error(`  Types: ${stats.types}`);
    console.error(`  Values: ${stats.values}`);
    console.error(`  Type References: ${stats.typeReferences}`);
    console.error(`  Generic Parameters: ${stats.genericParameters}`);
  } catch (error) {
    console.error(`Sync failed: ${error.message}`);
    throw error;
  } finally {
    if (shouldCloseDb && db) {
      db.close();
    }
  }

  if (!shouldCloseDb) {
    return db;
  }
}

async function insertModuleRecursive(
  module,
  packageId,
  parentModuleId,
  compiledFilePath,
  fileHash,
  insertModule,
  insertType,
  insertValue,
  insertAlias,
  getExistingModuleHash,
) {
  // Check if module already exists (might be from another file in same package)
  let moduleResult;
  try {
    moduleResult = insertModule.get(
      packageId,
      parentModuleId,
      module.name,
      module.qualifiedName,
      module.sourceFilePath, // Display path (src/ or lib/ocaml for runtime)
      compiledFilePath, // Actual file we hashed (lib/ocaml)
      fileHash,
      0, // is_auto_opened - will be updated later by detectAndMarkAutoOpenedModules
    );
  } catch (ex) {
    if (ex.code === "SQLITE_CONSTRAINT_UNIQUE") {
      // Module already exists, try to update it
      const existing = getExistingModuleHash.get(module.qualifiedName);
      if (existing) {
        moduleResult = { id: existing.id };
      } else {
        console.error(`  Skipping duplicate module: ${module.qualifiedName}`);
        return;
      }
    } else {
      throw ex;
    }
  }
  const moduleId = moduleResult.id;

  // Insert types
  for (const type of module.types) {
    insertType.run(
      moduleId,
      type.name,
      type.kind,
      type.signature,
      JSON.stringify(type.detail),
    );
  }

  // Insert values
  for (const value of module.values) {
    insertValue.run(
      moduleId,
      value.name,
      value.returnType,
      value.paramCount,
      value.signature,
      JSON.stringify(value.detail),
    );
  }

  // Insert aliases
  for (const alias of module.aliases || []) {
    insertAlias.run(
      moduleId,
      alias.name,
      alias.kind,
      alias.targetQualifiedName,
      JSON.stringify(alias.docstrings),
    );
  }

  // Insert nested modules
  for (const nested of module.nestedModules) {
    await insertModuleRecursive(
      nested,
      packageId,
      moduleId,
      compiledFilePath, // Pass through the same compiled path
      fileHash,
      insertModule,
      insertType,
      insertValue,
      insertAlias,
      getExistingModuleHash,
    );
  }
}

// ============================================================================
// Alias Resolution Helper
// ============================================================================

function resolveModuleAlias(db, moduleName) {
  // First try to find the module directly
  const directModule = db
    .query("SELECT id, qualified_name FROM modules WHERE qualified_name = ?")
    .get(moduleName);

  if (directModule) {
    return { module: directModule, resolvedFromAlias: null };
  }

  // If not found, check aliases table
  const aliases = db
    .query("SELECT target_qualified_name FROM aliases WHERE alias_name = ?")
    .all(moduleName);

  for (const alias of aliases) {
    // Now find the actual module
    const targetModule = db
      .query("SELECT id, qualified_name FROM modules WHERE qualified_name = ?")
      .get(alias.target_qualified_name);

    if (targetModule) {
      return {
        module: targetModule,
        resolvedFromAlias: `${moduleName} -> ${alias.target_qualified_name}`,
      };
    }
  }

  return { module: null, resolvedFromAlias: null };
}

// ============================================================================
// Namespace Mapping Helper
// ============================================================================

/**
 * Convert qualified name (internal format) to code access path (user-facing format)
 * Examples:
 *   "Global-WebAPI" -> "WebAPI.Global"
 *   "DOMAPI-WebAPI" -> "WebAPI.DOMAPI"
 *   "React.Children" -> "React.Children" (nested modules, no namespace)
 *   "Stdlib_Array" -> "Array" (if aliased) or "Stdlib_Array" (if not)
 */
function qualifiedNameToCodePath(qualifiedName) {
  if (!qualifiedName) return qualifiedName;

  // Check if it contains namespace separator (ModuleName-Namespace)
  const namespaceMatch = qualifiedName.match(
    /^([A-Za-z_][A-Za-z0-9_]*)-([A-Za-z_][A-Za-z0-9_.]*)$/,
  );
  if (namespaceMatch) {
    const [, moduleName, namespace] = namespaceMatch;
    // Convert to code access path: Namespace.ModuleName
    // Handle nested namespaces (e.g., "Module-SubNamespace.Namespace" -> "SubNamespace.Namespace.Module")
    const namespaceParts = namespace.split(".");
    namespaceParts.push(moduleName);
    return namespaceParts.join(".");
  }

  // No namespace, return as-is (could be nested module like "React.Children")
  return qualifiedName;
}

/**
 * Get both qualified name and code access path for a module
 */
function getModulePaths(qualifiedName) {
  const codePath = qualifiedNameToCodePath(qualifiedName);
  return {
    qualifiedName, // Internal format (e.g., "Global-WebAPI")
    codePath, // Code access path (e.g., "WebAPI.Global")
    ...(qualifiedName !== codePath && { hasNamespace: true }),
  };
}

// ============================================================================
// Core Lookup Functions
// ============================================================================

/**
 * Get detailed information for a single type
 */
async function getTypeDetails(db, qualifiedModuleName, typeName) {
  let resolvedModule, resolvedFromAlias;

  // Handle global types (empty module name)
  if (!qualifiedModuleName || qualifiedModuleName === "") {
    // Global types are stored in the Pervasives module
    resolvedModule = db
      .query(
        "SELECT id, qualified_name FROM modules WHERE qualified_name = 'Pervasives'",
      )
      .get();

    if (!resolvedModule) {
      return {
        success: false,
        error: `Global type '${typeName}' not found. Pervasives module not available.`,
      };
    }
    resolvedFromAlias = null;
  } else {
    // Try to resolve module with alias resolution
    const result = resolveModuleAlias(db, qualifiedModuleName);
    resolvedModule = result.module;
    resolvedFromAlias = result.resolvedFromAlias;

    if (!resolvedModule) {
      return {
        success: false,
        error: `Module '${qualifiedModuleName}' not found in database.`,
      };
    }
  }

  const type = db
    .query(
      `
    SELECT t.id, t.name, t.kind, t.signature, t.detail
    FROM types t
    JOIN modules m ON t.module_id = m.id
    WHERE m.qualified_name = ? AND t.name = ?
  `,
    )
    .get(resolvedModule.qualified_name, typeName);

  if (!type) {
    const moduleDisplayName = qualifiedModuleName || "global";
    return {
      success: false,
      error: `Type '${typeName}' not found in ${moduleDisplayName === "global" ? "global scope" : `module '${qualifiedModuleName}'`}.${resolvedFromAlias ? ` (Resolved from alias: ${resolvedFromAlias})` : ""}`,
    };
  }

  // Get generic parameters for this type
  const genericParameters = db
    .query(
      `
    SELECT parameter_index, base_type, base_module, parameter_signature, nesting_level, field_name
    FROM generic_type_parameters
    WHERE type_id = ?
    ORDER BY parameter_index, nesting_level
  `,
    )
    .all(type.id);

  // Get type references for this type
  const typeReferences = db
    .query(
      `
    SELECT referenced_type_name, referenced_module_name, context, position
    FROM type_references
    WHERE source_type_id = ?
    ORDER BY context, position
  `,
    )
    .all(type.id);

  // Parse the detail and enhance it with generic analysis
  const detail = JSON.parse(type.detail);

  // Add generic analysis to detail items if they exist
  if (detail.items && Array.isArray(detail.items)) {
    for (const item of detail.items) {
      if (item.signature) {
        const result = parseTypeSignature(item.signature, `field ${item.name}`);
        item.genericAnalysis = {
          typeReferences: result.typeReferences,
          genericParameters: result.genericParameters,
        };
      }
    }
  }

  // Generate usage hint for variants
  let usageHint = undefined;
  if (type.kind === "variant" && detail.items && Array.isArray(detail.items)) {
    const constructors = detail.items.map((item) => item.name).join(" | ");
    usageHint = `Pattern match with: ${constructors}`;
  }

  // Get module paths (qualified name and code access path)
  const modulePaths = getModulePaths(resolvedModule.qualified_name);

  const typeResult = {
    name: type.name,
    kind: type.kind || "unknown",
    signature: type.signature,
    detail: detail,
    genericParameters: genericParameters,
    typeReferences: typeReferences,
    usageHint: usageHint,
    module: {
      qualifiedName: resolvedModule.qualified_name,
      ...modulePaths,
    },
    ...(resolvedFromAlias && { resolvedFromAlias }),
  };

  return {
    success: true,
    type: typeResult,
  };
}

/**
 * Get detailed information for a single value
 */
async function getValueDetails(db, qualifiedModuleName, valueName) {
  let resolvedModule, resolvedFromAlias;

  // Handle global values (empty module name)
  if (!qualifiedModuleName || qualifiedModuleName === "") {
    // Global values are stored in the Pervasives module
    resolvedModule = db
      .query(
        "SELECT id, qualified_name FROM modules WHERE qualified_name = 'Pervasives'",
      )
      .get();

    if (!resolvedModule) {
      return {
        success: false,
        error: `Global value '${valueName}' not found. Pervasives module not available.`,
      };
    }
    resolvedFromAlias = null;
  } else {
    // Try to resolve module with alias resolution
    const result = resolveModuleAlias(db, qualifiedModuleName);
    resolvedModule = result.module;
    resolvedFromAlias = result.resolvedFromAlias;

    if (!resolvedModule) {
      return {
        success: false,
        error: `Module '${qualifiedModuleName}' not found in database.`,
      };
    }
  }

  const value = db
    .query(
      `
    SELECT v.name, v.signature, v.param_count, v.return_type, v.detail
    FROM "values" v
    JOIN modules m ON v.module_id = m.id
    WHERE m.qualified_name = ? AND v.name = ?
  `,
    )
    .get(resolvedModule.qualified_name, valueName);

  if (!value) {
    const moduleDisplayName = qualifiedModuleName || "global";
    return {
      success: false,
      error: `Value '${valueName}' not found in ${moduleDisplayName === "global" ? "global scope" : `module '${qualifiedModuleName}'`}.${resolvedFromAlias ? ` (Resolved from alias: ${resolvedFromAlias})` : ""}`,
    };
  }

  // Get module paths (qualified name and code access path)
  const modulePaths = getModulePaths(resolvedModule.qualified_name);

  const valueResult = {
    name: value.name,
    signature: value.signature,
    paramCount: value.param_count,
    returnType: value.return_type,
    detail: JSON.parse(value.detail),
    module: {
      qualifiedName: resolvedModule.qualified_name,
      ...modulePaths,
    },
    ...(resolvedFromAlias && { resolvedFromAlias }),
  };

  return {
    success: true,
    value: valueResult,
  };
}

// ============================================================================
// Search Implementation
// ============================================================================

/**
 * Search across all ReScript packages, modules, types, and values
 */
async function searchCodebase(
  db,
  searchTerm,
  categories = ["all"],
  maxResults = 50,
) {
  const results = [];
  const searchPattern = `%${searchTerm}%`;
  const searchTermLower = searchTerm.toLowerCase();

  // Helper function to calculate match score
  function calculateMatchScore(name, searchTerm) {
    const nameLower = name.toLowerCase();
    if (nameLower === searchTerm) return 100; // exact match
    if (nameLower.startsWith(searchTerm)) return 80; // starts with
    return 60; // contains
  }

  // Helper function to calculate category priority
  function getCategoryPriority(category) {
    switch (category) {
      case "value":
        return 4;
      case "type":
        return 3;
      case "module":
        return 2;
      case "package":
        return 1;
      default:
        return 0;
    }
  }

  // Search packages
  if (categories.includes("packages") || categories.includes("all")) {
    const packages = db
      .query(
        `
      SELECT name, path 
      FROM packages 
      WHERE LOWER(name) LIKE LOWER(?)
      ORDER BY name
    `,
      )
      .all(searchPattern);

    for (const pkg of packages) {
      const matchScore = calculateMatchScore(pkg.name, searchTermLower);
      results.push({
        category: "package",
        name: pkg.name,
        qualifiedName: pkg.name,
        packageName: pkg.name,
        signature: undefined,
        description: `Package: ${pkg.name}`,
        matchScore: matchScore,
        categoryPriority: getCategoryPriority("package"),
      });
    }
  }

  // Search modules
  if (categories.includes("modules") || categories.includes("all")) {
    const modules = db
      .query(
        `
      SELECT m.qualified_name, p.name as package_name
      FROM modules m
      JOIN packages p ON m.package_id = p.id
      WHERE LOWER(m.qualified_name) LIKE LOWER(?)
      ORDER BY m.qualified_name
    `,
      )
      .all(searchPattern);

    for (const mod of modules) {
      const matchScore = calculateMatchScore(
        mod.qualified_name,
        searchTermLower,
      );
      const modulePaths = getModulePaths(mod.qualified_name);
      results.push({
        category: "module",
        name: mod.qualified_name,
        qualifiedName: mod.qualified_name,
        codePath: modulePaths.codePath,
        packageName: mod.package_name,
        signature: undefined,
        description: `Module: ${mod.qualified_name}${modulePaths.hasNamespace ? ` (access as: ${modulePaths.codePath})` : ""}`,
        matchScore: matchScore,
        categoryPriority: getCategoryPriority("module"),
      });
    }
  }

  // Search types
  if (categories.includes("types") || categories.includes("all")) {
    const types = db
      .query(
        `
      SELECT t.name, t.kind, t.signature, m.qualified_name as module_name, p.name as package_name
      FROM types t
      JOIN modules m ON t.module_id = m.id
      JOIN packages p ON m.package_id = p.id
      WHERE LOWER(t.name) LIKE LOWER(?)
      ORDER BY t.name
    `,
      )
      .all(searchPattern);

    for (const type of types) {
      const matchScore = calculateMatchScore(type.name, searchTermLower);
      const modulePaths = getModulePaths(type.module_name);
      results.push({
        category: "type",
        name: type.name,
        qualifiedName: `${type.module_name}.${type.name}`,
        codePath: `${modulePaths.codePath}.${type.name}`,
        packageName: type.package_name,
        signature: type.signature,
        description: `${type.kind || "type"}: ${type.name}${modulePaths.hasNamespace ? ` (access as: ${modulePaths.codePath}.${type.name})` : ""}`,
        matchScore: matchScore,
        categoryPriority: getCategoryPriority("type"),
      });
    }
  }

  // Search values
  if (categories.includes("values") || categories.includes("all")) {
    const values = db
      .query(
        `
      SELECT v.name, v.signature, v.param_count, m.qualified_name as module_name, p.name as package_name
      FROM "values" v
      JOIN modules m ON v.module_id = m.id
      JOIN packages p ON m.package_id = p.id
      WHERE LOWER(v.name) LIKE LOWER(?)
      ORDER BY v.name
    `,
      )
      .all(searchPattern);

    for (const value of values) {
      const matchScore = calculateMatchScore(value.name, searchTermLower);
      const modulePaths = getModulePaths(value.module_name);
      results.push({
        category: "value",
        name: value.name,
        qualifiedName: `${value.module_name}.${value.name}`,
        codePath: `${modulePaths.codePath}.${value.name}`,
        packageName: value.package_name,
        signature: value.signature,
        description: `Function (${value.param_count} params): ${value.name}${modulePaths.hasNamespace ? ` (access as: ${modulePaths.codePath}.${value.name})` : ""}`,
        matchScore: matchScore,
        categoryPriority: getCategoryPriority("value"),
      });
    }
  }

  // Sort by match score (higher first), then by category priority (values > types > modules > packages)
  results.sort((a, b) => {
    if (b.matchScore !== a.matchScore) {
      return b.matchScore - a.matchScore;
    }
    return b.categoryPriority - a.categoryPriority;
  });

  // Apply maxResults limit
  const limitedResults = results.slice(0, maxResults);

  // Generate suggestions based on what was found
  const suggestions = [];
  const foundCategories = new Set(limitedResults.map((r) => r.category));

  if (foundCategories.has("type")) {
    suggestions.push("Use get_types to get detailed type information");
    suggestions.push("Use get_type_usage to see where these types are used");
  }
  if (foundCategories.has("value")) {
    suggestions.push("Use get_values to get detailed function signatures");
  }
  if (foundCategories.has("module")) {
    suggestions.push("Use get_rescript_module_info to explore module contents");
  }
  if (foundCategories.has("package")) {
    suggestions.push(
      "Use get_rescript_package_modules to see all modules in package",
    );
  }

  return {
    searchTerm: searchTerm,
    totalResults: results.length,
    results: limitedResults.map((r) => ({
      category: r.category,
      name: r.name,
      qualifiedName: r.qualifiedName,
      codePath: r.codePath,
      packageName: r.packageName,
      signature: r.signature,
      description: r.description,
      matchScore: r.matchScore,
    })),
    suggestions: suggestions,
  };
}

// ============================================================================
// MCP Server Implementation
// ============================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { parseArgs } from "node:util";

const server = new McpServer({
  name: "ReScript Project Assistant",
  version: "1.0.0",
  description:
    "Provides accurate ReScript module, type, and value information from indexed projects. Indexes compiled ReScript code and stores it in SQLite for fast querying. Supports namespaced modules (e.g., 'DOMAPI-WebAPI'), nested modules (e.g., 'React.Children'), multiple lookups in single calls, global types/values, and provides comprehensive documentation for types and values.\n\n" +
    "WHAT IT CAN DO:\n" +
    "- API exploration: Discover available functions, types, and modules\n" +
    "- Signature discovery: Get exact function signatures, parameter counts, and return types\n" +
    "- Type definitions: Understand type structures and variants\n" +
    "- Module hierarchy: Explore module relationships and qualified names\n" +
    "- Namespace mapping: Convert qualified names to code access paths\n\n" +
    "WHAT IT CANNOT DO:\n" +
    "- Code examples: Does not provide actual code implementations or usage examples from your codebase\n" +
    "- Usage patterns: Does not show how functions are typically used together in practice\n" +
    "- Implementation details: Cannot find actual code implementations or usage in your codebase\n\n" +
    "IMPORTANT: Use MCP tools for function signatures, type definitions, and module exploration. Use traditional grep/search for code patterns, usage examples, and implementation details.",
  capabilities: {
    resources: {},
    tools: {},
  },
});

// ============================================================================
// MCP Tools
// ============================================================================

// Tool 1: Sync database
server.registerTool(
  "sync_rescript_database",
  {
    description: `Sync the ReScript database with the current project. Compiles ReScript code and indexes all modules, types, and values. This may take 10-30 seconds on first run or when significant changes are detected.

Note: This tool requires being called from within a ReScript project directory (with rescript.json).`,
    inputSchema: {
      projectRoot: z
        .string()
        .describe(
          "Absolute path to ReScript workspace root (directory containing top-level rescript.json). Required.",
        ),
    },
    outputSchema: {
      success: z.boolean(),
      stats: z.object({
        packages: z.number(),
        modules: z.number(),
        types: z.number(),
        values: z.number(),
        typeReferences: z.number(),
        genericParameters: z.number(),
      }),
      duration: z.string(),
    },
  },
  async (args) => {
    try {
      const { projectRoot } = args;
      const startTime = performance.now();

      // Capture console.error output by temporarily overriding it
      const originalError = console.error;
      const errorMessages = [];
      console.error = (...args) => {
        errorMessages.push(args.join(" "));
        originalError(...args);
      };

      await syncDatabase(projectRoot);

      // Restore console.error
      console.error = originalError;

      // Get stats from database
      const db = await ensureDatabaseInitialized(projectRoot);
      const stats = {
        packages: db.query("SELECT COUNT(*) as count FROM packages").get()
          .count,
        modules: db.query("SELECT COUNT(*) as count FROM modules").get().count,
        types: db.query("SELECT COUNT(*) as count FROM types").get().count,
        values: db.query('SELECT COUNT(*) as count FROM "values"').get().count,
        typeReferences: db
          .query("SELECT COUNT(*) as count FROM type_references")
          .get().count,
        genericParameters: db
          .query("SELECT COUNT(*) as count FROM generic_type_parameters")
          .get().count,
      };
      db.close();

      const duration = ((performance.now() - startTime) / 1000).toFixed(2);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                stats,
                duration: `${duration}s`,
              },
              null,
              2,
            ),
          },
        ],
        structuredContent: {
          success: true,
          stats,
          duration: `${duration}s`,
        },
      };
    } catch (ex) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${ex.message}\n\nAttempted projectRoot: ${args?.projectRoot || "not provided"}\n\nSuggestion: Check that projectRoot points to a directory with rescript.json`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Tool 2: Query database with raw SQL
server.registerTool(
  "query_rescript_database",
  {
    description: `Execute a raw SQL SELECT query against the ReScript database. Only SELECT queries are allowed for security. The database schema is documented in rescript-db-schema.mdc.

Use this tool to query packages, modules, types, values, aliases, type references, and generic parameters. See rescript-db-schema.mdc for the complete schema and example queries.

WHAT IT CAN DO:
- Query database schema: Access packages, modules, types, values, aliases, type references, and generic parameters
- Complex queries: Join tables to find relationships between symbols
- Filter and search: Use SQL WHERE clauses to filter results

WHAT IT CANNOT DO:
- Code examples: Does not return actual code implementations
- Usage patterns: Cannot show how symbols are used in your codebase
- Pattern matching: Use grep/search for finding code patterns

Note: This tool requires being called from within a ReScript project directory (with rescript.json). The first call will automatically compile and index the project, which may take 10-30 seconds.`,
    inputSchema: {
      projectRoot: z
        .string()
        .describe(
          "Absolute path to ReScript workspace root (directory containing top-level rescript.json). Required.",
        ),
      sql: z
        .string()
        .describe(
          "SQL SELECT query to execute. Only SELECT statements are allowed. All values must be inlined directly in the query string (no parameters).",
        ),
    },
    outputSchema: {
      results: z
        .array(z.any())
        .describe("Query results as array of row objects"),
    },
  },
  async ({ projectRoot, sql }) => {
    if (!sql) {
      throw new Error("sql parameter is required");
    }

    // Validate SQL - only allow SELECT statements
    const sqlUpper = sql.trim().toUpperCase();
    const forbiddenKeywords = [
      "INSERT",
      "UPDATE",
      "DELETE",
      "DROP",
      "ALTER",
      "CREATE",
      "TRUNCATE",
      "REPLACE",
    ];

    for (const keyword of forbiddenKeywords) {
      if (sqlUpper.includes(keyword)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: SQL query contains forbidden keyword '${keyword}'. Only SELECT queries are allowed for security.`,
            },
          ],
          isError: true,
        };
      }
    }

    if (!sqlUpper.startsWith("SELECT")) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Only SELECT queries are allowed. Query must start with SELECT.",
          },
        ],
        isError: true,
      };
    }

    try {
      const dbPath = await getDbPath(projectRoot);
      const db = new Database(dbPath, { readonly: true });

      try {
        const results = db.query(sql).all();
        db.close();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(results, null, 2),
            },
          ],
          structuredContent: {
            results,
          },
        };
      } catch (queryError) {
        db.close();
        return {
          content: [
            {
              type: "text",
              text: `SQL Error: ${queryError.message}\n\nQuery: ${sql}`,
            },
          ],
          isError: true,
        };
      }
    } catch (ex) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${ex.message}\n\nAttempted projectRoot: ${projectRoot || "not provided"}\n\nSuggestion: Check that projectRoot points to a directory with rescript.json`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ============================================================================
// Main Entry Point
// ============================================================================

async function startMcpServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ReScript MCP Server running on stdio");
}

const { values } = parseArgs({
  args: Bun.argv,
  options: {
    stdio: {
      type: "boolean",
      description: "Run the MCP server in stdio mode",
    },
    sync: {
      type: "boolean",
      description: "Sync the ReScript database with current project",
    },
  },
  strict: true,
  allowPositionals: true,
});

if (values.stdio) {
  await startMcpServer().catch((error) => {
    console.error("Fatal error in MCP server:", error);
    process.exit(1);
  });
} else if (values.sync) {
  try {
    const projectRoot = process.cwd();
    await syncDatabase(projectRoot).catch((error) => {
      console.error("Fatal error during sync:", error);
      process.exit(1);
    });
  } catch (error) {
    console.error(
      `Sync command must be run from a ReScript project root (with rescript.json)`,
    );
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
} else {
  console.log(`
ReScript MCP Server

Usage:
  bun mcp/index.js --sync                    Sync the database with current ReScript projects
  bun mcp/index.js --stdio                   Run the MCP server
  bun start                                   Run the MCP server with inspector (via package.json script)

Examples:
  bun mcp/index.js --sync
  bun start
`);
}
