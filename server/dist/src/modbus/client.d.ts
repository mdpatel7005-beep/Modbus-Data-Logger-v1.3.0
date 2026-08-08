import type { Device, FunctionCode, RegisterDefinition } from "../types/domain.js";
export interface RegisterBlock {
    functionCode: FunctionCode;
    startAddress: number;
    length: number;
    registers: RegisterDefinition[];
}
export declare function groupRegisters(registers: RegisterDefinition[], maxBlockSize: number): RegisterBlock[];
export declare class DeviceClient {
    private readonly device;
    private readonly closeTimeoutMs;
    private readonly client;
    private connected;
    private connectionAttempted;
    private readonly pendingOperationCancellers;
    constructor(device: Device, closeTimeoutMs?: number);
    private runBounded;
    private cancelPendingOperations;
    connect(): Promise<void>;
    private destroyTransport;
    private closeTransport;
    private abortTransport;
    abort(): Promise<void>;
    close(): Promise<void>;
    private read;
    readRegister(register: RegisterDefinition): Promise<{
        raw: number[];
        value: number;
    }>;
    readBlock(block: RegisterBlock): Promise<Array<{
        register: RegisterDefinition;
        raw: number[];
        value: number;
    }>>;
}
