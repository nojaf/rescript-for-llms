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
bun mcp/index.js --sync
```

### Key Features

- **SQL-Based Queries**: Execute raw SQL SELECT queries directly against the database for maximum flexibility
- **Schema Documentation**: Complete database schema and example queries documented in `.cursor/rules/rescript-db-schema.mdc`
- **Minimal Context Bloat**: Schema documentation in rules file (loaded once), not in every tool call
- **Fast Querying**: SQLite database with optimized indexes for sub-second lookups
- **Readonly Safety**: Only SELECT queries allowed, database opened in readonly mode

**Performance:** The sync uses parallel processing (Piscina worker pool) and file hashing for incremental updates:

- Initial sync: processes all files in parallel (~9 seconds)
- Subsequent syncs: only processes changed files (~0.10 seconds when nothing changed)
- Package-level caching: skips entire packages when `rescript.json` unchanged
- File-level caching: skips files when content hash matches
- Parallel processing: uses 12 worker threads to extract documentation concurrently

### Database Schema

The database schema and example SQL queries are documented in `.cursor/rules/rescript-db-schema.mdc`. This file contains:

- Complete table definitions with columns, foreign keys, and indexes
- Example SQL queries for common operations
- Notes on alias resolution patterns
- Important: All values must be inlined in SQL queries (no parameters)

### Using the SQL Query Tool

The `query_rescript_database` tool accepts raw SQL SELECT queries. All values must be inlined directly in the query string.

**Example queries:**

```sql
-- List all packages
SELECT name, path FROM packages ORDER BY name

-- Get modules in a package
SELECT m.id, m.qualified_name, m.source_file_path
FROM modules m
JOIN packages p ON m.package_id = p.id
WHERE p.name = '@rescript/react' AND m.parent_module_id IS NULL
ORDER BY m.qualified_name

-- Get types in a module
SELECT name, kind, signature, detail
FROM types
WHERE module_id = (SELECT id FROM modules WHERE qualified_name = 'React')
ORDER BY name

-- Get values in a module
SELECT name, signature, param_count, return_type, detail
FROM "values"
WHERE module_id = (SELECT id FROM modules WHERE qualified_name = 'React')
ORDER BY name

-- Search for modules
SELECT m.qualified_name, p.name as package_name
FROM modules m
JOIN packages p ON m.package_id = p.id
WHERE LOWER(m.qualified_name) LIKE LOWER('%React%')
ORDER BY m.qualified_name

-- Search for types
SELECT t.name, t.kind, t.signature, m.qualified_name as module_name, p.name as package_name
FROM types t
JOIN modules m ON t.module_id = m.id
JOIN packages p ON m.package_id = p.id
WHERE LOWER(t.name) LIKE LOWER('%element%')
ORDER BY t.name

-- Search for values
SELECT v.name, v.signature, v.param_count, m.qualified_name as module_name, p.name as package_name
FROM "values" v
JOIN modules m ON v.module_id = m.id
JOIN packages p ON m.package_id = p.id
WHERE LOWER(v.name) LIKE LOWER('%useState%')
ORDER BY v.name
```

See `.cursor/rules/rescript-db-schema.mdc` for complete schema documentation and more example queries.

### Use with MCP clients

To use the MCP server with an LLM client (like Claude Desktop or Cursor), add it to your MCP configuration:

```json
{
  "mcpServers": {
    "rescript": {
      "command": "bun",
      "args": ["mcp/index.js", "--stdio"],
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

The server provides two tools:

- `sync_rescript_database` - Sync the ReScript database with the current project. Compiles ReScript code and indexes all modules, types, and values. Returns sync statistics.
- `query_rescript_database` - Execute raw SQL SELECT queries against the database. Only SELECT queries are allowed for security. Returns query results as an array of row objects.

**Important Notes:**

- The `query_rescript_database` tool does NOT accept SQL parameters. All values must be inlined directly in the SQL query string.
- The database schema and example queries are documented in `.cursor/rules/rescript-db-schema.mdc`.
- The database is automatically created and synced on first tool call. For manual syncs, use the `sync_rescript_database` tool or run `bun mcp/index.js --sync` from your project root.

### Testing with Inspector

You can test the MCP server interactively using the inspector:

```shell
bun start
```

This runs the MCP server with the inspector, allowing you to test tool calls and see responses in a web interface.
