# Installing `rs-database-server` on another workstation

This folder contains everything needed to install the RobsonSavage fork of
`@executeautomation/database-server` as a user-scope MCP server in Claude Code
on a new Windows machine.

## Contents

| File | Purpose |
|---|---|
| `robsonsavage-database-server-2.0.2.tgz` | npm tarball built via `npm pack` — installs the `rs-database-server` global binary |
| `rs-database-connections.template.json` | Sanitized connection registry template — populate with real values on the target machine |
| `INSTALL.md` | This file |

## Prerequisites on the target machine

- **Node.js 18+** (check with `node --version`)
- **Claude Code** installed and on `PATH` (check with `claude --version`)
- **Internet access** during `npm install` — pulls native deps (`mssql`, `msnodesqlv8`, `sqlite3`, `pg`, `mysql2`) from the npm registry
- **Architecture:** x64 Windows (the native deps ship prebuilt binaries for this target)

## Install steps

Run the following from a shell (Git Bash, PowerShell, or cmd — paths below use
bash-style `$USERPROFILE`; adjust if your shell expands variables differently).

### 1. Install the CLI globally from the tarball

```bash
npm install -g ./robsonsavage-database-server-2.0.2.tgz
```

This installs the `rs-database-server` (and `ea-database-server`) binaries to
`%APPDATA%\npm\`. Verify:

```bash
where rs-database-server
```

### 2. Place the connection registry at the expected path

```bash
mkdir -p "$USERPROFILE/.claude"
cp rs-database-connections.template.json "$USERPROFILE/.claude/rs-database-connections.json"
```

Then **edit** `%USERPROFILE%\.claude\rs-database-connections.json`:

- Replace `RS-SQL01` (and similar) with the real SQL Server hostname
- Credentials use **env-var indirection** — `user` and `password` strings of the
  form `${env:VAR_NAME}` resolve from `process.env` at connect time, so the JSON
  itself never contains plaintext secrets. See the "Credential env vars" section
  below for naming and how to populate them on Windows.
- Or delete the SQL login entries and keep a `trustedConnection: true` login for
  Windows integrated authentication — no credentials needed on disk at all.
- Keep exactly one `default: true` at each level that has siblings (server,
  database, login). Single-entry levels may omit `default` entirely.
- `connectionTimeoutMs` (optional, milliseconds) controls how long the driver waits
  for a connection to be established. Default: **15000** (15 seconds). Set it at
  server level to apply to all logins, or override per login. Example:
  `"connectionTimeoutMs": 30000` for 30 seconds.
- `multipleActiveResultSets` (optional, boolean) enables MARS on the connection.
  Default: **true**. For Windows auth (`trustedConnection: true`) this is injected
  into the ODBC connection string; for SQL auth (Tedious) the pool handles
  concurrency natively but the flag is stored for consistency.
- `driver` (optional, string) specifies the ODBC driver name used by
  `msnodesqlv8` for Windows integrated auth connections. Only relevant when
  `trustedConnection: true` — SQL auth uses Tedious (pure JS) and ignores this.
  Default: **`ODBC Driver 18 for SQL Server`**. The `mssql` library's built-in
  default is `SQL Server Native Client 11.0`, which is rarely installed on modern
  machines — this override fixes the common "Data source name not found" error.
  Set at server level or override per login. Example:
  `"driver": "ODBC Driver 17 for SQL Server"` for older driver installs.

### Credential env vars

Any `user` or `password` string of the form `${env:VAR_NAME}` is resolved from
`process.env` when the connection is opened. The MCP inherits env vars from the
process that spawns it (Claude Code), which inherits from your user session — so
setting them persistently via `setx` (or the System Properties → Environment
Variables UI) is enough.

The shipped template uses these names:

| Variable | Used by |
|---|---|
| `RS_SQL01_READONLY_USER` / `RS_SQL01_READONLY_PASSWORD` | `RS-SQL01` / `QMaster` + `BugTracker` readonly logins |
| `RS_SQL01_QMASTER_USER` / `RS_SQL01_QMASTER_PASSWORD` | `RS-SQL01` / `QMaster` / `QMaster` login |
| `RS_SQL01_BUGTRACKER_USER` / `RS_SQL01_BUGTRACKER_PASSWORD` | `RS-SQL01` / `BugTracker` / `BugTracker` login |

Set them persistently (PowerShell, new shell required to pick up):

```powershell
setx RS_SQL01_READONLY_USER "readonly"
setx RS_SQL01_READONLY_PASSWORD "<secret>"
```

Multiple logins can share a single var pair by pointing at the same `${env:...}`
reference — useful when one SQL account (e.g. `readonly`) is reused across
several databases on the same server. Conversely, distinct logins under the
same database just reference distinct var names.

Missing/empty env vars throw a clear error at connect time naming both the
registry path (`servers['X'].databases['Y'].logins['Z'].password`) and the
unresolved variable.

### 3. Register the MCP with Claude Code (user scope)

```bash
claude mcp add rs-database-server --scope user -- rs-database-server --sqlserver --config "$USERPROFILE/.claude/rs-database-connections.json"
```

### 4. Verify it connected

```bash
claude mcp list
```

Look for:

```
rs-database-server: rs-database-server --sqlserver --config ... - ✓ Connected
```

If you see `✗ Failed to connect`, the config file is the usual suspect:

- Invalid JSON — `node -e "JSON.parse(require('fs').readFileSync('<path>','utf8'))"`
- Missing `default: true` at a level with siblings
- A SQL login set without `trustedConnection`, `user`, or `password`
- Wrong server/database name — SQL Server refuses the handshake
- TLS handshake failure — set `trustServerCertificate: true` on the server entry
  for self-signed intranet certs

## Uninstalling

```bash
claude mcp remove rs-database-server --scope user
npm uninstall -g @robsonsavage/database-server
```

The scoped package name (`@robsonsavage/database-server`) is what npm registered,
even though the binary is called `rs-database-server`.

## Updating to a newer build

Replace the `.tgz` in this folder with a freshly built one (`npm run build &&
npm pack` in the source repo), then on the target machine:

```bash
npm install -g ./robsonsavage-database-server-<new-version>.tgz
```

The MCP registration in `~/.claude.json` does not need to change — it points at
the binary name, which npm keeps pointing at the newest installed version. Just
restart Claude Code to pick up the new binary.

## Security notes

- **Never commit a populated `rs-database-connections.json`.** The template in
  this folder uses `${env:...}` references only, which is why it is safe to ship.
- **Do not put real credentials on the thumb drive.** Carry the template; set
  the env vars on the target machine via `setx` or the System Properties UI.
- **Never embed plaintext passwords in the JSON.** Use `${env:VAR}` indirection
  — the loader will refuse to fall back silently if a referenced var is unset.
- The registry file lives in `%USERPROFILE%\.claude\`, readable by the
  current Windows user only. Treat it like `.pgpass` or `~/.aws/credentials`.
- Prefer `trustedConnection: true` (Windows integrated auth) over embedded
  SQL logins wherever the target database supports it — no plaintext passwords
  on disk.
