import type { FastifyBaseLogger } from "fastify";
import type { LoggerDatabase } from "../db/database.js";
import { type OpcUaAuthenticationProvider } from "./opc-ua-publisher.js";
import type { ProtocolPublicationSource, PublishedDevice } from "./protocol-publication.js";
export interface DataServerDeviceMapping {
    deviceId: string;
    enabled: boolean;
    unitId: number;
}
export interface OpcUaDevicePublication {
    deviceId: string;
    enabled: boolean;
}
export interface DataServerSettingsInput {
    modbus: {
        enabled: boolean;
        bindAddress: string;
        port: number;
        refreshIntervalMs: number;
        mappings: DataServerDeviceMapping[];
    };
    opcUa: {
        enabled: boolean;
        bindAddress: string;
        advertisedHost: string;
        port: number;
        endpointPath: string;
        allowAnonymous: boolean;
        refreshIntervalMs: number;
        publications: OpcUaDevicePublication[];
    };
}
export interface DataServerRuntimeStatus {
    state: "disabled" | "starting" | "running" | "stopping" | "error";
    message: string | null;
    startedAt: string | null;
    lastRefreshAt: string | null;
    connectedClients: number;
    requestCount: number;
}
export interface DataServerSettings extends DataServerSettingsInput {
    modbus: DataServerSettingsInput["modbus"] & {
        runtime: DataServerRuntimeStatus;
    };
    opcUa: DataServerSettingsInput["opcUa"] & {
        runtime: DataServerRuntimeStatus;
    };
    updatedAt: string | null;
}
export declare class DataServerSettingsRepository {
    private readonly database;
    constructor(database: LoggerDatabase);
    private migrate;
    getInput(): DataServerSettingsInput & {
        updatedAt: string | null;
    };
    save(input: DataServerSettingsInput): void;
    disableAll(): void;
    reset(): void;
}
export declare class DatabasePublicationSource implements ProtocolPublicationSource {
    private readonly database;
    constructor(database: LoggerDatabase);
    getPublishedDevices(): Promise<PublishedDevice[]>;
}
export declare class DataServerManager {
    private readonly database;
    private readonly logger;
    private readonly pkiDirectory;
    readonly repository: DataServerSettingsRepository;
    private readonly source;
    private opcUa;
    private monitorTimer;
    private lastStatusSignatures;
    private lastAppliedInput;
    private fullyStopped;
    constructor(database: LoggerDatabase, logger: FastifyBaseLogger, pkiDirectory: string, opcUaAuthenticationProvider: OpcUaAuthenticationProvider);
    start(): Promise<void>;
    reload(): Promise<void>;
    reloadOpcUa(): Promise<void>;
    stop(): Promise<void>;
    getSettings(): DataServerSettings;
    private opcUaConfig;
    private recordStatusChanges;
    private ensureMonitor;
}
