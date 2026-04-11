# Installing `rs-database-server` on another workstation

This folder contains everything needed to install the RobsonSavage fork of
`@executeautomation/database-server` as a user-scope MCP server in Claude Code
on a new Windows machine.

## Contents

| File | Purpose |
|---|---|
| `robsonsavage-database-server-2.0.0.tgz` | npm tarball built via `npm pack` — installs the `rs-database-server` global binary |
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
npm install -g ./robsonsavage-database-server-2.0.0.tgz
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

- Replace `YOUR-SQL-HOST` with the real SQL Server hostname
- Replace `REPLACE_WITH_USERNAME` / `REPLACE_WITH_PASSWORD` with real credentials,
  **or** delete the `sql-readonly` login and keep the `windows-auth` login for
  Windows integrated authentication (`trustedConnection: true`)
- Remove the `_comment` and `_schema` illustrative keys
- Keep exactly one `default: true` at each level that has siblings (server,
  database, login). Single-entry levels may omit `default` entirely.

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
  this folder has placeholders only, which is why it is safe to ship.
- **Do not put real credentials on the thumb drive.** Carry the template, type
  the secrets on the target machine.
- The registry file lives in `%USERPROFILE%\.claude\`, readable by the
  current Windows user only. Treat it like `.pgpass` or `~/.aws/credentials`.
- Prefer `trustedConnection: true` (Windows integrated auth) over embedded
  SQL logins wherever the target database supports it — no plaintext passwords
  on disk.
