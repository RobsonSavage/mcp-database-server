# MCP Database Server &mdash; Multi-Connection Edition

> **`@robsonsavage/database-server`** &mdash; a fork of [`@executeautomation/database-server`](https://github.com/executeautomation/mcp-database-server) built for multi-database Windows environments.
>
> - **Windows integrated authentication** for SQL Server via `msnodesqlv8` &mdash; connect as the current Windows user with no credentials on disk.
> - **Multi-connection registry (SQL Server only)** &mdash; one MCP entry serves many SQL Server instances, databases, and logins. Route tool calls with `use_connection` instead of spawning one MCP per combination.
> - **Env-var credential indirection** &mdash; `${env:VAR}` references in the registry JSON resolve at connect time so plaintext secrets never touch config files.

Supports **SQLite**, **SQL Server**, **PostgreSQL**, and **MySQL**.

## Quick start (SQL Server)

### Install globally

```bash
npm install -g @robsonsavage/database-server
```

### Register with Claude Code (user scope)

```bash
claude mcp add rs-database-server --scope user -- \
  rs-database-server --sqlserver --config "$HOME/.claude/rs-database-connections.json"
```

### Register with Claude Desktop/CLI

Add to your Claude Desktop config (`%APPDATA%\Claude\claude_desktop_config.json` on Windows, `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "rs-database-server": {
      "type": "stdio",
      "command": "rs-database-server",
      "args": [
        "--sqlserver",
        "--config", "C:/Users/you/.claude/rs-database-connections.json"
      ]
    }
  }
}
```

## Connection registry (SQL Server only)

The connection registry is **exclusive to SQL Server**. SQLite, PostgreSQL, and MySQL each support a single database per MCP process using the legacy CLI flags described in [Legacy single-connection mode](#legacy-single-connection-mode). To use multiple databases with those engines, register a separate MCP entry for each.

The `--config` flag loads a JSON file that defines servers, databases, and logins in a single tree. It requires `--sqlserver` and replaces the legacy `--server / --database / --user / --password` CLI flags (the two styles are mutually exclusive).

### Registry shape

```json
{
  "servers": {
    "PROD-SQL01": {
      "default": true,
      "trustServerCertificate": false,
      "connectionTimeoutMs": 15000,
      "multipleActiveResultSets": true,
      "databases": {
        "AppDB": {
          "default": true,
          "logins": {
            "readonly": {
              "default": true,
              "user": "${env:PROD_SQL01_READONLY_USER}",
              "password": "${env:PROD_SQL01_READONLY_PASSWORD}"
            },
            "admin": {
              "user": "${env:PROD_SQL01_ADMIN_USER}",
              "password": "${env:PROD_SQL01_ADMIN_PASSWORD}"
            }
          }
        },
        "Analytics": {
          "logins": {
            "readonly": {
              "default": true,
              "user": "${env:PROD_SQL01_READONLY_USER}",
              "password": "${env:PROD_SQL01_READONLY_PASSWORD}"
            }
          }
        }
      }
    },
    "localhost": {
      "trustServerCertificate": true,
      "connectionTimeoutMs": 15000,
      "multipleActiveResultSets": true,
      "driver": "ODBC Driver 18 for SQL Server",
      "databases": {
        "DevDB": {
          "logins": {
            "windows": {
              "trustedConnection": true
            }
          }
        }
      }
    }
  }
}
```

### Server-level properties

| Property | Type | Default | Description |
|---|---|---|---|
| `default` | boolean | &mdash; | Marks this server as the default when the caller omits `server` |
| `trustServerCertificate` | boolean | `false` | Accept self-signed TLS certs (set `true` for dev/intranet servers) |
| `connectionTimeoutMs` | number | `15000` | Connection timeout in milliseconds |
| `multipleActiveResultSets` | boolean | `true` | Enable MARS. For Windows auth this is injected into the ODBC connection string; for SQL auth Tedious handles concurrency natively |
| `driver` | string | `ODBC Driver 18 for SQL Server` | ODBC driver name for `msnodesqlv8` (Windows auth only). The `mssql` library defaults to `SQL Server Native Client 11.0` which is rarely installed on modern machines &mdash; this override prevents the "Data source name not found" error. Ignored for SQL auth (Tedious). Common values: `ODBC Driver 18 for SQL Server`, `ODBC Driver 17 for SQL Server` |
| `port` | number | `1433` | SQL Server port |
| `options` | object | &mdash; | Additional `mssql` config options passed through verbatim |

All server-level properties cascade to logins underneath unless overridden at the login level.

### Login-level properties

| Property | Type | Description |
|---|---|---|
| `default` | boolean | Marks this login as the default for its database |
| `user` | string | SQL auth username. Supports `${env:VAR}` indirection |
| `password` | string | SQL auth password. Supports `${env:VAR}` indirection |
| `trustedConnection` | boolean | Use Windows integrated auth (SSPI). Omit `user`/`password` |
| `driver` | string | Override the server-level ODBC driver for this login |
| `connectionTimeoutMs` | number | Override the server-level timeout for this login |
| `multipleActiveResultSets` | boolean | Override MARS for this login |
| `trustServerCertificate` | boolean | Override TLS cert validation for this login |
| `port` | number | Override port for this login |
| `options` | object | Merge with server-level options |

### Defaults resolution

Three independent default levels, each selected with `"default": true`:

| Level | Used when the caller omits... |
|---|---|
| Server | `server` |
| Database | `database` |
| Login | `login` |

Exactly one default is required at each level with more than one sibling. Single-child levels don't need the flag. Zero or multiple defaults at a level with siblings causes a startup error with a precise path.

### Auth types

- **SQL auth**: set `user` and `password`. Uses the default `mssql` entry (Tedious driver, pure JS).
- **Windows integrated auth**: set `"trustedConnection": true` and omit `user`/`password`. Uses `mssql/msnodesqlv8`, connecting as the current Windows user via SSPI. Requires the optional `msnodesqlv8` package and an ODBC Driver for SQL Server.

### Credential env-var indirection

Any `user` or `password` value of the form `${env:VAR_NAME}` is resolved from `process.env` at connect time. The MCP inherits env vars from its parent process (Claude Code or Claude Desktop), which inherits from your user session.

Set env vars persistently on Windows:

```powershell
setx PROD_SQL01_READONLY_USER "readonly"
setx PROD_SQL01_READONLY_PASSWORD "<secret>"
```

Multiple logins can share a single env-var pair if the SQL account is legitimately shared across databases. Missing or empty env vars produce a clear error naming both the registry path and the unresolved variable.

## Legacy single-connection mode

The original CLI flags still work for simple single-database setups. These are mutually exclusive with `--config`.

### SQLite

```bash
rs-database-server /path/to/database.db
```

### SQL Server

```bash
rs-database-server --sqlserver --server <host> --database <db> [--user <user> --password <pass>] [--port 1433]
```

Omit `--user`/`--password` for Windows integrated auth.

### PostgreSQL

```bash
rs-database-server --postgresql --host <host> --database <db> [--user <user> --password <pass>] [--port 5432] [--ssl true]
```

### MySQL

```bash
rs-database-server --mysql --host <host> --database <db> [--user <user> --password <pass>] [--port 3306]
```

#### AWS IAM Authentication (MySQL)

```bash
rs-database-server --mysql --aws-iam-auth --host <rds-endpoint> --database <db> --user <iam-user> --aws-region <region>
```

Requires AWS credentials via `aws configure`, environment variables, or IAM role. SSL is enabled automatically.

## Tools

| Tool | Description |
|---|---|
| `read_query` | Execute SELECT queries |
| `write_query` | Execute INSERT, UPDATE, or DELETE queries |
| `create_table` | Create new tables |
| `alter_table` | Modify existing table schema |
| `drop_table` | Remove a table (requires `confirm: true`) |
| `list_tables` | List all tables in the database |
| `describe_table` | View schema information for a table |
| `export_query` | Export results as CSV or JSON |
| `execute_ddl` | Execute a single `CREATE`/`ALTER`/`DROP` statement for procedures, functions, views, triggers, indexes, etc. **Only registered when the server is started with `ALLOW_DDL=true`**, and in registry mode only runs against servers whose config has `"allowDdl": true`. Not intended for table DDL &mdash; use `create_table`/`alter_table`/`drop_table` for those. `GO` batch separators are not supported &mdash; send one statement per call. |

In registry mode (`--config`), every tool gains three optional parameters: `server`, `database`, `login`. Missing levels fall through to the sticky connection (set by `use_connection`), then to registry defaults.

### Enabling `execute_ddl`

Two gates must both be satisfied:

1. Launch the server with `ALLOW_DDL=true` in its environment. Without this the tool is not even registered.
2. In registry mode, set `"allowDdl": true` on the server entry you want to permit. Servers without the flag reject DDL even when the env var is set &mdash; typical setup is `allowDdl: true` on `localhost` only, leaving shared/production servers locked.

Two additional tools in registry mode:

| Tool | Description |
|---|---|
| `list_connections` | Returns the full registry tree with default markers and auth type per leaf. Never emits passwords. |
| `use_connection` | Pins a `(server, database, login)` triple as the sticky connection for subsequent calls. Per-tool overrides still win for a single call. |

### Resolution examples

Given the registry above:

- `use_connection({ server: "PROD-SQL01", database: "AppDB", login: "readonly" })` &mdash; explicit triple
- `use_connection({ database: "Analytics" })` &mdash; default server `PROD-SQL01`, default login `readonly`
- `read_query({ query: "SELECT ...", server: "localhost" })` &mdash; one-off override without changing sticky

### Pool lifecycle

Each resolved `(server, database, login)` leaf gets a dedicated connection pool, opened lazily on first use and reused across tool calls. Unused leaves cost nothing at startup.

## Requirements

- **Node.js 18+**
- **SQL Server**: SQL Server 2012 or later
- **PostgreSQL**: PostgreSQL 9.5 or later
- **Windows integrated auth**: the optional `msnodesqlv8` package (installed automatically as an optionalDependency) plus a Microsoft ODBC Driver for SQL Server (Driver 17 or 18)

## Thumb-drive deployment

The `installation/` folder contains a tarball, template config, and step-by-step instructions for installing on an air-gapped or new workstation. See [`installation/INSTALL.md`](installation/INSTALL.md).

## Development

```bash
npm run dev      # build + run
npm run watch    # rebuild on changes
npm test         # run tests
```

## License

MIT
