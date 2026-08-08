import type {
  ByteOrder,
  FunctionCode,
  ReadingQuality,
  RegisterDataType,
} from "../types/domain.js";

export type PublisherRuntimeState =
  | "disabled"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error";

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

export function createDefaultOpcUaPublisherConfig(
  pkiDirectory: string,
): OpcUaPublisherConfig {
  return {
    enabled: false,
    host: "127.0.0.1",
    advertisedHost: "127.0.0.1",
    port: 4_840,
    endpointPath: "/ModbusDataLogger",
    allowAnonymous: true,
    refreshIntervalMs: 1_000,
    publishedDeviceIds: [],
    pkiDirectory,
    shutdownTimeoutMs: 5_000,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validateNetworkPublisherConfig(config: {
  host: string;
  port: number;
  refreshIntervalMs: number;
  shutdownTimeoutMs?: number;
}): void {
  if (!config.host.trim()) {
    throw new Error("Publisher host is required");
  }
  if (
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65_535
  ) {
    throw new Error("Publisher port must be an integer from 1 to 65535");
  }
  if (
    !Number.isInteger(config.refreshIntervalMs) ||
    config.refreshIntervalMs < 100 ||
    config.refreshIntervalMs > 3_600_000
  ) {
    throw new Error(
      "Publisher refresh interval must be an integer from 100 to 3600000 ms",
    );
  }
  if (
    config.shutdownTimeoutMs !== undefined &&
    (!Number.isInteger(config.shutdownTimeoutMs) ||
      config.shutdownTimeoutMs < 100 ||
      config.shutdownTimeoutMs > 60_000)
  ) {
    throw new Error(
      "Publisher shutdown timeout must be an integer from 100 to 60000 ms",
    );
  }
}

export function enabledTags(device: PublishedDevice): PublishedTag[] {
  return device.tags.filter((tag) => tag.enabled);
}

/**
 * Serializes lifecycle transitions without exposing a lock implementation to
 * the protocol services.
 */
export class LifecycleQueue {
  private tail: Promise<void> = Promise.resolve();

  run(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => {});
    return result;
  }
}
