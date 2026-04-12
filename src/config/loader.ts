import { readFileSync } from 'fs';

/**
 * Hierarchical SQL Server connection registry loaded from a JSON config file.
 *
 * Shape:
 * {
 *   "servers": {
 *     "<server-name>": {
 *       "default"?: true,
 *       "trustServerCertificate"?: boolean,
 *       "port"?: number,
 *       "connectionTimeoutMs"?: number,   // milliseconds, default 15000
 *       "options"?: object,
 *       "databases": {
 *         "<database-name>": {
 *           "default"?: true,
 *           "logins": {
 *             "<login-name>": {
 *               "default"?: true,
 *               "user"?: string,
 *               "password"?: string,
 *               "trustedConnection"?: boolean,
 *               "trustServerCertificate"?: boolean,
 *               "port"?: number,
 *               "connectionTimeoutMs"?: number,   // milliseconds, overrides server-level
 *               "options"?: object
 *             }
 *           }
 *         }
 *       }
 *     }
 *   }
 * }
 *
 * Defaults apply independently at each level (server, database, login).
 * Exactly one `default: true` is required per level that has more than one sibling.
 *
 * Env-var indirection:
 *   `user` and `password` may be either a literal string or a reference of the form
 *   `${env:VAR_NAME}`. References are resolved lazily from `process.env` when a
 *   connection is actually opened, so the registry file never has to contain
 *   plaintext credentials. Missing/empty env vars throw at resolve() time.
 */

export interface LoginConfig {
  default?: boolean;
  user?: string;
  password?: string;
  trustedConnection?: boolean;
  trustServerCertificate?: boolean;
  /** Enable Multiple Active Result Sets. Overrides server-level value. */
  multipleActiveResultSets?: boolean;
  /** ODBC driver name for msnodesqlv8 (e.g. "ODBC Driver 18 for SQL Server"). Overrides server-level value. */
  driver?: string;
  port?: number;
  /** Connection timeout in milliseconds. Overrides server-level value. */
  connectionTimeoutMs?: number;
  options?: Record<string, unknown>;
}

export interface DatabaseConfig {
  default?: boolean;
  logins: Record<string, LoginConfig>;
}

export interface ServerConfig {
  default?: boolean;
  trustServerCertificate?: boolean;
  /** Enable Multiple Active Result Sets. Applied to all logins unless overridden. Default: true. */
  multipleActiveResultSets?: boolean;
  /** ODBC driver name for msnodesqlv8 Windows auth. Applied to all logins unless overridden. */
  driver?: string;
  port?: number;
  /** Connection timeout in milliseconds. Applied to all logins unless overridden. Default: 15000. */
  connectionTimeoutMs?: number;
  options?: Record<string, unknown>;
  databases: Record<string, DatabaseConfig>;
}

export interface ConnectionRegistryFile {
  servers: Record<string, ServerConfig>;
}

/** A fully resolved connection, merged from server + database + login fields. */
export interface ResolvedConnection {
  serverName: string;
  databaseName: string;
  loginName: string;
  /** Unique key used to cache a pool per resolved leaf. */
  key: string;
  server: string;
  database: string;
  port: number;
  /** Connection timeout in milliseconds. */
  connectionTimeoutMs: number;
  trustServerCertificate: boolean;
  multipleActiveResultSets: boolean;
  options?: Record<string, unknown>;
  trustedConnection: boolean;
  /** ODBC driver name for msnodesqlv8 (e.g. "ODBC Driver 18 for SQL Server"). */
  driver?: string;
  user?: string;
  password?: string;
}

/** Loads and validates a connection registry JSON file. */
export class ConnectionRegistry {
  private constructor(private readonly file: ConnectionRegistryFile) {}

  static load(configPath: string): ConnectionRegistry {
    let raw: string;
    try {
      raw = readFileSync(configPath, 'utf8');
    } catch (err) {
      throw new Error(`Cannot read connection config at '${configPath}': ${(err as Error).message}`);
    }

    let parsed: ConnectionRegistryFile;
    try {
      parsed = JSON.parse(raw) as ConnectionRegistryFile;
    } catch (err) {
      throw new Error(`Invalid JSON in connection config '${configPath}': ${(err as Error).message}`);
    }

    validate(parsed, configPath);
    return new ConnectionRegistry(parsed);
  }

  /** Raw file shape, for diagnostic dumps. Never exposes passwords to callers who don't already have the file. */
  getFile(): ConnectionRegistryFile {
    return this.file;
  }

