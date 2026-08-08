import ModbusRTUModule from "modbus-serial";
import type {
  Device,
  FunctionCode,
  RegisterDefinition,
} from "../types/domain.js";
import { decodeRegisters, registerWidth, scaleValue } from "./codec.js";

interface ModbusReadResult {
  data: Array<number | boolean>;
}

interface ModbusRTUClient {
  setID(id: number): void;
  setTimeout(duration: number): void;
  connectTCP(host: string, options: { port: number }): Promise<void>;
  connectRTUBuffered(
    port: string,
    options: {
      baudRate: number;
      parity: "none" | "even" | "odd";
      dataBits: 7 | 8;
      stopBits: 1 | 2;
    },
  ): Promise<void>;
  close(callback?: () => void): void;
  destroy(callback?: () => void): void;
  readCoils(address: number, length: number): Promise<ModbusReadResult>;
  readDiscreteInputs(
    address: number,
    length: number,
  ): Promise<ModbusReadResult>;
  readHoldingRegisters(
    address: number,
    length: number,
  ): Promise<ModbusReadResult>;
  readInputRegisters(
    address: number,
    length: number,
  ): Promise<ModbusReadResult>;
}

const ModbusRTU = ModbusRTUModule as unknown as new () => ModbusRTUClient;

export interface RegisterBlock {
  functionCode: FunctionCode;
  startAddress: number;
  length: number;
  registers: RegisterDefinition[];
}

function width(register: RegisterDefinition): number {
  return register.functionCode === 1 || register.functionCode === 2
    ? 1
    : registerWidth(register.dataType);
}

function protocolReadLimit(functionCode: FunctionCode): number {
  return functionCode === 1 || functionCode === 2 ? 2_000 : 125;
}

export function groupRegisters(
  registers: RegisterDefinition[],
  maxBlockSize: number,
): RegisterBlock[] {
  const configuredBlockSize = Math.max(1, Math.trunc(maxBlockSize));
  const sorted = [...registers].sort(
    (left, right) =>
      left.functionCode - right.functionCode || left.address - right.address,
  );
  const blocks: RegisterBlock[] = [];

  for (const register of sorted) {
    const registerEnd = register.address + width(register);
    const current = blocks.at(-1);
    const boundedBlockSize = Math.min(
      configuredBlockSize,
      protocolReadLimit(register.functionCode),
    );
    const canAppend =
      current &&
      current.functionCode === register.functionCode &&
      registerEnd - current.startAddress <= boundedBlockSize;

    if (canAppend) {
      current.registers.push(register);
      current.length = Math.max(
        current.length,
        registerEnd - current.startAddress,
      );
    } else {
      blocks.push({
        functionCode: register.functionCode,
        startAddress: register.address,
        length: width(register),
        registers: [register],
      });
    }
  }
  return blocks;
}

export class DeviceClient {
  private readonly client: ModbusRTUClient = new ModbusRTU();
  private connected = false;
  private connectionAttempted = false;
  private readonly pendingOperationCancellers = new Set<() => void>();

  constructor(
    private readonly device: Device,
    private readonly closeTimeoutMs = 2_000,
  ) {
    this.client.setID(device.unitId);
    this.client.setTimeout(device.timeoutMs);
  }

