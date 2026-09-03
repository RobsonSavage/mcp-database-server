import { dbAll, dbRun, dbExec, isMultiConnectionMode, getResolvedConnection, getDbType } from '../db/index.js';
import { formatErrorResponse, formatSuccessResponse, formatToonResponse, convertToCSV } from '../utils/formatUtils.js';

export type ReadQueryFormat = "json" | "toon";

/**
 * Scan one physical line and advance the cross-line lexer state. Only block
 * comments and single-quoted string literals carry across line boundaries in
 * T-SQL, so those are the only flags that persist. Bracket (`[...]`) and
 * double-quote (`"..."`) identifiers are tracked within the line so a `'`, `--`,
 * or `/*` inside them doesn't flip state, but they are assumed to close on the
 * same line (the common case) and are not carried over. Line comments (`--`) end
 * at the newline by definition. Returns the updated state.
 */
function scanLineState(line: string, blockDepth: number, inString: boolean): { blockDepth: number; inString: boolean } {
  let i = 0;
  let inBracket = false;
  let inQuotedId = false;
  while (i < line.length) {
    const c = line[i];
    const next = line[i + 1];
    if (blockDepth > 0) {
      if (c === '*' && next === '/') { blockDepth--; i += 2; continue; }
      if (c === '/' && next === '*') { blockDepth++; i += 2; continue; } // T-SQL nests
      i++; continue;
    }
    if (inString) {
      if (c === "'") {
        if (next === "'") { i += 2; continue; } // '' escape
        inString = false;
      }
      i++; continue;
    }
    if (inBracket) {
      if (c === ']') {
        if (next === ']') { i += 2; continue; } // ]] escape
        inBracket = false;
      }
      i++; continue;
    }
    if (inQuotedId) {
      if (c === '"') {
        if (next === '"') { i += 2; continue; } // "" escape
        inQuotedId = false;
      }
      i++; continue;
    }
    // clean state
    if (c === '-' && next === '-') break;              // line comment to EOL
    if (c === '/' && next === '*') { blockDepth++; i += 2; continue; }
    if (c === "'") { inString = true; i++; continue; }
    if (c === '[') { inBracket = true; i++; continue; }
    if (c === '"') { inQuotedId = true; i++; continue; }
    i++;
  }
  return { blockDepth, inString };
}

/**
 * Split a SQL Server script on `GO` batch separators (sqlcmd / SSMS convention).
 * `GO` must be on its own line, may have leading/trailing whitespace, an optional
 * integer repeat count (`GO 5` = run the preceding batch 5 times), and an optional
 * trailing `-- comment`. Empty batches are dropped.
 *
 * Comment- and string-aware: a `GO` line that sits inside an open (possibly
 * nested) block comment or a multi-line string literal is treated as content,
 * not a separator. A line can only be a separator when the lexer state at the
 * START of that line is clean.
 */
export function splitOnGo(query: string): { sql: string; repeat: number }[] {
  const GO_RE = /^[ \t]*GO(?:[ \t]+(\d+))?[ \t]*(?:--.*)?$/i;
  const lines = query.split(/\r?\n/);
  const batches: { sql: string; repeat: number }[] = [];
  let buf: string[] = [];
  let blockDepth = 0;
  let inString = false;
  const flush = (repeat: number) => {
    const sql = buf.join('\n').trim();
    if (sql.length > 0) batches.push({ sql, repeat });
    buf = [];
  };
  for (const line of lines) {
    const clean = blockDepth === 0 && !inString;
    const m = clean ? line.match(GO_RE) : null;
    if (m) {
      // A clean GO line has no comment/string starters, so state is unchanged.
      flush(m[1] ? Math.max(1, parseInt(m[1], 10)) : 1);
    } else {
      buf.push(line);
      ({ blockDepth, inString } = scanLineState(line, blockDepth, inString));
    }
  }
  flush(1);
  return batches;
}

/**
 * Strip a leading block comment and a single trailing `;`, then reject any
 * remaining `;` to block multi-statement piggyback batches. Returns the
 * normalized SQL to execute.
 *
 * NOT a read-only guarantee and NOT string/comment-aware: a `;` inside a string
 * literal (e.g. `WHERE name = 'a;b'`) is a false positive, and data-modifying
 * CTEs (`WITH x AS (DELETE ... RETURNING) SELECT ...` on PostgreSQL, or
 * `WITH cte AS (...) DELETE FROM cte` on SQL Server) pass any leading-keyword
 * check by construction. True read/write enforcement is the DB login's job. This
 * guard's only jobs are routing the agent to the right tool and stopping batch
 * piggyback — which is the one thing the SQL Server driver's batch execution
 * does NOT block on its own (and which would otherwise bypass the execute_ddl gate).
 */
