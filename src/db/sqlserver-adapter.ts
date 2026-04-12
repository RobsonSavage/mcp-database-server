import type * as sql from "mssql";
import { DbAdapter, assertSafeIdentifier } from "./adapter.js";

// We dynamically import the correct mssql entry point at init() time so that
// msnodesqlv8 remains an optional dependency — users who only use SQL auth via
// Tedious should not pay a native-compile cost.
type MssqlModule = typeof import('mssql');

/**
 * SQL Server database adapter.
 *
 * Authentication:
 *  - SQL auth (user + password): uses the default 'mssql' entry (Tedious driver, pure JS).
 *  - Windows integrated auth (trustedConnection: true): uses 'mssql/msnodesqlv8' so the
 *    connection is made as the current Windows user via SSPI. Requires the optional
 *    `msnodesqlv8` npm dependency and an ODBC driver (e.g. "ODBC Driver 17/18 for SQL Server")
 *    installed on the machine.
 */
export class SqlServerAdapter implements DbAdapter {
  private sql: MssqlModule | null = null;
  private pool: sql.ConnectionPool | null = null;
  private readonly config: sql.config;
  private readonly server: string;
  private readonly database: string;
  private readonly trustedConnection: boolean;

  constructor(connectionInfo: {
    server: string;
    database: string;
    user?: string;
    password?: string;
    port?: number;
    /** Connection timeout in milliseconds. Converted to seconds for mssql driver. */
    connectionTimeoutMs?: number;
    trustServerCertificate?: boolean;
    multipleActiveResultSets?: boolean;
    trustedConnection?: boolean;
    /** ODBC driver name for msnodesqlv8 (e.g. "ODBC Driver 18 for SQL Server"). */
    driver?: string;
    options?: Record<string, unknown>;
  }) {
    this.server = connectionInfo.server;
    this.database = connectionInfo.database;
    this.trustedConnection = connectionInfo.trustedConnection === true;

    // Default changed to false: a published npm package pointing at production
    // SQL Server instances must not silently disable TLS verification. Users on
    // self-signed dev certs must set trustServerCertificate: true explicitly.
    const baseOptions: Record<string, unknown> = {
      trustServerCertificate: connectionInfo.trustServerCertificate ?? false,
      enableArithAbort: true,
      ...(connectionInfo.options ?? {}),
    };

    // MARS (Multiple Active Result Sets) — for msnodesqlv8/ODBC we inject it
    // into the connection string via beforeConnect. For Tedious the pool handles
    // concurrency natively, but we store the flag for consistency and diagnostics.
    const mars = connectionInfo.multipleActiveResultSets ?? true;

    const port = connectionInfo.port ?? 1433;
    // mssql connectionTimeout is in milliseconds (default 15000).
    const connectionTimeoutMs = connectionInfo.connectionTimeoutMs ?? 15000;

    if (this.trustedConnection) {
      // msnodesqlv8 shape — no user/password, trustedConnection lives under options.
      // Port must be included so non-default ports are honored; msnodesqlv8 accepts
      // `port` at the top level the same way Tedious does.
      this.config = {
        server: connectionInfo.server,
        database: connectionInfo.database,
        port,
        connectionTimeout: connectionTimeoutMs,
        // Override the ODBC driver in the connection string for msnodesqlv8.
        // mssql defaults to "SQL Server Native Client 11.0" on Windows, which
        // is rarely installed. Replace it with a modern ODBC driver.
        beforeConnect: (cfg: any) => {
            if (cfg.conn_str) {
              const driver = connectionInfo.driver ?? 'ODBC Driver 18 for SQL Server';
              cfg.conn_str = cfg.conn_str.replace(/Driver=\{[^}]*\}|Driver=[^;]*/i, `Driver={${driver}}`);
              if (mars && !cfg.conn_str.includes('MultipleActiveResultSets')) {
                cfg.conn_str += ';MultipleActiveResultSets=True';
              }
            }
          },
        options: {
          ...baseOptions,
          trustedConnection: true,
        } as sql.config['options'],
      } as sql.config;
    } else {
      if (!connectionInfo.user || !connectionInfo.password) {
        throw new Error(
          `SQL Server adapter for '${connectionInfo.server}/${connectionInfo.database}' requires ` +
          `either trustedConnection: true or explicit user + password.`
        );
      }
      // Tedious shape — explicit user/password at the top level.
      this.config = {
        server: connectionInfo.server,
        database: connectionInfo.database,
        user: connectionInfo.user,
        password: connectionInfo.password,
        port,
        connectionTimeout: connectionTimeoutMs,
        options: baseOptions as sql.config['options'],
      };
      // Note: MARS is an ODBC/msnodesqlv8 concept. Tedious handles concurrency
      // via the mssql connection pool, so no beforeConnect hook needed here.
    }
  }

  async init(): Promise<void> {
    const authMode = this.trustedConnection ? 'Windows (msnodesqlv8)' : 'SQL (Tedious)';
    console.error(
      `[INFO] Connecting to SQL Server: ${this.server}, Database: ${this.database} [auth=${authMode}]`
    );

    try {
      this.sql = await this.loadDriver();
      this.pool = await new this.sql.ConnectionPool(this.config).connect();
      console.error(`[INFO] SQL Server connection established successfully`);
    } catch (err) {
      console.error(`[ERROR] SQL Server connection error: ${(err as Error).message}`);
      throw new Error(`Failed to connect to SQL Server: ${(err as Error).message}`);
    }
  }

  private async loadDriver(): Promise<MssqlModule> {
    // mssql is pure CJS with Object.assign-style exports, so Node's ESM-CJS interop
    // doesn't lift named exports onto the dynamic-import namespace. ConnectionPool,
    // Int, etc. only exist on `.default`. Unwrap it; fall back to the namespace
    // itself if a future mssql build ships as real ESM.
    const unwrap = (ns: any): MssqlModule => (ns?.default ?? ns) as MssqlModule;

    if (this.trustedConnection) {
      try {
        return unwrap(await import('mssql/msnodesqlv8.js'));
      } catch (err) {
        throw new Error(
          `Windows integrated authentication requested but 'msnodesqlv8' is not installed. ` +
          `Install it with:\n\n    npm install msnodesqlv8\n\n` +
          `You will also need a Microsoft ODBC Driver for SQL Server ` +
          `(e.g. "ODBC Driver 18 for SQL Server") installed on this machine.\n\n` +
          `Underlying error: ${(err as Error).message}`
        );
      }
    }
    return unwrap(await import('mssql'));
  }

  /**
   * Replace `?` placeholders with `@param0`, `@param1`, ... using an explicit
   * parameter index. The previous implementation used the second argument of
   * the replace callback as the index, but without capture groups that is the
   * CHARACTER OFFSET of the match, not the match index — so queries with more
   * than one parameter generated `@param0`, `@param15`, ... and silently
   * misbound. Track the index explicitly.
   */
  private prepareParams(query: string): string {
    let idx = 0;
    return query.replace(/\?/g, () => `@param${idx++}`);
  }

  async all(query: string, params: any[] = []): Promise<any[]> {
    if (!this.pool || !this.sql) {
      throw new Error("Database not initialized");
    }

    try {
      // Use this.sql.Request explicitly — pool.request() defers to a global
      // shared.driver singleton that gets contaminated when msnodesqlv8 is
      // imported for Windows-auth connections, causing Tedious pools to
      // receive msnodesqlv8 Request objects whose queryRaw calls fail.
      const request = new this.sql.Request(this.pool);
      const preparedQuery = (params && params.length > 0)
        ? (() => {
            params.forEach((param, index) => {
              request.input(`param${index}`, param);
            });
            return this.prepareParams(query);
          })()
        : query;
      const result = await request.query(preparedQuery);
      return result.recordset;
    } catch (err) {
      throw new Error(`SQL Server query error: ${(err as Error).message}`);
    }
  }

  async run(query: string, params: any[] = []): Promise<{ changes: number, lastID: number }> {
    if (!this.pool || !this.sql) {
      throw new Error("Database not initialized");
    }

    try {
      const request = new this.sql.Request(this.pool);
      const preparedQuery = (params && params.length > 0)
        ? (() => {
            params.forEach((param, index) => {
              request.input(`param${index}`, param);
            });
            return this.prepareParams(query);
          })()
        : query;

      let lastID = 0;
      let changes = 0;
      if (query.trim().toUpperCase().startsWith('INSERT')) {
        request.output('insertedId', this.sql.Int, 0);
        const updatedQuery = `${preparedQuery}; SELECT @insertedId = SCOPE_IDENTITY();`;
        const result = await request.query(updatedQuery);
        lastID = (result.output as any).insertedId || 0;
        changes = result.rowsAffected[0] || 0;
      } else {
        const result = await request.query(preparedQuery);
        changes = result.rowsAffected[0] || 0;
      }

      return { changes, lastID };
    } catch (err) {
      throw new Error(`SQL Server query error: ${(err as Error).message}`);
    }
  }

  async exec(query: string): Promise<void> {
    if (!this.pool || !this.sql) {
      throw new Error("Database not initialized");
    }

    try {
      const request = new this.sql.Request(this.pool);
      await request.batch(query);
    } catch (err) {
      throw new Error(`SQL Server batch error: ${(err as Error).message}`);
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
    }
  }

  getMetadata(): { name: string, type: string, server: string, database: string } {
    return {
      name: "SQL Server",
      type: "sqlserver",
      server: this.server,
      database: this.database,
    };
  }

  getListTablesQuery(): string {
    return "SELECT TABLE_NAME as name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME";
  }

  getDescribeTableQuery(tableName: string): { query: string; params: any[] } {
    assertSafeIdentifier(tableName, 'table name');
    const query = `
      SELECT
        c.COLUMN_NAME as name,
        c.DATA_TYPE as type,
        CASE WHEN c.IS_NULLABLE = 'NO' THEN 1 ELSE 0 END as notnull,
        CASE WHEN pk.CONSTRAINT_TYPE = 'PRIMARY KEY' THEN 1 ELSE 0 END as pk,
        c.COLUMN_DEFAULT as dflt_value
      FROM
        INFORMATION_SCHEMA.COLUMNS c
      LEFT JOIN
        INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON c.TABLE_NAME = kcu.TABLE_NAME AND c.COLUMN_NAME = kcu.COLUMN_NAME
      LEFT JOIN
        INFORMATION_SCHEMA.TABLE_CONSTRAINTS pk ON kcu.CONSTRAINT_NAME = pk.CONSTRAINT_NAME AND pk.CONSTRAINT_TYPE = 'PRIMARY KEY'
      WHERE
        c.TABLE_NAME = ?
      ORDER BY
        c.ORDINAL_POSITION
    `;
    return { query, params: [tableName] };
  }

}
