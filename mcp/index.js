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

  const typeResult = {
    name: type.name,
    kind: type.kind || "unknown",
    signature: type.signature,
    detail: detail,
    genericParameters: genericParameters,
    typeReferences: typeReferences,
    usageHint: usageHint,
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

  const valueResult = {
    name: value.name,
    signature: value.signature,
    paramCount: value.param_count,
    returnType: value.return_type,
    detail: JSON.parse(value.detail),
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
      results.push({
        category: "module",
        name: mod.qualified_name,
        qualifiedName: mod.qualified_name,
        packageName: mod.package_name,
        signature: undefined,
        description: `Module: ${mod.qualified_name}`,
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
      results.push({
        category: "type",
        name: type.name,
        qualifiedName: `${type.module_name}.${type.name}`,
        packageName: type.package_name,
        signature: type.signature,
        description: `${type.kind || "type"}: ${type.name}`,
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
      results.push({
        category: "value",
        name: value.name,
        qualifiedName: `${value.module_name}.${value.name}`,
        packageName: value.package_name,
        signature: value.signature,
        description: `Function (${value.param_count} params): ${value.name}`,
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

const server = new McpServer({
  name: "ReScript Project Assistant",
  version: "1.0.0",
  description:
    "Provides accurate ReScript module, type, and value information from indexed projects. Indexes compiled ReScript code and stores it in SQLite for fast querying. Supports namespaced modules (e.g., 'DOMAPI-WebAPI'), nested modules (e.g., 'React.Children'), multiple lookups in single calls, global types/values, and provides comprehensive documentation for types and values.\n\nIMPORTANT: Use MCP tools for function signatures, type definitions, and module exploration. Use traditional grep/search for code patterns, usage examples, and implementation details. MCP tools excel at finding declared symbols but cannot find code patterns or usage examples.",
  capabilities: {
    resources: {},
    tools: {},
  },
});

// Tool 1: List all indexed packages
server.registerTool(
  "list_rescript_packages",
  {
    description: `List all ReScript packages that have been indexed in the database.

WHAT YOU GET:
- packages: Array of all available packages with their names and paths
- Use this to see what packages are available before exploring specific modules

WORKFLOW:
1. Call this tool to see available packages
2. Use get_rescript_package_modules to explore a specific package
3. Use get_rescript_module_info to dive into specific modules

WHEN TO USE:
✅ Use this for discovering available packages and their structure
❌ Don't use this for finding specific functions or code patterns (use grep instead)

BAD EXAMPLES TO AVOID:
❌ Searching for "async component" - MCP tools can't find code patterns
❌ Looking for "dict{" usage - MCP tools can't find syntax patterns  
❌ Finding "let make = async" - MCP tools can't find code examples

Note: This tool requires being called from within a ReScript project directory (with rescript.json). The first call will automatically compile and index the project, which may take 10-30 seconds.`,
    inputSchema: {
      projectRoot: z
        .string()
        .describe(
          "Absolute path to ReScript workspace root (directory containing top-level rescript.json). Required.",
        ),
    },
    outputSchema: {
      packages: z.array(
        z.object({
          name: z.string(),
          path: z.string(),
        }),
      ),
    },
  },
  async (args) => {
    try {
      const { projectRoot } = args;
      const db = await ensureDatabaseInitialized(projectRoot);
      const packages = db
        .query("SELECT name, path FROM packages ORDER BY name")
        .all();
      db.close();

      return {
        content: [
          { type: "text", text: JSON.stringify({ packages }, null, 2) },
        ],
        structuredContent: { packages },
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

// Tool 2: Get top-level modules for a package
server.registerTool(
  "get_rescript_package_modules",
  {
    description: `Get all top-level modules (and their nested modules) for a specific package.

WHAT YOU GET:
- modules: Array of top-level modules in the package
- Each module shows its qualified name and nested sub-modules
- Use this to explore what modules are available before diving deeper

WORKFLOW:
1. Use list_rescript_packages to find available packages
2. Use this tool to explore modules in a specific package
3. Use get_rescript_module_info to get detailed info about specific modules

EXAMPLES:
- Explore @rescript/webapi: see all WebAPI modules like DOMAPI-WebAPI, FetchAPI-WebAPI
- Explore React: see React and its nested modules like React.Children

WHEN TO USE:
✅ Use this for discovering module structure and hierarchy
✅ Use this to find the right module before looking up specific functions
❌ Don't use this for finding specific function implementations (use grep instead)

BAD EXAMPLES TO AVOID:
❌ Searching for "async" - MCP tools can't find code patterns
❌ Looking for "JSON.Object" usage - MCP tools can't find syntax examples
❌ Finding "React.use" patterns - MCP tools can't find code snippets

Note: This tool requires being called from within a ReScript project directory (with rescript.json). The first call will automatically compile and index the project, which may take 10-30 seconds.`,
    inputSchema: {
      projectRoot: z
        .string()
        .describe(
          "Absolute path to ReScript workspace root (directory containing top-level rescript.json). Required.",
        ),
      packageName: z
        .string()
        .describe(
          "The name of the ReScript package. Examples: '@rescript/runtime', '@rescript/react', 'ronnies.be', 'rescript-pocketbase'",
        ),
    },
    outputSchema: {
      modules: z.array(
        z.object({
          qualifiedName: z.string(),
          nestedModules: z.array(z.string()),
        }),
      ),
    },
  },
  async ({ projectRoot, packageName }) => {
    if (!packageName) {
      throw new Error("packageName is required");
    }

    try {
      const db = await ensureDatabaseInitialized(projectRoot);

      // Get package ID
      const pkg = db
        .query("SELECT id FROM packages WHERE name = ?")
        .get(packageName);
      if (!pkg) {
        db.close();
        return {
          content: [
            {
              type: "text",
              text: `Package '${packageName}' not found in database. Run sync first.`,
            },
          ],
          isError: true,
        };
      }

      // Get top-level modules (no parent)
      const topLevelModules = db
        .query(
          `
        SELECT id, qualified_name 
        FROM modules 
        WHERE package_id = ? AND parent_module_id IS NULL 
        ORDER BY qualified_name
      `,
        )
        .all(pkg.id);

      const modules = topLevelModules.map((mod) => {
        // Get nested modules
        const nested = db
          .query(
            `
          SELECT qualified_name 
          FROM modules 
          WHERE parent_module_id = ? 
          ORDER BY qualified_name
        `,
          )
          .all(mod.id);

        return {
          qualifiedName: mod.qualified_name,
          nestedModules: nested.map((n) => n.qualified_name),
        };
      });

      db.close();

      return {
        content: [{ type: "text", text: JSON.stringify({ modules }, null, 2) }],
        structuredContent: { modules },
      };
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

// Tool 3: Get module information (nested modules, types, values)
server.registerTool(
  "get_rescript_module_info",
  {
    description: `Get detailed information about a ReScript module including its types, values, and nested modules.

WHAT YOU GET:
- types: Type definitions (records, variants, etc.) with their signatures
- values: Functions, constants, and other values with their signatures  
- nestedModules: Sub-modules within this module
- qualifiedName: The full module path used in ReScript code

HOW TO USE THE RESULTS:
- Use 'signature' fields to understand function/type definitions
- Follow type references (e.g., 'WebAPI.ClipboardAPI.clipboard') to other modules
- Use 'paramCount' to understand function arity
- Combine with get_rescript_package_modules to explore module hierarchy

EXAMPLES:
- Find clipboard API: search for 'clipboard' in 'DOMAPI-WebAPI' 
- Explore React hooks: search for 'use' in 'React'
- Check available functions: search for 'values' type in any module

WHEN TO USE:
✅ Use this for getting exact function signatures and type definitions
✅ Use this to discover what functions/types are available in a module
✅ Use this for understanding parameter counts and return types
❌ Don't use this for finding code patterns or usage examples (use grep instead)

BAD EXAMPLES TO AVOID:
❌ Searching for "async component" - MCP tools can't find code patterns
❌ Looking for "dict{" usage - MCP tools can't find syntax patterns
❌ Finding "let make = async" - MCP tools can't find code examples
❌ Searching for "JSON.Object" usage - MCP tools can't find implementation details

Note: This tool requires being called from within a ReScript project directory (with rescript.json). The first call will automatically compile and index the project, which may take 10-30 seconds.`,
    inputSchema: {
      projectRoot: z
        .string()
        .describe(
          "Absolute path to ReScript workspace root (directory containing top-level rescript.json). Required.",
        ),
      qualifiedModuleName: z
        .string()
        .describe(
          "The fully qualified module name. Examples: 'Iluvatar', 'React.Children' (nested module), 'Stdlib_Array' (Array in source code), 'DOMAPI-WebAPI' (module with namespace), 'Buffer-RescriptBun' (module with namespace)",
        ),
      searchTerm: z
        .string()
        .optional()
        .describe(
          "Optional search string for filtering results. Performs case-insensitive substring matching on names.",
        ),
      searchType: z
        .enum(["types", "values", "nested-modules", "aliases", "all"])
        .optional()
        .describe(
          "Optional filter type. When provided with searchTerm, only returns results of this type. Defaults to 'all' when searchTerm is provided.",
        ),
    },
    outputSchema: {
      module: z.object({
        qualifiedName: z
          .string()
          .describe("Full module path (e.g., 'WebAPI.DOMAPI')"),
        sourceFilePath: z
          .string()
          .optional()
          .describe("Path to the source file"),
        nestedModules: z
          .array(z.string())
          .describe("Sub-modules you can explore further"),
        types: z
          .array(
            z.object({
              name: z.string().describe("Type name as used in ReScript code"),
              kind: z
                .string()
                .describe("Type kind: 'record', 'variant', 'abstract', etc."),
              signature: z
                .string()
                .optional()
                .describe(
                  "Full type definition - use this to understand the type structure",
                ),
            }),
          )
          .describe("Type definitions available in this module"),
        values: z
          .array(
            z.object({
              name: z
                .string()
                .describe("Function/value name as used in ReScript code"),
              signature: z
                .string()
                .optional()
                .describe(
                  "Function signature showing parameters and return type",
                ),
              paramCount: z
                .number()
                .describe("Number of parameters this function takes"),
            }),
          )
          .describe(
            "Functions, constants, and other values available in this module",
          ),
        aliases: z
          .array(
            z.object({
              name: z.string().describe("Alias name"),
              kind: z
                .string()
                .describe("What the alias points to (type/value/module)"),
              targetQualifiedName: z
                .string()
                .describe("Full path to the actual module/type/value"),
            }),
          )
          .describe("Module aliases that redirect to other modules"),
        resolvedFromAlias: z
          .string()
          .nullable()
          .optional()
          .describe(
            "If this module was resolved from an alias, shows the alias path",
          ),
      }),
    },
  },
  async ({ projectRoot, qualifiedModuleName, searchTerm, searchType }) => {
    if (!qualifiedModuleName) {
      throw new Error("qualifiedModuleName is required");
    }

    try {
      const db = await ensureDatabaseInitialized(projectRoot);

      // Get module with alias resolution
      const { module, resolvedFromAlias } = resolveModuleAlias(
        db,
        qualifiedModuleName,
      );

      if (!module) {
        db.close();
        return {
          content: [
            {
              type: "text",
              text: `Module '${qualifiedModuleName}' not found in database.`,
            },
          ],
          isError: true,
        };
      }

      // Determine search behavior
      const hasSearch = searchTerm && searchTerm.trim() !== "";
      const effectiveSearchType = hasSearch && !searchType ? "all" : searchType;
      const searchPattern = hasSearch ? `%${searchTerm}%` : null;

      // Get nested modules
      let nestedModulesQuery = `
        SELECT qualified_name 
        FROM modules 
        WHERE parent_module_id = ? 
      `;
      let nestedModulesParams = [module.id];

      if (
        hasSearch &&
        (effectiveSearchType === "all" ||
          effectiveSearchType === "nested-modules")
      ) {
        nestedModulesQuery += ` AND LOWER(qualified_name) LIKE LOWER(?)`;
        nestedModulesParams.push(searchPattern);
      }

      nestedModulesQuery += ` ORDER BY qualified_name`;

      const nestedModules = db
        .query(nestedModulesQuery)
        .all(...nestedModulesParams);

      // Get types
      let typesQuery = `
        SELECT name, kind, signature 
        FROM types 
        WHERE module_id = ? 
      `;
      let typesParams = [module.id];

      if (
        hasSearch &&
        (effectiveSearchType === "all" || effectiveSearchType === "types")
      ) {
        typesQuery += ` AND LOWER(name) LIKE LOWER(?)`;
        typesParams.push(searchPattern);
      }

      typesQuery += ` ORDER BY name`;

      const types = db.query(typesQuery).all(...typesParams);

      // Get values
      let valuesQuery = `
        SELECT name, signature, param_count 
        FROM "values" 
        WHERE module_id = ? 
      `;
      let valuesParams = [module.id];

      if (
        hasSearch &&
        (effectiveSearchType === "all" || effectiveSearchType === "values")
      ) {
        valuesQuery += ` AND LOWER(name) LIKE LOWER(?)`;
        valuesParams.push(searchPattern);
      }

      valuesQuery += ` ORDER BY name`;

      const values = db.query(valuesQuery).all(...valuesParams);

      // Get aliases
      let aliasesQuery = `
        SELECT alias_name, alias_kind, target_qualified_name 
        FROM aliases 
        WHERE source_module_id = ? 
      `;
      let aliasesParams = [module.id];

      if (
        hasSearch &&
        (effectiveSearchType === "all" || effectiveSearchType === "aliases")
      ) {
        aliasesQuery += ` AND LOWER(alias_name) LIKE LOWER(?)`;
        aliasesParams.push(searchPattern);
      }

      aliasesQuery += ` ORDER BY alias_name`;

      const aliases = db.query(aliasesQuery).all(...aliasesParams);

      db.close();

      const result = {
        module: {
          qualifiedName: module.qualified_name,
          sourceFilePath: module.source_file_path,
          nestedModules: nestedModules.map((m) => m.qualified_name),
          types: types.map((t) => ({
            name: t.name,
            kind: t.kind || "unknown",
            signature: t.signature,
          })),
          values: values.map((v) => ({
            name: v.name,
            signature: v.signature,
            paramCount: v.param_count,
          })),
          aliases: aliases.map((a) => ({
            name: a.alias_name,
            kind: a.alias_kind,
            targetQualifiedName: a.target_qualified_name,
          })),
          resolvedFromAlias,
        },
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
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

// Tool 4: Get global symbols
server.registerTool(
  "get_global_symbols",
  {
    description:
      "Get all symbols (types, values, module aliases) that are globally available in any ReScript file. This includes symbols from Stdlib, Pervasives, and modules opened via -open compiler flag. Note: This tool requires being called from within a ReScript project directory (with rescript.json). The first call will automatically compile and index the project, which may take 10-30 seconds. If called from outside a ReScript project, will return an error.",
    inputSchema: {
      projectRoot: z
        .string()
        .describe(
          "Absolute path to ReScript workspace root (directory containing top-level rescript.json). Required.",
        ),
      packageName: z
        .string()
        .optional()
        .describe(
          "Optional package name to filter global symbols for a specific package context",
        ),
    },
    outputSchema: {
      globalSymbols: z.array(
        z.object({
          moduleName: z.string(),
          packageName: z.string(),
          isAutoOpened: z.boolean(),
          types: z.array(
            z.object({
              name: z.string(),
              kind: z.string(),
              signature: z.string().optional(),
            }),
          ),
          values: z.array(
            z.object({
              name: z.string(),
              signature: z.string().optional(),
              paramCount: z.number(),
            }),
          ),
          aliases: z.array(
            z.object({
              name: z.string(),
              kind: z.string(),
              targetQualifiedName: z.string(),
            }),
          ),
        }),
      ),
    },
  },
  async ({ projectRoot, packageName }) => {
    try {
      const db = await ensureDatabaseInitialized(projectRoot);

      // Get all auto-opened modules
      let query = `
        SELECT m.qualified_name, m.is_auto_opened, p.name as package_name
        FROM modules m
        JOIN packages p ON m.package_id = p.id
        WHERE m.is_auto_opened = 1 AND m.parent_module_id IS NULL
      `;
      let params = [];

      if (packageName) {
        query += ` AND p.name = ?`;
        params.push(packageName);
      }

      query += ` ORDER BY p.name, m.qualified_name`;

      const autoOpenedModules = db.query(query).all(...params);

      const globalSymbols = [];

      for (const module of autoOpenedModules) {
        // Get types for this module
        const types = db
          .query(
            `
          SELECT name, kind, signature 
          FROM types 
          WHERE module_id = (SELECT id FROM modules WHERE qualified_name = ?)
          ORDER BY name
        `,
          )
          .all(module.qualified_name);

        // Get values for this module
        const values = db
          .query(
            `
          SELECT name, signature, param_count 
          FROM "values" 
          WHERE module_id = (SELECT id FROM modules WHERE qualified_name = ?)
          ORDER BY name
        `,
          )
          .all(module.qualified_name);

        // Get aliases for this module
        const aliases = db
          .query(
            `
          SELECT alias_name, alias_kind, target_qualified_name 
          FROM aliases 
          WHERE source_module_id = (SELECT id FROM modules WHERE qualified_name = ?)
          ORDER BY alias_name
        `,
          )
          .all(module.qualified_name);

        globalSymbols.push({
          moduleName: module.qualified_name,
          packageName: module.package_name,
          isAutoOpened: Boolean(module.is_auto_opened),
          types: types.map((t) => ({
            name: t.name,
            kind: t.kind || "unknown",
            signature: t.signature,
          })),
          values: values.map((v) => ({
            name: v.name,
            signature: v.signature,
            paramCount: v.param_count,
          })),
          aliases: aliases.map((a) => ({
            name: a.alias_name,
            kind: a.alias_kind,
            targetQualifiedName: a.target_qualified_name,
          })),
        });
      }

      db.close();

      return {
        content: [
          { type: "text", text: JSON.stringify({ globalSymbols }, null, 2) },
        ],
        structuredContent: { globalSymbols },
      };
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

// Tool 5: Get type usage
server.registerTool(
  "get_type_usage",
  {
    description:
      "Find where a specific type is used across all modules in the codebase. This provides global cross-module search to discover all functions, types, and fields that reference the specified type. Note: This tool requires being called from within a ReScript project directory (with rescript.json). The first call will automatically compile and index the project, which may take 10-30 seconds. If called from outside a ReScript project, will return an error.",
    inputSchema: {
      projectRoot: z
        .string()
        .describe(
          "Absolute path to ReScript workspace root (directory containing top-level rescript.json). Required.",
        ),
      qualifiedModuleName: z
        .string()
        .describe(
          "The fully qualified module name. Examples: 'Stdlib_String', 'String' (with alias resolution). Use empty string for global types like 'string', 'int'.",
        ),
      typeName: z
        .string()
        .describe(
          "The name of the type to search for. Examples: 't', 'string'",
        ),
      filter: z
        .string()
        .optional()
        .describe(
          "Optional case-insensitive filter to limit results. Filters by module name, type name, value name, or field name.",
        ),
    },
    outputSchema: {
      usedInTypes: z.array(
        z.object({
          module: z.string(),
          type: z.string(),
          field: z.string().optional(),
          context: z.string(),
          signature: z.string().optional(),
        }),
      ),
      usedInValues: z.array(
        z.object({
          module: z.string(),
          value: z.string(),
          context: z.string(),
          signature: z.string().optional(),
        }),
      ),
      usedAsGenericParameter: z.array(
        z.object({
          module: z.string(),
          type: z.string().optional(),
          value: z.string().optional(),
          field: z.string().optional(),
          signature: z.string(),
          baseType: z.string(),
        }),
      ),
    },
  },
  async ({ projectRoot, qualifiedModuleName, typeName, filter }) => {
    if (!typeName) {
      throw new Error("typeName is required");
    }

    try {
      const db = await ensureDatabaseInitialized(projectRoot);

      let resolvedModule, resolvedFromAlias;

      if (!qualifiedModuleName || qualifiedModuleName === "") {
        // Global type - stored in Pervasives module
        resolvedModule = db
          .query(
            "SELECT id, qualified_name FROM modules WHERE qualified_name = 'Pervasives'",
          )
          .get();
        resolvedFromAlias = null;
      } else {
        // Try to resolve module with alias resolution
        const result = resolveModuleAlias(db, qualifiedModuleName);
        resolvedModule = result.module;
        resolvedFromAlias = result.resolvedFromAlias;
      }

      if (!resolvedModule) {
        const moduleDisplayName = qualifiedModuleName || "global";
        db.close();
        return {
          content: [
            {
              type: "text",
              text: `Type '${typeName}' not found in ${moduleDisplayName === "global" ? "global scope" : `module '${qualifiedModuleName}'`}.`,
            },
          ],
          isError: true,
        };
      }

      // Find all type references for this type
      const typeReferences = db
        .query(
          `
        SELECT 
          tr.context,
          tr.position,
          CASE 
            WHEN tr.source_type_id IS NOT NULL THEN t.name
            WHEN tr.source_value_id IS NOT NULL THEN v.name
            ELSE NULL
          END as source_name,
          CASE 
            WHEN tr.source_type_id IS NOT NULL THEN tm.qualified_name
            WHEN tr.source_value_id IS NOT NULL THEN vm.qualified_name
            ELSE NULL
          END as source_module,
          CASE 
            WHEN tr.source_type_id IS NOT NULL THEN 'type'
            WHEN tr.source_value_id IS NOT NULL THEN 'value'
            ELSE 'unknown'
          END as source_kind,
          CASE 
            WHEN tr.source_type_id IS NOT NULL THEN t.signature
            WHEN tr.source_value_id IS NOT NULL THEN v.signature
            ELSE NULL
          END as source_signature
        FROM type_references tr
        LEFT JOIN types t ON tr.source_type_id = t.id
        LEFT JOIN modules tm ON t.module_id = tm.id
        LEFT JOIN "values" v ON tr.source_value_id = v.id
        LEFT JOIN modules vm ON v.module_id = vm.id
        WHERE (tr.referenced_type_name = ? AND tr.referenced_module_name = ?) 
           OR (tr.referenced_type_name = ? AND (tr.referenced_module_name = '' OR tr.referenced_module_name IS NULL) AND vm.qualified_name = ?)
        ORDER BY source_module, source_name, tr.context
      `,
        )
        .all(
          typeName,
          resolvedModule.qualified_name,
          typeName,
          resolvedModule.qualified_name,
        );

      // Find all generic parameters that use this type
      const genericParameters = db
        .query(
          `
        SELECT 
          gtp.parameter_signature,
          gtp.base_type,
          gtp.field_name,
          CASE 
            WHEN gtp.type_id IS NOT NULL THEN t.name
            WHEN gtp.value_id IS NOT NULL THEN v.name
            ELSE NULL
          END as source_name,
          CASE 
            WHEN gtp.type_id IS NOT NULL THEN tm.qualified_name
            WHEN gtp.value_id IS NOT NULL THEN vm.qualified_name
            ELSE NULL
          END as source_module,
          CASE 
            WHEN gtp.type_id IS NOT NULL THEN 'type'
            WHEN gtp.value_id IS NOT NULL THEN 'value'
            ELSE 'unknown'
          END as source_kind,
          CASE 
            WHEN gtp.type_id IS NOT NULL THEN t.signature
            WHEN gtp.value_id IS NOT NULL THEN v.signature
            ELSE NULL
          END as source_signature
        FROM generic_type_parameters gtp
        LEFT JOIN types t ON gtp.type_id = t.id
        LEFT JOIN modules tm ON t.module_id = tm.id
        LEFT JOIN "values" v ON gtp.value_id = v.id
        LEFT JOIN modules vm ON v.module_id = vm.id
        WHERE gtp.parameter_signature = ? OR gtp.parameter_signature = ? OR gtp.parameter_signature LIKE ? OR gtp.parameter_signature LIKE ?
        ORDER BY source_module, source_name, gtp.parameter_signature
      `,
        )
        .all(
          typeName, // Exact match for global types
          `${resolvedModule.qualified_name}.${typeName}`, // Exact match for qualified types
          `%<${typeName}>%`, // Generic parameter like Type<React.element>
          `%<${resolvedModule.qualified_name}.${typeName}>%`, // Generic parameter like Type<Module.Type>
        );

      db.close();

      // Organize results
      const usedInTypes = [];
      const usedInValues = [];
      const usedAsGenericParameter = [];

      for (const ref of typeReferences) {
        if (ref.source_kind === "type") {
          usedInTypes.push({
            module: ref.source_module,
            type: ref.source_name,
            field: ref.context.includes("field")
              ? ref.context.split(" ")[1]
              : undefined,
            context: ref.context,
            signature: ref.source_signature,
          });
        } else if (ref.source_kind === "value") {
          usedInValues.push({
            module: ref.source_module,
            value: ref.source_name,
            context: ref.context,
            signature: ref.source_signature,
          });
        }
      }

      for (const param of genericParameters) {
        usedAsGenericParameter.push({
          module: param.source_module,
          type: param.source_kind === "type" ? param.source_name : undefined,
          value: param.source_kind === "value" ? param.source_name : undefined,
          field: param.field_name === null ? undefined : param.field_name,
          signature: param.parameter_signature,
          baseType: param.base_type,
        });
      }

      // Apply filtering if provided
      const filterLower = filter ? filter.toLowerCase() : null;
      const filterResults = (items) => {
        if (!filterLower) return items;
        return items.filter((item) => {
          return (
            item.module?.toLowerCase().includes(filterLower) ||
            item.type?.toLowerCase().includes(filterLower) ||
            item.value?.toLowerCase().includes(filterLower) ||
            item.field?.toLowerCase().includes(filterLower) ||
            item.context?.toLowerCase().includes(filterLower) ||
            item.signature?.toLowerCase().includes(filterLower) ||
            item.baseType?.toLowerCase().includes(filterLower)
          );
        });
      };

      const result = {
        usedInTypes: filterResults(usedInTypes),
        usedInValues: filterResults(usedInValues),
        usedAsGenericParameter: filterResults(usedAsGenericParameter),
        ...(resolvedFromAlias && { resolvedFromAlias }),
        ...(filter && { filter }),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
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

// Tool 6: Get types
server.registerTool(
  "get_types",
  {
    description:
      "Get detailed information for multiple types in a single call. Supports alias resolution, global types, and returns partial results if some lookups fail. Note: This tool requires being called from within a ReScript project directory (with rescript.json). The first call will automatically compile and index the project, which may take 10-30 seconds. If called from outside a ReScript project, will return an error.",
    inputSchema: {
      projectRoot: z
        .string()
        .describe(
          "Absolute path to ReScript workspace root (directory containing top-level rescript.json). Required.",
        ),
      typeNames: z
        .array(z.string())
        .describe(
          "Array of fully qualified type names. Examples: 'React.element', 'Array.t', 'string', 'int' (global types)",
        ),
    },
    outputSchema: {
      results: z.array(
        z.object({
          typeName: z.string(),
          success: z.boolean(),
          type: z.any().optional(),
          error: z.string().optional(),
        }),
      ),
    },
  },
  async ({ projectRoot, typeNames }) => {
    if (!typeNames || !Array.isArray(typeNames)) {
      throw new Error("typeNames must be a non-empty array");
    }

    try {
      const db = await ensureDatabaseInitialized(projectRoot);
      const results = [];

      for (const typeName of typeNames) {
        try {
          // Parse the fully qualified type name
          const parts = typeName.split(".");
          let qualifiedModuleName, actualTypeName;

          if (parts.length === 1) {
            // Global type (e.g., "string", "int")
            qualifiedModuleName = "";
            actualTypeName = parts[0];
          } else {
            // Module type (e.g., "React.element", "Array.t")
            actualTypeName = parts.pop();
            qualifiedModuleName = parts.join(".");
          }

          const result = await getTypeDetails(
            db,
            qualifiedModuleName,
            actualTypeName,
          );
          results.push({
            typeName,
            ...result,
          });
        } catch (error) {
          results.push({
            typeName,
            success: false,
            error: `Error processing request: ${error.message}`,
          });
        }
      }

      db.close();

      return {
        content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }],
        structuredContent: { results },
      };
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

// Tool 7: Get values
server.registerTool(
  "get_values",
  {
    description: `Get detailed information for multiple values/functions in a single call.

WHAT YOU GET:
- results: Array of lookup results for each requested value
- Each result shows success/failure, signature, parameter count, and return type
- Supports alias resolution and global values
- Returns partial results if some lookups fail

HOW TO USE:
- Use fully qualified names like 'WebAPI.Clipboard.writeText'
- Use global values like 'console.log' (no module prefix)
- Check success field to see if lookup worked
- Use signature to understand function parameters and return type

EXAMPLES:
- Find clipboard API: ['Clipboard-WebAPI.writeText']
- Find React hooks: ['React.useEffect', 'React.useState']
- Find DOM functions: ['Element-WebAPI.querySelectorAll']

WHEN TO USE:
✅ Use this for getting exact function signatures and parameter counts
✅ Use this to understand return types and function arity
✅ Use this for discovering available functions in modules
❌ Don't use this for finding code patterns or usage examples (use grep instead)

BAD EXAMPLES TO AVOID:
❌ Searching for "async component" - MCP tools can't find code patterns
❌ Looking for "dict{" usage - MCP tools can't find syntax patterns
❌ Finding "let make = async" - MCP tools can't find code examples
❌ Searching for "Response.json" usage - MCP tools can't find implementation details
❌ Looking for "try/catch" patterns - MCP tools can't find code snippets

Note: This tool requires being called from within a ReScript project directory (with rescript.json). The first call will automatically compile and index the project, which may take 10-30 seconds.`,
    inputSchema: {
      projectRoot: z
        .string()
        .describe(
          "Absolute path to ReScript workspace root (directory containing top-level rescript.json). Required.",
        ),
      valueNames: z
        .array(z.string())
        .describe(
          "Array of fully qualified value names. Examples: 'React.useState', 'Array.map', 'console.log' (global values)",
        ),
    },
    outputSchema: {
      results: z.array(
        z.object({
          valueName: z.string(),
          success: z.boolean(),
          value: z.any().optional(),
          error: z.string().optional(),
        }),
      ),
    },
  },
  async ({ projectRoot, valueNames }) => {
    if (!valueNames || !Array.isArray(valueNames)) {
      throw new Error("valueNames must be a non-empty array");
    }

    try {
      const db = await ensureDatabaseInitialized(projectRoot);
      const results = [];

      for (const valueName of valueNames) {
        try {
          // Parse the fully qualified value name
          const parts = valueName.split(".");
          let qualifiedModuleName, actualValueName;

          if (parts.length === 1) {
            // Global value (e.g., "console", "window")
            qualifiedModuleName = "";
            actualValueName = parts[0];
          } else {
            // Module value (e.g., "React.useState", "Array.map")
            actualValueName = parts.pop();
            qualifiedModuleName = parts.join(".");
          }

          const result = await getValueDetails(
            db,
            qualifiedModuleName,
            actualValueName,
          );
          results.push({
            valueName,
            ...result,
          });
        } catch (error) {
          results.push({
            valueName,
            success: false,
            error: `Error processing request: ${error.message}`,
          });
        }
      }

      db.close();

      return {
        content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }],
        structuredContent: { results },
      };
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

// Tool 8: Search codebase
server.registerTool(
  "search_rescript_codebase",
  {
    description: `Search across all ReScript packages, modules, types, and values with a single query.

WHAT YOU GET:
- Unified search results across all packages
- Categorized results (types, values, modules, packages)
- Direct pointers to specific tools for detailed exploration
- Search suggestions and related matches

HOW TO USE THE RESULTS:
- Use 'category' to understand what type of result it is
- Use 'qualifiedName' for direct tool calls (get_rescript_module_info, get_values, etc.)
- Use 'packageName' to explore the package further
- Use 'suggestions' to refine your search

EXAMPLES:
- Search 'clipboard' → finds Clipboard-WebAPI module, writeText function, clipboard type
- Search 'useState' → finds React.useState hook
- Search 'querySelector' → finds Element-WebAPI.querySelectorAll function
- Search 'fetch' → finds FetchAPI-WebAPI module, fetch function

WORKFLOW:
1. Use this tool for initial discovery
2. Use suggested follow-up tools for detailed exploration
3. Use qualifiedName results for specific lookups

WHEN TO USE:
✅ Use this for discovering available symbols (functions, types, modules)
✅ Use this to find the right module/function before getting detailed info
✅ Use this for exploring the codebase structure
❌ Don't use this for finding code patterns or usage examples (use grep instead)

BAD EXAMPLES TO AVOID:
❌ Searching for "async component" - MCP tools can't find code patterns
❌ Looking for "dict{" usage - MCP tools can't find syntax patterns
❌ Finding "let make = async" - MCP tools can't find code examples
❌ Searching for "JSON.Object" usage - MCP tools can't find implementation details
❌ Looking for "try/catch" patterns - MCP tools can't find code snippets
❌ Finding "React.use" patterns - MCP tools can't find code examples

Note: This tool requires being called from within a ReScript project directory (with rescript.json). The first call will automatically compile and index the project, which may take 10-30 seconds.`,
    inputSchema: {
      projectRoot: z
        .string()
        .describe(
          "Absolute path to ReScript workspace root (directory containing top-level rescript.json). Required.",
        ),
      searchTerm: z
        .string()
        .describe(
          "Search term to find across all packages, modules, types, and values",
        ),
      categories: z
        .array(z.enum(["packages", "modules", "types", "values", "all"]))
        .optional()
        .describe("Filter results by category (default: ['all'])"),
      maxResults: z
        .number()
        .optional()
        .describe("Maximum number of results to return (default: 50)"),
    },
    outputSchema: {
      searchTerm: z.string().describe("The search term that was used"),
      totalResults: z.number().describe("Total number of matches found"),
      results: z
        .array(
          z.object({
            category: z
              .enum(["package", "module", "type", "value"])
              .describe("What type of result this is"),
            name: z.string().describe("The name of the found item"),
            qualifiedName: z
              .string()
              .describe("Full qualified name for direct tool calls"),
            packageName: z.string().describe("Package this result belongs to"),
            signature: z
              .string()
              .optional()
              .describe("Function/type signature if available"),
            description: z
              .string()
              .optional()
              .describe("Brief description of what this is"),
            matchScore: z
              .number()
              .describe("Relevance score for ranking (higher is better)"),
          }),
        )
        .describe("Search results categorized by type"),
      suggestions: z
        .array(z.string())
        .describe("Suggested follow-up tool calls based on results found"),
    },
  },
  async ({
    projectRoot,
    searchTerm,
    categories = ["all"],
    maxResults = 50,
  }) => {
    if (!searchTerm) {
      throw new Error("searchTerm is required");
    }

    try {
      const db = await ensureDatabaseInitialized(projectRoot);
      const searchResults = await searchCodebase(
        db,
        searchTerm,
        categories,
        maxResults,
      );
      db.close();

      return {
        content: [
          { type: "text", text: JSON.stringify(searchResults, null, 2) },
        ],
        structuredContent: searchResults,
      };
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

import { parseArgs } from "node:util";

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
    "test-query": {
      type: "string",
      description: "Test querying a package",
    },
    "test-module": {
      type: "string",
      description: "Test querying a specific module",
    },
    "test-module-search-term": {
      type: "string",
      description: "Optional search term for filtering within the module",
    },
    "test-module-search-type": {
      type: "string",
      description:
        "Search type for test-module: types, values, nested-modules, aliases, or all (default: all)",
    },
    "test-global-symbols": {
      type: "boolean",
      description: "Test querying global symbols",
    },
    "test-global-symbols-package": {
      type: "string",
      description:
        "Package name to filter global symbols (use with --test-global-symbols)",
    },
    "test-type-usage": {
      type: "string",
      description:
        "Test where a type is used across all modules (format: ModuleName.TypeName or TypeName for global types)",
    },
    "test-type-usage-filter": {
      type: "string",
      description:
        "Optional filter for test-type-usage results (case-insensitive)",
    },
    "test-generic-parse": {
      type: "string",
      description: "Test the generic type parser with a signature string",
    },
    "test-type": {
      type: "string",
      multiple: true,
      description:
        "Test type query (fully qualified type name). Can be used multiple times.",
    },
    "test-value": {
      type: "string",
      multiple: true,
      description:
        "Test value query (fully qualified value name). Can be used multiple times.",
    },
    "test-search": {
      type: "string",
      description: "Test the search_rescript_codebase tool",
    },
    "test-search-category": {
      type: "string",
      description:
        "Optional category filter for search (packages, modules, types, values, all)",
    },
    "test-search-max": {
      type: "string",
      description: "Optional max results for search (default: 50)",
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
} else if (values["test-query"]) {
  try {
    const projectRoot = process.cwd();
    const dbPath = await getDbPath(projectRoot);
    const db = new Database(dbPath, { readonly: true });

    console.log("\n=== Packages ===");
    const packages = db
      .query("SELECT name, path FROM packages ORDER BY name")
      .all();
    console.table(packages);

    if (values["test-query"] !== "all") {
      const pkg = db
        .query("SELECT id FROM packages WHERE name = ?")
        .get(values["test-query"]);

      if (pkg) {
        console.log(`\n=== Top-level Modules in ${values["test-query"]} ===`);
        const modules = db
          .query(
            `
        SELECT qualified_name, source_file_path 
        FROM modules 
        WHERE package_id = ? AND parent_module_id IS NULL
        ORDER BY qualified_name
      `,
          )
          .all(pkg.id);
        console.table(modules);

        if (modules.length > 0) {
          const firstModule = modules[0].qualified_name;
          const module = db
            .query(
              `
          SELECT id, qualified_name, source_file_path 
          FROM modules 
          WHERE qualified_name = ?
        `,
            )
            .get(firstModule);

          if (module) {
            console.log(`\n=== Sample Module: ${firstModule} ===`);
            console.log(`Source: ${module.source_file_path}`);

            const nestedModules = db
              .query(
                `
            SELECT qualified_name 
            FROM modules 
            WHERE parent_module_id = ?
            ORDER BY qualified_name
          `,
              )
              .all(module.id);
            if (nestedModules.length > 0) {
              console.log(
                `\nNested modules (showing ${nestedModules.length}):`,
              );
              console.table(nestedModules);
            }

            const types = db
              .query(
                `
            SELECT name, kind, signature 
            FROM types 
            WHERE module_id = ?
            ORDER BY name
          `,
              )
              .all(module.id);
            if (types.length > 0) {
              console.log(`\nTypes (showing ${types.length}):`);
              console.table(types);
            }

            const values = db
              .query(
                `
            SELECT name, param_count, signature 
            FROM "values" 
            WHERE module_id = ?
            ORDER BY name
          `,
              )
              .all(module.id);
            if (values.length > 0) {
              console.log(`\nValues (showing ${values.length}):`);
              console.table(values);
            }
          }
        }
      } else {
        console.log(`\nPackage "${values["test-query"]}" not found.`);
      }
    }

    db.close();
  } catch (error) {
    console.error(
      `Test command must be run from a ReScript project root (with rescript.json)`,
    );
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
} else if (values["test-module"]) {
  try {
    const projectRoot = process.cwd();
    const dbPath = await getDbPath(projectRoot);
    const db = new Database(dbPath, { readonly: true });
    const moduleName = values["test-module"];
    const searchTerm = values["test-module-search-term"];
    const searchType = values["test-module-search-type"] || "all";

    if (!moduleName) {
      console.log(
        '\nUsage: --test-module "ModuleName" [--test-module-search-term <term>] [--test-module-search-type <type>]',
      );
      console.log('Example: --test-module "Iluvatar"');
      console.log(
        'Example: --test-module "FetchAPI-WebAPI" --test-module-search-term "response"',
      );
      console.log(
        'Example: --test-module "FetchAPI-WebAPI" --test-module-search-term "response" --test-module-search-type "types"',
      );
      console.log(
        "SearchType can be: types, values, nested-modules, or all (default: all)",
      );
      db.close();
    } else {
      // Try to resolve module with alias resolution
      const { module: resolvedModule, resolvedFromAlias } = resolveModuleAlias(
        db,
        moduleName,
      );

      if (!resolvedModule) {
        console.log(`\nModule "${moduleName}" not found.`);
        db.close();
      } else {
        const module = db
          .query(
            `
        SELECT m.id, m.qualified_name, m.source_file_path, p.name as package_name
        FROM modules m
        JOIN packages p ON m.package_id = p.id
        WHERE m.qualified_name = ?
      `,
          )
          .get(resolvedModule.qualified_name);

        if (!module) {
          console.log(`\nModule "${moduleName}" not found.`);
          db.close();
        } else {
          if (searchTerm) {
            console.log(
              `\n=== Search Results in Module: ${module.qualified_name} ===`,
            );
            console.log(`Package: ${module.package_name}`);
            console.log(`Source: ${module.source_file_path}`);
            if (resolvedFromAlias) {
              console.log(`Resolved from alias: ${resolvedFromAlias}`);
            }
            console.log(`Search Term: "${searchTerm}"`);
            console.log(`Search Type: "${searchType}"`);
          } else {
            console.log(`\n=== Module: ${module.qualified_name} ===`);
            console.log(`Package: ${module.package_name}`);
            console.log(`Source: ${module.source_file_path}`);
            if (resolvedFromAlias) {
              console.log(`Resolved from alias: ${resolvedFromAlias}`);
            }
          }

          // Determine search behavior
          const hasSearch = searchTerm && searchTerm.trim() !== "";
          const effectiveSearchType =
            hasSearch && !searchType ? "all" : searchType;
          const searchPattern = hasSearch ? `%${searchTerm}%` : null;

          // Get nested modules
          let nestedModulesQuery = `
        SELECT qualified_name 
        FROM modules 
        WHERE parent_module_id = ? 
      `;
          let nestedModulesParams = [module.id];

          if (
            hasSearch &&
            (effectiveSearchType === "all" ||
              effectiveSearchType === "nested-modules")
          ) {
            nestedModulesQuery += ` AND LOWER(qualified_name) LIKE LOWER(?)`;
            nestedModulesParams.push(searchPattern);
          }

          nestedModulesQuery += ` ORDER BY qualified_name`;

          const nestedModules = db
            .query(nestedModulesQuery)
            .all(...nestedModulesParams);
          if (
            effectiveSearchType === "all" ||
            effectiveSearchType === "nested-modules"
          ) {
            if (nestedModules.length > 0) {
              console.log(`\n--- Nested Modules (${nestedModules.length}) ---`);
              console.table(nestedModules);
            } else {
              console.log(`\n--- Nested Modules (0 matches) ---`);
            }
          }

          // Get types
          let typesQuery = `
        SELECT name, kind, signature
        FROM types
        WHERE module_id = ?
      `;
          let typesParams = [module.id];

          if (
            hasSearch &&
            (effectiveSearchType === "all" || effectiveSearchType === "types")
          ) {
            typesQuery += ` AND LOWER(name) LIKE LOWER(?)`;
            typesParams.push(searchPattern);
          }

          typesQuery += ` ORDER BY name`;

          const types = db.query(typesQuery).all(...typesParams);
          if (
            effectiveSearchType === "all" ||
            effectiveSearchType === "types"
          ) {
            if (types.length > 0) {
              console.log(`\n--- Types (${types.length}) ---`);
              console.table(types);
            } else {
              console.log(`\n--- Types (0 matches) ---`);
            }
          }

          // Get values
          let valuesQuery = `
        SELECT name, param_count, signature
        FROM "values"
        WHERE module_id = ?
      `;
          let valuesParams = [module.id];

          if (
            hasSearch &&
            (effectiveSearchType === "all" || effectiveSearchType === "values")
          ) {
            valuesQuery += ` AND LOWER(name) LIKE LOWER(?)`;
            valuesParams.push(searchPattern);
          }

          valuesQuery += ` ORDER BY name`;

          const values = db.query(valuesQuery).all(...valuesParams);
          if (
            effectiveSearchType === "all" ||
            effectiveSearchType === "values"
          ) {
            if (values.length > 0) {
              console.log(`\n--- Values (${values.length}) ---`);
              console.table(values);
            } else {
              console.log(`\n--- Values (0 matches) ---`);
            }
          }

          // Get aliases
          let aliasesQuery = `
        SELECT alias_name, alias_kind, target_qualified_name
        FROM aliases
        WHERE source_module_id = ?
      `;
          let aliasesParams = [module.id];

          if (
            hasSearch &&
            (effectiveSearchType === "all" || effectiveSearchType === "aliases")
          ) {
            aliasesQuery += ` AND LOWER(alias_name) LIKE LOWER(?)`;
            aliasesParams.push(searchPattern);
          }

          aliasesQuery += ` ORDER BY alias_name`;

          const aliases = db.query(aliasesQuery).all(...aliasesParams);
          if (
            effectiveSearchType === "all" ||
            effectiveSearchType === "aliases"
          ) {
            if (aliases.length > 0) {
              console.log(`\n--- Aliases (${aliases.length}) ---`);
              console.table(aliases);
            } else {
              console.log(`\n--- Aliases (0 matches) ---`);
            }
          }

          db.close();
        }
      }
    }
  } catch (error) {
    console.error(
      `Test command must be run from a ReScript project root (with rescript.json)`,
    );
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
} else if (values["test-global-symbols"]) {
  try {
    const projectRoot = process.cwd();
    const dbPath = await getDbPath(projectRoot);
    const db = new Database(dbPath, { readonly: true });
    const packageName = values["test-global-symbols-package"];

    // Get all auto-opened modules
    let query = `
    SELECT m.qualified_name, m.is_auto_opened, p.name as package_name
    FROM modules m
    JOIN packages p ON m.package_id = p.id
    WHERE m.is_auto_opened = 1 AND m.parent_module_id IS NULL
  `;
    let params = [];

    if (packageName && packageName !== "all") {
      query += ` AND p.name = ?`;
      params.push(packageName);
    }

    query += ` ORDER BY p.name, m.qualified_name`;

    const autoOpenedModules = db.query(query).all(...params);

    if (autoOpenedModules.length === 0) {
      console.log(
        `\nNo auto-opened modules found${packageName && packageName !== "all" ? ` for package "${packageName}"` : ""}.`,
      );
      db.close();
    } else {
      console.log(
        `\n=== Global Symbols${packageName && packageName !== "all" ? ` (${packageName})` : ""} ===`,
      );
      console.log(`Found ${autoOpenedModules.length} auto-opened module(s):\n`);

      for (const module of autoOpenedModules) {
        console.log(
          `--- ${module.qualified_name} (${module.package_name}) ---`,
        );

        // Get types for this module
        const types = db
          .query(
            `
        SELECT name, kind, signature 
        FROM types 
        WHERE module_id = (SELECT id FROM modules WHERE qualified_name = ?)
        ORDER BY name
      `,
          )
          .all(module.qualified_name);

        if (types.length > 0) {
          console.log(`\nTypes (showing ${types.length}):`);
          console.table(types);
        }

        // Get values for this module
        const values = db
          .query(
            `
        SELECT name, signature, param_count 
        FROM "values" 
        WHERE module_id = (SELECT id FROM modules WHERE qualified_name = ?)
        ORDER BY name
      `,
          )
          .all(module.qualified_name);

        if (values.length > 0) {
          console.log(`\nValues (showing ${values.length}):`);
          console.table(values);
        }

        // Get aliases for this module
        const aliases = db
          .query(
            `
        SELECT alias_name, alias_kind, target_qualified_name 
        FROM aliases 
        WHERE source_module_id = (SELECT id FROM modules WHERE qualified_name = ?)
        ORDER BY alias_name
      `,
          )
          .all(module.qualified_name);

        if (aliases.length > 0) {
          console.log(`\nAliases (showing ${aliases.length}):`);
          console.table(aliases);
        }

        console.log(""); // Empty line between modules
      }

      db.close();
    }
  } catch (error) {
    console.error(
      `Test command must be run from a ReScript project root (with rescript.json)`,
    );
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
} else if (values["test-type-usage"]) {
  try {
    const projectRoot = process.cwd();
    const dbPath = await getDbPath(projectRoot);
    const db = new Database(dbPath, { readonly: true });
    const input = values["test-type-usage"];
    const filter = values["test-type-usage-filter"];

    // Parse the input to handle both "ModuleName.TypeName" and "TypeName" (global type) formats
    let moduleName, typeName;
    if (input.includes(".")) {
      // Format: ModuleName.TypeName
      [moduleName, typeName] = input.split(".");
    } else {
      // Format: TypeName (global type)
      moduleName = "";
      typeName = input;
    }

    if (!typeName) {
      console.log(
        '\nUsage: --test-type-usage "ModuleName.TypeName" or --test-type-usage "TypeName"',
      );
      console.log('Example: --test-type-usage "String.t" (module type)');
      console.log('Example: --test-type-usage "string" (global type)');
      db.close();
    } else {
      let resolvedModule, resolvedFromAlias;

      if (moduleName === "") {
        // Global type - stored in Pervasives module
        resolvedModule = db
          .query(
            "SELECT id, qualified_name FROM modules WHERE qualified_name = 'Pervasives'",
          )
          .get();
        resolvedFromAlias = null;
      } else {
        // Try to resolve module with alias resolution
        const result = resolveModuleAlias(db, moduleName);
        resolvedModule = result.module;
        resolvedFromAlias = result.resolvedFromAlias;
      }

      if (!resolvedModule) {
        const moduleDisplayName = moduleName || "global";
        console.log(
          `\nType "${typeName}" not found in ${moduleDisplayName === "global" ? "global scope" : `module "${moduleName}"`}.`,
        );
        db.close();
      } else {
        const displayName =
          moduleName === ""
            ? typeName
            : `${resolvedModule.qualified_name}.${typeName}`;
        console.log(`\n=== Type Usage: ${displayName} ===`);
        if (resolvedFromAlias) {
          console.log(`Resolved from alias: ${resolvedFromAlias}`);
        }

        // Find all type references for this type
        const typeReferences = db
          .query(
            `
        SELECT 
          tr.context,
          tr.position,
          CASE 
            WHEN tr.source_type_id IS NOT NULL THEN t.name
            WHEN tr.source_value_id IS NOT NULL THEN v.name
            ELSE NULL
          END as source_name,
          CASE 
            WHEN tr.source_type_id IS NOT NULL THEN tm.qualified_name
            WHEN tr.source_value_id IS NOT NULL THEN vm.qualified_name
            ELSE NULL
          END as source_module,
          CASE 
            WHEN tr.source_type_id IS NOT NULL THEN 'type'
            WHEN tr.source_value_id IS NOT NULL THEN 'value'
            ELSE 'unknown'
          END as source_kind,
          CASE 
            WHEN tr.source_type_id IS NOT NULL THEN t.signature
            WHEN tr.source_value_id IS NOT NULL THEN v.signature
            ELSE NULL
          END as source_signature
        FROM type_references tr
        LEFT JOIN types t ON tr.source_type_id = t.id
        LEFT JOIN modules tm ON t.module_id = tm.id
        LEFT JOIN "values" v ON tr.source_value_id = v.id
        LEFT JOIN modules vm ON v.module_id = vm.id
        WHERE (tr.referenced_type_name = ? AND tr.referenced_module_name = ?) 
           OR (tr.referenced_type_name = ? AND (tr.referenced_module_name = '' OR tr.referenced_module_name IS NULL) AND vm.qualified_name = ?)
        ORDER BY source_module, source_name, tr.context
      `,
          )
          .all(
            typeName,
            resolvedModule.qualified_name,
            typeName,
            resolvedModule.qualified_name,
          );

        // Find all generic parameters that use this type
        const genericParameters = db
          .query(
            `
        SELECT 
          gtp.parameter_signature,
          gtp.base_type,
          gtp.field_name,
          CASE 
            WHEN gtp.type_id IS NOT NULL THEN t.name
            WHEN gtp.value_id IS NOT NULL THEN v.name
            ELSE NULL
          END as source_name,
          CASE 
            WHEN gtp.type_id IS NOT NULL THEN tm.qualified_name
            WHEN gtp.value_id IS NOT NULL THEN vm.qualified_name
            ELSE NULL
          END as source_module,
          CASE 
            WHEN gtp.type_id IS NOT NULL THEN 'type'
            WHEN gtp.value_id IS NOT NULL THEN 'value'
            ELSE 'unknown'
          END as source_kind
        FROM generic_type_parameters gtp
        LEFT JOIN types t ON gtp.type_id = t.id
        LEFT JOIN modules tm ON t.module_id = tm.id
        LEFT JOIN "values" v ON gtp.value_id = v.id
        LEFT JOIN modules vm ON v.module_id = vm.id
        WHERE gtp.parameter_signature = ? OR gtp.parameter_signature = ? OR gtp.parameter_signature LIKE ? OR gtp.parameter_signature LIKE ?
        ORDER BY source_module, source_name, gtp.parameter_signature
      `,
          )
          .all(
            typeName, // Exact match for global types
            `${resolvedModule.qualified_name}.${typeName}`, // Exact match for qualified types
            `%<${typeName}>%`, // Generic parameter like Type<React.element>
            `%<${resolvedModule.qualified_name}.${typeName}>%`, // Generic parameter like Type<Module.Type>
          );

        // Organize results
        const usedInTypes = [];
        const usedInValues = [];
        const usedAsGenericParameter = [];

        for (const ref of typeReferences) {
          if (ref.source_kind === "type") {
            usedInTypes.push({
              module: ref.source_module,
              type: ref.source_name,
              context: ref.context,
              signature: ref.source_signature,
            });
          } else if (ref.source_kind === "value") {
            usedInValues.push({
              module: ref.source_module,
              value: ref.source_name,
              context: ref.context,
              signature: ref.source_signature,
            });
          }
        }

        for (const param of genericParameters) {
          usedAsGenericParameter.push({
            module: param.source_module,
            type: param.source_kind === "type" ? param.source_name : undefined,
            value:
              param.source_kind === "value" ? param.source_name : undefined,
            field: param.field_name === null ? undefined : param.field_name,
            signature: param.parameter_signature,
            baseType: param.base_type,
          });
        }

        // Apply filtering if provided
        const filterLower = filter ? filter.toLowerCase() : null;
        const filterResults = (items) => {
          if (!filterLower) return items;
          return items.filter((item) => {
            return (
              item.module?.toLowerCase().includes(filterLower) ||
              item.type?.toLowerCase().includes(filterLower) ||
              item.value?.toLowerCase().includes(filterLower) ||
              item.field?.toLowerCase().includes(filterLower) ||
              item.context?.toLowerCase().includes(filterLower) ||
              item.signature?.toLowerCase().includes(filterLower) ||
              item.baseType?.toLowerCase().includes(filterLower)
            );
          });
        };

        const filteredUsedInTypes = filterResults(usedInTypes);
        const filteredUsedInValues = filterResults(usedInValues);
        const filteredUsedAsGenericParameter = filterResults(
          usedAsGenericParameter,
        );

        if (filter) {
          console.log(`\nFilter applied: "${filter}" (case-insensitive)`);
          console.log(
            `Results: ${filteredUsedInTypes.length} types, ${filteredUsedInValues.length} values, ${filteredUsedAsGenericParameter.length} generic parameters`,
          );
        }

        console.log(`\nUsed in Types (${filteredUsedInTypes.length}):`);
        if (filteredUsedInTypes.length > 0) {
          console.table(filteredUsedInTypes);
        } else {
          console.log("  None found");
        }

        console.log(`\nUsed in Values (${filteredUsedInValues.length}):`);
        if (filteredUsedInValues.length > 0) {
          console.table(filteredUsedInValues);
        } else {
          console.log("  None found");
        }

        console.log(
          `\nUsed as Generic Parameter (${filteredUsedAsGenericParameter.length}):`,
        );
        if (filteredUsedAsGenericParameter.length > 0) {
          console.table(filteredUsedAsGenericParameter);
        } else {
          console.log("  None found");
        }

        db.close();
      }
    }
  } catch (error) {
    console.error(
      `Test command must be run from a ReScript project root (with rescript.json)`,
    );
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
} else if (values["test-generic-parse"]) {
  const signature = values["test-generic-parse"];

  console.log(`\n=== Generic Type Parser Test ===`);
  console.log(`Input signature: ${signature}`);

  try {
    const result = parseTypeSignature(signature, "test");

    console.log(`\nType References (${result.typeReferences.length}):`);
    if (result.typeReferences.length > 0) {
      console.table(result.typeReferences);
    } else {
      console.log("  None found");
    }

    console.log(`\nGeneric Parameters (${result.genericParameters.length}):`);
    if (result.genericParameters.length > 0) {
      console.table(result.genericParameters);
    } else {
      console.log("  None found");
    }
  } catch (ex) {
    console.log(`\nError parsing signature: ${ex.message}`);
  }
} else if (values["test-type"]) {
  const typeNames = values["test-type"];

  if (!typeNames || typeNames.length === 0) {
    console.log(
      "\nUsage: --test-type <typeName> [--test-type <typeName2> ...]",
    );
    console.log(
      'Example: --test-type string --test-type "Array.t" --test-type "React.element"',
    );
  } else {
    console.log(`\n=== Type Lookup (${typeNames.length} requests) ===`);

    // Simulate the MCP tool call
    try {
      const projectRoot = process.cwd();
      const dbPath = await getDbPath(projectRoot);
      const db = new Database(dbPath, { readonly: true });
      const results = [];

      for (const typeName of typeNames) {
        try {
          // Parse the fully qualified type name
          const parts = typeName.split(".");
          let qualifiedModuleName, actualTypeName;

          if (parts.length === 1) {
            // Global type (e.g., "string", "int")
            qualifiedModuleName = "";
            actualTypeName = parts[0];
          } else {
            // Module type (e.g., "React.element", "Array.t")
            actualTypeName = parts.pop();
            qualifiedModuleName = parts.join(".");
          }

          const result = await getTypeDetails(
            db,
            qualifiedModuleName,
            actualTypeName,
          );
          results.push({
            typeName,
            ...result,
          });
        } catch (error) {
          results.push({
            typeName,
            success: false,
            error: `Error processing request: ${error.message}`,
          });
        }
      }

      db.close();

      // Display results
      const successful = results.filter((r) => r.success);
      const failed = results.filter((r) => !r.success);

      console.log(
        `\nResults: ${successful.length} successful, ${failed.length} failed\n`,
      );

      if (successful.length > 0) {
        console.log("--- Successful Lookups ---");
        for (const result of successful) {
          console.log(`\n✅ ${result.typeName}`);
          if (result.type.resolvedFromAlias) {
            console.log(
              `   Resolved from alias: ${result.type.resolvedFromAlias}`,
            );
          }
          console.log(`   Kind: ${result.type.kind}`);
          if (result.type.signature) {
            console.log(`   Signature: ${result.type.signature}`);
          }
          if (result.type.usageHint) {
            console.log(`   Usage Hint: ${result.type.usageHint}`);
          }
        }
      }

      if (failed.length > 0) {
        console.log("\n--- Failed Lookups ---");
        for (const result of failed) {
          console.log(`\n❌ ${result.typeName}`);
          console.log(`   Error: ${result.error}`);
        }
      }
    } catch (error) {
      console.error(
        `Test command must be run from a ReScript project root (with rescript.json)`,
      );
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  }
} else if (values["test-value"]) {
  const valueNames = values["test-value"];

  if (!valueNames || valueNames.length === 0) {
    console.log(
      "\nUsage: --test-value <valueName> [--test-value <valueName2> ...]",
    );
    console.log(
      'Example: --test-value "+" --test-value "Array.map" --test-value "React.useState"',
    );
  } else {
    console.log(`\n=== Value Lookup (${valueNames.length} requests) ===`);

    // Simulate the MCP tool call
    try {
      const projectRoot = process.cwd();
      const dbPath = await getDbPath(projectRoot);
      const db = new Database(dbPath, { readonly: true });
      const results = [];

      for (const valueName of valueNames) {
        try {
          // Parse the fully qualified value name
          const parts = valueName.split(".");
          let qualifiedModuleName, actualValueName;

          if (parts.length === 1) {
            // Global value (e.g., "console", "window")
            qualifiedModuleName = "";
            actualValueName = parts[0];
          } else {
            // Module value (e.g., "React.useState", "Array.map")
            actualValueName = parts.pop();
            qualifiedModuleName = parts.join(".");
          }

          const result = await getValueDetails(
            db,
            qualifiedModuleName,
            actualValueName,
          );
          results.push({
            valueName,
            ...result,
          });
        } catch (error) {
          results.push({
            valueName,
            success: false,
            error: `Error processing request: ${error.message}`,
          });
        }
      }

      db.close();

      // Display results
      const successful = results.filter((r) => r.success);
      const failed = results.filter((r) => !r.success);

      console.log(
        `\nResults: ${successful.length} successful, ${failed.length} failed\n`,
      );

      if (successful.length > 0) {
        console.log("--- Successful Lookups ---");
        for (const result of successful) {
          console.log(`\n✅ ${result.valueName}`);
          if (result.value.resolvedFromAlias) {
            console.log(
              `   Resolved from alias: ${result.value.resolvedFromAlias}`,
            );
          }
          console.log(`   Parameters: ${result.value.paramCount}`);
          if (result.value.returnType) {
            console.log(`   Return type: ${result.value.returnType}`);
          }
          if (result.value.signature) {
            console.log(`   Signature: ${result.value.signature}`);
          }
        }
      }

      if (failed.length > 0) {
        console.log("\n--- Failed Lookups ---");
        for (const result of failed) {
          console.log(`\n❌ ${result.valueName}`);
          console.log(`   Error: ${result.error}`);
        }
      }
    } catch (error) {
      console.error(
        `Test command must be run from a ReScript project root (with rescript.json)`,
      );
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  }
} else if (values["test-search"]) {
  const searchTerm = values["test-search"];
  const category = values["test-search-category"];
  const maxResults = values["test-search-max"]
    ? parseInt(values["test-search-max"], 10)
    : 50;

  if (!searchTerm) {
    console.log(
      '\nUsage: --test-search "searchTerm" [--test-search-category <category>] [--test-search-max <max>]',
    );
    console.log('Example: --test-search "useState"');
    console.log(
      'Example: --test-search "element" --test-search-category "types"',
    );
    console.log('Example: --test-search "clipboard" --test-search-max 10');
    console.log(
      "Categories: packages, modules, types, values, all (default: all)",
    );
  } else {
    try {
      const projectRoot = process.cwd();
      const dbPath = await getDbPath(projectRoot);
      const db = new Database(dbPath, { readonly: true });

      const categories = category ? [category] : ["all"];
      const searchResults = await searchCodebase(
        db,
        searchTerm,
        categories,
        maxResults,
      );

      console.log(`\n=== Search Results for "${searchTerm}" ===`);
      if (category) {
        console.log(`Category filter: ${category}`);
      }
      console.log(`Max results: ${maxResults}`);
      console.log(`Total matches found: ${searchResults.totalResults}`);
      console.log(`Results returned: ${searchResults.results.length}`);

      if (searchResults.results.length > 0) {
        console.log(`\n--- Search Results ---`);
        console.table(
          searchResults.results.map((r) => ({
            category: r.category,
            name: r.name,
            qualifiedName: r.qualifiedName,
            package: r.packageName,
            matchScore: r.matchScore,
            description: r.description,
          })),
        );

        if (searchResults.suggestions.length > 0) {
          console.log(`\n--- Suggestions ---`);
          searchResults.suggestions.forEach((suggestion) => {
            console.log(`  • ${suggestion}`);
          });
        }
      } else {
        console.log(`\nNo results found for "${searchTerm}"`);
        console.log(`Try a broader search term or different categories`);
      }

      db.close();
    } catch (error) {
      console.error(
        `Test command must be run from a ReScript project root (with rescript.json)`,
      );
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  }
} else {
  console.log(`
ReScript MCP Server

Usage:
  bun mcp.js --sync                    Sync the database with current ReScript projects
  bun mcp.js --stdio                   Run the MCP server
  bun mcp.js --test-query <pkg>        Test querying a package (or 'all' for package list)
  bun mcp.js --test-module <module> [--test-module-search-term <term>] [--test-module-search-type <type>] Test querying a specific module
  bun mcp.js --test-global-symbols [--test-global-symbols-package <package>] Test querying global symbols
  bun mcp.js --test-type-usage <mod.type|type> [--test-type-usage-filter <filter>] Test where a type is used across all modules
  bun mcp.js --test-generic-parse <signature> Test the generic type parser
  bun mcp.js --test-type <typeName> [--test-type <typeName2> ...] Test type queries
  bun mcp.js --test-value <valueName> [--test-value <valueName2> ...] Test value queries
  bun mcp.js --test-search <term> [--test-search-category <category>] [--test-search-max <max>] Test the search tool

Examples:
  bun mcp.js --sync
  bun mcp.js --test-query all
  bun mcp.js --test-query ronnies.be
  bun mcp.js --test-module Iluvatar
  bun mcp.js --test-module "FetchAPI-WebAPI" --test-module-search-term "response"
  bun mcp.js --test-module "FetchAPI-WebAPI" --test-module-search-term "response" --test-module-search-type "types"
  bun mcp.js --test-module "Stdlib_Array" --test-module-search-term "map" --test-module-search-type "values"
  bun mcp.js --test-global-symbols
  bun mcp.js --test-global-symbols --test-global-symbols-package "ronnies.be"
  bun mcp.js --test-type-usage "String.t"
  bun mcp.js --test-type-usage "string"
  bun mcp.js --test-type-usage "String.t" --test-type-usage-filter "Iluvatar"
  bun mcp.js --test-type-usage "string" --test-type-usage-filter "Iluvatar"
  bun mcp.js --test-generic-parse "Null.t<Option.t<string>>"
  bun mcp.js --test-type string --test-type "Array.t" --test-type "React.element"
  bun mcp.js --test-value "+" --test-value "Array.map" --test-value "React.useState"
  bun mcp.js --test-search "useState"
  bun mcp.js --test-search "element" --test-search-category "types"
  bun mcp.js --test-search "clipboard" --test-search-max 10
  `);
}
