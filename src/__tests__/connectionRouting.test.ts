import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';

/**
 * Routing tests for multi-connection mode.
 *
 * The only seam is a fake SqlServerAdapter: db/index.ts imports the real one at
 * module load, so mocking that module intercepts every pool the registry opens.
 * Each fake instance records which leaf it was constructed for, so a test can
 * assert exactly which server/database/login every driver call landed on.
 */
const fake = vi.hoisted(() => ({
  calls: [] as Array<{
    op: string;
    query: string;
    server: string;
    database: string;
    probeLogin?: string;
    connectionTimeoutMs?: number;
  }>,
  /** Optional hook that lets a test park a driver call mid-flight. */
  barrier: null as null | ((op: string) => Promise<void> | void),
  /** Rows returned by `all`. Defaults to an empty result set. */
  rows: null as null | ((query: string) => any[]),
  /** Server messages (PRINT output) returned by `exec`/`run`. Defaults to none. */
  messages: null as null | ((query: string) => string[]),
}));

vi.mock('../db/sqlserver-adapter.js', () => {
  class SqlServerAdapter {
    constructor(private readonly info: any) {}
    private record(op: string, query: string) {
      fake.calls.push({
        op,
        query,
        server: this.info.server,
        database: this.info.database,
        probeLogin: this.info.options?.probeLogin,
        connectionTimeoutMs: this.info.connectionTimeoutMs,
      });
    }
    async init(): Promise<void> {}
    async close(): Promise<void> {}
    async all(query: string): Promise<any[]> {
      this.record('all', query);
      if (fake.barrier) await fake.barrier('all');
      return fake.rows ? fake.rows(query) : [];
    }
    async run(query: string): Promise<{ changes: number; lastID: number; messages: string[] }> {
      this.record('run', query);
      if (fake.barrier) await fake.barrier('run');
      return { changes: 1, lastID: 0, messages: fake.messages ? fake.messages(query) : [] };
    }
    async exec(query: string): Promise<{ messages: string[]; resultSets: any[][] }> {
      this.record('exec', query);
      if (fake.barrier) await fake.barrier('exec');
      return { messages: fake.messages ? fake.messages(query) : [], resultSets: [] };
    }
    // Resolving these also picks an adapter, so they count as routing reads.
    getListTablesQuery(): string {
      this.record('getListTablesQuery', 'LIST_TABLES');
      return 'LIST_TABLES';
    }
    getDescribeTableQuery(tableName: string): { query: string; params: any[] } {
      this.record('getDescribeTableQuery', `DESCRIBE ${tableName}`);
      return { query: `DESCRIBE ${tableName}`, params: [tableName] };
    }
  }
  return { SqlServerAdapter };
});

import { ConnectionRegistry } from '../config/loader.js';
import {
  closeDatabase,
  dbAll,
  getResolvedConnection,
  initDatabasePool,
  resolveCallTarget,
  runWithTarget,
  setStickyConnection,
} from '../db/index.js';
import { handleToolCall } from '../handlers/toolHandlers.js';
import { handleReadResource } from '../handlers/resourceHandlers.js';

// tsconfig has no test exclude, so `npm run build` also emits these tests into
// dist/ and vitest's default include collects both copies. Resolve the fixture
// from the project root so the dist copy finds it too.
const FIXTURE = resolve(process.cwd(), 'src/__tests__/fixtures/connections.test.json');

/** A promise plus its resolver. */
function deferred() {
  // Named `settle` rather than `resolve` so it does not shadow node:path's
  // `resolve`, imported above.
  let settle!: () => void;
  const promise = new Promise<void>((r) => {
    settle = () => r();
  });
  return { promise, resolve: settle };
}

/**
 * Park the first driver call of `op` until released, and expose a promise that
 * settles once it is parked. Gives a test a deterministic window in which to
 * fire a competing use_connection.
 */
function parkFirst(op: string) {
  const reached = deferred();
  const release = deferred();
  let parked = false;
  fake.barrier = async (seenOp: string) => {
    if (seenOp !== op || parked) return;
    parked = true;
    reached.resolve();
    await release.promise;
  };
  return { reached: reached.promise, release: release.resolve };
}

const leaves = () => fake.calls.map((c) => `${c.server}/${c.database}/${c.probeLogin}`);
const responseText = (res: any): string => res?.content?.[0]?.text ?? '';

