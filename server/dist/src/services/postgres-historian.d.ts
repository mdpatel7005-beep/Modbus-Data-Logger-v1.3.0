import type { FastifyBaseLogger } from "fastify";
import { Pool, type PoolConfig } from "pg";
import type { HistorianColumnRename, LoggerDatabase } from "../db/database.js";
import type { Device, PostgresSettingsInput, ReadingInsert, RegisterDefinition } from "../types/domain.js";
import type { SystemAlertService } from "./system-alerts.js";
interface RuntimePostgresSettings extends PostgresSettingsInput {
    password: string;
    source: "saved" | "environment" | "none";
}
export interface PublicPostgresSettings extends Omit<PostgresSettingsInput, "password"> {
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
    status: "disabled" | "idle" | "completed" | "paused" | "unavailable" | "error";
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
export declare class HistorianSchemaConflictError extends Error {
    constructor(message: string);
}
export declare class HistorianAdministrationPausedError extends Error {
    constructor();
}
export declare class HistorianDrainTimeoutError extends Error {
    constructor(timeoutMs: number);
}
export declare class HistorianSchemaWarningTracker {
    private readonly warnedDeviceIds;
    shouldWarn(deviceId: string): boolean;
    reset(deviceId: string): void;
    clear(): void;
}
export declare function historianSaveIsDue(lastSavedAtMs: number | undefined, sampleAtMs: number, saveIntervalMs: number): boolean;
export declare function historianNumericType(decimalPlaces: number): string;
export declare function roundHistorianValue(value: number | null, decimalPlaces: number): number | null;
export declare function isPostgresAvailabilityError(error: unknown): boolean;
export declare function isPostgresSchemaMissingError(error: unknown): boolean;
export declare function configuredHistorianColumns(registers: RegisterDefinition[]): Array<{
    name: string;
    decimalPlaces: number;
}>;
export declare function planHistorianColumnRenames(tableName: string, existingColumns: string[], pendingRenames: HistorianColumnRename[]): HistorianColumnRename[];
export declare function buildExactHistorianCreateSql(tableName: string, columns: Array<{
    name: string;
    decimalPlaces: number;
}>): string;
export declare function buildLastValueDownsampleSql(rawTableName: string, downsampleTableName: string, columns: string[]): string;
export declare class PostgresHistorian {
    private readonly database;
    private readonly logger;
    private readonly poolFactory;
    private readonly systemAlerts?;
    private pool;
    private runtime;
    private connectionGeneration;
    private activePoolGeneration;
    private readonly lastSavedAtByDevice;
    private readonly schemaWarningTracker;
    private lastMaintenanceAtMemory;
    private lastReplayAtMemory;
    private lastReplayCountMemory;
    private replayPromise;
    private readonly lastOfflineQueueWarningAtByDevice;
    private lastOfflineDropWarningAt;
    private administrationPaused;
    private activeOperations;
    private readonly drainWaiters;
    private readonly activeOperationsByDevice;
    private readonly deviceDrainWaiters;
    private readonly deviceAdministrationTails;
    constructor(database: LoggerDatabase, logger: FastifyBaseLogger, poolFactory?: (config: PoolConfig) => Pool, systemAlerts?: SystemAlertService | undefined);
    get configured(): boolean;
    checkAvailability(): Promise<{
        monitored: boolean;
        online: boolean | null;
    }>;
    private performAvailabilityCheck;
    pauseAndDrain(timeoutMs?: number): Promise<void>;
    resume(): void;
    get paused(): boolean;
    private trackOperation;
    private trackDeviceOperation;
    private drainDeviceOperations;
    private serializeDeviceAdministration;
    getPublicSettings(): PublicPostgresSettings;
    saveSettings(input: PostgresSettingsInput): Promise<PublicPostgresSettings>;
    private performSaveSettings;
    testConnection(input: PostgresSettingsInput): Promise<PostgresConnectionTestResult>;
    private performConnectionTest;
    runMaintenance(force?: boolean): Promise<PostgresMaintenanceResult>;
    private performMaintenance;
    close(): Promise<void>;
    forgetDevice(deviceId: string): void;
    disconnectDevice(deviceId: string): Promise<PostgresDeviceConnectionResult>;
    connectDevice(deviceId: string): Promise<PostgresDeviceConnectionResult>;
    syncDeviceSchema(deviceId: string, dropRemoved?: boolean, expectedOrphanedColumns?: string[]): Promise<HistorianSchemaSyncResult>;
    private performDeviceSchemaSync;
    write(device: Device, readings: ReadingInsert[]): Promise<void>;
    private performWrite;
    replayOfflineCache(limit?: number): Promise<PostgresOfflineReplayResult>;
    private beginOfflineReplay;
    private performOfflineReplay;
    private queueOfflineSample;
    private persistItems;
    private writeWideRaw;
    private writeLastValueDownsample;
    private getTableColumns;
    private assertConvertibleLayout;
    private syncExactTable;
    private resolveRuntime;
    private createConfiguredPool;
    reloadSettings(): Promise<PublicPostgresSettings>;
    private invalidateConnectionGeneration;
    private observePostgresForGeneration;
    private reconcilePostgresSettingsAlert;
    private reconfigure;
    private deleteExpired;
    getPool(): Pool | null;
}
export {};
