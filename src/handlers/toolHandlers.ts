import { formatErrorResponse, formatSuccessResponse } from '../utils/formatUtils.js';

// Import all tool implementations
import { readQuery, writeQuery, exportQuery, executeDdl } from '../tools/queryTools.js';
import { createTable, alterTable, dropTable, listTables, describeTable } from '../tools/schemaTools.js';
import { appendInsight, listInsights } from '../tools/insightTools.js';

// Multi-connection plumbing
import {
  isMultiConnectionMode,
  resolveCallTarget,
  runWithTarget,
  setStickyConnection,
  getStickyConnection,
  getRegistry,
  getDbType,
} from '../db/index.js';

/**
 * Optional connection-selection properties added to every tool's inputSchema when
 * multi-connection mode is active. Each field is optional; missing levels fall
 * through to the sticky selection (set by use_connection) and then to the registry
 * defaults - but only within the sticky's own branch. Naming a different server or
 * database drops the sticky levels below it, which then come from that branch's
 * defaults instead of naming something that need not exist there.
 */
const CONNECTION_PROPS = {
  server: {
    type: "string",
    description: "(optional) Target server name from the connection registry. Falls back to sticky or default. Naming a server other than the sticky one resets database and login to that server's defaults.",
  },
  database: {
    type: "string",
    description: "(optional) Target database name on that server. Falls back to sticky or default. Naming a database other than the sticky one resets login to that database's default.",
  },
  login: {
    type: "string",
    description: "(optional) Login name for that database. Falls back to sticky or default.",
  },
};

function extendProps(base: Record<string, any>): Record<string, any> {
  if (!isMultiConnectionMode()) return base;
  return { ...base, ...CONNECTION_PROPS };
}

