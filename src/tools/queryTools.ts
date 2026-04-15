import { dbAll, dbRun, dbExec, isMultiConnectionMode, getResolvedConnection } from '../db/index.js';
import { formatErrorResponse, formatSuccessResponse, convertToCSV } from '../utils/formatUtils.js';

/**
 * Execute a read-only SQL query
 * @param query SQL query to execute
 * @returns Query results
 */
export async function readQuery(query: string, params: any[] = []) {
  try {
    const trimmed = query.trim();
    // Strip leading block comments before checking the query type
    const stripped = trimmed.replace(/^\/\*[\s\S]*?\*\/\s*/g, '');
    if (!stripped.toLowerCase().startsWith("select") && !stripped.toLowerCase().startsWith("with")) {
      throw new Error("Only SELECT queries are allowed with read_query");
    }
    // Reject multiple statements to prevent piggyback attacks
    if (trimmed.includes(';')) {
      throw new Error("Multiple statements are not allowed in read_query");
    }

    const result = await dbAll(query, params);
    return formatSuccessResponse(result);
  } catch (error: any) {
    throw new Error(`SQL Error: ${error.message}`);
  }
}

/**
 * Execute a data modification SQL query
 * @param query SQL query to execute
 * @returns Information about affected rows
 */
export async function writeQuery(query: string, params: any[] = []) {
  try {
    const lowerQuery = query.trim().toLowerCase();

    if (lowerQuery.startsWith("select")) {
      throw new Error("Use read_query for SELECT operations");
    }

    if (!(lowerQuery.startsWith("insert") || lowerQuery.startsWith("update") || lowerQuery.startsWith("delete"))) {
      throw new Error("Only INSERT, UPDATE, or DELETE operations are allowed with write_query");
    }

    const result = await dbRun(query, params);
    return formatSuccessResponse({ affected_rows: result.changes });
  } catch (error: any) {
    throw new Error(`SQL Error: ${error.message}`);
  }
}

/**
 * Execute a DDL statement (CREATE/ALTER/DROP PROCEDURE|FUNCTION|VIEW|TRIGGER|INDEX, etc.)
 * Gated behind ALLOW_DDL=true env var. Intended for stored-proc maintenance where
 * the structured schema tools are insufficient.
 */
export async function executeDdl(query: string) {
  try {
    if (process.env.ALLOW_DDL !== 'true') {
      throw new Error("execute_ddl is disabled. Set ALLOW_DDL=true in the server environment to enable.");
    }

    if (isMultiConnectionMode()) {
      const resolved = getResolvedConnection();
      if (!resolved.allowDdl) {
        throw new Error(
          `execute_ddl is not permitted on server '${resolved.serverName}'. ` +
          `Set "allowDdl": true on that server entry in the connection config to enable.`
        );
      }
    }

    const trimmed = query.trim();
    const stripped = trimmed.replace(/^\/\*[\s\S]*?\*\/\s*/g, '').replace(/^--[^\n]*\n/g, '');
    const first = stripped.toLowerCase().split(/\s+/)[0];
    const allowed = new Set(['create', 'alter', 'drop']);
    if (!allowed.has(first)) {
      throw new Error("execute_ddl only accepts CREATE, ALTER, or DROP statements. Use write_query for DML.");
    }

    await dbExec(query);
    return formatSuccessResponse({ success: true, message: `DDL executed: ${first.toUpperCase()}` });
  } catch (error: any) {
    throw new Error(`DDL Error: ${error.message}`);
  }
}

/**
 * Export query results to CSV or JSON format
 * @param query SQL query to execute
 * @param format Output format (csv or json)
 * @returns Formatted query results
 */
export async function exportQuery(query: string, format: string) {
  try {
    if (!query.trim().toLowerCase().startsWith("select")) {
      throw new Error("Only SELECT queries are allowed with export_query");
    }

    const result = await dbAll(query);
    
    if (format === "csv") {
      const csvData = convertToCSV(result);
      return {
        content: [{ 
          type: "text", 
          text: csvData
        }],
        isError: false,
      };
    } else if (format === "json") {
      return formatSuccessResponse(result);
    } else {
      throw new Error("Unsupported export format. Use 'csv' or 'json'");
    }
  } catch (error: any) {
    throw new Error(`Export Error: ${error.message}`);
  }
} 