import { formatErrorResponse, formatSuccessResponse } from '../utils/formatUtils.js';

// Import all tool implementations
import { readQuery, writeQuery, exportQuery, executeDdl } from '../tools/queryTools.js';
import { createTable, alterTable, dropTable, listTables, describeTable } from '../tools/schemaTools.js';
import { appendInsight, listInsights } from '../tools/insightTools.js';

// Multi-connection plumbing
import {
  isMultiConnectionMode,
  runWithOverride,
  setStickyConnection,
  getStickyConnection,
  getRegistry,
  getDbType,
} from '../db/index.js';

/**
 * Optional connection-selection properties added to every tool's inputSchema when
 * multi-connection mode is active. Each field is independent and optional — missing
 * levels fall through to the sticky selection (set by use_connection) and then to
 * the registry defaults.
 */
const CONNECTION_PROPS = {
  server: {
    type: "string",
    description: "(optional) Target server name from the connection registry. Falls back to sticky or default.",
  },
  database: {
    type: "string",
    description: "(optional) Target database name on that server. Falls back to sticky or default.",
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
        }),
        required: ["query"],
      },
    },
    {
      name: "write_query",
      description: "Execute INSERT, UPDATE, or DELETE queries",
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
      description: "Export query results to various formats (CSV, JSON)",
      inputSchema: {
        type: "object",
        properties: extendProps({
          query: { type: "string" },
          format: { type: "string", enum: ["csv", "json"] },
        }),
        required: ["query", "format"],
      },
    },
    {
      name: "list_tables",
      description: "Get a list of all tables in the database",
      inputSchema: {
        type: "object",
        properties: extendProps({}),
      },
    },
    {
      name: "describe_table",
      description: "View schema information for a specific table",
      inputSchema: {
        type: "object",
        properties: extendProps({ table_name: { type: "string" } }),
        required: ["table_name"],
      },
    },
  ];

  if (process.env.ALLOW_DDL === 'true') {
    tools.push({
      name: "execute_ddl",
      description:
        "Execute a DDL statement (CREATE/ALTER/DROP for procedures, functions, views, triggers, indexes, etc.). " +
        "Only available when the server is started with ALLOW_DDL=true. Accepts a single statement starting " +
        "with CREATE, ALTER, or DROP. Use write_query for DML and the dedicated table tools for table DDL.",
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
          "and return to the registry default. Note: use_connection should be called and awaited before " +
          "subsequent tool calls. Concurrent calls may see non-deterministic routing.",
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
 * Dispatch a tool call. In multi-connection mode, tool invocations are wrapped
 * in runWithOverride so that any dbAll/dbRun/dbExec calls inside the tool see
 * the right adapter. The tool functions themselves stay untouched.
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
          return await readQuery(args.query, args.params);

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
          return await listTables();

        case "describe_table":
          return await describeTable(args.table_name);

        case "append_insight":
          return await appendInsight(args.insight);

        case "list_insights":
          return await listInsights();

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    };

    if (isMultiConnectionMode()) {
      return await runWithOverride(
        { server: args?.server, database: args?.database, login: args?.login },
        dataToolCall
      );
    }
    return await dataToolCall();
  } catch (error: any) {
    return formatErrorResponse(error);
  }
}