export function handleListTools() {
  const multi = isMultiConnectionMode();

  const tools: Array<any> = [
    {
      name: "read_query",
      description: "Execute SELECT queries to read data from the database",
      inputSchema: {
        type: "object",
        properties: extendProps({
          query: { type: "string" },
          params: {
            type: "array",
            items: {},
            description: "Optional array of parameter values for parameterized queries. Use ? placeholders in the query string.",
          },
          format: {
            type: "string",
            enum: ["json", "toon"],
            description: "(optional) Output encoding for the result set. 'toon' (default, v3+) emits Token-Oriented Object Notation — significantly fewer tokens for uniform row arrays, lossless w.r.t. JSON. Pass 'json' for the legacy pretty-printed JSON shape.",
          },
        }),
        required: ["query"],
      },
    },
    {
      name: "write_query",
      description: "Execute INSERT, UPDATE, or DELETE queries. Accepts semicolon-separated DML statements and, " +
        "for SQL Server, GO-separated batches with optional GO N repeat counts. PRINT statements are allowed " +
        "alongside the DML so a batch can report its own progress. Every statement is validated " +
        "before execution; SELECT, DDL, temp tables, DECLARE, and explicit BEGIN TRAN/ROLLBACK are rejected - " +
        "use execute_ddl for scripted scenarios, read_query for SELECT. Each GO batch is a separate driver call, " +
        "so a later runtime failure does not roll back earlier batches. Parameterized calls cannot span GO batches. " +
        "PRINT output, low-severity RAISERROR, and engine warnings are returned in a `messages` array.",
      inputSchema: {
        type: "object",
        properties: extendProps({
          query: { type: "string" },
          params: {
            type: "array",
            items: {},
            description: "Optional array of parameter values for parameterized queries. Use ? placeholders in the query string.",
          },
        }),
        required: ["query"],
      },
    },
    {
      name: "create_table",
      description: "Create new tables in the database",
      inputSchema: {
        type: "object",
        properties: extendProps({ query: { type: "string" } }),
        required: ["query"],
      },
    },
    {
      name: "alter_table",
      description: "Modify existing table schema (add columns, rename tables, etc.)",
      inputSchema: {
        type: "object",
        properties: extendProps({ query: { type: "string" } }),
        required: ["query"],
      },
    },
    {
      name: "drop_table",
      description: "Remove a table from the database with safety confirmation",
      inputSchema: {
        type: "object",
        properties: extendProps({
          table_name: { type: "string" },
          confirm: { type: "boolean" },
        }),
        required: ["table_name", "confirm"],
      },
    },
    {
      name: "export_query",
      description: "Export query results to various formats (CSV, JSON, or TOON)",
      inputSchema: {
        type: "object",
        properties: extendProps({
          query: { type: "string" },
          format: { type: "string", enum: ["csv", "json", "toon"] },
        }),
        required: ["query", "format"],
      },
    },
    {
      name: "list_tables",
      description: "Get a list of all tables in the database",
      inputSchema: {
        type: "object",
        properties: extendProps({
          format: {
            type: "string",
            enum: ["json", "toon"],
            description: "(optional) Output encoding. 'toon' (default) emits Token-Oriented Object Notation for fewer LLM tokens. Pass 'json' to opt back into the legacy pretty-printed JSON shape.",
          },
        }),
      },
    },
    {
      name: "describe_table",
      description: "View schema information for a specific table",
      inputSchema: {
        type: "object",
        properties: extendProps({
          table_name: { type: "string" },
          format: {
            type: "string",
            enum: ["json", "toon"],
            description: "(optional) Output encoding. 'toon' (default) emits Token-Oriented Object Notation for fewer LLM tokens. Pass 'json' to opt back into the legacy pretty-printed JSON shape.",
          },
        }),
        required: ["table_name"],
      },
    },
  ];

  if (process.env.ALLOW_DDL === 'true') {
    tools.push({
      name: "execute_ddl",
      description:
        "Execute arbitrary DDL / schema-maintenance SQL: CREATE/ALTER/DROP for procedures, functions, views, " +
        "triggers, indexes, etc., plus EXEC sp_rename / sp_addextendedproperty / sp_helptext, semicolon- " +
        "separated multi-statement batches, AND (SQL Server only) GO-separated batches with optional `GO N` " +
        "repeat counts — each GO-batch runs as its own driver call, NOT wrapped in a shared transaction (a " +
        "failure mid-script leaves earlier batches committed). Also the tool for scripted scenarios " +
        "write_query rejects: temp tables, DECLARE variables, explicit BEGIN TRAN ... ROLLBACK, and SELECT " +
        "verification inside one batch. PRINT and low-severity RAISERROR output is returned in a `messages` " +
        "array; result sets the script's SELECTs produced are returned in a `result_sets` array, in statement " +
        "order. Only available when the server is started with " +
        "ALLOW_DDL=true and, in multi-connection mode, the resolved server has \"allowDdl\": true. Use " +
        "write_query for DML parameterization.",
      inputSchema: {
        type: "object",
        properties: extendProps({ query: { type: "string" } }),
        required: ["query"],
      },
    });
  }

  // Insight tools use SQLite-only SQL (AUTOINCREMENT, sqlite_master)
  const currentDbType = getDbType();
  if (currentDbType === 'sqlite') {
    tools.push(
      {
        name: "append_insight",
        description: "Add a business insight to the memo",
        inputSchema: {
          type: "object",
          properties: { insight: { type: "string" } },
          required: ["insight"],
        },
      },
      {
        name: "list_insights",
        description: "List all business insights in the memo",
        inputSchema: {
          type: "object",
          properties: {},
        },
      }
    );
  }

  if (multi) {
    tools.push(
      {
        name: "list_connections",
        description:
          "List all SQL Server connections defined in the registry. Returns servers, databases, and logins " +
          "with their default markers and auth type. Never emits passwords.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "use_connection",
        description:
          "Set the sticky connection (server/database/login) used by subsequent tool calls that do not " +
          "explicitly name a connection. Any subset of server, database, login may be provided — missing " +
          "levels fall back to the registry defaults. Pass `reset: true` to clear the sticky selection " +
          "and return to the registry default. Routing is frozen per request: whichever sticky is in " +
          "effect when a tool call is dispatched governs that entire call, so a use_connection issued " +
          "while another call is in flight cannot reroute it. Explicit server/database/login arguments " +
          "on a tool call always win over the sticky.",
        inputSchema: {
          type: "object",
          properties: {
            server: { type: "string", description: "Target server name. Optional — defaults via registry." },
            database: { type: "string", description: "Target database name. Optional — defaults via registry." },
            login: { type: "string", description: "Login name. Optional — defaults via registry." },
            connectionTimeoutMs: {
              type: "number",
              description: "Connection timeout in milliseconds (e.g., 30000 for 30 seconds). Overrides the config-file value for this sticky session. Only affects newly created connection pools.",
            },
            reset: {
              type: "boolean",
              description: "If true, clear the sticky selection and return the current registry default. Other fields are ignored when reset is true.",
            },
          },
        },
      }
    );
  }

  return { tools };
}

