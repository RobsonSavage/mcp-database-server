import {
  dbAll,
  getListTablesQuery,
  getDescribeTableQuery,
  getDatabaseMetadata,
  isMultiConnectionMode,
  getRegistry,
  runWithOverride,
} from '../db/index.js';

const SCHEMA_PATH = 'schema';

/**
 * Build the canonical resource URI for a (server, database, table) triple.
 * We use a file-URL-style form so that the pathname keeps all segments and
 * host carries the server name:
 *   sqlserver://<server>/<database>/<table>/schema
 */
function buildMultiResourceUri(server: string, database: string, table: string): string {
  return `sqlserver://${encodeURIComponent(server)}/${encodeURIComponent(database)}/${encodeURIComponent(table)}/${SCHEMA_PATH}`;
}

/**
 * Parse a multi-connection resource URI back into its routing components.
 * Returns null when the URI has no host (legacy single-connection form).
 */
function parseResourceUri(uri: string): {
  server: string | null;
  database: string | null;
  tableName: string;
} {
  const url = new URL(uri);
  const segments = url.pathname.split('/').filter((s) => s.length > 0);

  if (segments.length < 2 || segments[segments.length - 1] !== SCHEMA_PATH) {
    throw new Error('Invalid resource URI');
  }

  // Last segment is 'schema'; the one before is the table name.
  const tableName = decodeURIComponent(segments[segments.length - 2]);

  // URL.host may be empty for URIs of the form `sqlite:///path/...`.
  const server = url.host ? decodeURIComponent(url.host) : null;

  // In multi-mode URIs we emit:
  //   sqlserver://<server>/<database>/<table>/schema
  // so when a host is present, the first path segment is the database.
  let database: string | null = null;
  if (server && segments.length >= 3) {
    database = decodeURIComponent(segments[0]);
  }

  return { server, database, tableName };
}

/**
 * Handle listing resources request.
 *
 * In multi-connection mode, we emit one resource per (server, database, table)
 * across every leaf in the registry. In single-connection mode, we list the
 * tables of the one active adapter.
 */
export async function handleListResources() {
  try {
    if (isMultiConnectionMode()) {
      return await listResourcesMulti();
    }
    return await listResourcesSingle();
  } catch (error: any) {
    throw new Error(`Error listing resources: ${error.message}`);
  }
}

async function listResourcesSingle() {
  const dbInfo = await getDatabaseMetadata();
  const dbType = dbInfo.type;
  let resourceBaseUrl: URL;

  if (dbType === 'sqlite' && dbInfo.path) {
    resourceBaseUrl = new URL(`sqlite:///${dbInfo.path}`);
  } else if (dbType === 'sqlserver' && dbInfo.server && dbInfo.database) {
    resourceBaseUrl = new URL(`sqlserver://${dbInfo.server}/${dbInfo.database}`);
  } else if (dbType === 'postgresql' && dbInfo.server && dbInfo.database) {
    resourceBaseUrl = new URL(`postgresql://${dbInfo.server}/${dbInfo.database}`);
  } else if (dbType === 'mysql' && dbInfo.server && dbInfo.database) {
    resourceBaseUrl = new URL(`mysql://${dbInfo.server}/${dbInfo.database}`);
  } else {
    resourceBaseUrl = new URL(`db:///database`);
  }

  const query = await getListTablesQuery();
  const result = await dbAll(query);

  return {
    resources: result.map((row: any) => ({
      uri: new URL(`${row.name}/${SCHEMA_PATH}`, resourceBaseUrl).href,
      mimeType: 'application/json',
      name: `"${row.name}" database schema`,
    })),
  };
}

async function listResourcesMulti() {
  const registry = getRegistry();
  if (!registry) {
    // Defensive — should never happen because isMultiConnectionMode() gated us.
    return listResourcesSingle();
  }

  const description = registry.describe();
  const resources: Array<{ uri: string; mimeType: string; name: string }> = [];

  for (const serverEntry of description.servers) {
    for (const dbEntry of serverEntry.databases) {
      // List tables on this specific leaf. runWithOverride routes the
      // subsequent dbAll to the adapter for (server, database) using the
      // default login.
      try {
        const tables: Array<{ name: string }> = await runWithOverride(
          { server: serverEntry.name, database: dbEntry.name },
          async () => {
            const query = await getListTablesQuery();
            return (await dbAll(query)) as Array<{ name: string }>;
          }
        );

        for (const row of tables) {
          const uri = buildMultiResourceUri(serverEntry.name, dbEntry.name, row.name);
          resources.push({
            uri,
            mimeType: 'application/json',
            name: `"${serverEntry.name}/${dbEntry.name}/${row.name}" schema`,
          });
        }
      } catch (err) {
        // A broken or offline leaf must not take out the whole list.
        console.error(
          `[WARN] Failed to list tables for ${serverEntry.name}/${dbEntry.name}: ${(err as Error).message}`
        );
      }
    }
  }

  return { resources };
}

/**
 * Handle reading a specific resource. In multi-connection mode, we pin the
 * read to the (server, database) encoded in the URI — NOT the current sticky —
 * so the MCP resource model stays consistent: a resource URI must always
 * resolve to the same data regardless of what use_connection has been called
 * in the meantime.
 */
export async function handleReadResource(uri: string) {
  try {
    const { server, database, tableName } = parseResourceUri(uri);

    const readBody = async () => {
      const { query, params } = await getDescribeTableQuery(tableName);
      const result = await dbAll(query, params);
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(
              result.map((column: any) => ({
                column_name: column.name,
                data_type: column.type,
              })),
              null,
              2
            ),
          },
        ],
      };
    };

    if (isMultiConnectionMode() && server && database) {
      return await runWithOverride({ server, database }, readBody);
    }
    return await readBody();
  } catch (error: any) {
    throw new Error(`Error reading resource: ${error.message}`);
  }
}
