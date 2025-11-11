# Useful ReScript content for LLMS

## Cursor Rules

[.cursor/rules/rescript.mdc](rescript.mdc) contains a bunch of good to have context for working with ReScript 12+.

```shell
cp ./.cursor/rules/rescript.mdc ../<other project>/.cursor/rules
```

## ReScript MCP Server

This project includes an MCP (Model Context Protocol) server that provides accurate ReScript module, type, and value information to LLMs. It indexes the compiled ReScript code and stores it in a SQLite database for fast querying.

### Lazy database initialization

The MCP server automatically creates and syncs the database on first tool call. No manual setup required!

The server will:
1. Validate that the provided project root contains a `rescript.json` file
2. Compile your ReScript code (`bunx rescript`) if needed
3. Create and sync the database (`rescript.db` at project root)
4. Cache the database for subsequent calls

**Note:** The first tool call may take 10-30 seconds as it compiles and indexes your project.

### Manual sync of database:

```shell
# First, ensure ReScript code is compiled
bunx rescript
# Then sync the database (indexes all packages and dependencies)
bun mcp.js --sync
```

### Key Features

- **Simplified API**: Use fully qualified names like `"Array.t"` instead of complex objects
- **Global Types Support**: Access basic ReScript types like `"string"`, `"int"`, `"bool"` directly
- **Multiple Flag Syntax**: Use multiple `--test-type` and `--test-value` flags instead of JSON arrays
- **Automatic Alias Resolution**: `"Array"` automatically resolves to `"Belt_Array"`
- **Partial Results**: Batch operations return results for all requests, even if some fail
- **Fast Querying**: SQLite database with optimized indexes for sub-second lookups

**Performance:** The sync uses parallel processing (Piscina worker pool) and file hashing for incremental updates:

- Initial sync: processes all files in parallel (~9 seconds)
- Subsequent syncs: only processes changed files (~0.10 seconds when nothing changed)
- Package-level caching: skips entire packages when `rescript.json` unchanged
- File-level caching: skips files when content hash matches
- Parallel processing: uses 12 worker threads to extract documentation concurrently

### Test the database

Explore the database step by step - drill down from packages to modules to individual types/values:

```shell
# Step 1: List all indexed packages
bun mcp.js --test-query all

# Step 2: Explore a specific package (shows top-level modules)
bun mcp.js --test-query "ronnies.be"

# Step 3: Drill into a specific module (shows types and values)
bun mcp.js --test-module "Iluvatar"

# Step 4: Query specific types/values using the simplified API
bun mcp.js --test-type "React.element"
bun mcp.js --test-value "Array.map"

# Step 5: Search within a module
bun mcp.js --test-module "FetchAPI-WebAPI" --test-module-search-term "response"                           # Search all for "response"
bun mcp.js --test-module "FetchAPI-WebAPI" --test-module-search-term "response" --test-module-search-type "types" # Search only types for "response"
bun mcp.js --test-module "Stdlib_Array" --test-module-search-term "map" --test-module-search-type "values"        # Search only values for "map"

# Step 5b: Search using module aliases
bun mcp.js --test-module "Array" --test-module-search-term "fil"                    # Search for "fil" in Array (resolves to Belt_Array)
bun mcp.js --test-module "Promise" --test-module-search-term "all"                  # Search for "all" in Promise (resolves to Stdlib_Promise)
bun mcp.js --test-module "List" --test-module-search-term "map" --test-module-search-type "values"  # Search values for "map" in List

# Step 5c: Query types and values using aliases with the simplified API
bun mcp.js --test-type "Null.t"                    # Query Null.t (resolves to Stdlib_Null.t)
bun mcp.js --test-type "Array.t"                   # Query Array.t (resolves to Belt_Array.t)
bun mcp.js --test-type "Promise.t"                 # Query Promise.t (resolves to Stdlib_Promise.t)
bun mcp.js --test-value "Array.map"                # Query Array.map (resolves to Belt_Array.map)
bun mcp.js --test-value "Null.make"                # Query Null.make (resolves to Stdlib_Null.make)

# Step 6: Discover global symbols
bun mcp.js --test-global-symbols                    # Show all globally available symbols
bun mcp.js --test-global-symbols --test-global-symbols-package "ronnies.be"  # Show global symbols for specific package

# Step 7: Find type usage across all modules
bun mcp.js --test-type-usage "String.t"             # Find where string type is used globally
bun mcp.js --test-type-usage "String.t" --test-type-usage-filter "Iluvatar"  # Filter results to only show Iluvatar module
bun mcp.js --test-type-usage "Null.t"               # Find where nullable types are used globally
bun mcp.js --test-type-usage "Option.t"             # Find where option types are used globally

# Step 8: Test generic type parser
bun mcp.js --test-generic-parse "Null.t<Option.t<string>>"  # Test parser with nested generics
bun mcp.js --test-generic-parse "(string, int) => bool"     # Test parser with function types

# Step 9: Type and value lookups with global types support
bun mcp.js --test-type string --test-type "Array.t" --test-type "React.element"  # Global + module types
bun mcp.js --test-value "+" --test-value "Array.map" --test-value "React.useState"  # Global + module values
bun mcp.js --test-type "int" --test-type "bool" --test-type "option" --test-type "list"  # All global types
bun mcp.js --test-value "==" --test-value "!=" --test-value "&&" --test-value "||"  # Global operators

# More examples:
bun mcp.js --test-query "@rescript/react"
bun mcp.js --test-query "@rescript/runtime"
bun mcp.js --test-module "React.Children"        # Nested module
bun mcp.js --test-module "Stdlib_Array"          # Array in source code
bun mcp.js --test-module "DOMAPI-WebAPI"         # Module with namespace
bun mcp.js --test-module "Buffer-RescriptBun"    # Module with namespace
bun mcp.js --test-type "React.element"           # Module type
bun mcp.js --test-type "DOMAPI-WebAPI.element"   # Type with namespace
bun mcp.js --test-value "React.useState"         # Module value
bun mcp.js --test-value "Stdlib_Array.map"       # Module value

# Step 10: Unified search across all packages, modules, types, and values
bun mcp.js --test-search "useState"              # Find all items matching "useState"
bun mcp.js --test-search "element"               # Find all items matching "element" (types, modules, values)
bun mcp.js --test-search "clipboard" --test-search-max 10  # Limit results to 10
bun mcp.js --test-search "element" --test-search-category "types"  # Only search types
bun mcp.js --test-search "fetch" --test-search-category "values"   # Only search values/functions
```

