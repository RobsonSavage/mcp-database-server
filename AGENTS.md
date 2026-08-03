# Agent Instructions

## Build & Deploy

When the request includes pushing to main, perform these steps before pushing:

1. If there are code changes (not just docs/config), bump the patch version in `package.json` via `npm version patch --no-git-tag-version`
2. `npm pack` to build the tarball
2. Copy the new `.tgz` into `installation/`, replacing the old one
3. Update `installation/INSTALL.md` if the version number or install steps changed
4. Update `installation/rs-database-connections.template.json` to reflect the current config schema supported by the program — any new or changed settings should appear as samples with placeholder values; never include real passwords
5. Check the install topology before reinstalling globally. On this workstation
   `%APPDATA%\npm\node_modules\@robsonsavage\database-server` is a directory
   junction into this repo, so `npm run build` alone is the deploy and a Claude
   Code restart is the only cutover. `npm install -g <tgz>` would replace the
   junction with a real copy and end the instant-rebuild loop (restoring it
   needs `npm link`). Run it only when you intend to change the topology;
   otherwise the tarball in `installation/` is an archival snapshot for other
   machines, not a local install step.
6. Stage the installation folder changes along with the source changes
7. Then push