/**
 * Dispatch a tool call. In multi-connection mode, the routing target is resolved
 * once up front and pinned via runWithTarget, so any dbAll/dbRun/dbExec calls
 * inside the tool see the same adapter. The tool functions stay untouched.
 */
export async function handleToolCall(name: string, args: any) {
  try {
    // New registry-level tools — handled outside the override wrapper because
    // they don't touch a data adapter.
    if (name === "list_connections") {
      const reg = getRegistry();
      if (!reg) throw new Error("list_connections is only available in --config mode.");
      const sticky = getStickyConnection();
      return formatSuccessResponse({
        registry: reg.describe(),
        sticky: sticky
          ? { server: sticky.serverName, database: sticky.databaseName, login: sticky.loginName }
          : null,
      });
    }

    if (name === "use_connection") {
      const reset = args?.reset === true;
      const timeoutMs = args?.connectionTimeoutMs != null ? Number(args.connectionTimeoutMs) : undefined;
      const resolved = setStickyConnection({
        server: args?.server,
        database: args?.database,
        login: args?.login,
        connectionTimeoutMs: timeoutMs,
        reset,
      });
      return formatSuccessResponse({
        success: true,
        message: reset
          ? `Sticky connection cleared; default is ${resolved.serverName}/${resolved.databaseName}/${resolved.loginName}`
          : `Sticky connection set to ${resolved.serverName}/${resolved.databaseName}/${resolved.loginName}`,
        reset,
        server: resolved.serverName,
        database: resolved.databaseName,
        login: resolved.loginName,
        auth: resolved.trustedConnection ? 'windows' : 'sql',
        connectionTimeoutMs: timeoutMs ?? resolved.connectionTimeoutMs,
      });
    }

    const dataToolCall = async () => {
      switch (name) {
        case "read_query":
          return await readQuery(args.query, args.params, args.format);

        case "write_query":
          return await writeQuery(args.query, args.params);

        case "execute_ddl":
          return await executeDdl(args.query);

        case "create_table":
          return await createTable(args.query);

        case "alter_table":
          return await alterTable(args.query);

        case "drop_table":
          return await dropTable(args.table_name, args.confirm);

        case "export_query":
          return await exportQuery(args.query, args.format);

        case "list_tables":
          return await listTables(args.format);

        case "describe_table":
          return await describeTable(args.table_name, args.format);

        case "append_insight":
          return await appendInsight(args.insight);

        case "list_insights":
          return await listInsights();

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    };

    if (isMultiConnectionMode()) {
      // Resolve the leaf once, before the tool body runs, and pin it for the
      // whole invocation. Every driver call inside reads that frozen target, so
      // a use_connection arriving mid-flight cannot straddle two leaves.
      const target = resolveCallTarget({
        server: args?.server,
        database: args?.database,
        login: args?.login,
      });
      const result: any = await runWithTarget(target, dataToolCall);
      // Echo the leaf this call actually used, as its own content block so
      // content[0] stays pure CSV/TOON/JSON. A misroute then shows up in the
      // transcript when it happens, not when someone notices missing rows.
      if (!result?.isError && Array.isArray(result?.content)) {
        result.content.push({
          type: "text",
          text: `[routed: ${target.server}/${target.database}/${target.login}]`,
        });
      }
      return result;
    }
    return await dataToolCall();
  } catch (error: any) {
    return formatErrorResponse(error);
  }
}
