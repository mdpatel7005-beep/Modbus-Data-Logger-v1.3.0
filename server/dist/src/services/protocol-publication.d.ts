import type { ByteOrder, FunctionCode, ReadingQuality, RegisterDataType } from "../types/domain.js";
export type PublisherRuntimeState = "disabled" | "stopped" | "starting" | "running" | "stopping" | "error";
export interface PublishedReading {
    value: number | null;
    /**
     * Original Modbus words/bits captured by the collector. A publisher should
     * prefer these over rebuilding raw data from the scaled engineering value.
     */
    raw: number[];
    quality: ReadingQuality;
    timestamp: string;
    hasReading: boolean;
}
export interface PublishedTag {
    id: string;
    name: string;
    address: number;
    functionCode: FunctionCode;
    dataType: RegisterDataType;
    byteOrder: ByteOrder;
    scale: number;
    offset: number;
    unit: string;
    enabled: boolean;
    reading: PublishedReading | null;
}
export interface PublishedDevice {
    id: string;
    name: string;
    tags: PublishedTag[];
}
/**
 * Adapter implemented by the application layer. Keeping this interface free of
 * database types makes both publishers independently testable.
 */
export interface ProtocolPublicationSource {
    getPublishedDevices(): Promise<PublishedDevice[]>;
}
export interface DeviceUnitMapping {
    deviceId: string;
    unitId: number;
}
export interface OpcUaPublisherConfig {
    enabled: boolean;
    /** Interface/IP on which the TCP listener accepts connections. */
    host: string;
    /** Hostname or IP published in endpoint discovery and certificates. */
    advertisedHost?: string;
    port: number;
    endpointPath: string;
    allowAnonymous: boolean;
    refreshIntervalMs: number;
    publishedDeviceIds: string[];
    /**
     * Required non-public data directory for certificates, keys, and trust lists.
     */
    pkiDirectory: string;
    shutdownTimeoutMs?: number;
}
export interface PublisherStatusBase {
    state: PublisherRuntimeState;
    startedAt: string | null;
    stoppedAt: string | null;
    lastError: string | null;
    lastRefreshAt: string | null;
}
export declare function createDefaultOpcUaPublisherConfig(pkiDirectory: string): OpcUaPublisherConfig;
export declare function errorMessage(error: unknown): string;
export declare function validateNetworkPublisherConfig(config: {
    host: string;
    port: number;
    refreshIntervalMs: number;
    shutdownTimeoutMs?: number;
}): void;
export declare function enabledTags(device: PublishedDevice): PublishedTag[];
/**
 * Serializes lifecycle transitions without exposing a lock implementation to
 * the protocol services.
 */
export declare class LifecycleQueue {
    private tail;
    run(operation: () => Promise<void>): Promise<void>;
}
