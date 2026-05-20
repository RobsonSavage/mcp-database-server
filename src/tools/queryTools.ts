import { dbAll, dbRun, dbExec, isMultiConnectionMode, getResolvedConnection, getDbType } from '../db/index.js';
import { formatErrorResponse, formatSuccessResponse, formatToonResponse, convertToCSV } from '../utils/formatUtils.js';

export type ReadQueryFormat = "json" | "toon";

/**
 * Split a SQL Server script on `GO` batch separators (sqlcmd / SSMS convention).
 * `GO` must be on its own line, may have leading/trailing whitespace, an optional
 * integer repeat count (`GO 5` = run the preceding batch 5 times), and an optional
 * trailing `-- comment`. Empty batches are dropped. Not string/comment-aware —
 * matches the same approximation used by Flyway, DbUp, sqlcmd, and SSMS.
 */
function splitOnGo(query: string): { sql: string; repeat: number }[] {
  const GO_RE = /^[ \t]*GO(?:[ \t]+(\d+))?[ \t]*(?:--.*)?$/i;
  const lines = query.split(/\r?\n/);
  const batches: { sql: string; repeat: number }[] = [];
  let buf: string[] = [];
  const flush = (repeat: number) => {
    const sql = buf.join('\n').trim();
    if (sql.length > 0) batches.push({ sql, repeat });
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(GO_RE);
    if (m) {
      flush(m[1] ? Math.max(1, parseInt(m[1], 10)) : 1);
    } else {
      buf.push(line);
    }
  }
  flush(1);
  return batches;
}

/**
 * Execute a read-only SQL query
 * @param query SQL query to execute
 * @param params Parameter values for parameterized queries
 * @param format Output encoding for the result set. "toon" (default, v3+) emits
 *               Token-Oriented Object Notation — significantly fewer LLM tokens
 *               for uniform row arrays. Pass "json" for the legacy pretty-printed
 *               JSON shape.
 * @returns Query results
 */
export async function readQuery(query: string, params: any[] = [], format: ReadQueryFormat = "toon") {
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
    if (format === "json") return formatSuccessResponse(result);
    return formatToonResponse(result);
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
 * Execute arbitrary DDL / schema-maintenance SQL. Supports CREATE/ALTER/DROP,
 * EXEC sp_rename / sp_addextendedproperty / sp_helptext, semicolon-separated
 * multi-statement batches, and (SQL Server only) GO-separated batches with
 * optional `GO N` repeat counts — each GO-batch runs as a separate driver call,
 * so a single execute_ddl can mix CREATE PROC ... GO EXEC sp_addextendedproperty
 * ... etc. Batches are NOT wrapped in a single transaction (GO ends a batch by
 * definition); a failure mid-script leaves earlier batches committed.
 *
 * Gated by two independent flags: ALLOW_DDL=true in the process env AND, in
 * multi-connection mode, "allowDdl": true on the resolved server entry.
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

    // GO is a sqlcmd/SSMS client-side convention — only SQL Server uses it. For
    // other engines pass through unchanged so a literal `GO` on its own line
    // (legal identifier in other dialects) isn't misinterpreted as a separator.
    const isSqlServer = getDbType() === 'sqlserver';
    const batches = isSqlServer ? splitOnGo(query) : [{ sql: query, repeat: 1 }];

    if (batches.length === 0) {
      throw new Error("execute_ddl: query is empty after stripping GO separators.");
    }

    let executed = 0;
    for (const b of batches) {
      for (let i = 0; i < b.repeat; i++) {
        await dbExec(b.sql);
        executed++;
      }
    }
    const batchWord = executed === 1 ? 'batch' : 'batches';
    return formatSuccessResponse({ success: true, message: `DDL executed (${executed} ${batchWord})` });
  } catch (error: any) {
    throw new Error(`DDL Error: ${error.message}`);
  }
}

/**
 * Export query results to CSV, JSON, or TOON format
 * @param query SQL query to execute
 * @param format Output format (csv, json, or toon)
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
    } else if (format === "toon") {
      return formatToonResponse(result);
    } else {
      throw new Error("Unsupported export format. Use 'csv', 'json', or 'toon'");
    }
  } catch (error: any) {
    throw new Error(`Export Error: ${error.message}`);
  }
}