describe('connection routing is frozen per request', () => {
  const savedAllowDdl = process.env.ALLOW_DDL;

  beforeEach(async () => {
    fake.calls.length = 0;
    fake.barrier = null;
    fake.rows = null;
    fake.messages = null;
    await initDatabasePool(ConnectionRegistry.load(FIXTURE));
    setStickyConnection({ reset: true });
  });

  afterEach(async () => {
    await closeDatabase();
    if (savedAllowDdl === undefined) delete process.env.ALLOW_DDL;
    else process.env.ALLOW_DDL = savedAllowDdl;
  });

  it('gives two interleaved requests their own frozen target', async () => {
    const gate = deferred();
    const seen: { a: string[]; b: string[] } = { a: [], b: [] };

    const one = runWithTarget(resolveCallTarget({ server: 'A', database: 'db2' }), async () => {
      seen.a.push(getResolvedConnection().key);
      await gate.promise;
      seen.a.push(getResolvedConnection().key);
    });
    const two = runWithTarget(resolveCallTarget({ server: 'B', login: 'elevated' }), async () => {
      seen.b.push(getResolvedConnection().key);
      await gate.promise;
      seen.b.push(getResolvedConnection().key);
    });

    gate.resolve();
    await Promise.all([one, two]);

    expect(seen.a).toEqual(['A/db2/appuser', 'A/db2/appuser']);
    expect(seen.b).toEqual(['B/bdb1/elevated', 'B/bdb1/elevated']);
  });

  it('a concurrent use_connection cannot reroute an in-flight request', async () => {
    setStickyConnection({ server: 'A', database: 'db1' });
    const gate = deferred();
    const keys: string[] = [];

    const request = runWithTarget(resolveCallTarget({}), async () => {
      keys.push(getResolvedConnection().key);
      keys.push(getResolvedConnection().key);
      await gate.promise;
      keys.push(getResolvedConnection().key);
      keys.push(getResolvedConnection().key);
    });

    setStickyConnection({ server: 'B', login: 'elevated' });
    gate.resolve();
    await request;

    expect(keys).toEqual(new Array(4).fill('A/db1/appuser'));
  });

  it('drops the sticky database and login when routed to another server', async () => {
    setStickyConnection({ server: 'B', login: 'elevated' });

    const target = resolveCallTarget({ server: 'A' });

    // Neither 'bdb1' nor 'elevated' exists under A, so both fall through to A's
    // defaults rather than failing the call.
    expect(`${target.server}/${target.database}/${target.login}`).toBe('A/db1/appuser');
  });

  it('drops the sticky login when routed to another database on the sticky server', async () => {
    setStickyConnection({ server: 'A', database: 'db2', login: 'db2only' });

    const result: any = await handleToolCall('read_query', {
      database: 'db1',
      query: 'SELECT 1',
    });

    expect(result.isError).toBeFalsy();
    expect(leaves()).toEqual(['A/db1/appuser']);
  });

  it('keeps the sticky levels when the explicit name re-states the sticky branch', async () => {
    setStickyConnection({ server: 'B', login: 'elevated' });

    const target = resolveCallTarget({ server: 'B' });

    expect(`${target.server}/${target.database}/${target.login}`).toBe('B/bdb1/elevated');
  });

  it('lets an explicit login win over the sticky one on the same branch', async () => {
    setStickyConnection({ server: 'B', login: 'elevated' });

    const target = resolveCallTarget({ login: 'readonly' });

    expect(`${target.server}/${target.database}/${target.login}`).toBe('B/bdb1/readonly');
  });

  it('describe_table keeps all four routing reads on one leaf', async () => {
    setStickyConnection({ server: 'A', database: 'db1' });
    fake.rows = (q) => (q === 'LIST_TABLES' ? [{ name: 'T' }] : [{ name: 'id', type: 'int' }]);
    const park = parkFirst('all');

    const call = handleToolCall('describe_table', { table_name: 'T' });
    await park.reached;
    setStickyConnection({ server: 'B', login: 'elevated' });
    park.release();
    const result: any = await call;

    expect(result.isError).toBeFalsy();
    expect(fake.calls.map((c) => c.op)).toEqual([
      'getListTablesQuery',
      'all',
      'getDescribeTableQuery',
      'all',
    ]);
    expect(leaves()).toEqual(new Array(4).fill('A/db1/appuser'));
  });

  it('execute_ddl executes every batch on the leaf its gate approved', async () => {
    process.env.ALLOW_DDL = 'true';
    // A carries allowDdl: true; B does not. Flipping the sticky between batches
    // must not move execution onto the unapproved server.
    setStickyConnection({ server: 'A', database: 'db1' });
    const park = parkFirst('exec');

    const call = handleToolCall('execute_ddl', {
      query: 'CREATE TABLE dbo.probe1 (id int)\nGO\nCREATE TABLE dbo.probe2 (id int)',
    });
    await park.reached;
    setStickyConnection({ server: 'B', login: 'elevated' });
    park.release();
    const result: any = await call;

    expect(result.isError).toBeFalsy();
    expect(leaves()).toEqual(['A/db1/appuser', 'A/db1/appuser']);
  });

  it('execute_ddl returns the PRINT output of every batch', async () => {
    process.env.ALLOW_DDL = 'true';
    setStickyConnection({ server: 'A', database: 'db1' });
    fake.messages = (q) => [`printed from: ${q}`];

    const result: any = await handleToolCall('execute_ddl', {
      query: 'PRINT 1\nGO\nPRINT 2',
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(responseText(result)).messages).toEqual([
      'printed from: PRINT 1',
      'printed from: PRINT 2',
    ]);
  });

  it('execute_ddl rejects a server without allowDdl and executes nothing', async () => {
    process.env.ALLOW_DDL = 'true';

    const result: any = await handleToolCall('execute_ddl', {
      server: 'B',
      query: 'CREATE TABLE dbo.probe (id int)',
    });

    expect(result.isError).toBe(true);
    expect(responseText(result)).toContain("execute_ddl is not permitted on 'B/bdb1'");
    expect(fake.calls).toHaveLength(0);
  });

  it('write_query runs every GO batch on one leaf', async () => {
    setStickyConnection({ server: 'A', database: 'db1' });
    const park = parkFirst('run');

    const call = handleToolCall('write_query', {
      query: 'UPDATE t SET a = 1\nGO\nUPDATE t SET b = 2',
    });
    await park.reached;
    setStickyConnection({ server: 'B', login: 'elevated' });
    park.release();
    const result: any = await call;

    expect(result.isError).toBeFalsy();
    expect(leaves()).toEqual(['A/db1/appuser', 'A/db1/appuser']);
  });

  it('drop_table verifies and drops on the same leaf', async () => {
    setStickyConnection({ server: 'A', database: 'db1' });
    fake.rows = () => [{ name: 'T' }];
    const park = parkFirst('all');

    const call = handleToolCall('drop_table', { table_name: 'T', confirm: true });
    await park.reached;
    setStickyConnection({ server: 'B', login: 'elevated' });
    park.release();
    const result: any = await call;

    expect(result.isError).toBeFalsy();
    expect(leaves()).toEqual(new Array(3).fill('A/db1/appuser'));
    expect(fake.calls[2]).toMatchObject({ op: 'exec', query: 'DROP TABLE "T"' });
  });

  it('rejects a driver call made outside a routed request context', async () => {
    await expect(dbAll('SELECT 1')).rejects.toThrow(/outside a routed request context/);
    expect(() => getResolvedConnection()).toThrow(/outside a routed request context/);
    expect(fake.calls).toHaveLength(0);
  });

  it('carries the use_connection connectionTimeoutMs into the pool', async () => {
    setStickyConnection({ server: 'A', database: 'db1', connectionTimeoutMs: 30000 });

    const result: any = await handleToolCall('read_query', { query: 'SELECT 1' });

    expect(result.isError).toBeFalsy();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].connectionTimeoutMs).toBe(30000);
  });

  it('echoes the routed leaf without disturbing the payload block', async () => {
    setStickyConnection({ server: 'B', login: 'elevated' });
    fake.rows = () => [{ id: 1, name: 'ok' }];

    const result: any = await handleToolCall('export_query', {
      query: 'SELECT TOP 5 * FROM t',
      format: 'csv',
    });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe('id,name\n1,"ok"\n');
    expect(result.content[1].text).toBe('[routed: B/bdb1/elevated]');
  });

  it('does not echo a routed leaf on an error result', async () => {
    const result: any = await handleToolCall('read_query', { query: 'DELETE FROM t' });

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
  });

  it('pins a resource read to its URI and ignores the sticky login', async () => {
    setStickyConnection({ server: 'B', login: 'elevated' });
    fake.rows = () => [{ name: 'id', type: 'int' }];

    await handleReadResource('sqlserver://A/db1/T/schema');

    expect(leaves()).toEqual(new Array(2).fill('A/db1/appuser'));
  });
});
