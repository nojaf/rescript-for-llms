import { $ } from "bun";
import * as path from "bun:path";
import { stat } from "bun:fs/promises";
import { Glob } from "bun";
import crypto from "bun:crypto";

function getRelativeSourceFilePath(json) {
  // Extract the actual source filepath from rescript-tools doc JSON
  // The items inside have the real source path, not the compiled lib/ocaml path
  for (const item of json.items || []) {
    if (
      item.source &&
      item.source.filepath &&
      !item.source.filepath.startsWith("lib/ocaml")
    ) {
      return item.source.filepath;
    }
    // Recurse into nested items if needed
    if (item.items && item.items.length > 0) {
      const nested = getRelativeSourceFilePath(item);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function parseModuleDocumentation(docJson, sourceFilePath) {
  function extractModule(item, parentQualifiedName = null) {
    const qualifiedName = item.id || item.name;

    const module = {
      name: item.name,
      qualifiedName,
      sourceFilePath,
      parentQualifiedName,
      nestedModules: [],
      types: [],
      values: [],
      aliases: [],
    };

    for (const subItem of item.items || []) {
      if (subItem.kind === "module") {
        const nested = extractModule(subItem, qualifiedName);
        module.nestedModules.push(nested);
      } else if (subItem.kind === "moduleAlias") {
        // For module aliases, the target module name is typically "Stdlib_" + alias name
        // This is based on the pattern we see in Stdlib.res: module Array = Stdlib_Array
        let targetModule = null;
        if (qualifiedName === "Stdlib") {
          // For Stdlib module aliases, the target is typically "Stdlib_" + alias name
          targetModule = `Stdlib_${subItem.name}`;
        } else {
          // For other modules, we might need to infer differently
          // For now, try the same pattern
          targetModule = `${qualifiedName}_${subItem.name}`;
        }

        module.aliases.push({
          name: subItem.name,
          kind: "module",
          targetQualifiedName: targetModule,
          docstrings: subItem.docstrings || [],
          detail: subItem,
        });
      } else if (subItem.kind === "type") {
        module.types.push({
          name: subItem.name || subItem.id,
          kind: subItem.detail?.kind || "unknown",
          signature: subItem.signature,
          detail: subItem,
        });
      } else if (subItem.kind === "value") {
        const paramCount = subItem.signature
          ? (subItem.signature.match(/=>/g) || []).length
          : 0;

        module.values.push({
          name: subItem.name || subItem.id,
          returnType: extractReturnType(subItem.signature),
          paramCount,
          signature: subItem.signature,
          detail: subItem,
        });
      }
    }

    return module;
  }

  return [extractModule(docJson, null)];
}

function extractReturnType(signature) {
  if (!signature) return null;
  const parts = signature.split("=>");
  if (parts.length > 0) {
    return parts[parts.length - 1].trim();
  }
  return signature;
}

async function hashFileContent(filePath) {
  try {
    const content = await Bun.file(filePath).text();
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch (ex) {
    return null;
  }
}

async function extractDocumentationForFile(filePath, packageDir) {
  try {
    const json = await $`bunx rescript-tools doc ${filePath}`.quiet().json();

    // Extract the actual source filepath from the JSON
    let sourceFilePath = filePath;
    const relativeSourcePath = getRelativeSourceFilePath(json);

    if (relativeSourcePath && !relativeSourcePath.startsWith("..")) {
      // Found valid source path in JSON items (not a build-time absolute path)
      // Resolve it relative to package directory
      sourceFilePath = path.resolve(packageDir, relativeSourcePath);
    } else if (!filePath.includes("@rescript/runtime")) {
      // No valid source info in JSON, but not @rescript/runtime
      // Default fallback: convert lib/ocaml to src
      sourceFilePath = filePath.replace(/\/lib\/ocaml\//, "/src/");
    }
    // else: @rescript/runtime with no valid source info - keep lib/ocaml path as is

    return parseModuleDocumentation(json, sourceFilePath);
  } catch (ex) {
    console.error(`Failed to extract docs for ${filePath}:`, ex.message);
    return [];
  }
}

// Memoize rescript.json parsing to avoid reading the same file multiple times
const rescriptJsonCache = new Map();

async function parseRescriptJson(packageDir) {
  if (rescriptJsonCache.has(packageDir)) {
    return rescriptJsonCache.get(packageDir);
  }

  try {
    const rescriptJsonPath = path.resolve(packageDir, "rescript.json");
    const rescriptJson = await Bun.file(rescriptJsonPath).json();
    rescriptJsonCache.set(packageDir, rescriptJson);
    return rescriptJson;
  } catch (error) {
    const fallback = { sources: ["src"] };
    rescriptJsonCache.set(packageDir, fallback);
    return fallback;
  }
}

// Worker function that processes a single file
async function processFile({ filePath, packageDir }) {
  const modules = await extractDocumentationForFile(filePath, packageDir);

  // Find the actual source file using the file name and ReScript configuration
  const fileName = path.basename(filePath);
  let sourceFilePath = filePath;

  // For @rescript/runtime, the source files are in the same directory structure
  if (!filePath.includes("@rescript/runtime")) {
    const rescriptJson = await parseRescriptJson(packageDir);

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
      const sourceDirPath = path.resolve(packageDir, sourceDir);

      try {
        // Use recursive glob to find the file anywhere in the source directory tree
        const globPattern = `**/${fileName}`;
        const glob = new Glob(globPattern);

        for await (const filePath of glob.scan({
          cwd: sourceDirPath,
          absolute: true,
          onlyFiles: true,
        })) {
          // Found the file, use this path
          sourceFilePath = filePath;
          break;
        }

        if (sourceFilePath !== filePath) {
          break; // Found the file, exit the loop
        }
      } catch {
        // Directory doesn't exist or isn't accessible, continue to next source dir
        continue;
      }
    }
  }

  // Prioritize .resi files over .res files
  let prioritizedSourceFile = sourceFilePath;
  if (sourceFilePath.endsWith(".res")) {
    const resiFile = sourceFilePath.replace(/\.res$/, ".resi");
    try {
      await stat(resiFile);
      prioritizedSourceFile = resiFile;
    } catch {
      // .resi file doesn't exist, use the .res file
      prioritizedSourceFile = sourceFilePath;
    }
  }

  // Hash the prioritized source file
  const fileHash = await hashFileContent(prioritizedSourceFile);

  return {
    compiledFilePath: filePath, // The lib/ocaml path we're processing
    fileHash, // Hash of the prioritized source file
    modules,
  };
}

export default processFile;
