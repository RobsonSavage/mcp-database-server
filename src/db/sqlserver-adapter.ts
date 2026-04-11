import { DbAdapter } from "./adapter.js";

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
  private pool: any = null;
  private readonly config: any;
  private readonly server: string;
  private readonly database: string;
  private readonly trustedConnection: boolean;

  constructor(connectionInfo: {
    server: string;
    database: string;
    user?: string;
    password?: string;
    port?: number;
    trustServerCertificate?: boolean;
    trustedConnection?: boolean;
    options?: any;
  }) {
    this.server = connectionInfo.server;
    this.database = connectionInfo.database;
    this.trustedConnection = connectionInfo.trustedConnection === true;

    const baseOptions = {
      trustServerCertificate: connectionInfo.trustServerCertificate ?? true,
      ...(connectionInfo.options ?? {}),
    };

    if (this.trustedConnection) {
      // msnodesqlv8 shape — no user/password, trustedConnection lives under options.
      this.config = {
        server: connectionInfo.server,
        database: connectionInfo.database,
        options: {
          ...baseOptions,
          trustedConnection: true,
        },
      };
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
        port: connectionInfo.port ?? 1433,
        options: baseOptions,
      };
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
    if (this.trustedConnection) {
      try {
        return (await import('mssql/msnodesqlv8')) as unknown as MssqlModule;
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
    return (await import('mssql')) as unknown as MssqlModule;
  }

  async all(query: string, params: any[] = []): Promise<any[]> {
    if (!this.pool) {
      throw new Error("Database not initialized");
    }

    try {
      const request = this.pool.request();
      params.forEach((param, index) => {
        request.input(`param${index}`, param);
      });
      const preparedQuery = query.replace(/\?/g, (_, i) => `@param${i}`);
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
      const request = this.pool.request();
      params.forEach((param, index) => {
        request.input(`param${index}`, param);
      });
      const preparedQuery = query.replace(/\?/g, (_, i) => `@param${i}`);

      let lastID = 0;
      if (query.trim().toUpperCase().startsWith('INSERT')) {
        request.output('insertedId', this.sql.Int, 0);
        const updatedQuery = `${preparedQuery}; SELECT @insertedId = SCOPE_IDENTITY();`;
        const result = await request.query(updatedQuery);
        lastID = result.output.insertedId || 0;
      } else {
        await request.query(preparedQuery);
        lastID = 0;
      }

      return {
        changes: this.getAffectedRows(query, lastID),
        lastID: lastID,
      };
    } catch (err) {
      throw new Error(`SQL Server query error: ${(err as Error).message}`);
    }
  }

  async exec(query: string): Promise<void> {
    if (!this.pool) {
      throw new Error("Database not initialized");
    }

    try {
      const request = this.pool.request();
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

  getDescribeTableQuery(tableName: string): string {
    return `
      SELECT
        c.COLUMN_NAME as name,
        c.DATA_TYPE as type,
        CASE WHEN c.IS_NULLABLE = 'YES' THEN 1 ELSE 0 END as notnull,
        CASE WHEN pk.CONSTRAINT_TYPE = 'PRIMARY KEY' THEN 1 ELSE 0 END as pk,
        c.COLUMN_DEFAULT as dflt_value
      FROM
        INFORMATION_SCHEMA.COLUMNS c
      LEFT JOIN
        INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON c.TABLE_NAME = kcu.TABLE_NAME AND c.COLUMN_NAME = kcu.COLUMN_NAME
      LEFT JOIN
        INFORMATION_SCHEMA.TABLE_CONSTRAINTS pk ON kcu.CONSTRAINT_NAME = pk.CONSTRAINT_NAME AND pk.CONSTRAINT_TYPE = 'PRIMARY KEY'
      WHERE
        c.TABLE_NAME = '${tableName}'
      ORDER BY
        c.ORDINAL_POSITION
    `;
  }

  private getAffectedRows(query: string, lastID: number): number {
    const queryType = query.trim().split(' ')[0].toUpperCase();
    if (queryType === 'INSERT' && lastID > 0) {
      return 1;
    }
    return 0;
  }
}