function assertSingleStatement(query: string, tool: string): string {
  let stripped = query.trim().replace(/^\/\*[\s\S]*?\*\/\s*/g, '');
  stripped = stripped.replace(/^(?:--[^\n]*\n)*/g, '').trim();
  const body = stripped.replace(/;\s*$/, '');
  if (body.includes(';')) {
    throw new Error(`Multiple statements are not allowed in ${tool}`);
  }
  return body;
}

/**
 * Split SQL statements on semicolons while preserving semicolons inside
 * comments, string literals, and quoted identifiers.
 */
export function splitOnSemicolons(query: string): string[] {
  const statements: string[] = [];
  let buffer = '';
  let blockDepth = 0;
  let inString = false;
  let inBracket = false;
  let inQuotedId = false;
  let inLineComment = false;

  const flush = () => {
    const statement = buffer.trim();
    if (statement.length > 0) statements.push(statement);
    buffer = '';
  };

  for (let i = 0; i < query.length; i++) {
    const c = query[i];
    const next = query[i + 1];

    if (inLineComment) {
      buffer += c;
      if (c === '\n' || c === '\r') inLineComment = false;
      continue;
    }
    if (blockDepth > 0) {
      buffer += c;
      if (c === '/' && next === '*') { buffer += next; blockDepth++; i++; }
      else if (c === '*' && next === '/') { buffer += next; blockDepth--; i++; }
      continue;
    }
    if (inString) {
      buffer += c;
      if (c === "'") {
        if (next === "'") { buffer += next; i++; }
        else inString = false;
      }
      continue;
    }
    if (inBracket) {
      buffer += c;
      if (c === ']') {
        if (next === ']') { buffer += next; i++; }
        else inBracket = false;
      }
      continue;
    }
    if (inQuotedId) {
      buffer += c;
      if (c === '"') {
        if (next === '"') { buffer += next; i++; }
        else inQuotedId = false;
      }
      continue;
    }

    if (c === '-' && next === '-') { buffer += c + next; inLineComment = true; i++; continue; }
    if (c === '/' && next === '*') { buffer += c + next; blockDepth++; i++; continue; }
    if (c === "'") { buffer += c; inString = true; continue; }
    if (c === '[') { buffer += c; inBracket = true; continue; }
    if (c === '"') { buffer += c; inQuotedId = true; continue; }
    if (c === ';') { flush(); continue; }
    buffer += c;
  }

  flush();
  return statements;
}

/**
 * Validate a read-path query (read_query / export_query). Allows SELECT and CTE
 * (WITH) heads. Returns the normalized SQL. `tool` only shapes the error text.
 * Exported so tests exercise the real logic instead of a reimplementation.
 */
export function validateReadQuery(query: string, tool = "read_query"): string {
  const sql = assertSingleStatement(query, tool);
  const lower = sql.toLowerCase();
  if (!lower.startsWith("select") && !lower.startsWith("with")) {
    throw new Error(`Only SELECT queries are allowed with ${tool}`);
  }
  return sql;
}

/**
 * Validate a write-path batch (write_query). Allows semicolon-separated
 * INSERT/UPDATE/DELETE statements plus PRINT, rejects SELECT and DDL, and
 * returns the SQL.
 *
 * PRINT is admitted so a write batch can annotate its own progress; the output
 * comes back in the tool's `messages`. It mutates nothing, so it does not widen
 * the execute_ddl gate this check backstops - and that check was never a
 * security boundary anyway, since T-SQL does not require semicolons between
 * statements and the split is on `;`.
 *
 * Rejections name the right tool for what the batch actually contains, so an
 * agent that reaches for write_query with a scripted scenario (temp tables,
 * explicit BEGIN TRAN/ROLLBACK, DECLARE) learns to use execute_ddl in one
 * round trip instead of bisecting the vocabulary.
 */
export function validateWriteQuery(query: string): string {
  const statements = splitOnSemicolons(query);
  if (statements.length === 0) {
    throw new Error("write_query: query is empty");
  }

  for (const statement of statements) {
    let sql = statement.trim().replace(/^\/\*[\s\S]*?\*\/\s*/g, '');
    sql = sql.replace(/^(?:--[^\n]*\n)*/g, '').trim();
    const lower = sql.toLowerCase();
    if (lower.startsWith("select")) {
      throw new Error("Use read_query for SELECT operations");
    }
    if (!(lower.startsWith("insert") || lower.startsWith("update") ||
          lower.startsWith("delete") || lower.startsWith("print"))) {
      throw new Error(
        "write_query accepts only INSERT, UPDATE, DELETE, and PRINT. " +
        "Scripted batches (temp tables, DECLARE, BEGIN TRAN/ROLLBACK, " +
        "control flow, SELECT verification) need execute_ddl (requires " +
        "ALLOW_DDL=true and allowDdl on the connection)"
      );
    }
  }

  return query.trim();
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
    const sql = validateReadQuery(query);
    const result = await dbAll(sql, params);
    if (format === "json") return formatSuccessResponse(result);
    return formatToonResponse(result);
  } catch (error: any) {
    throw new Error(`SQL Error: ${error.message}`);
  }
}

