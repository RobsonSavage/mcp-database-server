#!/usr/bin/env node

// Node 22+ removed buffer.SlowBuffer, which the ancient buffer-equal-constant-time
// package (pulled in via tedious → jsonwebtoken → jwa) dereferences at module load.
// Shim it before anything else imports mssql, otherwise any SQL Server adapter init
// crashes with "Cannot read properties of undefined (reading 'prototype')".
import { createRequire as __cr } from 'node:module';
{
  const __buf = __cr(import.meta.url)('buffer');
  if (!__buf.SlowBuffer) __buf.SlowBuffer = __buf.Buffer;
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Import database utils
import { initDatabase, initDatabasePool, closeDatabase, getDatabaseMetadata } from './db/index.js';
import { ConnectionRegistry } from './config/loader.js';

// Import handlers
import { handleListResources, handleReadResource } from './handlers/resourceHandlers.js';
import { handleListTools, handleToolCall } from './handlers/toolHandlers.js';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

// Setup a logger that uses stderr instead of stdout to avoid interfering with MCP communications
const logger = {
  log: (...args: any[]) => console.error('[INFO]', ...args),
  error: (...args: any[]) => console.error('[ERROR]', ...args),
  warn: (...args: any[]) => console.error('[WARN]', ...args),
  info: (...args: any[]) => console.error('[INFO]', ...args),
};

// Configure the server
const server = new Server(
  {
    name: "robsonsavage/database-server",
    version: pkg.version,
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length === 0) {
  logger.error("Please provide database connection information");
  logger.error("Usage for SQLite: node index.js <database_file_path>");
  logger.error("Usage for SQL Server: node index.js --sqlserver --server <server> --database <database> [--user <user> --password <password>]");
  logger.error("Usage for SQL Server multi-connection: node index.js --sqlserver --config <path-to-connections.json>");
  logger.error("Usage for PostgreSQL: node index.js --postgresql --host <host> --database <database> [--user <user> --password <password> --port <port>]");
  logger.error("Usage for MySQL: node index.js --mysql --host <host> --database <database> [--user <user> --password <password> --port <port>]");
  logger.error("Usage for MySQL with AWS IAM: node index.js --mysql --aws-iam-auth --host <rds-endpoint> --database <database> --user <aws-username> --aws-region <region>");
  process.exit(1);
}

// Parse arguments to determine database type and connection info
let dbType = 'sqlite';
let connectionInfo: any = null;
let connectionRegistry: ConnectionRegistry | null = null;
let configPath: string | null = null;

function consumeArgValue(args: string[], i: number, flag: string): string {
  if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
    logger.error(`Error: ${flag} requires a value`);
    process.exit(1);
  }
  return args[i + 1];
}

// Check if using SQL Server
if (args.includes('--sqlserver')) {
  dbType = 'sqlserver';

  // --config takes precedence and switches to multi-connection mode.
  const configIdx = args.indexOf('--config');
  if (configIdx !== -1 && configIdx + 1 < args.length) {
    configPath = args[configIdx + 1];

    // Reject legacy flags when --config is used. Mixing the two modes would
    // silently ignore one set of settings — better to fail fast.
    const legacyFlags = ['--server', '--database', '--user', '--password', '--port'];
    const conflicts = legacyFlags.filter(f => args.includes(f));
    if (conflicts.length > 0) {
      logger.error(
        `Error: --config cannot be combined with legacy flags (${conflicts.join(', ')}). ` +
        `Move all connection details into the JSON config file.`
      );
      process.exit(1);
    }

    try {
      connectionRegistry = ConnectionRegistry.load(configPath);
    } catch (err) {
      logger.error(`Error loading connection config: ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    connectionInfo = {
      server: '',
      database: '',
      user: undefined,
      password: undefined
    };

    // Parse SQL Server connection parameters
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--server') {
        connectionInfo.server = consumeArgValue(args, i, '--server');
      } else if (args[i] === '--database') {
        connectionInfo.database = consumeArgValue(args, i, '--database');
      } else if (args[i] === '--user') {
        connectionInfo.user = consumeArgValue(args, i, '--user');
      } else if (args[i] === '--password') {
        connectionInfo.password = consumeArgValue(args, i, '--password');
      } else if (args[i] === '--port') {
        connectionInfo.port = parseInt(consumeArgValue(args, i, '--port'), 10);
      }
    }

    // Validate SQL Server connection info
    if (!connectionInfo.server || !connectionInfo.database) {
      logger.error("Error: SQL Server requires --server and --database parameters (or use --config <path>)");
      process.exit(1);
    }
  }
} 
// Check if using PostgreSQL
else if (args.includes('--postgresql') || args.includes('--postgres')) {
  dbType = 'postgresql';
  connectionInfo = {
    host: '',
    database: '',
    user: undefined,
    password: undefined,
    port: undefined,
    ssl: undefined,
    connectionTimeoutMs: undefined
  };
  
  // Parse PostgreSQL connection parameters
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--host') {
      connectionInfo.host = consumeArgValue(args, i, '--host');
    } else if (args[i] === '--database') {
      connectionInfo.database = consumeArgValue(args, i, '--database');
    } else if (args[i] === '--user') {
      connectionInfo.user = consumeArgValue(args, i, '--user');
    } else if (args[i] === '--password') {
      connectionInfo.password = consumeArgValue(args, i, '--password');
    } else if (args[i] === '--port') {
      connectionInfo.port = parseInt(consumeArgValue(args, i, '--port'), 10);
    } else if (args[i] === '--ssl') {
      connectionInfo.ssl = consumeArgValue(args, i, '--ssl') === 'true';
    } else if (args[i] === '--connection-timeout') {
      connectionInfo.connectionTimeoutMs = parseInt(consumeArgValue(args, i, '--connection-timeout'), 10);
    }
  }
  
  // Validate PostgreSQL connection info
  if (!connectionInfo.host || !connectionInfo.database) {
    logger.error("Error: PostgreSQL requires --host and --database parameters");
    process.exit(1);
  }
}
// Check if using MySQL
else if (args.includes('--mysql')) {
  dbType = 'mysql';
  connectionInfo = {
    host: '',
    database: '',
    user: undefined,
    password: undefined,
    port: undefined,
    ssl: undefined,
    connectionTimeoutMs: undefined,
    awsIamAuth: false,
    awsRegion: undefined
  };
  // Parse MySQL connection parameters
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--host') {
      connectionInfo.host = consumeArgValue(args, i, '--host');
    } else if (args[i] === '--database') {
      connectionInfo.database = consumeArgValue(args, i, '--database');
    } else if (args[i] === '--user') {
      connectionInfo.user = consumeArgValue(args, i, '--user');
    } else if (args[i] === '--password') {
      connectionInfo.password = consumeArgValue(args, i, '--password');
    } else if (args[i] === '--port') {
      connectionInfo.port = parseInt(consumeArgValue(args, i, '--port'), 10);
    } else if (args[i] === '--ssl') {
      const sslVal = consumeArgValue(args, i, '--ssl');
      if (sslVal === 'true') connectionInfo.ssl = true;
      else if (sslVal === 'false') connectionInfo.ssl = false;
      else connectionInfo.ssl = sslVal;
    } else if (args[i] === '--connection-timeout') {
      connectionInfo.connectionTimeoutMs = parseInt(consumeArgValue(args, i, '--connection-timeout'), 10);
    } else if (args[i] === '--aws-iam-auth') {
      connectionInfo.awsIamAuth = true;
    } else if (args[i] === '--aws-region') {
      connectionInfo.awsRegion = consumeArgValue(args, i, '--aws-region');
    }
  }
  // Validate MySQL connection info
  if (!connectionInfo.host || !connectionInfo.database) {
    logger.error("Error: MySQL requires --host and --database parameters");
    process.exit(1);
  }
  
  // Additional validation for AWS IAM authentication
  if (connectionInfo.awsIamAuth) {
    if (!connectionInfo.user) {
      logger.error("Error: AWS IAM authentication requires --user parameter");
      process.exit(1);
    }
    if (!connectionInfo.awsRegion) {
      logger.error("Error: AWS IAM authentication requires --aws-region parameter");
      process.exit(1);
    }
    // Automatically enable SSL for AWS IAM authentication (required)
    connectionInfo.ssl = true;
    logger.info("AWS IAM authentication enabled - SSL automatically configured");
  }
} else {
  // SQLite mode (default)
  dbType = 'sqlite';
  connectionInfo = args[0]; // First argument is the SQLite file path
  logger.info(`Using SQLite database at path: ${connectionInfo}`);
}

// Set up request handlers
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return await handleListResources();
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  return await handleReadResource(request.params.uri);
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return handleListTools();
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return await handleToolCall(request.params.name, request.params.arguments);
});

// Handle shutdown gracefully
process.on('SIGINT', async () => {
  logger.info('Shutting down gracefully...');
  await closeDatabase();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down gracefully...');
  await closeDatabase();
  process.exit(0);
});

// Add global error handler — exit after logging since Node is in undefined state
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

/**
 * Start the server
 */
async function runServer() {
  try {
    logger.info(`Initializing ${dbType} database...`);
    if (dbType === 'sqlite') {
      logger.info(`Database path: ${connectionInfo}`);
    } else if (dbType === 'sqlserver') {
      if (connectionRegistry) {
        logger.info(`Multi-connection mode: loaded ${configPath}`);
      } else {
        logger.info(`Server: ${connectionInfo.server}, Database: ${connectionInfo.database}`);
      }
    } else if (dbType === 'postgresql') {
      logger.info(`Host: ${connectionInfo.host}, Database: ${connectionInfo.database}`);
    } else if (dbType === 'mysql') {
      logger.info(`Host: ${connectionInfo.host}, Database: ${connectionInfo.database}`);
    }

    // Initialize the database
    if (connectionRegistry) {
      await initDatabasePool(connectionRegistry);
      const description = connectionRegistry.describe();
      const leafCount = description.servers.reduce(
        (sum, s) => sum + s.databases.reduce((dSum, d) => dSum + d.logins.length, 0),
        0
      );
      logger.info(`Connection registry ready (${description.servers.length} servers, ${leafCount} total connections).`);
    } else {
      await initDatabase(connectionInfo, dbType);
      const dbInfo = await getDatabaseMetadata();
      logger.info(`Connected to ${dbInfo.name} database`);
    }

    logger.info('Starting MCP server...');
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info('Server running. Press Ctrl+C to exit.');
  } catch (error) {
    logger.error("Failed to initialize:", error);
    process.exit(1);
  }
}

// Start the server
runServer().catch(error => {
  logger.error("Server initialization failed:", error);
  process.exit(1);
}); 