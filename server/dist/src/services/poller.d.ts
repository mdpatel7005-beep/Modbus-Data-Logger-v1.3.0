import type { FastifyBaseLogger } from "fastify";
import type { LoggerDatabase } from "../db/database.js";
import { DeviceClient } from "../modbus/client.js";
import type { Device } from "../types/domain.js";
import type { PostgresHistorian } from "./postgres-historian.js";
import type { SystemAlertService } from "./system-alerts.js";
export declare class PollingDrainTimeoutError extends Error {
    constructor(timeoutMs: number);
}
export declare class PollingService {
    private readonly database;
    private readonly logger;
    private readonly postgresHistorian;
    private readonly enabled;
    private readonly clientFactory;
    private readonly tasks;
    private readonly alarmEngine;
    private started;
    private administrationPaused;
    private lifecycleTail;
    private readonly activePollOperations;
    private resumeAfterDrainPending;
    private systemAlerts;
    constructor(database: LoggerDatabase, logger: FastifyBaseLogger, postgresHistorian: PostgresHistorian, enabled?: boolean, clientFactory?: (device: Device) => DeviceClient);
    setSystemAlertService(systemAlerts: SystemAlertService): void;
    start(): Promise<void>;
    private startNow;
    reload(): Promise<void>;
    stop(): Promise<void>;
    private stopTasks;
    stopAndDrain(): Promise<void>;
    pauseAndDrain(timeoutMs?: number): Promise<void>;
    resumeAndStart(): Promise<void>;
    private stopAndDrainNow;
    private scheduleStartAfterDrain;
    private serializeLifecycle;
    get activeDeviceCount(): number;
    get paused(): boolean;
    private startDevice;
    private pollDevice;
    private readBlock;
    private readBlockWithFallback;
}
