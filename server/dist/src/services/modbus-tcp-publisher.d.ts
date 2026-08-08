import { type IServiceVector } from "modbus-serial";
import { type ModbusTcpPublisherConfig, type ProtocolPublicationSource, type PublishedDevice, type PublishedTag, type PublisherStatusBase } from "./protocol-publication.js";
interface ModbusUnitImage {
    coils: Map<number, boolean>;
    discreteInputs: Map<number, boolean>;
    holdingRegisters: Map<number, number>;
    inputRegisters: Map<number, number>;
}
export interface ModbusTcpPublisherStatus extends PublisherStatusBase {
    host: string;
    port: number;
    connectedClients: number;
    totalConnections: number;
    requestCount: number;
    readErrors: number;
    rejectedWrites: number;
    publishedDevices: number;
    publishedTags: number;
}
export interface ModbusTcpServerRuntime {
    getConnectedClientCount(): number;
    close(timeoutMs: number): Promise<void>;
}
export interface ModbusTcpRuntimeCallbacks {
    onConnection(): void;
    onRuntimeError(error: unknown): void;
}
export type ModbusTcpRuntimeFactory = (vector: IServiceVector, options: {
    host: string;
    port: number;
    unitID: number;
}, callbacks: ModbusTcpRuntimeCallbacks) => Promise<ModbusTcpServerRuntime>;
/**
 * Converts an engineering value back to source register words. This is only a
 * fallback: captured raw words are preferable because inverse scaling can be
 * lossy for integer data.
 */
export declare function encodeEngineeringValueAsRaw(tag: Pick<PublishedTag, "dataType" | "byteOrder" | "scale" | "offset">, engineeringValue: number): number[];
export declare function buildModbusUnitImages(devices: PublishedDevice[], mappings: ModbusTcpPublisherConfig["deviceMappings"]): {
    images: Map<number, ModbusUnitImage>;
    publishedDevices: number;
    publishedTags: number;
};
export declare function createModbusTcpServerRuntime(vector: IServiceVector, options: {
    host: string;
    port: number;
    unitID: number;
}, callbacks: ModbusTcpRuntimeCallbacks): Promise<ModbusTcpServerRuntime>;
export declare class ModbusTcpPublisher {
    private readonly source;
    private readonly runtimeFactory;
    private readonly lifecycle;
    private config;
    private runtime;
    private images;
    private refreshTimer;
    private status;
    constructor(source: ProtocolPublicationSource, config?: ModbusTcpPublisherConfig, runtimeFactory?: ModbusTcpRuntimeFactory);
    getStatus(): ModbusTcpPublisherStatus;
    start(): Promise<void>;
    reload(config: ModbusTcpPublisherConfig): Promise<void>;
    stop(): Promise<void>;
    refresh(): Promise<void>;
    private createVector;
    private scheduleRefresh;
    private startUnsafe;
    private stopUnsafe;
}
export {};
