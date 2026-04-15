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

/**
 * Lazily-initialized pool per resolved leaf key (`server/db/login`).
 * We store a Promise<SqlServerAdapter> (not the adapter itself) so that two
 * concurrent first-use calls share a single in-flight init instead of each
 * constructing its own adapter and orphaning the loser's TCP pool.
 */
const pools = new Map<string, Promise<SqlServerAdapter>>();

/**
 * Process-level sticky selection set by the `use_connection` tool.
 *
 * NOTE ON CONCURRENCY: `sticky` is module-scoped mutable state. The MCP stdio
 * transport is typically single-client-serial, so clients are expected to
 * serialize `use_connection` against subsequent tool calls. If a client fires
 * `use_connection` and `read_query` concurrently without awaiting between them,
 * routing of the read is non-deterministic. `resolveMultiAdapter` snapshots
 * sticky at the very start of each tool call (via local destructuring) so that
 * within a single tool invocation the routing is consistent even if another
 * call mutates sticky mid-flight.
 */
let sticky: { server?: string; database?: string; login?: string; connectionTimeoutMs?: number } = {};

/**
 * Per-tool-call override. Tool handlers set this via `runWithOverride` so tools
 * can call dbAll/dbRun/dbExec without knowing which adapter they're routed to.
 */
interface CallContext {
  server?: string;
  database?: string;
  login?: string;
  connectionTimeoutMs?: number;
}
const callContext = new AsyncLocalStorage<CallContext>();

/**
 * In-flight query tracking for graceful shutdown. Every `dbAll`/`dbRun`/`dbExec`
 * registers its promise here; `closeDatabase` awaits settlement (with a timeout)
 * before closing pools so signal-driven shutdowns don't sever live queries.
 */
const inflight = new Set<Promise<unknown>>();

function trackInflight<T>(p: Promise<T>): Promise<T> {
  inflight.add(p);
  // Use .finally so both success and failure remove the entry. Return the
  // original promise so callers still see the original resolution/rejection.
  p.finally(() => inflight.delete(p)).catch(() => { /* swallow — finally handler only */ });
  return p;
}

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

/**
 * Set the sticky connection. If `reset` is true, the sticky is cleared and the
 * registry default is returned. Otherwise the provided (server, database, login)
 * selection is resolved against the registry and pinned.
 */
export function setStickyConnection(
  selection: { server?: string; database?: string; login?: string; connectionTimeoutMs?: number; reset?: boolean }
): ResolvedConnection {
  if (!registry) {
    throw new Error("use_connection is only available in --config mode.");
  }
  if (selection.reset) {
    sticky = {};
    return registry.resolve();
  }
  const resolved = registry.resolve(selection.server, selection.database, selection.login);
  sticky = {
    server: resolved.serverName,
    database: resolved.databaseName,
    login: resolved.loginName,
    connectionTimeoutMs: selection.connectionTimeoutMs,
  };
  return resolved;
}

/**
 * Resolve the current (override -> sticky -> default) connection without opening
 * a pool. Tools that need to consult connection-level flags (e.g. allowDdl)
 * before dispatching a query call this inside `runWithOverride`.
 */
