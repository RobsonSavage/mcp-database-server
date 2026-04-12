/**
 * Database adapter interface
 * Defines the contract for all database implementations (SQLite, SQL Server)
 */
export interface DbAdapter {
  /**
   * Initialize database connection
   */
  init(): Promise<void>;

  /**
   * Close database connection
   */
  close(): Promise<void>;

  /**
   * Execute a query and return all results
   * @param query SQL query to execute
   * @param params Query parameters
   */
  all(query: string, params?: any[]): Promise<any[]>;

  /**
   * Execute a query that modifies data
   * @param query SQL query to execute
   * @param params Query parameters
   */
  run(query: string, params?: any[]): Promise<{ changes: number, lastID: number }>;

  /**
   * Execute multiple SQL statements
   * @param query SQL statements to execute
   */
  exec(query: string): Promise<void>;

  /**
   * Get database metadata
   */
  getMetadata(): { name: string, type: string, path?: string, server?: string, database?: string };

  /**
   * Get database-specific query for listing tables
   */
  getListTablesQuery(): string;

  /**
   * Get database-specific query for describing a table.
   * Returns a parameterized query where possible. For identifier-position
   * contexts (SQLite PRAGMA, MySQL DESCRIBE) the tableName is validated
   * against a strict safelist and interpolated; params will be empty in
   * that case.
   * @param tableName Table name (must already be validated by caller)
   */
  getDescribeTableQuery(tableName: string): { query: string; params: any[] };
}

/**
 * Strict identifier safelist for SQL table/column names.
 * Matches: letter/underscore followed by letters, digits, underscores.
 * Rejects anything that could contain quotes, backticks, brackets, semicolons, etc.
 */
export function assertSafeIdentifier(name: string, label: string = 'identifier'): string {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(name)) {
    throw new Error(`Invalid ${label}: '${name}'. Must be a valid identifier (letters, digits, underscores; optional schema.table with one dot).`);
  }
  return name;
}

// Import adapters using dynamic imports
import { SqliteAdapter } from './sqlite-adapter.js';
import { SqlServerAdapter } from './sqlserver-adapter.js';
import { PostgresqlAdapter } from './postgresql-adapter.js';
import { MysqlAdapter } from './mysql-adapter.js';

/**
 * Factory function to create the appropriate database adapter
 */
export function createDbAdapter(type: string, connectionInfo: any): DbAdapter {
  switch (type.toLowerCase()) {
    case 'sqlite':
      // For SQLite, if connectionInfo is a string, use it directly as path
      if (typeof connectionInfo === 'string') {
        return new SqliteAdapter(connectionInfo);
      } else {
        return new SqliteAdapter(connectionInfo.path);
      }
    case 'sqlserver':
      return new SqlServerAdapter(connectionInfo);
    case 'postgresql':
    case 'postgres':
      return new PostgresqlAdapter(connectionInfo);
    case 'mysql':
      return new MysqlAdapter(connectionInfo);
    default:
      throw new Error(`Unsupported database type: ${type}`);
  }
} 