  /**
   * Resolve (serverName?, databaseName?, loginName?) to a concrete leaf, walking defaults
   * when any level is missing.
   */
  resolve(serverName?: string, databaseName?: string, loginName?: string): ResolvedConnection {
    const serverEntry = pickServer(this.file.servers, serverName);
    const dbEntry = pickDatabase(serverEntry.name, serverEntry.value.databases, databaseName);
    const loginEntry = pickLogin(serverEntry.name, dbEntry.name, dbEntry.value.logins, loginName);

    const server = serverEntry.value;
    const database = dbEntry.value;
    const login = loginEntry.value;

    const trustedConnection = login.trustedConnection === true;
    if (!trustedConnection && (!login.user || !login.password)) {
      throw new Error(
        `Login '${loginEntry.name}' under '${serverEntry.name}/${dbEntry.name}' must set either ` +
        `trustedConnection: true or both user and password.`
      );
    }

    const fieldPrefix =
      `servers['${serverEntry.name}'].databases['${dbEntry.name}'].logins['${loginEntry.name}']`;
    const resolvedUser = trustedConnection
      ? undefined
      : resolveEnvRef(login.user, { strict: true, fieldLabel: `${fieldPrefix}.user` });
    const resolvedPassword = trustedConnection
      ? undefined
      : resolveEnvRef(login.password, { strict: true, fieldLabel: `${fieldPrefix}.password` });

    return {
      serverName: serverEntry.name,
      databaseName: dbEntry.name,
      loginName: loginEntry.name,
      key: `${serverEntry.name}/${dbEntry.name}/${loginEntry.name}`,
      server: serverEntry.name,
      database: dbEntry.name,
      port: login.port ?? server.port ?? 1433,
      connectionTimeoutMs: login.connectionTimeoutMs ?? server.connectionTimeoutMs ?? 15000,
      trustServerCertificate: login.trustServerCertificate ?? server.trustServerCertificate ?? false,
      multipleActiveResultSets: login.multipleActiveResultSets ?? server.multipleActiveResultSets ?? true,
      options: { ...(server.options ?? {}), ...(login.options ?? {}) },
      trustedConnection,
      driver: login.driver ?? server.driver,
      user: resolvedUser,
      password: resolvedPassword,
    };
  }

  /** Safe listing for the list_connections tool — passwords stripped. */
  describe() {
    const servers: Array<{
      name: string;
      default: boolean;
      databases: Array<{
        name: string;
        default: boolean;
        logins: Array<{
          name: string;
          default: boolean;
          auth: 'windows' | 'sql';
          user?: string;
        }>;
      }>;
    }> = [];

    for (const [serverName, serverCfg] of Object.entries(this.file.servers)) {
      servers.push({
        name: serverName,
        default: serverCfg.default === true,
        databases: Object.entries(serverCfg.databases).map(([dbName, dbCfg]) => ({
          name: dbName,
          default: dbCfg.default === true,
          logins: Object.entries(dbCfg.logins).map(([loginName, login]) => ({
            name: loginName,
            default: login.default === true,
            auth: login.trustedConnection ? ('windows' as const) : ('sql' as const),
            user: login.trustedConnection
              ? undefined
              : resolveEnvRef(login.user, { strict: false }),
          })),
        })),
      });
    }
    return { servers };
  }
}

function validate(file: ConnectionRegistryFile, configPath: string): void {
  if (!file || typeof file !== 'object' || !file.servers || typeof file.servers !== 'object') {
    throw new Error(`${configPath}: top-level 'servers' object is required.`);
  }

  const serverEntries = Object.entries(file.servers);
  if (serverEntries.length === 0) {
    throw new Error(`${configPath}: at least one server must be defined under 'servers'.`);
  }

  // Default rule: exactly one default when siblings > 1.
  requireSingleDefault(serverEntries, 'servers', configPath);

  for (const [serverName, serverCfg] of serverEntries) {
    if (!serverCfg.databases || typeof serverCfg.databases !== 'object') {
      throw new Error(`${configPath}: servers['${serverName}'].databases is required.`);
    }
    const dbEntries = Object.entries(serverCfg.databases);
    if (dbEntries.length === 0) {
      throw new Error(`${configPath}: servers['${serverName}'].databases must have at least one entry.`);
    }
    requireSingleDefault(dbEntries, `servers['${serverName}'].databases`, configPath);

    for (const [dbName, dbCfg] of dbEntries) {
      if (!dbCfg.logins || typeof dbCfg.logins !== 'object') {
        throw new Error(
          `${configPath}: servers['${serverName}'].databases['${dbName}'].logins is required.`
        );
      }
      const loginEntries = Object.entries(dbCfg.logins);
      if (loginEntries.length === 0) {
        throw new Error(
          `${configPath}: servers['${serverName}'].databases['${dbName}'].logins must have at least one entry.`
        );
      }
      requireSingleDefault(
        loginEntries,
        `servers['${serverName}'].databases['${dbName}'].logins`,
        configPath
      );

      for (const [loginName, loginCfg] of loginEntries) {
        const trusted = loginCfg.trustedConnection === true;
        if (!trusted && (!loginCfg.user || !loginCfg.password)) {
          throw new Error(
            `${configPath}: servers['${serverName}'].databases['${dbName}'].logins['${loginName}'] ` +
            `must set trustedConnection: true OR both user and password.`
          );
        }
      }
    }
  }
}