/**
 * Execute one or more data modification statements. SQL Server GO batches are
 * executed separately, matching sqlcmd/SSMS batch semantics. All batches are
 * validated before the first write. Parameterized calls must use one batch.
 *
 * PRINT / low-severity RAISERROR output is returned as `messages` (omitted when
 * nothing was printed) and, on failure, the messages from batches that already
 * completed are appended to the error - same contract as execute_ddl.
 * @param query SQL query to execute
 * @returns Information about affected rows
 */
export async function writeQuery(query: string, params: any[] = []) {
  // Declared outside the try so the catch can report what earlier batches
  // printed before the failing one threw.
  const messages: string[] = [];
  try {
    const isSqlServer = getDbType() === 'sqlserver';
    const batches = isSqlServer ? splitOnGo(query) : [{ sql: query, repeat: 1 }];
    if (batches.length === 0) {
      throw new Error("write_query: query is empty after stripping GO separators");
    }
    if (params.length > 0 && (batches.length > 1 || batches[0].repeat > 1)) {
      throw new Error("Parameterized write_query calls cannot contain GO separators");
    }

    const validatedBatches = batches.map(batch => ({
      sql: validateWriteQuery(batch.sql),
      repeat: batch.repeat,
    }));

    let affectedRows = 0;
    for (const batch of validatedBatches) {
      for (let i = 0; i < batch.repeat; i++) {
        const result = await dbRun(batch.sql, params);
        affectedRows += result.changes;
        messages.push(...result.messages);
      }
    }
    return formatSuccessResponse({
      affected_rows: affectedRows,
      ...(messages.length > 0 ? { messages } : {}),
    });
  } catch (error: any) {
    const printed = messages.length > 0
      ? `\nMessages from completed batches:\n${messages.join('\n')}`
      : '';
    throw new Error(`SQL Error: ${error.message}${printed}`);
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
 * PRINT / low-severity RAISERROR output from every batch is collected and
 * returned as `messages` (omitted when the script printed nothing), so a
 * migration script's own progress reporting reaches the caller instead of being
 * discarded with the driver's info events. On failure the messages produced
 * before the throw are appended to the error.
 *
 * Result sets the script produced (its SELECTs, in statement order across
 * batches) are returned as `result_sets` - omitted when the script selected
 * nothing - so a scripted scenario can verify its own effect in the same call:
 * BEGIN TRAN ... DML ... SELECT checks ... ROLLBACK runs as one self-contained
 * unit whose checks come back with the result, and the transaction state lives
 * and dies inside the single GO batch.
 *
 * Gated by two independent flags: ALLOW_DDL=true in the process env AND, in
 * multi-connection mode, "allowDdl": true on the resolved connection. The
 * database-level "allowDdl" overrides the server-level one when set.
 */
export async function executeDdl(query: string) {
  // Declared outside the try so the catch can report what earlier batches
  // printed before the failing one threw.
  const messages: string[] = [];
  try {
    if (process.env.ALLOW_DDL !== 'true') {
      throw new Error("execute_ddl is disabled. Set ALLOW_DDL=true in the server environment to enable.");
    }

    if (isMultiConnectionMode()) {
      const resolved = getResolvedConnection();
      if (!resolved.allowDdl) {
        throw new Error(
          `execute_ddl is not permitted on '${resolved.serverName}/${resolved.databaseName}'. ` +
          `Set "allowDdl": true on that server entry (or override it on the database entry) ` +
          `in the connection config to enable.`
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
    const resultSets: any[][] = [];
    for (const b of batches) {
      for (let i = 0; i < b.repeat; i++) {
        const result = await dbExec(b.sql);
        messages.push(...result.messages);
        resultSets.push(...result.resultSets);
        executed++;
      }
    }
    const batchWord = executed === 1 ? 'batch' : 'batches';
    return formatSuccessResponse({
      success: true,
      message: `DDL executed (${executed} ${batchWord})`,
      ...(messages.length > 0 ? { messages } : {}),
      ...(resultSets.length > 0 ? { result_sets: resultSets } : {}),
    });
  } catch (error: any) {
    const printed = messages.length > 0
      ? `\nMessages from completed batches:\n${messages.join('\n')}`
      : '';
    throw new Error(`DDL Error: ${error.message}${printed}`);
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
    const sql = validateReadQuery(query, "export_query");
    const result = await dbAll(sql);

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
