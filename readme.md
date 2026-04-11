[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/executeautomation-mcp-database-server-badge.png)](https://mseep.ai/app/executeautomation-mcp-database-server)

# MCP Database Server

> **RobsonSavage fork (`@robsonsavage/database-server`)**
> Extends the upstream [`@executeautomation/database-server`](https://github.com/executeautomation/mcp-database-server) with two features targeted at multi-database Windows environments:
>
> 1. **True Windows integrated authentication** for SQL Server via `msnodesqlv8` — connect as the current Windows user with no credentials in config.
> 2. **Multi-connection registry mode** — register a single MCP entry that holds many servers/databases/logins, then route tool calls with `"use X on Y with Z"` addressing instead of spawning one MCP per combination.
>
> See **[SQL Server multi-connection mode](#sql-server-multi-connection-mode)** below.

This MCP (Model Context Protocol) server provides database access capabilities to Claude, supporting SQLite, SQL Server, PostgreSQL, and MySQL databases.

## Installation

1. Clone the repository:
```
git clone https://github.com/executeautomation/mcp-database-server.git
cd mcp-database-server
```

2. Install dependencies:
```
npm install
```

3. Build the project:
```
npm run build
```

## Usage Options

There are two ways to use this MCP server with Claude:

1. **Direct usage**: Install the package globally and use it directly
2. **Local development**: Run from your local development environment

### Direct Usage with NPM Package

The easiest way to use this MCP server is by installing it globally:

```bash
npm install -g @executeautomation/database-server
```

This allows you to use the server directly without building it locally.

### Local Development Setup

If you want to modify the code or run from your local environment:

1. Clone and build the repository as shown in the Installation section
2. Run the server using the commands in the Usage section below

## Usage

### SQLite Database

To use with an SQLite database:

```
node dist/src/index.js /path/to/your/database.db
```

### SQL Server Database

To use with a SQL Server database:

```
node dist/src/index.js --sqlserver --server <server-name> --database <database-name> [--user <username> --password <password>]
```

Required parameters:
- `--server`: SQL Server host name or IP address
- `--database`: Name of the database

Optional parameters:
- `--user`: Username for SQL Server authentication (if not provided, Windows Authentication will be used)
- `--password`: Password for SQL Server authentication
- `--port`: Port number (default: 1433)

### PostgreSQL Database

To use with a PostgreSQL database:

```
node dist/src/index.js --postgresql --host <host-name> --database <database-name> [--user <username> --password <password>]
```

Required parameters:
- `--host`: PostgreSQL host name or IP address
- `--database`: Name of the database

Optional parameters:
- `--user`: Username for PostgreSQL authentication
- `--password`: Password for PostgreSQL authentication
- `--port`: Port number (default: 5432)
- `--ssl`: Enable SSL connection (true/false)
- `--connection-timeout`: Connection timeout in milliseconds (default: 30000)

### MySQL Database

#### Standard Authentication

To use with a MySQL database:

```
node dist/src/index.js --mysql --host <host-name> --database <database-name> --port <port> [--user <username> --password <password>]
```

Required parameters:
- `--host`: MySQL host name or IP address
- `--database`: Name of the database
- `--port`: Port number (default: 3306)

Optional parameters:
- `--user`: Username for MySQL authentication
- `--password`: Password for MySQL authentication
- `--ssl`: Enable SSL connection (true/false or object)
- `--connection-timeout`: Connection timeout in milliseconds (default: 30000)

#### AWS IAM Authentication

For Amazon RDS MySQL instances with IAM database authentication:

**Prerequisites:**
- AWS credentials must be configured (the RDS Signer uses the default credential provider chain)
- Configure using one of these methods:
  - `aws configure` (uses default profile)
  - `AWS_PROFILE=myprofile` environment variable
  - `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` environment variables
  - IAM roles (if running on EC2)

```
node dist/src/index.js --mysql --aws-iam-auth --host <rds-endpoint> --database <database-name> --user <aws-username> --aws-region <region>
```

Required parameters:
- `--host`: RDS endpoint hostname
- `--database`: Name of the database
- `--aws-iam-auth`: Enable AWS IAM authentication
- `--user`: AWS IAM username (also the database user)
- `--aws-region`: AWS region where RDS instance is located

Note: SSL is automatically enabled for AWS IAM authentication

## Configuring Claude Desktop

### Direct Usage Configuration

If you installed the package globally, configure Claude Desktop with:

```json
{
  "mcpServers": {
    "sqlite": {
      "command": "npx",
      "args": [
        "-y",
        "@executeautomation/database-server",
        "/path/to/your/database.db"
      ]
    },
    "sqlserver": {
      "command": "npx",
      "args": [
        "-y",
        "@executeautomation/database-server",
        "--sqlserver",
        "--server", "your-server-name",
        "--database", "your-database-name",
        "--user", "your-username",
        "--password", "your-password"
      ]
    },
    "postgresql": {
      "command": "npx",
      "args": [
        "-y",
        "@executeautomation/database-server",
        "--postgresql",
        "--host", "your-host-name",
        "--database", "your-database-name",
        "--user", "your-username",
        "--password", "your-password"
      ]
    },
    "mysql": {
      "command": "npx",
      "args": [
        "-y",
        "@executeautomation/database-server",
        "--mysql",
        "--host", "your-host-name",
        "--database", "your-database-name",
        "--port", "3306",
        "--user", "your-username",
        "--password", "your-password"
      ]
    },
    "mysql-aws": {
      "command": "npx",
      "args": [
        "-y",
        "@executeautomation/database-server",
        "--mysql",
        "--aws-iam-auth",
        "--host", "your-rds-endpoint.region.rds.amazonaws.com",
        "--database", "your-database-name",
        "--user", "your-aws-username",
        "--aws-region", "us-east-1"
      ]
    }
  }
}
```

### Local Development Configuration

For local development, configure Claude Desktop to use your locally built version:

```json
{
  "mcpServers": {
    "sqlite": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-database-server/dist/src/index.js", 
        "/path/to/your/database.db"
      ]
    },
    "sqlserver": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-database-server/dist/src/index.js",
        "--sqlserver",
        "--server", "your-server-name",
        "--database", "your-database-name",
        "--user", "your-username",
        "--password", "your-password"
      ]
    },
    "postgresql": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-database-server/dist/src/index.js",
        "--postgresql",
        "--host", "your-host-name",
        "--database", "your-database-name",
        "--user", "your-username",
        "--password", "your-password"
      ]
    },
    "mysql": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-database-server/dist/src/index.js",
        "--mysql",
        "--host", "your-host-name",
        "--database", "your-database-name",
        "--port", "3306",
        "--user", "your-username",
        "--password", "your-password"
      ]
    },
    "mysql-aws": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-database-server/dist/src/index.js",
        "--mysql",
        "--aws-iam-auth",
        "--host", "your-rds-endpoint.region.rds.amazonaws.com",
        "--database", "your-database-name",
        "--user", "your-aws-username",
        "--aws-region", "us-east-1"
      ]
    }
  }
}
```

The Claude Desktop configuration file is typically located at:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

## Available Database Tools

The MCP Database Server provides the following tools that Claude can use:

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `read_query` | Execute SELECT queries to read data | `query`: SQL SELECT statement |
| `write_query` | Execute INSERT, UPDATE, or DELETE queries | `query`: SQL modification statement |
| `create_table` | Create new tables in the database | `query`: CREATE TABLE statement |
| `alter_table` | Modify existing table schema | `query`: ALTER TABLE statement |
| `drop_table` | Remove a table from the database | `table_name`: Name of table<br>`confirm`: Safety flag (must be true) |
| `list_tables` | Get a list of all tables | None |
| `describe_table` | View schema information for a table | `table_name`: Name of table |
| `export_query` | Export query results as CSV/JSON | `query`: SQL SELECT statement<br>`format`: "csv" or "json" |
| `append_insight` | Add a business insight to memo | `insight`: Text of insight |
| `list_insights` | List all business insights | None |

For practical examples of how to use these tools with Claude, see [Usage Examples](docs/usage-examples.md).

## Additional Documentation

- [SQL Server Setup Guide](docs/sql-server-setup.md): Details on connecting to SQL Server databases
- [PostgreSQL Setup Guide](docs/postgresql-setup.md): Details on connecting to PostgreSQL databases
- [Usage Examples](docs/usage-examples.md): Example queries and commands to use with Claude

## Development

To run the server in development mode:

```
npm run dev
```

To watch for changes during development:

```
npm run watch
```

## Requirements

- Node.js 18+
- For SQL Server connectivity: SQL Server 2012 or later
- For PostgreSQL connectivity: PostgreSQL 9.5 or later
- For **SQL Server Windows integrated authentication**: the optional `msnodesqlv8` package (installed automatically as an optionalDependency if your machine can build it) plus a Microsoft ODBC Driver for SQL Server (e.g. "ODBC Driver 18 for SQL Server")

## SQL Server multi-connection mode

In addition to the legacy `--server / --database / --user / --password` CLI flags, the SQL Server adapter supports a **connection registry** loaded from a JSON file. This lets one MCP entry hold many (server, database, login) combinations and route each tool call to the right one.

### Launch it

```json
"sql": {
  "command": "cmd",
  "args": [
    "/c", "npx", "-y", "@robsonsavage/database-server",
    "--sqlserver",
    "--config", "C:/Users/you/.mcp-db-connections.json"
  ]
}
```

`--config` is mutually exclusive with `--server`/`--database`/`--user`/`--password`. Mix them and startup fails fast.

### Registry file shape

```json
{
  "servers": {
    "RS-SQL01": {
      "trustServerCertificate": true,
      "default": true,
      "databases": {
        "QMaster": {
          "default": true,
          "logins": {
            "readonly": {
              "user": "readonly",
              "password": "secret",
              "default": true
            },
            "sa": { "user": "sa", "password": "secret" }
          }
        },
        "BugTracker": {
          "logins": {
            "readonly": { "user": "readonly", "password": "secret", "default": true }
          }
        }
      }
    },
    "(local)": {
      "trustServerCertificate": true,
      "databases": {
        "x26QMaster": {
          "logins": {
            "windows": { "trustedConnection": true, "default": true }
          }
        }
      }
    }
  }
}
```

### Defaults

Three independent default levels, each picked with `"default": true`:

| Level | Used when the caller omits... |
|------|------------------------------|
| `servers["X"].default` | `server` |
| `servers["X"].databases["Y"].default` | `database` |
| `servers["X"].databases["Y"].logins["Z"].default` | `login` |

Exactly one default is required at each level that has more than one sibling. Single-child levels don't need the flag. Zero or multiple defaults at a level with siblings → startup fails with a precise path.

### Auth types per login

- **SQL auth**: set `user` and `password`. Uses the default `mssql` entry (Tedious driver, pure JS).
- **Windows integrated auth**: set `"trustedConnection": true` and omit `user`/`password`. Uses `mssql/msnodesqlv8`, connecting as the **current Windows user** via SSPI. Requires the optional `msnodesqlv8` package and a Microsoft ODBC Driver for SQL Server.

Inherited fields: `trustServerCertificate`, `port`, and `options` set at the `server` level cascade to children unless overridden at the database or login level.

### Tools added in registry mode

When `--config` is in use, every existing tool (`read_query`, `write_query`, `list_tables`, `describe_table`, `export_query`, `create_table`, `alter_table`, `drop_table`, `append_insight`, `list_insights`) gains three **optional** parameters: `server`, `database`, `login`. Any combination can be supplied; missing levels fall through to the sticky connection (set by `use_connection`) and then to the registry defaults.

Two **new** tools:

- **`list_connections`** — returns the full registry tree with default markers and the auth type per leaf. Never emits passwords.
- **`use_connection({ server?, database?, login? })`** — resolves the triple to a concrete leaf and pins it as the sticky connection for subsequent tool calls. Per-tool overrides still win over sticky for a single call.

### Example resolution

Given the registry above:

- *"use QMaster on RS-SQL01 with readonly"* → `RS-SQL01 / QMaster / readonly`
- *"use BugTracker"* → default server `RS-SQL01` → `BugTracker` → default login `readonly`
- *"use x26QMaster"* → default server is `RS-SQL01`, which has no `x26QMaster` database → error listing available databases on `RS-SQL01`. Explicitness is required; there is no cross-server fuzzy matching.

### Pool lifecycle

Each resolved `(server, database, login)` leaf gets a dedicated connection pool, opened lazily on first use and reused across tool calls. Unused leaves cost nothing at startup.

## License

MIT
