import type { FastifyBaseLogger } from "fastify";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { env } from "../config/env.js";
import type { HistorianColumnRename, LoggerDatabase } from "../db/database.js";
import type {
  Device,
  PostgresSettingsInput,
  ReadingInsert,
  RegisterDefinition,
} from "../types/domain.js";
import { decryptSecret, encryptSecret } from "./secret-box.js";
import type { SystemAlertService } from "./system-alerts.js";

const TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
const OFFLINE_CACHE_WARNING_INTERVAL_MS = 60_000;
const POSTGRES_STATEMENT_TIMEOUT_MS = 15_000;
const POSTGRES_QUERY_TIMEOUT_MS = 20_000;
const POSTGRES_LOCK_TIMEOUT_MS = 5_000;
const POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS = 30_000;
const HISTORIAN_DRAIN_TIMEOUT_MS = 35_000;

interface RuntimePostgresSettings extends PostgresSettingsInput {
  password: string;
  source: "saved" | "environment" | "none";
}

export interface PublicPostgresSettings extends Omit<
  PostgresSettingsInput,
  "password"
> {
  configured: boolean;
  passwordConfigured: boolean;
  source: RuntimePostgresSettings["source"];
  lastConnectionTestAt: string | null;
  lastConnectionTestOk: boolean | null;
  lastConnectionTestMessage: string | null;
  lastMaintenanceAt: string | null;
  lastMaintenanceRawDeleted: number;
  lastMaintenanceDownsampleDeleted: number;
  offlineCacheQueuedRows: number;
  offlineCacheOldestAt: string | null;
  lastReplayAt: string | null;
  lastReplayCount: number;
  updatedAt: string | null;
}

export interface PostgresConnectionTestResult {
  ok: boolean;
  message: string;
  serverVersion?: string;
  database?: string;
  username?: string;
  canConnect?: boolean;
  canUseSchema?: boolean;
  canCreateTables?: boolean;
}

export interface PostgresMaintenanceResult {
  skipped: boolean;
  message: string;
  rawDeleted: number;
  downsampleDeleted: number;
  completedAt: string;
}

export interface PostgresOfflineReplayResult {
  status:
    "disabled" | "idle" | "completed" | "paused" | "unavailable" | "error";
  message: string;
  queuedRows: number;
  replayedRows: number;
  discardedRows: number;
  pausedRows: number;
  remainingRows: number;
  remainingEligibleRows: number;
  completedAt: string;
}

export interface HistorianSchemaSyncResult {
  ok: boolean;
  message: string;
  addedColumns: string[];
  changedColumns: string[];
  orphanedColumns: string[];
  droppedColumns: string[];
  syncedAt: string | null;
}

export interface PostgresDeviceConnectionResult {
  connected: boolean;
  message: string;
  device: Device;
  schema?: HistorianSchemaSyncResult;
}

export class HistorianSchemaConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistorianSchemaConflictError";
  }
}

export class HistorianAdministrationPausedError extends Error {
  constructor() {
    super("Remote PostgreSQL administration is temporarily paused");
    this.name = "HistorianAdministrationPausedError";
  }
}