export function getResolvedConnection(): ResolvedConnection {
  if (!registry) {
    throw new Error("getResolvedConnection is only available in --config mode.");
  }
  const override = callContext.getStore() ?? {};
  return registry.resolve(
    override.server ?? sticky.server,
    override.database ?? sticky.database,
    override.login ?? sticky.login,
  );
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
 * Lazily opens and caches a SqlServerAdapter per resolved leaf key. Uses a
 * Promise-based cache to prevent concurrent-first-use races from creating
 * duplicate adapters.
 */
async function resolveMultiAdapter(): Promise<DbAdapter> {
  if (!registry) {
    throw new Error("Multi-connection mode not initialized.");
  }

  const override = callContext.getStore() ?? {};
  // Snapshot sticky at call entry so concurrent sticky mutation doesn't
  // reroute this in-flight call halfway through.
  const effective = {
    server: override.server ?? sticky.server,
    database: override.database ?? sticky.database,
    login: override.login ?? sticky.login,
    connectionTimeoutMs: override.connectionTimeoutMs ?? sticky.connectionTimeoutMs,
  };

  const resolved = registry.resolve(effective.server, effective.database, effective.login);
  // Runtime timeout override takes precedence over config-file value.
  const effectiveTimeout = effective.connectionTimeoutMs ?? resolved.connectionTimeoutMs;
  // Include timeout in pool key so different timeouts get separate pools.
  const poolKey = effectiveTimeout !== resolved.connectionTimeoutMs
    ? `${resolved.key}:t=${effectiveTimeout}`
    : resolved.key;

  let adapterPromise = pools.get(poolKey);
  if (!adapterPromise) {
    const adapter = new SqlServerAdapter({
      server: resolved.server,
      database: resolved.database,
      user: resolved.user,
      password: resolved.password,
      port: resolved.port,
      connectionTimeoutMs: effectiveTimeout,
      trustServerCertificate: resolved.trustServerCertificate,
      multipleActiveResultSets: resolved.multipleActiveResultSets,
      trustedConnection: resolved.trustedConnection,
      driver: resolved.driver,
      options: resolved.options,
    });
    adapterPromise = adapter.init().then(
      () => adapter,
      (err) => {
        // Failed init must not poison the cache — evict so the next call can retry.
        pools.delete(poolKey);
        throw err;
      }
    );
    pools.set(poolKey, adapterPromise);
  }
  return adapterPromise;
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
  return trackInflight(adapter.all(query, params));
}

export async function dbRun(query: string, params: any[] = []): Promise<{ changes: number, lastID: number }> {
  const adapter = await currentAdapter();
  return trackInflight(adapter.run(query, params));
}

export async function dbExec(query: string): Promise<void> {
  const adapter = await currentAdapter();
  return trackInflight(adapter.exec(query));
}

/**
 * Close all database connections gracefully.
 *
 * On SIGINT/SIGTERM we want to let in-flight queries drain so we don't sever
 * a running INSERT mid-statement. We wait up to `drainTimeoutMs` for the
 * inflight set to empty, then force-close whatever remains.
 */
export async function closeDatabase(drainTimeoutMs: number = 5000): Promise<void> {
  // Drain: wait for in-flight queries to settle, bounded by the timeout.
  if (inflight.size > 0) {
    const drain = Promise.allSettled(Array.from(inflight));
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), drainTimeoutMs);
    });
    const result = await Promise.race([drain.then(() => 'drained' as const), timeout]);
    clearTimeout(timer!);
    if (result === 'timeout') {
      console.error(`[WARN] closeDatabase drain timeout after ${drainTimeoutMs}ms — forcing close with ${inflight.size} in-flight queries.`);
    }
  }

  if (dbAdapter) {
    try {
      await dbAdapter.close();
    } catch {
      // Best-effort shutdown.
    }
    dbAdapter = null;
  }

  // Await and close each resolved adapter. If an init is still pending we
  // wait for it before closing (or swallow its rejection).
  for (const adapterPromise of pools.values()) {
    try {
      const adapter = await adapterPromise;
      await adapter.close();
    } catch {
      // Best-effort — individual pool failures must not block the rest.
    }
  }
  pools.clear();
  registry = null;
}

export async function getDatabaseMetadata(): Promise<{ name: string, type: string, path?: string, server?: string, database?: string }> {
  const adapter = await currentAdapter();
  return adapter.getMetadata();
}

export function getDbType(): string | null {
  if (registry) return 'sqlserver';
  if (!dbAdapter) return null;
  return dbAdapter.getMetadata().type;
}

export async function getListTablesQuery(): Promise<string> {
  const adapter = await currentAdapter();
  return adapter.getListTablesQuery();
}

export async function getDescribeTableQuery(tableName: string): Promise<{ query: string; params: any[] }> {
  const adapter = await currentAdapter();
  return adapter.getDescribeTableQuery(tableName);
}