### Search Tool Usage

The `search_rescript_codebase` tool provides unified search across all indexed ReScript packages, modules, types, and values. It's the best starting point when you don't know exactly what you're looking for.

**When to use search vs other tools:**
- Use `search_rescript_codebase` for **discovery** - when you want to find what's available
- Use other tools (`get_types`, `get_values`, etc.) for **detailed exploration** - when you know what you want to examine

**Search features:**
- **Smart ranking**: Exact matches score highest, then partial matches. Values and types are prioritized over modules and packages.
- **Category filtering**: Search only specific categories (packages, modules, types, values, or all)
- **Contextual suggestions**: Get suggestions for follow-up tool calls based on what was found
- **Result limiting**: Control the number of results returned

**Example workflows:**
1. Search for "clipboard" → find Clipboard-WebAPI module, writeText function, clipboard type
2. Search for "useState" → find React.useState hook with suggestions to use get_values
3. Search for "element" → find DOM element types with suggestions to use get_types and get_type_usage

### Use with MCP clients

To use the MCP server with an LLM client (like Claude Desktop or Cursor), add it to your MCP configuration:

```json
{
  "mcpServers": {
    "rescript": {
      "command": "bun",
      "args": ["mcp.js", "--stdio"],
      "cwd": "/absolute/path/to/your/rescript/project"
    }
  }
}
```

**Important:** The `cwd` must point to a directory containing a top-level `rescript.json` file. Nested packages are not supported as project roots.

### Troubleshooting

Common errors and solutions:

- **"No rescript.json found"** - Check that the `cwd` path points to a directory containing `rescript.json`
- **"Compilation failed"** - Run `bunx rescript` manually in the project directory to see detailed errors
- **"No packages found"** - Check that `rescript.json` is properly configured with dependencies

The server provides these tools:

- `list_rescript_packages` - List all indexed packages
- `get_rescript_package_modules` - Get modules in a package (with automatic alias resolution)
- `get_rescript_module_info` - Get types, values, and aliases in a module (with optional search/filter and alias resolution)
- `get_global_symbols` - Get all globally available symbols from auto-opened modules (Stdlib, Pervasives, and -open modules)
- `get_type_usage` - Find where a specific type is used across all modules in the codebase (global cross-module search with optional filtering)
- `get_types` - Lookup for multiple types in a single call (with automatic alias resolution, global types support, and partial results)
- `get_values` - Lookup for multiple values/functions in a single call (with automatic alias resolution, global values support, and partial results)
- `search_rescript_codebase` - Unified search across all packages, modules, types, and values with a single query (with ranking, filtering, and contextual suggestions)
- `sync_rescript_database` - Manually trigger a full database sync (useful when project dependencies or code have changed)

The database is automatically created and synced on first tool call. For manual syncs, use the `sync_rescript_database` tool or run `bun mcp.js --sync` from your project root.