export class HistorianDrainTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Remote PostgreSQL work did not drain within ${timeoutMs} ms; system administration was not started`,
    );
    this.name = "HistorianDrainTimeoutError";
  }
}

export class HistorianSchemaWarningTracker {
  private readonly warnedDeviceIds = new Set<string>();

  shouldWarn(deviceId: string): boolean {
    if (this.warnedDeviceIds.has(deviceId)) return false;
    this.warnedDeviceIds.add(deviceId);
    return true;
  }

  reset(deviceId: string): void {
    this.warnedDeviceIds.delete(deviceId);
  }

  clear(): void {
    this.warnedDeviceIds.clear();
  }
}

export function historianSaveIsDue(
  lastSavedAtMs: number | undefined,
  sampleAtMs: number,
  saveIntervalMs: number,
): boolean {
  if (lastSavedAtMs === undefined) return true;
  if (sampleAtMs < lastSavedAtMs) return false;
  return (
    Math.floor(sampleAtMs / saveIntervalMs) >
    Math.floor(lastSavedAtMs / saveIntervalMs)
  );
}

export function historianNumericType(decimalPlaces: number): string {
  if (
    !Number.isInteger(decimalPlaces) ||
    decimalPlaces < 0 ||
    decimalPlaces > 10
  ) {
    throw new Error("Historian decimal places must be between 0 and 10");
  }
  return `NUMERIC(30, ${decimalPlaces})`;
}

export function roundHistorianValue(
  value: number | null,
  decimalPlaces: number,
): number | null {
  historianNumericType(decimalPlaces);
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** decimalPlaces;
  const magnitude = Math.abs(value);
  const rounded =
    Math.round((magnitude + Number.EPSILON * Math.max(1, magnitude)) * factor) /
    factor;
  return Math.sign(value) * rounded;
}

export function isPostgresAvailabilityError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code : "";
  if (
    [
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "EPIPE",
      "57P01",
      "57P02",
      "57P03",
    ].includes(code) ||
    code.startsWith("08")
  ) {
    return true;
  }
  const message =
    typeof candidate.message === "string"
      ? candidate.message.toLowerCase()
      : "";
  return [
    "connection refused",
    "connection terminated",
    "connection timeout",
    "connection timed out",
    "query read timeout",
    "server closed the connection",
    "socket hang up",
    "network is unreachable",
    "getaddrinfo",
  ].some((fragment) => message.includes(fragment));
}

export function isPostgresSchemaMissingError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "42P01" || code === "42703";
}

export function configuredHistorianColumns(
  registers: RegisterDefinition[],
): Array<{ name: string; decimalPlaces: number }> {
  return [
    ...new Map(
      registers.map((register) => [
        register.historianColumn,
        {
          name: register.historianColumn,
          decimalPlaces: register.decimalPlaces,
        },
      ]),
    ).values(),
  ].sort((left, right) => left.name.localeCompare(right.name));
}

export function planHistorianColumnRenames(
  tableName: string,
  existingColumns: string[],
  pendingRenames: HistorianColumnRename[],
): HistorianColumnRename[] {
  const existing = new Set(existingColumns);
  const planned: HistorianColumnRename[] = [];
  for (const rename of pendingRenames) {
    const hasSource = existing.has(rename.from);
    const hasTarget = existing.has(rename.to);
    if (hasSource && hasTarget) {
      throw new HistorianSchemaConflictError(
        `Table ${tableName} contains both the previous column ${rename.from} and requested column ${rename.to}. Back up the table and resolve the duplicate columns before synchronizing; the collector will not merge values automatically.`,
      );
    }
    if (!hasSource || hasTarget) continue;
    planned.push(rename);
    existing.delete(rename.from);
    existing.add(rename.to);
  }
  return planned;
}

function identifier(value: string): string {
  if (!TABLE_NAME_PATTERN.test(value)) {
    throw new Error(`Invalid PostgreSQL table name: ${value}`);
  }
  return `"${value}"`;
}

function existingIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function buildExactHistorianCreateSql(
  tableName: string,
  columns: Array<{ name: string; decimalPlaces: number }>,
): string {
  const tagDefinitions = columns.map(
    (column) =>
      `${identifier(column.name)} ${historianNumericType(column.decimalPlaces)}`,
  );
  return `CREATE TABLE ${identifier(tableName)} (
           "timestamp" TIMESTAMPTZ PRIMARY KEY${tagDefinitions.length > 0 ? `,\n           ${tagDefinitions.join(",\n           ")}` : ""}
         )`;
}

export function buildLastValueDownsampleSql(
  rawTableName: string,
  downsampleTableName: string,
  columns: string[],
): string {
  const rawTable = identifier(rawTableName);
  const downsampleTable = identifier(downsampleTableName);
  const columnNames = columns.map(identifier);
  if (columnNames.length === 0) {
    throw new Error("At least one historian tag column is required");
  }
  const latestValues = columnNames.map(
    (column) =>
      `(SELECT source.${column}
          FROM ${rawTable} AS source
          WHERE source."timestamp" >= bucket.bucket_start
            AND source."timestamp" <
              bucket.bucket_start + ($2 * INTERVAL '1 second')
            AND source.${column} IS NOT NULL
          ORDER BY source."timestamp" DESC
          LIMIT 1)`,
  );
  const qualityFlags = columnNames.map(
    (column) =>
      `(SELECT CASE WHEN COUNT(*) > 0 THEN 'good' ELSE 'stale' END
          FROM ${rawTable} AS source
          WHERE source."timestamp" >= bucket.bucket_start
            AND source."timestamp" <
              bucket.bucket_start + ($2 * INTERVAL '1 second')
            AND source.${column} IS NOT NULL)`,
  );
  const updateAssignments = columnNames.map(
    (column) =>
      `${column} = COALESCE(EXCLUDED.${column}, ${downsampleTable}.${column})`,
  );
  return `INSERT INTO ${downsampleTable} (
         "timestamp", ${columnNames.join(", ")}, data_quality
       )
       SELECT
         bucket.bucket_start,
         ${latestValues.join(", ")},
         CASE WHEN ${qualityFlags[0]} = 'good' THEN 'good' ELSE 'stale' END
       FROM (
         SELECT to_timestamp(
           floor(extract(epoch FROM $1::timestamptz) / $2) * $2
         ) AS bucket_start
       ) AS bucket
       ON CONFLICT ("timestamp") DO UPDATE SET
         ${columnNames.map((column) => `${column} = COALESCE(EXCLUDED.${column}, ${downsampleTable}.${column})`).join(", ")},
         data_quality = CASE WHEN ${qualityFlags[0]} = 'good' THEN EXCLUDED.data_quality ELSE ${downsampleTable}.data_quality END`;
}

function defaultSettings(): RuntimePostgresSettings {
  return {
    enabled: false,
    host: "",
    port: 5432,
    database: "modbus_logger",
    username: "logger",
    password: "",
    sslMode: "require",
    historianTimezone: "UTC",
    autoDownsampleEnabled: true,
    defaultRawTable: "modbus_raw",
    defaultDownsampleTable: "modbus_1m",
    defaultDownsampleIntervalSec: 60,
    rawRetentionDays: 30,
    downsampleRetentionDays: 365,
    maintenanceIntervalHours: 24,
    offlineCacheEnabled: true,
    offlineCacheMaxRows: 100_000,
    source: "none",
  };
}

function environmentSettings(): RuntimePostgresSettings | null {
  if (!env.postgresUrl) return null;
  const url = new URL(env.postgresUrl);
  return {
    ...defaultSettings(),
    enabled: true,
    host: url.hostname,
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    sslMode: env.postgresSsl ? "verify-full" : "disable",
    source: "environment",
  };
}

function poolConfig(settings: RuntimePostgresSettings): PoolConfig {
  return {
    host: settings.host,
    port: settings.port,
    database: settings.database,
    user: settings.username,
    password: settings.password || undefined,
    ssl:
      settings.sslMode === "disable"
        ? false
        : {
            rejectUnauthorized: settings.sslMode === "verify-full",
          },
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: POSTGRES_STATEMENT_TIMEOUT_MS,
    query_timeout: POSTGRES_QUERY_TIMEOUT_MS,
    lock_timeout: POSTGRES_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS,
    application_name: "modbus-data-logger-v1",
  };
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replaceAll(/postgres(?:ql)?:\/\/[^\s]+/gi, "[connection]")
    .replaceAll(/password\s*=\s*[^\s]+/gi, "password=[hidden]")
    .slice(0, 500);
}

function parseQueuedReadings(value: string): ReadingInsert[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const readings = parsed.filter(
      (item): item is ReadingInsert =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as ReadingInsert).registerId === "string" &&
        typeof (item as ReadingInsert).deviceId === "string" &&
        (typeof (item as ReadingInsert).value === "number" ||
          (item as ReadingInsert).value === null) &&
        Array.isArray((item as ReadingInsert).raw) &&
        ["good", "stale", "bad"].includes((item as ReadingInsert).quality) &&
        typeof (item as ReadingInsert).timestamp === "string" &&
        Number.isFinite(Date.parse((item as ReadingInsert).timestamp)),
    );
    return readings.length === parsed.length ? readings : null;
  } catch {
    return null;
  }
}

interface HistorianColumnMetadata {
  column_name: string;
  data_type: string;
  numeric_precision: number | null;
  numeric_scale: number | null;
  is_nullable: "YES" | "NO";
}

interface MutableSchemaChanges {
  addedColumns: string[];
  changedColumns: string[];
  orphanedColumns: string[];
  droppedColumns: string[];
}

interface OrphanColumnTarget {
  tableName: string;
  columnName: string;
}

export class PostgresHistorian {
  private pool: Pool | null = null;
  private runtime: RuntimePostgresSettings;
  private connectionGeneration = 0;
  private activePoolGeneration = 0;
  private readonly lastSavedAtByDevice = new Map<string, number>();
  private readonly schemaWarningTracker = new HistorianSchemaWarningTracker();
  private lastMaintenanceAtMemory: string | null = null;
  private lastReplayAtMemory: string | null = null;
  private lastReplayCountMemory = 0;
  private replayPromise: Promise<PostgresOfflineReplayResult> | null = null;
  private readonly lastOfflineQueueWarningAtByDevice = new Map<
    string,
    number
  >();
  private lastOfflineDropWarningAt = 0;
  private administrationPaused = false;
  private activeOperations = 0;
  private readonly drainWaiters = new Set<() => void>();
  private readonly activeOperationsByDevice = new Map<string, number>();
  private readonly deviceDrainWaiters = new Map<string, Set<() => void>>();
  private readonly deviceAdministrationTails = new Map<string, Promise<void>>();

  constructor(
    private readonly database: LoggerDatabase,
    private readonly logger: FastifyBaseLogger,
    private readonly poolFactory: (config: PoolConfig) => Pool = (config) =>
      new Pool(config),
    private readonly systemAlerts?: SystemAlertService,
  ) {
    this.runtime = this.resolveRuntime();
    this.pool = this.createConfiguredPool(this.runtime);
  }

  get configured(): boolean {
    return (
      this.runtime.enabled &&
      Boolean(
        this.runtime.host && this.runtime.database && this.runtime.username,
      )
    );
  }

  async checkAvailability(): Promise<{
    monitored: boolean;
    online: boolean | null;
  }> {
    return this.trackOperation(
      () => ({ monitored: false, online: null }),
      () => this.performAvailabilityCheck(),
    );
  }

  private async performAvailabilityCheck(): Promise<{
    monitored: boolean;
    online: boolean | null;
  }> {
    const generation = this.activePoolGeneration;
    const pool = this.pool;
    const intended =
      this.configured &&
      this.database
        .listDevices()
        .some((device) => device.enabled && device.postgresEnabled);
    if (!intended || !pool) {
      this.observePostgresForGeneration(generation, {
        intended: false,
        offline: false,
        detail: "Remote PostgreSQL monitoring is intentionally disabled",
      });
      return { monitored: false, online: null };
    }
    try {
      await pool.query("SELECT 1");
      this.observePostgresForGeneration(generation, {
        intended: true,
        offline: false,
        detail: "Remote PostgreSQL connection recovered",
      });
      return { monitored: true, online: true };
    } catch (error) {
      if (isPostgresAvailabilityError(error)) {
        this.observePostgresForGeneration(generation, {
          intended: true,
          offline: true,
          detail: safeError(error),
        });
        return { monitored: true, online: false };
      }
      this.logger.warn(
        { error: safeError(error) },
        "PostgreSQL availability check reached the server but failed for a non-availability reason",
      );
      return { monitored: true, online: null };
    }
  }

  async pauseAndDrain(timeoutMs = HISTORIAN_DRAIN_TIMEOUT_MS): Promise<void> {
    this.administrationPaused = true;
    if (this.activeOperations === 0) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.drainWaiters.delete(finish);
        resolve();
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.drainWaiters.delete(finish);
        reject(new HistorianDrainTimeoutError(timeoutMs));
      }, timeoutMs);
      this.drainWaiters.add(finish);
      if (this.activeOperations === 0) finish();
    });
  }

  resume(): void {
    this.administrationPaused = false;
  }

  get paused(): boolean {
    return this.administrationPaused;
  }

  private async trackOperation<T>(
    pausedResult: () => T | Promise<T>,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.administrationPaused) return pausedResult();
    this.activeOperations += 1;
    try {
      return await operation();
    } finally {
      this.activeOperations -= 1;
      if (this.activeOperations === 0) {
        for (const resolve of this.drainWaiters) resolve();
        this.drainWaiters.clear();
      }
    }
  }

  private async trackDeviceOperation<T>(
    deviceId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.activeOperationsByDevice.set(
      deviceId,
      (this.activeOperationsByDevice.get(deviceId) ?? 0) + 1,
    );
    try {
      return await operation();
    } finally {
      const remaining = (this.activeOperationsByDevice.get(deviceId) ?? 1) - 1;
      if (remaining > 0) {
        this.activeOperationsByDevice.set(deviceId, remaining);
      } else {
        this.activeOperationsByDevice.delete(deviceId);
        for (const resolve of this.deviceDrainWaiters.get(deviceId) ?? []) {
          resolve();
        }
        this.deviceDrainWaiters.delete(deviceId);
      }
    }
  }

  private async drainDeviceOperations(
    deviceId: string,
    timeoutMs = HISTORIAN_DRAIN_TIMEOUT_MS,
  ): Promise<void> {
    if ((this.activeOperationsByDevice.get(deviceId) ?? 0) === 0) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const waiters =
        this.deviceDrainWaiters.get(deviceId) ?? new Set<() => void>();
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        waiters.delete(finish);
        if (waiters.size === 0) this.deviceDrainWaiters.delete(deviceId);
        resolve();
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        waiters.delete(finish);
        if (waiters.size === 0) this.deviceDrainWaiters.delete(deviceId);
        reject(
          new Error(
            `PostgreSQL work for this device did not drain within ${timeoutMs} ms; saving remains disconnected`,
          ),
        );
      }, timeoutMs);
      waiters.add(finish);
      this.deviceDrainWaiters.set(deviceId, waiters);
      if ((this.activeOperationsByDevice.get(deviceId) ?? 0) === 0) finish();
    });
  }

  private async serializeDeviceAdministration<T>(
    deviceId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.deviceAdministrationTails.get(deviceId) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.deviceAdministrationTails.set(deviceId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.deviceAdministrationTails.get(deviceId) === tail) {
        this.deviceAdministrationTails.delete(deviceId);
      }
    }
  }

  getPublicSettings(): PublicPostgresSettings {
    const stored = this.database.getPostgresSettings();
    const outbox = this.database.getPostgresOutboxStats();
    return {
      enabled: this.runtime.enabled,
      host: this.runtime.host,
      port: this.runtime.port,
      database: this.runtime.database,
      username: this.runtime.username,
      sslMode: this.runtime.sslMode,
      historianTimezone: this.runtime.historianTimezone,
      autoDownsampleEnabled: this.runtime.autoDownsampleEnabled,
      defaultRawTable: this.runtime.defaultRawTable,
      defaultDownsampleTable: this.runtime.defaultDownsampleTable,
      defaultDownsampleIntervalSec: this.runtime.defaultDownsampleIntervalSec,
      rawRetentionDays: this.runtime.rawRetentionDays,
      downsampleRetentionDays: this.runtime.downsampleRetentionDays,
      maintenanceIntervalHours: this.runtime.maintenanceIntervalHours,
      offlineCacheEnabled: this.runtime.offlineCacheEnabled,
      offlineCacheMaxRows: this.runtime.offlineCacheMaxRows,
      configured: this.configured,
      passwordConfigured: this.runtime.password.length > 0,
      source: this.runtime.source,
      lastConnectionTestAt: stored?.lastConnectionTestAt ?? null,
      lastConnectionTestOk: stored?.lastConnectionTestOk ?? null,
      lastConnectionTestMessage: stored?.lastConnectionTestMessage ?? null,
      lastMaintenanceAt:
        stored?.lastMaintenanceAt ?? this.lastMaintenanceAtMemory,
      lastMaintenanceRawDeleted: stored?.lastMaintenanceRawDeleted ?? 0,
      lastMaintenanceDownsampleDeleted:
        stored?.lastMaintenanceDownsampleDeleted ?? 0,
      offlineCacheQueuedRows: outbox.queuedRows,
      offlineCacheOldestAt: outbox.oldestAt,
      lastReplayAt: stored?.lastReplayAt ?? this.lastReplayAtMemory,
      lastReplayCount: stored?.lastReplayCount ?? this.lastReplayCountMemory,
      updatedAt: stored?.updatedAt ?? null,
    };
  }

  async saveSettings(
    input: PostgresSettingsInput,
  ): Promise<PublicPostgresSettings> {
    return this.trackOperation(
      () => {
        throw new HistorianAdministrationPausedError();
      },
      () => this.performSaveSettings(input),
    );
  }

  private async performSaveSettings(
    input: PostgresSettingsInput,
  ): Promise<PublicPostgresSettings> {
    const databaseTargetChanged =
      this.runtime.host !== input.host ||
      this.runtime.port !== input.port ||
      this.runtime.database !== input.database ||
      this.runtime.username !== input.username;
    const password =
      input.password === undefined || input.password === ""
        ? this.runtime.password
        : input.password;
    const passwordEncrypted = password ? encryptSecret(password) : null;
    this.database.savePostgresSettings(input, passwordEncrypted);
    const generation = this.invalidateConnectionGeneration();
    this.reconcilePostgresSettingsAlert(generation);
    const dropped = this.database.trimPostgresOutbox(input.offlineCacheMaxRows);
    if (dropped > 0) {
      this.logger.warn(
        { dropped, maxRows: input.offlineCacheMaxRows },
        "PostgreSQL offline cache limit was reduced; oldest queued samples were removed",
      );
    }
    if (databaseTargetChanged) {
      this.database.markAllPostgresSchemasDirty();
    }
    if (await this.reconfigure(generation)) {
      this.reconcilePostgresSettingsAlert(generation);
    }
    return this.getPublicSettings();
  }

  async testConnection(
    input: PostgresSettingsInput,
  ): Promise<PostgresConnectionTestResult> {
    return this.trackOperation(
      () => {
        throw new HistorianAdministrationPausedError();
      },
      () => this.performConnectionTest(input),
    );
  }

  private async performConnectionTest(
    input: PostgresSettingsInput,
  ): Promise<PostgresConnectionTestResult> {
    const candidate: RuntimePostgresSettings = {
      ...input,
      password:
        input.password === undefined || input.password === ""
          ? this.runtime.password
          : input.password,
      source: "saved",
    };
    const pool = this.poolFactory(poolConfig(candidate));
    let client: PoolClient | null = null;
    try {
      client = await pool.connect();
      await client.query("SELECT set_config('TimeZone', $1, false)", [
        candidate.historianTimezone,
      ]);
      const result = await client.query<{
        server_version: string;
        database_name: string;
        username: string;
        can_connect: boolean;
        can_use_schema: boolean;
        can_create_tables: boolean;
      }>(
        `SELECT
           current_setting('server_version') AS server_version,
           current_database() AS database_name,
           current_user AS username,
           has_database_privilege(
             current_user, current_database(), 'CONNECT'
           ) AS can_connect,
           has_schema_privilege(
             current_user, current_schema(), 'USAGE'
           ) AS can_use_schema,
           has_schema_privilege(
             current_user, current_schema(), 'CREATE'
           ) AS can_create_tables`,
      );
      const row = result.rows[0];
      const ok = Boolean(
        row?.can_connect && row.can_use_schema && row.can_create_tables,
      );
      const message = ok
        ? "Connection successful and required schema permissions are available"
        : "Connection works, but CONNECT, USAGE, or CREATE permission is missing";
      this.database.recordPostgresConnectionTest(ok, message);
      return {
        ok,
        message,
        serverVersion: row?.server_version,
        database: row?.database_name,
        username: row?.username,
        canConnect: row?.can_connect,
        canUseSchema: row?.can_use_schema,
        canCreateTables: row?.can_create_tables,
      };
    } catch (error) {
      const message = safeError(error);
      this.database.recordPostgresConnectionTest(false, message);
      return { ok: false, message };
    } finally {
      client?.release();
      await pool.end();
    }
  }

  async runMaintenance(force = false): Promise<PostgresMaintenanceResult> {
    return this.trackOperation(
      () => ({
        skipped: true,
        message:
          "Remote PostgreSQL maintenance is paused for system administration",
        rawDeleted: 0,
        downsampleDeleted: 0,
        completedAt: new Date().toISOString(),
      }),
      () => this.performMaintenance(force),
    );
  }

  private async performMaintenance(
    force: boolean,
  ): Promise<PostgresMaintenanceResult> {
    const completedAt = new Date().toISOString();
    if (!this.configured || !this.pool) {
      return {
        skipped: true,
        message: "Remote PostgreSQL historian is disabled or incomplete",
        rawDeleted: 0,
        downsampleDeleted: 0,
        completedAt,
      };
    }

    const devices = this.database
      .listDevices()
      .filter(
        (device) =>
          device.postgresEnabled &&
          !device.postgresSchemaDirty &&
          device.postgresSchemaSyncedAt !== null,
      );
    let rawDeleted = 0;
    let downsampleDeleted = 0;
    let maintainedDevices = 0;

    for (const device of devices) {
      if (!force && device.postgresLastMaintenanceAt) {
        const elapsedMs =
          Date.now() - Date.parse(device.postgresLastMaintenanceAt);
        const intervalMs =
          device.postgresMaintenanceIntervalHours * 60 * 60 * 1000;
        if (elapsedMs < intervalMs) continue;
      }

      if (device.postgresRawRetentionDays > 0) {
        rawDeleted += await this.deleteExpired(
          device.postgresRawTable,
          device.postgresRawRetentionDays,
        );
      }
      if (device.postgresDownsampleRetentionDays > 0) {
        downsampleDeleted += await this.deleteExpired(
          device.postgresDownsampleTable,
          device.postgresDownsampleRetentionDays,
        );
      }
      this.database.recordDevicePostgresMaintenance(device.id, completedAt);
      maintainedDevices += 1;
    }

    if (maintainedDevices === 0) {
      return {
        skipped: true,
        message: "Automatic retention is not due for any device",
        rawDeleted: 0,
        downsampleDeleted: 0,
        completedAt,
      };
    }

    this.lastMaintenanceAtMemory = completedAt;
    this.database.recordPostgresMaintenance(rawDeleted, downsampleDeleted);
    this.logger.info(
      { rawDeleted, downsampleDeleted, maintainedDevices },
      "PostgreSQL retention maintenance completed",
    );
    return {
      skipped: false,
      message: `PostgreSQL retention completed for ${maintainedDevices} device(s)`,
      rawDeleted,
      downsampleDeleted,
      completedAt,
    };
  }

  async close(): Promise<void> {
    await this.pauseAndDrain();
    await this.replayPromise;
    await this.pool?.end();
    this.pool = null;
  }

  forgetDevice(deviceId: string): void {
    this.lastSavedAtByDevice.delete(deviceId);
    this.schemaWarningTracker.reset(deviceId);
    this.lastOfflineQueueWarningAtByDevice.delete(deviceId);
  }

  async disconnectDevice(
    deviceId: string,
  ): Promise<PostgresDeviceConnectionResult> {
    return this.serializeDeviceAdministration(deviceId, async () => {
      const device = this.database.setDevicePostgresEnabled(deviceId, false);
      if (!device) {
        throw new Error("Device was not found");
      }
      this.forgetDevice(deviceId);
      await this.drainDeviceOperations(deviceId);
      return {
        connected: false,
        message: "Remote PostgreSQL saving is disconnected for this device",
        device: this.database.getDevice(deviceId) ?? device,
      };
    });
  }

  async connectDevice(
    deviceId: string,
  ): Promise<PostgresDeviceConnectionResult> {
    return this.serializeDeviceAdministration(deviceId, () =>
      this.trackOperation(
        () => {
          throw new HistorianAdministrationPausedError();
        },
        async () => {
          const existing = this.database.getDevice(deviceId);
          if (!existing) {
            throw new Error("Device was not found");
          }

          // Keep the persisted write gate closed for the complete verification
          // transaction. A failed connection attempt must never resume writes.
          this.database.setDevicePostgresEnabled(deviceId, false);
          this.database.markDevicePostgresSchemaDirty(deviceId);
          this.forgetDevice(deviceId);
          await this.drainDeviceOperations(deviceId);
          const disconnected = this.database.getDevice(deviceId) as Device;
          if (!this.configured || !this.pool) {
            return {
              connected: false,
              message:
                "Configure and enable Remote PostgreSQL before connecting this device",
              device: disconnected,
            };
          }
          if (
            !TABLE_NAME_PATTERN.test(disconnected.postgresRawTable) ||
            !TABLE_NAME_PATTERN.test(disconnected.postgresDownsampleTable) ||
            disconnected.postgresRawTable ===
              disconnected.postgresDownsampleTable
          ) {
            return {
              connected: false,
              message:
                "Choose different valid lowercase raw and downsample table names before connecting",
              device: disconnected,
            };
          }
          if (
            disconnected.postgresDownsampleEnabled &&
            disconnected.postgresDownsampleIntervalSec * 1000 <
              disconnected.saveIntervalMs
          ) {
            return {
              connected: false,
              message:
                "Downsample interval must be equal to or longer than the database save interval before connecting",
              device: disconnected,
            };
          }

          try {
            const schema = await this.performDeviceSchemaSync(deviceId, false);
            const verified = this.database.getDevice(deviceId);
            if (
              !schema.ok ||
              !verified ||
              verified.postgresSchemaDirty ||
              !verified.postgresSchemaSyncedAt
            ) {
              return {
                connected: false,
                message: `${schema.message}. Remote saving remains disconnected`,
                device: verified ?? disconnected,
                schema,
              };
            }
            const connected = this.database.setDevicePostgresEnabled(
              deviceId,
              true,
            );
            if (!connected) {
              throw new Error(
                "Device was removed while PostgreSQL was verified",
              );
            }
            this.forgetDevice(deviceId);
            return {
              connected: true,
              message:
                "Remote PostgreSQL tables were verified and data saving is connected",
              device: connected,
              schema,
            };
          } catch (error) {
            this.database.setDevicePostgresEnabled(deviceId, false);
            this.forgetDevice(deviceId);
            throw error;
          }
        },
      ),
    );
  }

  async syncDeviceSchema(
    deviceId: string,
    dropRemoved = false,
    expectedOrphanedColumns?: string[],
  ): Promise<HistorianSchemaSyncResult> {
    return this.trackOperation(
      () => ({
        ok: false,
        message:
          "Historian schema synchronization is paused for system administration",
        addedColumns: [],
        changedColumns: [],
        orphanedColumns: [],
        droppedColumns: [],
        syncedAt: null,
      }),
      () =>
        this.performDeviceSchemaSync(
          deviceId,
          dropRemoved,
          expectedOrphanedColumns,
        ),
    );
  }

  private async performDeviceSchemaSync(
    deviceId: string,
    dropRemoved: boolean,
    expectedOrphanedColumns?: string[],
  ): Promise<HistorianSchemaSyncResult> {
    const device = this.database.getDevice(deviceId);
    if (!device) {
      throw new Error("Device was not found");
    }
    if (!this.configured || !this.pool) {
      throw new Error(
        "Configure and enable Remote PostgreSQL before synchronizing historian tables",
      );
    }
    const owner = this.database.findHistorianTableOwner(
      device.postgresRawTable,
      device.postgresDownsampleTable,
      device.id,
    );
    if (owner) {
      throw new HistorianSchemaConflictError(
        `Historian tables are reserved by ${owner.name}. Choose unique raw and downsample table names before synchronizing.`,
      );
    }

    const registers = this.database.listRegisters(device.id);
    const desiredColumns = configuredHistorianColumns(registers);
    const pendingRenames = this.database.listPendingHistorianColumnRenames(
      device.id,
    );
    const schemaRevision = device.postgresSchemaRevision;
    const changes: MutableSchemaChanges = {
      addedColumns: [],
      changedColumns: [],
      orphanedColumns: [],
      droppedColumns: [],
    };
    const orphanTargets: OrphanColumnTarget[] = [];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const tableName of [
        ...new Set([device.postgresRawTable, device.postgresDownsampleTable]),
      ].sort()) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `modbus-historian-table:${tableName}`,
        ]);
      }
      const lockedOwner = this.database.findHistorianTableOwner(
        device.postgresRawTable,
        device.postgresDownsampleTable,
        device.id,
      );
      if (lockedOwner) {
        throw new HistorianSchemaConflictError(
          `Historian tables are reserved by ${lockedOwner.name}. Choose unique raw and downsample table names before synchronizing.`,
        );
      }
      await client.query("SELECT set_config('TimeZone', $1, true)", [
        this.runtime.historianTimezone,
      ]);

      const rawBefore = await this.getTableColumns(
        client,
        device.postgresRawTable,
      );
      const downsampleBefore = await this.getTableColumns(
        client,
        device.postgresDownsampleTable,
      );
      this.assertConvertibleLayout(device.postgresRawTable, rawBefore);
      this.assertConvertibleLayout(
        device.postgresDownsampleTable,
        downsampleBefore,
      );

      await this.syncExactTable(
        client,
        device.postgresRawTable,
        desiredColumns,
        pendingRenames,
        changes,
        orphanTargets,
      );
      await this.syncExactTable(
        client,
        device.postgresDownsampleTable,
        desiredColumns,
        pendingRenames,
        changes,
        orphanTargets,
      );
      if (dropRemoved) {
        const currentDevice = this.database.getDevice(device.id);
        if (
          !currentDevice ||
          currentDevice.postgresSchemaRevision !== schemaRevision
        ) {
          throw new HistorianSchemaConflictError(
            "Device tags or historian tables changed during synchronization. Review the latest schema preview and try again.",
          );
        }
        const expected = [...(expectedOrphanedColumns ?? [])].sort();
        const actual = [...changes.orphanedColumns].sort();
        if (
          expectedOrphanedColumns === undefined ||
          expected.length !== actual.length ||
          expected.some((value, index) => value !== actual[index])
        ) {
          throw new HistorianSchemaConflictError(
            "Historian orphan columns changed after the preview. Run schema sync without removal, review the current orphan list, then confirm again.",
          );
        }
        for (const orphan of orphanTargets) {
          await client.query(
            `ALTER TABLE ${identifier(orphan.tableName)}
             DROP COLUMN ${existingIdentifier(orphan.columnName)}`,
          );
          changes.droppedColumns.push(
            `${orphan.tableName}.${orphan.columnName}`,
          );
        }
      }
      await client.query("COMMIT");
      this.database.acknowledgeHistorianColumnRenames(
        device.id,
        pendingRenames,
      );

      let ok = dropRemoved || changes.orphanedColumns.length === 0;
      let syncedAt = device.postgresSchemaSyncedAt;
      if (ok) {
        const candidateSyncedAt = new Date().toISOString();
        ok = this.database.markDevicePostgresSchemaSynced(
          device.id,
          schemaRevision,
          candidateSyncedAt,
        );
        if (ok) syncedAt = candidateSyncedAt;
      }
      if (ok) this.forgetDevice(device.id);
      const message = ok
        ? "Historian tables are synchronized"
        : changes.orphanedColumns.length > 0 && !dropRemoved
          ? "Historian tables contain columns that are no longer configured; confirm removal to finish synchronization"
          : "Device tags or historian tables changed during synchronization; review and synchronize again";
      this.logger.info(
        {
          deviceId: device.id,
          rawTable: device.postgresRawTable,
          downsampleTable: device.postgresDownsampleTable,
          dropRemoved,
          ...changes,
        },
        message,
      );
      return { ok, message, ...changes, syncedAt };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async write(device: Device, readings: ReadingInsert[]): Promise<void> {
    return this.trackOperation(
      () => undefined,
      () =>
        this.trackDeviceOperation(device.id, () =>
          this.performWrite(device, readings),
        ),
    );
  }

  private async performWrite(
    device: Device,
    readings: ReadingInsert[],
  ): Promise<void> {
    const currentDevice = this.database.getDevice(device.id);
    if (!currentDevice) return;
    device = currentDevice;
    if (
      !device.enabled ||
      !device.postgresEnabled ||
      readings.length === 0 ||
      !this.runtime.enabled
    ) {
      return;
    }
    const parsedTimes = readings
      .map((reading) => Date.parse(reading.timestamp))
      .filter(Number.isFinite);
    const sampleAtMs =
      parsedTimes.length > 0 ? Math.max(...parsedTimes) : Date.now();
    if (
      !historianSaveIsDue(
        this.lastSavedAtByDevice.get(device.id),
        sampleAtMs,
        device.saveIntervalMs,
      )
    ) {
      return;
    }

    const registers = new Map(
      this.database
        .listRegisters(device.id)
        .filter((register) => register.enabled)
        .map((register) => [register.id, register]),
    );
    const readingsWithRegisters = readings.flatMap((reading) => {
      const register = registers.get(reading.registerId);
      return register ? [{ reading, register }] : [];
    });
    if (readingsWithRegisters.length === 0) return;

    const eligibleReadings = readingsWithRegisters.map(
      ({ reading }) => reading,
    );
    if (device.postgresSchemaDirty || !device.postgresSchemaSyncedAt) {
      if (this.schemaWarningTracker.shouldWarn(device.id)) {
        this.logger.warn(
          {
            deviceId: device.id,
            deviceName: device.name,
            rawTable: device.postgresRawTable,
            downsampleTable: device.postgresDownsampleTable,
          },
          this.runtime.offlineCacheEnabled
            ? "PostgreSQL historian schema sync is required; remote replay is paused while current samples continue into the offline cache"
            : "PostgreSQL historian schema sync is required; remote writes are paused for this device",
        );
      }
      if (this.runtime.offlineCacheEnabled) {
        this.queueOfflineSample(
          device,
          eligibleReadings,
          sampleAtMs,
          "PostgreSQL historian schema sync is required before replay",
        );
      }
      return;
    }
    if (!this.pool) {
      throw new Error(
        "Remote PostgreSQL logging is enabled but its connection is incomplete",
      );
    }
    if (this.runtime.offlineCacheEnabled) {
      const replay = await this.replayOfflineCache(50);
      if (replay.status === "unavailable" || replay.remainingEligibleRows > 0) {
        this.queueOfflineSample(
          device,
          eligibleReadings,
          sampleAtMs,
          "PostgreSQL is unavailable or older cached samples are still pending",
        );
        return;
      }
      if (replay.status === "error") {
        if (!this.database.getDevice(device.id)?.postgresEnabled) {
          if (this.runtime.offlineCacheEnabled) {
            this.queueOfflineSample(
              device,
              eligibleReadings,
              sampleAtMs,
              "PostgreSQL schema repair is required before cached replay can continue",
            );
          }
          return;
        }
        throw new Error(`PostgreSQL offline replay failed: ${replay.message}`);
      }
    }

    try {
      await this.persistItems(device, readingsWithRegisters, [
        ...registers.values(),
      ]);
      this.lastSavedAtByDevice.set(device.id, sampleAtMs);
      this.lastOfflineQueueWarningAtByDevice.delete(device.id);
    } catch (error) {
      if (isPostgresSchemaMissingError(error)) {
        if (this.runtime.offlineCacheEnabled) {
          this.queueOfflineSample(
            device,
            eligibleReadings,
            sampleAtMs,
            "The configured PostgreSQL table or tag column is missing",
          );
        }
        this.database.setDevicePostgresEnabled(device.id, false);
        this.database.markDevicePostgresSchemaDirty(device.id);
        this.forgetDevice(device.id);
        this.logger.error(
          {
            deviceId: device.id,
            rawTable: device.postgresRawTable,
            downsampleTable: device.postgresDownsampleTable,
          },
          "PostgreSQL historian schema disappeared; remote saving was disconnected until Connect and verify repairs it",
        );
        return;
      }
      if (
        this.runtime.offlineCacheEnabled &&
        isPostgresAvailabilityError(error)
      ) {
        this.queueOfflineSample(
          device,
          eligibleReadings,
          sampleAtMs,
          safeError(error),
        );
        return;
      }
      throw error;
    }
  }

  async replayOfflineCache(
    limit = 1_000,
  ): Promise<PostgresOfflineReplayResult> {
    return this.trackOperation(
      () => {
        const stats = this.database.getPostgresOutboxStats();
        return {
          status: "paused",
          message:
            "PostgreSQL offline replay is paused for system administration",
          queuedRows: stats.queuedRows,
          replayedRows: 0,
          discardedRows: 0,
          pausedRows: stats.queuedRows,
          remainingRows: stats.queuedRows,
          remainingEligibleRows:
            this.database.getReplayablePostgresOutboxCount(),
          completedAt: new Date().toISOString(),
        };
      },
      () => this.beginOfflineReplay(limit),
    );
  }

  private async beginOfflineReplay(
    limit: number,
  ): Promise<PostgresOfflineReplayResult> {
    if (this.replayPromise) return this.replayPromise;
    const boundedLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    const pending = this.performOfflineReplay(boundedLimit);
    this.replayPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.replayPromise === pending) this.replayPromise = null;
    }
  }

  private async performOfflineReplay(
    limit: number,
  ): Promise<PostgresOfflineReplayResult> {
    const initial = this.database.getPostgresOutboxStats();
    const completedAt = new Date().toISOString();
    if (!this.runtime.offlineCacheEnabled) {
      return {
        status: "disabled",
        message: "PostgreSQL offline cache is disabled",
        queuedRows: initial.queuedRows,
        replayedRows: 0,
        discardedRows: 0,
        pausedRows: initial.queuedRows,
        remainingRows: initial.queuedRows,
        remainingEligibleRows: this.database.getReplayablePostgresOutboxCount(),
        completedAt,
      };
    }
    if (!this.configured || !this.pool) {
      return {
        status: "unavailable",
        message: "Remote PostgreSQL historian is disabled or incomplete",
        queuedRows: initial.queuedRows,
        replayedRows: 0,
        discardedRows: 0,
        pausedRows: initial.queuedRows,
        remainingRows: initial.queuedRows,
        remainingEligibleRows: this.database.getReplayablePostgresOutboxCount(),
        completedAt,
      };
    }
    if (initial.queuedRows === 0) {
      return {
        status: "idle",
        message: "No PostgreSQL offline samples are queued",
        queuedRows: 0,
        replayedRows: 0,
        discardedRows: 0,
        pausedRows: 0,
        remainingRows: 0,
        remainingEligibleRows: 0,
        completedAt,
      };
    }

    const entries = this.database.listReplayablePostgresOutbox(limit);
    let replayedRows = 0;
    let discardedRows = 0;
    let blockingStatus: "unavailable" | "error" | null = null;
    let blockingMessage = "";

    for (const entry of entries) {
      const device = this.database.getDevice(entry.deviceId);
      if (
        !device ||
        !device.enabled ||
        !device.postgresEnabled ||
        device.postgresSchemaDirty ||
        !device.postgresSchemaSyncedAt
      ) {
        continue;
      }
      const readings = parseQueuedReadings(entry.readingsJson);
      if (!readings) {
        this.database.deletePostgresOutbox(entry.id);
        discardedRows += 1;
        this.logger.warn(
          { outboxId: entry.id, deviceId: entry.deviceId },
          "Discarded an invalid PostgreSQL offline cache entry",
        );
        continue;
      }

      const registers = new Map(
        this.database
          .listRegisters(device.id)
          .filter((register) => register.enabled)
          .map((register) => [register.id, register]),
      );
      const items = readings.flatMap((reading) => {
        if (reading.deviceId !== device.id) return [];
        const register = registers.get(reading.registerId);
        return register ? [{ reading, register }] : [];
      });
      if (items.length === 0) {
        this.database.deletePostgresOutbox(entry.id);
        discardedRows += 1;
        this.logger.warn(
          { outboxId: entry.id, deviceId: entry.deviceId },
          "Discarded a PostgreSQL offline sample because none of its tags remain enabled",
        );
        continue;
      }

      try {
        await this.trackDeviceOperation(device.id, () =>
          this.persistItems(device, items, [...registers.values()]),
        );
        this.database.deletePostgresOutbox(entry.id);
        replayedRows += 1;
      } catch (error) {
        if (isPostgresSchemaMissingError(error)) {
          this.database.setDevicePostgresEnabled(device.id, false);
          this.database.markDevicePostgresSchemaDirty(device.id);
          this.forgetDevice(device.id);
        }
        blockingStatus = isPostgresAvailabilityError(error)
          ? "unavailable"
          : "error";
        blockingMessage = safeError(error);
        break;
      }
    }

    const finishedAt = new Date().toISOString();
    this.lastReplayAtMemory = finishedAt;
    this.lastReplayCountMemory = replayedRows;
    this.database.recordPostgresReplay(replayedRows, finishedAt);
    const remaining = this.database.getPostgresOutboxStats();
    const remainingEligibleRows =
      this.database.getReplayablePostgresOutboxCount();
    const pausedRows = Math.max(
      0,
      remaining.queuedRows - remainingEligibleRows,
    );
    let status: PostgresOfflineReplayResult["status"];
    let message: string;
    if (blockingStatus) {
      status = blockingStatus;
      message =
        blockingStatus === "unavailable"
          ? `Remote PostgreSQL is unavailable: ${blockingMessage}`
          : `Replay stopped without deleting the queued sample: ${blockingMessage}`;
    } else if (entries.length === 0) {
      status = "paused";
      message =
        "Queued samples are paused until their devices are enabled and schema-synchronized";
    } else {
      status = "completed";
      message =
        remainingEligibleRows > 0
          ? `Replayed ${replayedRows} sample(s); another bounded batch remains`
          : `Replayed ${replayedRows} sample(s)`;
    }
    this.logger.info(
      {
        status,
        replayedRows,
        discardedRows,
        pausedRows,
        remainingRows: remaining.queuedRows,
      },
      "PostgreSQL offline cache replay finished",
    );
    return {
      status,
      message,
      queuedRows: initial.queuedRows,
      replayedRows,
      discardedRows,
      pausedRows,
      remainingRows: remaining.queuedRows,
      remainingEligibleRows,
      completedAt: finishedAt,
    };
  }

  private queueOfflineSample(
    device: Device,
    readings: ReadingInsert[],
    sampleAtMs: number,
    reason: string,
  ): void {
    const sampleTimestamp = new Date(sampleAtMs).toISOString();
    const saveBucketMs =
      Math.floor(sampleAtMs / device.saveIntervalMs) * device.saveIntervalMs;
    const result = this.database.enqueuePostgresOutbox(
      device.id,
      sampleTimestamp,
      saveBucketMs,
      readings,
      this.runtime.offlineCacheMaxRows,
    );
    this.lastSavedAtByDevice.set(device.id, sampleAtMs);
    const now = Date.now();
    const lastQueueWarning =
      this.lastOfflineQueueWarningAtByDevice.get(device.id) ?? 0;
    if (now - lastQueueWarning >= OFFLINE_CACHE_WARNING_INTERVAL_MS) {
      this.lastOfflineQueueWarningAtByDevice.set(device.id, now);
      this.logger.warn(
        {
          deviceId: device.id,
          sampleTimestamp,
          queued: result.queued,
          reason,
        },
        "Saved PostgreSQL historian samples to the durable offline cache",
      );
    }
    if (
      result.dropped > 0 &&
      now - this.lastOfflineDropWarningAt >= OFFLINE_CACHE_WARNING_INTERVAL_MS
    ) {
      this.lastOfflineDropWarningAt = now;
      this.logger.warn(
        {
          dropped: result.dropped,
          maxRows: this.runtime.offlineCacheMaxRows,
        },
        "PostgreSQL offline cache reached its limit; oldest samples were removed",
      );
    }
  }

  private async persistItems(
    device: Device,
    items: Array<{
      reading: ReadingInsert;
      register: RegisterDefinition;
    }>,
    registers: RegisterDefinition[],
  ): Promise<void> {
    const generation = this.activePoolGeneration;
    const pool = this.pool;
    const historianTimezone = this.runtime.historianTimezone;
    if (!pool) {
      throw new Error(
        "Remote PostgreSQL logging is enabled but its connection is incomplete",
      );
    }
    let client: PoolClient | null = null;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT set_config('TimeZone', $1, true)", [
        historianTimezone,
      ]);
      const savedTimestamp = await this.writeWideRaw(
        client,
        device.postgresRawTable,
        items,
      );
      if (
        device.postgresDownsampleEnabled &&
        items.some(
          ({ reading }) => reading.quality === "good" && reading.value !== null,
        )
      ) {
        await this.writeLastValueDownsample(
          client,
          device.postgresRawTable,
          device.postgresDownsampleTable,
          device.postgresDownsampleIntervalSec,
          savedTimestamp,
          registers,
        );
      }
      await client.query("COMMIT");
      this.observePostgresForGeneration(generation, {
        intended: true,
        offline: false,
        detail: "Remote PostgreSQL connection recovered",
      });
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      if (isPostgresAvailabilityError(error)) {
        this.observePostgresForGeneration(generation, {
          intended: true,
          offline: true,
          detail: safeError(error),
        });
      }
      throw error;
    } finally {
      client?.release();
    }
  }

  private async writeWideRaw(
    client: PoolClient,
    rawTableName: string,
    items: Array<{
      reading: ReadingInsert;
      register: RegisterDefinition;
    }>,
  ): Promise<string> {
    const uniqueItems = [
      ...new Map(items.map((item) => [item.register.id, item])).values(),
    ];
    const timestamp = uniqueItems
      .map((item) => item.reading.timestamp)
      .sort()
      .at(-1) as string;
    const tagColumns = uniqueItems.map((item) =>
      identifier(item.register.historianColumn),
    );
    const placeholders = uniqueItems.map((_, index) => `$${index + 2}`);
    const values: unknown[] = [
      timestamp,
      ...uniqueItems.map((item) =>
        item.reading.quality === "good"
          ? roundHistorianValue(item.reading.value, item.register.decimalPlaces)
          : null,
      ),
    ];
    const updateAssignments = tagColumns.map(
      (column) => `${column} = EXCLUDED.${column}`,
    );
    await client.query(
      `INSERT INTO ${identifier(rawTableName)} (
         "timestamp", ${tagColumns.join(", ")}
       ) VALUES (
         $1::timestamptz, ${placeholders.join(", ")}
       )
       ON CONFLICT ("timestamp") DO UPDATE SET
         ${updateAssignments.join(", ")}`,
      values,
    );
    return timestamp;
  }

  private async writeLastValueDownsample(
    client: PoolClient,
    rawTableName: string,
    downsampleTableName: string,
    bucketSeconds: number,
    sampleTimestamp: string,
    registers: RegisterDefinition[],
  ): Promise<void> {
    const columns = configuredHistorianColumns(registers);
    if (columns.length === 0) return;
    await client.query(
      buildLastValueDownsampleSql(
        rawTableName,
        downsampleTableName,
        columns.map((column) => column.name),
      ),
      [sampleTimestamp, bucketSeconds],
    );
  }

  private async getTableColumns(
    client: PoolClient,
    tableName: string,
  ): Promise<HistorianColumnMetadata[]> {
    const result = await client.query<HistorianColumnMetadata>(
      `SELECT
         column_name, data_type, numeric_precision, numeric_scale,
         is_nullable
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = $1
       ORDER BY ordinal_position`,
      [tableName],
    );
    return result.rows;
  }

  private assertConvertibleLayout(
    tableName: string,
    columns: HistorianColumnMetadata[],
  ): void {
    if (columns.length === 0) return;
    const names = new Set(columns.map((column) => column.column_name));
    const longFormatMarkers = [
      "register_id",
      "sample_count",
      "min_value",
      "max_value",
      "avg_value",
      "first_value",
      "last_value",
      "bucket_seconds",
    ];
    if (longFormatMarkers.some((column) => names.has(column))) {
      throw new HistorianSchemaConflictError(
        `Table ${tableName} uses a legacy long-format layout that cannot be converted losslessly. Choose a new raw or downsample table name, save the device, then synchronize again.`,
      );
    }
    if (names.has("timestamp") && names.has("recorded_at")) {
      throw new HistorianSchemaConflictError(
        `Table ${tableName} contains both timestamp and recorded_at columns. Choose a new table name so existing data is not overwritten.`,
      );
    }
  }

  private async syncExactTable(
    client: PoolClient,
    tableName: string,
    desiredColumns: Array<{ name: string; decimalPlaces: number }>,
    pendingRenames: HistorianColumnRename[],
    changes: MutableSchemaChanges,
    orphanTargets: OrphanColumnTarget[],
  ): Promise<void> {
    const table = identifier(tableName);
    let existing = await this.getTableColumns(client, tableName);
    if (existing.length === 0) {
      await client.query(
        buildExactHistorianCreateSql(tableName, desiredColumns),
      );
      changes.addedColumns.push(
        `${tableName}.timestamp`,
        ...desiredColumns.map((column) => `${tableName}.${column.name}`),
      );
      return;
    }

    const recordedAt = existing.find(
      (column) => column.column_name === "recorded_at",
    );
    if (recordedAt) {
      if (recordedAt.data_type !== "timestamp with time zone") {
        throw new HistorianSchemaConflictError(
          `Table ${tableName}.recorded_at is not TIMESTAMPTZ. Choose a new table name to avoid changing existing timestamp meaning.`,
        );
      }
      await client.query(
        `ALTER TABLE ${table}
         RENAME COLUMN "recorded_at" TO "timestamp"`,
      );
      changes.changedColumns.push(`${tableName}.recorded_at -> timestamp`);
      existing = await this.getTableColumns(client, tableName);
    }

    const timestamp = existing.find(
      (column) => column.column_name === "timestamp",
    );
    if (!timestamp) {
      throw new HistorianSchemaConflictError(
        `Table ${tableName} has data but no timestamp column. Choose a new table name; the collector will not guess or overwrite timestamps.`,
      );
    }
    if (timestamp.data_type !== "timestamp with time zone") {
      throw new HistorianSchemaConflictError(
        `Table ${tableName}.timestamp is not TIMESTAMPTZ. Choose a new table name to preserve existing timestamp meaning.`,
      );
    }
    if (timestamp.is_nullable === "YES") {
      await client.query(
        `ALTER TABLE ${table}
         ALTER COLUMN "timestamp" SET NOT NULL`,
      );
      changes.changedColumns.push(`${tableName}.timestamp set NOT NULL`);
    }

    const primaryKey = await client.query<{ column_name: string }>(
      `SELECT attribute.attname AS column_name
       FROM pg_index AS index_info
       JOIN pg_class AS table_info
         ON table_info.oid = index_info.indrelid
       JOIN pg_namespace AS namespace_info
         ON namespace_info.oid = table_info.relnamespace
       JOIN LATERAL unnest(index_info.indkey)
         WITH ORDINALITY AS key_info(attnum, position) ON true
       JOIN pg_attribute AS attribute
         ON attribute.attrelid = table_info.oid
        AND attribute.attnum = key_info.attnum
       WHERE namespace_info.nspname = current_schema()
         AND table_info.relname = $1
         AND index_info.indisprimary
       ORDER BY key_info.position`,
      [tableName],
    );
    if (
      primaryKey.rows.length > 0 &&
      (primaryKey.rows.length !== 1 ||
        primaryKey.rows[0]?.column_name !== "timestamp")
    ) {
      throw new HistorianSchemaConflictError(
        `Table ${tableName} has a primary key other than timestamp. Choose a new table name so the existing key is not replaced.`,
      );
    }
    if (primaryKey.rows.length === 0) {
      await client.query(
        `ALTER TABLE ${table}
         ADD PRIMARY KEY ("timestamp")`,
      );
      changes.changedColumns.push(`${tableName}.timestamp set PRIMARY KEY`);
    }

    let existingByName = new Map(
      existing.map((column) => [column.column_name, column]),
    );
    const plannedRenames = planHistorianColumnRenames(
      tableName,
      existing.map((column) => column.column_name),
      pendingRenames,
    );
    for (const rename of plannedRenames) {
      await client.query(
        `ALTER TABLE ${table}
         RENAME COLUMN ${identifier(rename.from)}
         TO ${identifier(rename.to)}`,
      );
      changes.changedColumns.push(
        `${tableName}.${rename.from} -> ${rename.to}`,
      );
    }
    if (plannedRenames.length > 0) {
      existing = await this.getTableColumns(client, tableName);
      existingByName = new Map(
        existing.map((column) => [column.column_name, column]),
      );
    }

    for (const desired of desiredColumns) {
      const current = existingByName.get(desired.name);
      if (!current) {
        await client.query(
          `ALTER TABLE ${table}
           ADD COLUMN ${identifier(desired.name)}
             ${historianNumericType(desired.decimalPlaces)}`,
        );
        changes.addedColumns.push(`${tableName}.${desired.name}`);
        continue;
      }
      if (
        current.data_type !== "numeric" ||
        current.numeric_precision !== 30 ||
        current.numeric_scale !== desired.decimalPlaces
      ) {
        await client.query(
          `ALTER TABLE ${table}
           ALTER COLUMN ${identifier(desired.name)}
           TYPE ${historianNumericType(desired.decimalPlaces)}
           USING ROUND(
             ${identifier(desired.name)}::numeric,
             ${desired.decimalPlaces}
           )`,
        );
        changes.changedColumns.push(
          `${tableName}.${desired.name} -> ${historianNumericType(desired.decimalPlaces)}`,
        );
      }
    }

    const desiredNames = new Set([
      "timestamp",
      ...desiredColumns.map((column) => column.name),
    ]);
    const orphaned = existing
      .map((column) => column.column_name)
      .filter((column) => !desiredNames.has(column));
    changes.orphanedColumns.push(
      ...orphaned.map((column) => `${tableName}.${column}`),
    );
    orphanTargets.push(
      ...orphaned.map((columnName) => ({ tableName, columnName })),
    );
  }

  private resolveRuntime(): RuntimePostgresSettings {
    const environment = environmentSettings();
    const stored = this.database.getPostgresSettings();
    if (!stored) return environment ?? defaultSettings();

    let password = environment?.password ?? "";
    if (stored.passwordEncrypted) {
      try {
        password = decryptSecret(stored.passwordEncrypted);
      } catch (error) {
        this.logger.error(
          { error: safeError(error) },
          "Stored PostgreSQL password could not be decrypted",
        );
        password = "";
      }
    }

    return {
      enabled: stored.enabled,
      host: stored.host,
      port: stored.port,
      database: stored.database,
      username: stored.username,
      password,
      sslMode: stored.sslMode,
      historianTimezone: stored.historianTimezone,
      autoDownsampleEnabled: stored.autoDownsampleEnabled,
      defaultRawTable: stored.defaultRawTable,
      defaultDownsampleTable: stored.defaultDownsampleTable,
      defaultDownsampleIntervalSec: stored.defaultDownsampleIntervalSec,
      rawRetentionDays: stored.rawRetentionDays,
      downsampleRetentionDays: stored.downsampleRetentionDays,
      maintenanceIntervalHours: stored.maintenanceIntervalHours,
      offlineCacheEnabled: stored.offlineCacheEnabled,
      offlineCacheMaxRows: stored.offlineCacheMaxRows,
      source: "saved",
    };
  }

  private createConfiguredPool(settings: RuntimePostgresSettings): Pool | null {
    return settings.enabled &&
      settings.host &&
      settings.database &&
      settings.username
      ? this.poolFactory(poolConfig(settings))
      : null;
  }

  async reloadSettings(): Promise<PublicPostgresSettings> {
    this.lastMaintenanceAtMemory = null;
    this.lastReplayAtMemory = null;
    this.lastReplayCountMemory = 0;
    const generation = this.invalidateConnectionGeneration();
    this.reconcilePostgresSettingsAlert(generation);
    if (await this.reconfigure(generation)) {
      this.reconcilePostgresSettingsAlert(generation);
    }
    return this.getPublicSettings();
  }

  private invalidateConnectionGeneration(): number {
    this.connectionGeneration += 1;
    return this.connectionGeneration;
  }

  private observePostgresForGeneration(
    generation: number,
    input: Parameters<SystemAlertService["observePostgres"]>[0],
  ): void {
    if (generation !== this.connectionGeneration) {
      this.logger.debug(
        {
          observationGeneration: generation,
          connectionGeneration: this.connectionGeneration,
        },
        "ignored a stale PostgreSQL alert observation after settings changed",
      );
      return;
    }
    this.systemAlerts?.observePostgres(input);
  }

  private reconcilePostgresSettingsAlert(generation: number): void {
    if (!this.systemAlerts || generation !== this.connectionGeneration) return;
    const intended = this.systemAlerts.postgresMonitoringIntended();
    this.observePostgresForGeneration(generation, {
      intended,
      offline: false,
      detail: intended
        ? "Remote PostgreSQL connection was verified after settings changed"
        : "Remote PostgreSQL monitoring was intentionally disabled",
    });
  }

  private async reconfigure(generation: number): Promise<boolean> {
    await this.replayPromise;
    if (generation !== this.connectionGeneration) return false;
    const previousPool = this.pool;
    const runtime = this.resolveRuntime();
    const pool = this.createConfiguredPool(runtime);
    if (generation !== this.connectionGeneration) {
      await pool?.end();
      return false;
    }
    this.runtime = runtime;
    this.pool = pool;
    this.activePoolGeneration = generation;
    this.lastSavedAtByDevice.clear();
    this.schemaWarningTracker.clear();
    this.lastOfflineQueueWarningAtByDevice.clear();
    this.lastOfflineDropWarningAt = 0;
    await previousPool?.end();
    return generation === this.connectionGeneration;
  }

  private async deleteExpired(
    tableName: string,
    retentionDays: number,
  ): Promise<number> {
    try {
      const result = await this.pool?.query(
        `DELETE FROM ${identifier(tableName)}
         WHERE "timestamp" <
           NOW() - ($1 * INTERVAL '1 day')`,
        [retentionDays],
      );
      return result?.rowCount ?? 0;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "42P01"
      ) {
        return 0;
      }
      throw error;
    }
  }

  getPool(): Pool | null {
    return this.pool;
  }
}