  private async runBounded<T>(
    operation: Promise<T>,
    label: string,
  ): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    let cancel = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () =>
        reject(new Error(`${label} was cancelled because polling stopped`));
    });
    this.pendingOperationCancellers.add(cancel);
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () =>
          reject(
            new Error(`${label} timed out after ${this.device.timeoutMs} ms`),
          ),
        this.device.timeoutMs,
      );
    });
    try {
      return await Promise.race([operation, cancelled, timedOut]);
    } finally {
      if (timeout) clearTimeout(timeout);
      this.pendingOperationCancellers.delete(cancel);
    }
  }

  private cancelPendingOperations(): void {
    for (const cancel of this.pendingOperationCancellers) cancel();
    this.pendingOperationCancellers.clear();
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.connectionAttempted = true;

    try {
      if (this.device.protocol === "tcp") {
        if (!this.device.tcpHost || !this.device.tcpPort) {
          throw new Error("TCP device is missing host or port");
        }
        await this.runBounded(
          this.client.connectTCP(this.device.tcpHost, {
            port: this.device.tcpPort,
          }),
          "Modbus TCP connection",
        );
      } else {
        if (!this.device.serialPort || !this.device.baudRate) {
          throw new Error("RTU device is missing serial port or baud rate");
        }
        await this.runBounded(
          this.client.connectRTUBuffered(this.device.serialPort, {
            baudRate: this.device.baudRate,
            parity: this.device.parity ?? "none",
            dataBits: this.device.dataBits ?? 8,
            stopBits: this.device.stopBits ?? 1,
          }),
          "Modbus RTU connection",
        );
      }

      this.connected = true;
    } catch (error) {
      this.connected = false;
      this.connectionAttempted = false;
      await this.abortTransport();
      throw error;
    }
  }

  private async destroyTransport(): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(finish, 500);
      try {
        this.client.destroy(finish);
      } catch {
        finish();
      }
    });
  }

  private async closeTransport(): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const forceDestroy = () => {
        if (this.device.protocol === "rtu") {
          finish();
          return;
        }
        try {
          this.client.destroy(finish);
        } catch {
          finish();
        }
      };
      const timeout = setTimeout(forceDestroy, this.closeTimeoutMs);
      try {
        this.client.close(finish);
      } catch {
        forceDestroy();
      }
    });
  }

  private async abortTransport(): Promise<void> {
    if (this.device.protocol === "tcp") {
      await this.destroyTransport();
      return;
    }
    await this.closeTransport();
  }

  async abort(): Promise<void> {
    this.connected = false;
    this.connectionAttempted = false;
    this.cancelPendingOperations();
    await this.abortTransport();
  }

  async close(): Promise<void> {
    if (!this.connected && !this.connectionAttempted) return;
    this.connected = false;
    this.connectionAttempted = false;
    this.cancelPendingOperations();
    await this.closeTransport();
  }

  private async read(
    functionCode: FunctionCode,
    address: number,
    length: number,
  ): Promise<ModbusReadResult> {
    let operation: Promise<ModbusReadResult>;
    switch (functionCode) {
      case 1:
        operation = this.client.readCoils(address, length);
        break;
      case 2:
        operation = this.client.readDiscreteInputs(address, length);
        break;
      case 3:
        operation = this.client.readHoldingRegisters(address, length);
        break;
      case 4:
        operation = this.client.readInputRegisters(address, length);
        break;
    }
    return this.runBounded(operation, "Modbus read");
  }

  async readRegister(
    register: RegisterDefinition,
  ): Promise<{ raw: number[]; value: number }> {
    const width =
      register.functionCode === 1 || register.functionCode === 2
        ? 1
        : registerWidth(register.dataType);
    const result = await this.read(
      register.functionCode,
      register.address,
      width,
    );
    const raw = result.data.map((value) => Number(value));
    const decoded = decodeRegisters(raw, register.dataType, register.byteOrder);

    return {
      raw,
      value: scaleValue(decoded, register.scale, register.offset),
    };
  }

  async readBlock(
    block: RegisterBlock,
  ): Promise<
    Array<{ register: RegisterDefinition; raw: number[]; value: number }>
  > {
    const result = await this.read(
      block.functionCode,
      block.startAddress,
      block.length,
    );
    const values = result.data.map((value) => Number(value));

    return block.registers.map((register) => {
      const offset = register.address - block.startAddress;
      const raw = values.slice(offset, offset + width(register));
      const decoded = decodeRegisters(
        raw,
        register.dataType,
        register.byteOrder,
      );
      return {
        register,
        raw,
        value: scaleValue(decoded, register.scale, register.offset),
      };
    });
  }
}
