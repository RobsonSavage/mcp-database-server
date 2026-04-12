import { DbAdapter, assertSafeIdentifier } from "./adapter.js";
import pg from 'pg';

/**
 * PostgreSQL database adapter implementation
 */
export class PostgresqlAdapter implements DbAdapter {
  private pool: pg.Pool | null = null;
  private config: pg.PoolConfig;
  private host: string;
  private database: string;

  constructor(connectionInfo: {
    host: string;
    database: string;
    user?: string;
    password?: string;
    port?: number;
    ssl?: boolean | object;
    options?: any;
    connectionTimeoutMs?: number;
  }) {
    this.host = connectionInfo.host;
    this.database = connectionInfo.database;

    // Create PostgreSQL connection config
    this.config = {
      host: connectionInfo.host,
      database: connectionInfo.database,
      port: connectionInfo.port || 5432,
      user: connectionInfo.user,
      password: connectionInfo.password,
      ssl: connectionInfo.ssl,
      connectionTimeoutMillis: connectionInfo.connectionTimeoutMs || 30000,
    };
  }

  /**
   * Initialize PostgreSQL connection
   */
  async init(): Promise<void> {
    try {
      console.error(`[INFO] Connecting to PostgreSQL: ${this.host}, Database: ${this.database}`);
      console.error(`[DEBUG] Connection details:`, {
        host: this.host, 
        database: this.database,
        port: this.config.port,
        user: this.config.user,
        connectionTimeoutMillis: this.config.connectionTimeoutMillis,
        ssl: !!this.config.ssl
      });
      
      this.pool = new pg.Pool(this.config);
      this.pool.on('error', (err) => { console.error('[ERROR] PostgreSQL pool error:', err.message); });
      // Verify connectivity by running a test query
      await this.pool.query('SELECT 1');
      console.error(`[INFO] PostgreSQL connection established successfully`);
    } catch (err) {
      console.error(`[ERROR] PostgreSQL connection error: ${(err as Error).message}`);
      throw new Error(`Failed to connect to PostgreSQL: ${(err as Error).message}`);
    }
  }

  /**
   * Execute a SQL query and get all results
   * @param query SQL query to execute
   * @param params Query parameters
   * @returns Promise with query results
   */
  async all(query: string, params: any[] = []): Promise<any[]> {
    if (!this.pool) {
      throw new Error("Database not initialized");
    }

    try {
      // PostgreSQL uses $1, $2, etc. for parameterized queries.
      // Only replace ? when there are actual params to avoid corrupting
      // string literals and PostgreSQL JSON operators.
      let preparedQuery = query;
      if (params && params.length > 0) {
        let __pgIdx = 0;
        preparedQuery = query.replace(/\?/g, () => `$${++__pgIdx}`);
      }

      const result = await this.pool.query(preparedQuery, params);
      return result.rows;
    } catch (err) {
      throw new Error(`PostgreSQL query error: ${(err as Error).message}`);
    }
  }

  /**
   * Execute a SQL query that modifies data
   * @param query SQL query to execute
   * @param params Query parameters
   * @returns Promise with result info
   */
  async run(query: string, params: any[] = []): Promise<{ changes: number, lastID: number }> {
    if (!this.pool) {
      throw new Error("Database not initialized");
    }

    try {
      // Only replace ? when there are actual params to avoid corrupting
      // string literals and PostgreSQL JSON operators.
      let preparedQuery = query;
      if (params && params.length > 0) {
        let __pgIdx = 0;
        preparedQuery = query.replace(/\?/g, () => `$${++__pgIdx}`);
      }

      let lastID = 0;
      let changes = 0;

      if (query.trim().toUpperCase().startsWith('INSERT') && preparedQuery.includes('RETURNING')) {
        // Caller explicitly included RETURNING — honor it
        const result = await this.pool.query(preparedQuery, params);
        changes = result.rowCount || 0;
        lastID = result.rows[0]?.id || 0;
      } else {
        const result = await this.pool.query(preparedQuery, params);
        changes = result.rowCount || 0;
      }

      return { changes, lastID };
    } catch (err) {
      throw new Error(`PostgreSQL query error: ${(err as Error).message}`);
    }
  }

  /**
   * Execute multiple SQL statements
   * @param query SQL statements to execute
   * @returns Promise that resolves when execution completes
   */
  async exec(query: string): Promise<void> {
    if (!this.pool) {
      throw new Error("Database not initialized");
    }

    try {
      await this.pool.query(query);
    } catch (err) {
      throw new Error(`PostgreSQL batch error: ${(err as Error).message}`);
    }
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  /**
   * Get database metadata
   */
  getMetadata(): { name: string, type: string, server: string, database: string } {
    return {
      name: "PostgreSQL",
      type: "postgresql",
      server: this.host,
      database: this.database
    };
  }

  /**
   * Get database-specific query for listing tables
   */
  getListTablesQuery(): string {
    return "SELECT table_name as name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name";
  }

  /**
   * Get database-specific query for describing a table
   * @param tableName Table name
   */
  getDescribeTableQuery(tableName: string): { query: string; params: any[] } {
    assertSafeIdentifier(tableName, 'table name');
    const query = `
      SELECT
        c.column_name as name,
        c.data_type as type,
        CASE WHEN c.is_nullable = 'NO' THEN 1 ELSE 0 END as notnull,
        CASE WHEN pk.constraint_name IS NOT NULL THEN 1 ELSE 0 END as pk,
        c.column_default as dflt_value
      FROM
        information_schema.columns c
      LEFT JOIN
        information_schema.key_column_usage kcu
        ON c.table_name = kcu.table_name AND c.column_name = kcu.column_name
      LEFT JOIN
        information_schema.table_constraints pk
        ON kcu.constraint_name = pk.constraint_name AND pk.constraint_type = 'PRIMARY KEY'
      WHERE
        c.table_name = ?
        AND c.table_schema = 'public'
      ORDER BY
        c.ordinal_position
    `;
    return { query, params: [tableName] };
  }
} 