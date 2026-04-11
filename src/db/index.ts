import { AsyncLocalStorage } from 'node:async_hooks';
import { DbAdapter, createDbAdapter } from './adapter.js';
import { ConnectionRegistry, ResolvedConnection } from '../config/loader.js';
import { SqlServerAdapter } from './sqlserver-adapter.js';

/**
 * Single-connection singleton (legacy --server/--database/--user/--password mode).
 * Used when the MCP is launched without --config.
 */
let dbAdapter: DbAdapter | null = null;

/**
 * Multi-connection registry (new --config mode). When non-null, tool calls are
 * routed through `resolveAdapter` instead of the singleton.
 */
let registry: ConnectionRegistry | null = null;

/** Lazily-initialized pool per resolved leaf key (`server/db/login`). */
const pools = new Map<string, SqlServerAdapter>();

/** Process-level sticky selection set by the `use_connection` tool. */
let sticky: { server?: string; database?: string; login?: string } = {};

/**
 * Per-tool-call override. Tool handlers set this via `runWithOverride` so tools
 * can call dbAll/dbRun/dbExec without knowing which adapter they're routed to.
 */
interface CallContext {
  server?: string;
  database?: string;
  login?: string;
}
const callContext = new AsyncLocalStorage<CallContext>();

/* ------------------------------------------------------------------------- */
/* Legacy single-adapter mode                                                */
/* ------------------------------------------------------------------------- */

/**
 * Legacy init — a single adapter backed by one connection. Used by the existing
 * --sqlserver --server X --database Y CLI flow and by all non-SQL-Server databases.
 */
export async function initDatabase(connectionInfo: any, dbType: string = 'sqlite'): Promise<void> {
  try {
    if (typeof connectionInfo === 'string') {
      connectionInfo = { path: connectionInfo };
    }
    dbAdapter = createDbAdapter(dbType, connectionInfo);
    await dbAdapter.init();
  } catch (error) {
    throw new Error(`Failed to initialize database: ${(error as Error).message}`);
  }
}

/* ------------------------------------------------------------------------- */
/* Multi-connection mode                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Initialize multi-connection mode. The registry is stored but no pools are
 * opened — pools are created lazily the first time each leaf is used, so an
 * unused connection costs nothing at startup.
 */
export async function initDatabasePool(reg: ConnectionRegistry): Promise<void> {
  registry = reg;
  // Eagerly resolve the default triple to fail fast on obviously-broken configs.
  reg.resolve();
}

export function getRegistry(): ConnectionRegistry | null {
  return registry;
}

export function isMultiConnectionMode(): boolean {
  return registry !== null;
}

export function setStickyConnection(selection: { server?: string; database?: string; login?: string }): ResolvedConnection {
  if (!registry) {
    throw new Error("use_connection is only available in --config mode.");
  }
  const resolved = registry.resolve(selection.server, selection.database, selection.login);
  sticky = {
    server: resolved.serverName,
    database: resolved.databaseName,
    login: resolved.loginName,
  };
  return resolved;
}

export function getStickyConnection(): ResolvedConnection | null {
  if (!registry) return null;
  return registry.resolve(sticky.server, sticky.database, sticky.login);
}

/**
 * Runs `fn` with an ambient override so that any dbAll/dbRun/dbExec calls inside
 * it target the requested (server, database, login) leaf. Used by handleToolCall
 * to scope a single MCP tool invocation to a specific connection.
 */
export function runWithOverride<T>(override: CallContext, fn: () => Promise<T>): Promise<T> {
  return callContext.run(override, fn);
}

/**
 * Resolve the current adapter based on (in order of precedence):
 *   1. Per-call override set via `runWithOverride` (tool-call parameters)
 *   2. Sticky selection from `use_connection`
 *   3. The registry's default leaf
 *
 * Lazily opens and caches a SqlServerAdapter per resolved leaf key.
 */
async function resolveMultiAdapter(): Promise<DbAdapter> {
  if (!registry) {
    throw new Error("Multi-connection mode not initialized.");
  }

  const override = callContext.getStore() ?? {};
  const effective = {
    server: override.server ?? sticky.server,
    database: override.database ?? sticky.database,
    login: override.login ?? sticky.login,
  };

  const resolved = registry.resolve(effective.server, effective.database, effective.login);

  let adapter = pools.get(resolved.key);
  if (!adapter) {
    adapter = new SqlServerAdapter({
      server: resolved.server,
      database: resolved.database,
      user: resolved.user,
      password: resolved.password,
      port: resolved.port,
      trustServerCertificate: resolved.trustServerCertificate,
      trustedConnection: resolved.trustedConnection,
      options: resolved.options,
    });
    await adapter.init();
    pools.set(resolved.key, adapter);
  }
  return adapter;
}

async function currentAdapter(): Promise<DbAdapter> {
  if (registry) {
    return resolveMultiAdapter();
  }
  if (!dbAdapter) {
    throw new Error("Database not initialized");
  }
  return dbAdapter;
}

/* ------------------------------------------------------------------------- */
/* Public query surface (unchanged signatures)                                */
/* ------------------------------------------------------------------------- */

export async function dbAll(query: string, params: any[] = []): Promise<any[]> {
  const adapter = await currentAdapter();
  return adapter.all(query, params);
}

export async function dbRun(query: string, params: any[] = []): Promise<{ changes: number, lastID: number }> {
  const adapter = await currentAdapter();
  return adapter.run(query, params);
}

export async function dbExec(query: string): Promise<void> {
  const adapter = await currentAdapter();
  return adapter.exec(query);
}

export async function closeDatabase(): Promise<void> {
  if (dbAdapter) {
    await dbAdapter.close();
    dbAdapter = null;
  }
  for (const pool of pools.values()) {
    try {
      await pool.close();
    } catch {
      // Best-effort shutdown — individual pool failures must not block the rest.
    }
  }
  pools.clear();
  registry = null;
}

export async function getDatabaseMetadata(): Promise<{ name: string, type: string, path?: string, server?: string, database?: string }> {
  const adapter = await currentAdapter();
  return adapter.getMetadata();
}

export async function getListTablesQuery(): Promise<string> {
  const adapter = await currentAdapter();
  return adapter.getListTablesQuery();
}

export async function getDescribeTableQuery(tableName: string): Promise<string> {
  const adapter = await currentAdapter();
  return adapter.getDescribeTableQuery(tableName);
}