function requireSingleDefault(
  entries: Array<[string, { default?: boolean }]>,
  path: string,
  configPath: string
): void {
  if (entries.length <= 1) return;
  const defaults = entries.filter(([, v]) => v.default === true).map(([k]) => k);
  if (defaults.length === 0) {
    throw new Error(
      `${configPath}: ${path}: expected exactly one entry with "default": true, found none. ` +
      `Candidates: ${entries.map(([k]) => k).join(', ')}`
    );
  }
  if (defaults.length > 1) {
    throw new Error(
      `${configPath}: ${path}: expected exactly one entry with "default": true, found ${defaults.length} ` +
      `(${defaults.join(', ')}).`
    );
  }
}

function pickServer(
  servers: Record<string, ServerConfig>,
  explicit?: string
): { name: string; value: ServerConfig } {
  if (explicit != null) {
    const value = servers[explicit];
    if (!value) {
      throw new Error(
        `Unknown server '${explicit}'. Available: ${Object.keys(servers).join(', ')}`
      );
    }
    return { name: explicit, value };
  }
  return pickDefault(servers, 'server');
}

function pickDatabase(
  serverName: string,
  databases: Record<string, DatabaseConfig>,
  explicit?: string
): { name: string; value: DatabaseConfig } {
  if (explicit != null) {
    const value = databases[explicit];
    if (!value) {
      throw new Error(
        `Database '${explicit}' not found on server '${serverName}'. ` +
        `Available: ${Object.keys(databases).join(', ')}`
      );
    }
    return { name: explicit, value };
  }
  return pickDefault(databases, `database on server '${serverName}'`);
}

function pickLogin(
  serverName: string,
  databaseName: string,
  logins: Record<string, LoginConfig>,
  explicit?: string
): { name: string; value: LoginConfig } {
  if (explicit != null) {
    const value = logins[explicit];
    if (!value) {
      throw new Error(
        `Login '${explicit}' not found on '${serverName}/${databaseName}'. ` +
        `Available: ${Object.keys(logins).join(', ')}`
      );
    }
    return { name: explicit, value };
  }
  return pickDefault(logins, `login on '${serverName}/${databaseName}'`);
}

const ENV_REF_PATTERN = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Resolve a `${env:VAR_NAME}` reference against `process.env`. Literal values
 * (anything not matching the pattern) are returned unchanged. In strict mode a
 * missing/empty env var throws; otherwise the original literal is returned so
 * diagnostic output (e.g. list_connections) can fall back gracefully.
 */
function resolveEnvRef(
  value: string | undefined,
  options: { strict: boolean; fieldLabel?: string }
): string | undefined {
  if (value == null) return undefined;
  const match = ENV_REF_PATTERN.exec(value);
  if (!match) return value;
  const envName = match[1];
  const envValue = process.env[envName];
  if (envValue == null || envValue === '') {
    if (options.strict) {
      throw new Error(
        `${options.fieldLabel ?? 'field'} references env var '${envName}' but it is not set or is empty.`
      );
    }
    return '<env var not set>';
  }
  return envValue;
}

function pickDefault<T extends { default?: boolean }>(
  entries: Record<string, T>,
  levelLabel: string
): { name: string; value: T } {
  const list = Object.entries(entries);
  if (list.length === 1) {
    return { name: list[0][0], value: list[0][1] };
  }
  const found = list.find(([, v]) => v.default === true);
  if (!found) {
    throw new Error(
      `No default ${levelLabel} configured and none specified. Candidates: ${list.map(([k]) => k).join(', ')}`
    );
  }
  return { name: found[0], value: found[1] };
}
