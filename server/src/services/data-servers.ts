import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { LoggerDatabase } from "../db/database.js";
import type {
  ByteOrder,
  FunctionCode,
  ReadingQuality,
  RegisterDataType,
} from "../types/domain.js";
import {
  OpcUaPublisher,
  type OpcUaAuthenticationProvider,
} from "./opc-ua-publisher.js";
import type {
  OpcUaPublisherConfig,
  ProtocolPublicationSource,
  PublishedDevice,
  PublishedReading,
  PublishedTag,
  PublisherRuntimeState,
} from "./protocol-publication.js";

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

interface DataServerSettingsRow {
  modbus_enabled: number;
  modbus_bind_address: string;
  modbus_port: number;
  modbus_refresh_interval_ms: number;
  opcua_enabled: number;
  opcua_bind_address: string;
  opcua_advertised_host: string;
  opcua_port: number;
  opcua_endpoint_path: string;
  opcua_allow_anonymous: number;
  opcua_refresh_interval_ms: number;
  updated_at: string;
}

interface DataServerDeviceExportRow {
  device_id: string;
  modbus_enabled: number;
  modbus_unit_id: number;
  opcua_enabled: number;
}

interface PublicationRow {
  device_id: string;
  device_name: string;
  device_enabled: number;
  device_status: "online" | "warning" | "offline" | "disabled";
  register_id: string | null;
  register_name: string | null;
  address: number | null;
  function_code: FunctionCode | null;
  data_type: RegisterDataType | null;
  byte_order: ByteOrder | null;
  scale: number | null;
  offset: number | null;
  unit: string | null;
  register_enabled: number | null;
  reading_id: number | null;
  value: number | null;
  raw_json: string | null;
  quality: ReadingQuality | null;
  reading_timestamp: string | null;
}

const DEFAULT_SETTINGS = {
  modbus: {
    enabled: false,
    bindAddress: "127.0.0.1",
    port: 1502,
    refreshIntervalMs: 1_000,
  },
  opcUa: {
    enabled: false,
    bindAddress: "127.0.0.1",
    advertisedHost: "127.0.0.1",
    port: 4_840,
    endpointPath: "/ModbusDataLogger",
    allowAnonymous: true,
    refreshIntervalMs: 1_000,
  },
} as const;

function safeRawWords(value: string | null): number[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(
          (word): word is number =>
            Number.isInteger(word) && word >= 0 && word <= 0xffff,
        )
      : [];
  } catch {
    return [];
  }
}

function suggestedMappings(
  deviceIds: Array<{ id: string; unitId: number }>,
  stored: Map<string, DataServerDeviceExportRow>,
): DataServerDeviceMapping[] {
  const used = new Set(
    [...stored.values()]
      .filter((item) => item.modbus_enabled === 1)
      .map((item) => item.modbus_unit_id),
  );
  let nextUnitId = 1;
  const nextAvailable = () => {
    while (used.has(nextUnitId) && nextUnitId <= 247) nextUnitId += 1;
    const result = Math.min(nextUnitId, 247);
    used.add(result);
    nextUnitId += 1;
    return result;
  };

  return deviceIds.map((device) => {
    const saved = stored.get(device.id);
    if (saved) {
      return {
        deviceId: device.id,
        enabled: saved.modbus_enabled === 1,
        unitId: saved.modbus_unit_id,
      };
    }
    const preferred = device.unitId;
    const unitId =
      preferred >= 1 && preferred <= 247 && !used.has(preferred)
        ? preferred
        : nextAvailable();
    used.add(unitId);
    return { deviceId: device.id, enabled: false, unitId };
  });
}

function publicState(
  state: PublisherRuntimeState,
  enabled: boolean,
): DataServerRuntimeStatus["state"] {
  if (state === "stopped") return enabled ? "error" : "disabled";
  return state;
}

export class DataServerSettingsRepository {
  constructor(private readonly database: LoggerDatabase) {
    this.migrate();
  }

  private migrate(): void {
    this.database.connection.transaction(() => {
      this.database.connection
        .prepare(
          `CREATE TABLE IF NOT EXISTS data_server_settings (
             id INTEGER PRIMARY KEY CHECK (id = 1),
             modbus_enabled INTEGER NOT NULL DEFAULT 0,
             modbus_bind_address TEXT NOT NULL DEFAULT '127.0.0.1',
             modbus_port INTEGER NOT NULL DEFAULT 1502,
             modbus_refresh_interval_ms INTEGER NOT NULL DEFAULT 1000,
             opcua_enabled INTEGER NOT NULL DEFAULT 0,
             opcua_bind_address TEXT NOT NULL DEFAULT '127.0.0.1',
             opcua_advertised_host TEXT NOT NULL DEFAULT '127.0.0.1',
             opcua_port INTEGER NOT NULL DEFAULT 4840,
             opcua_endpoint_path TEXT NOT NULL DEFAULT '/ModbusDataLogger',
             opcua_allow_anonymous INTEGER NOT NULL DEFAULT 1,
             opcua_refresh_interval_ms INTEGER NOT NULL DEFAULT 1000,
             updated_at TEXT NOT NULL
           )`,
        )
        .run();
      const settingsColumns = this.database.connection
        .prepare("PRAGMA table_info(data_server_settings)")
        .all() as Array<{ name: string }>;
      if (
        !settingsColumns.some(
          (column) => column.name === "opcua_advertised_host",
        )
      ) {
        this.database.connection
          .prepare(
            `ALTER TABLE data_server_settings
             ADD COLUMN opcua_advertised_host TEXT NOT NULL
             DEFAULT '127.0.0.1'`,
          )
          .run();
      }
      this.database.connection
        .prepare(
          `CREATE TABLE IF NOT EXISTS data_server_device_exports (
             device_id TEXT PRIMARY KEY
               REFERENCES devices(id) ON DELETE CASCADE,
             modbus_enabled INTEGER NOT NULL DEFAULT 0,
             modbus_unit_id INTEGER NOT NULL
               CHECK (modbus_unit_id BETWEEN 1 AND 247),
             opcua_enabled INTEGER NOT NULL DEFAULT 0
           )`,
        )
        .run();
      this.database.connection
        .prepare(
          `CREATE UNIQUE INDEX IF NOT EXISTS
             data_server_modbus_unit_idx
           ON data_server_device_exports(modbus_unit_id)
           WHERE modbus_enabled = 1`,
        )
        .run();
      this.database.connection
        .prepare(
          `INSERT OR IGNORE INTO data_server_settings (
             id, modbus_enabled, modbus_bind_address, modbus_port,
             modbus_refresh_interval_ms, opcua_enabled,
             opcua_bind_address, opcua_advertised_host, opcua_port,
             opcua_endpoint_path,
             opcua_allow_anonymous, opcua_refresh_interval_ms, updated_at
           ) VALUES (1, 0, '127.0.0.1', 1502, 1000, 0, '127.0.0.1',
                     '127.0.0.1', 4840, '/ModbusDataLogger', 1, 1000, ?)`,
        )
        .run(new Date().toISOString());
    })();
  }

  getInput(): DataServerSettingsInput & { updatedAt: string | null } {
    const row = this.database.connection
      .prepare("SELECT * FROM data_server_settings WHERE id = 1")
      .get() as DataServerSettingsRow | undefined;
    const exports = this.database.connection
      .prepare(
        `SELECT device_id, modbus_enabled, modbus_unit_id, opcua_enabled
         FROM data_server_device_exports`,
      )
      .all() as DataServerDeviceExportRow[];
    const exportByDevice = new Map(
      exports.map((item) => [item.device_id, item] as const),
    );
    const devices = this.database.listDevices().map((device) => ({
      id: device.id,
      unitId: device.unitId,
    }));
    const settings = row
      ? {
          modbus: {
            enabled: row.modbus_enabled === 1,
            bindAddress: row.modbus_bind_address,
            port: row.modbus_port,
            refreshIntervalMs: row.modbus_refresh_interval_ms,
          },
          opcUa: {
            enabled: row.opcua_enabled === 1,
            bindAddress: row.opcua_bind_address,
            advertisedHost: row.opcua_advertised_host,
            port: row.opcua_port,
            endpointPath: row.opcua_endpoint_path,
            allowAnonymous: row.opcua_allow_anonymous === 1,
            refreshIntervalMs: row.opcua_refresh_interval_ms,
          },
          updatedAt: row.updated_at,
        }
      : {
          modbus: DEFAULT_SETTINGS.modbus,
          opcUa: DEFAULT_SETTINGS.opcUa,
          updatedAt: null,
        };

    return {
      modbus: {
        ...settings.modbus,
        mappings: suggestedMappings(devices, exportByDevice),
      },
      opcUa: {
        ...settings.opcUa,
        publications: devices.map((device) => ({
          deviceId: device.id,
          enabled: exportByDevice.get(device.id)?.opcua_enabled === 1,
        })),
      },
      updatedAt: settings.updatedAt,
    };
  }

  save(input: DataServerSettingsInput): void {
    const existingDevices = new Set(
      this.database.listDevices().map((device) => device.id),
    );
    for (const item of [
      ...input.modbus.mappings,
      ...input.opcUa.publications,
    ]) {
      if (!existingDevices.has(item.deviceId)) {
        throw new Error(`Configured data-server device ${item.deviceId} was not found`);
      }
    }

    const combined = new Map<
      string,
      { modbusEnabled: boolean; unitId: number; opcUaEnabled: boolean }
    >();
    for (const mapping of input.modbus.mappings) {
      combined.set(mapping.deviceId, {
        modbusEnabled: mapping.enabled,
        unitId: mapping.unitId,
        opcUaEnabled: false,
      });
    }
    for (const publication of input.opcUa.publications) {
      const current = combined.get(publication.deviceId);
      combined.set(publication.deviceId, {
        modbusEnabled: current?.modbusEnabled ?? false,
        unitId: current?.unitId ?? 1,
        opcUaEnabled: publication.enabled,
      });
    }

    const now = new Date().toISOString();
    this.database.connection.transaction(() => {
      this.database.connection
        .prepare(
          `UPDATE data_server_settings SET
             modbus_enabled = ?,
             modbus_bind_address = ?,
             modbus_port = ?,
             modbus_refresh_interval_ms = ?,
             opcua_enabled = ?,
             opcua_bind_address = ?,
             opcua_advertised_host = ?,
             opcua_port = ?,
             opcua_endpoint_path = ?,
             opcua_allow_anonymous = ?,
             opcua_refresh_interval_ms = ?,
             updated_at = ?
           WHERE id = 1`,
        )
        .run(
          Number(input.modbus.enabled),
          input.modbus.bindAddress,
          input.modbus.port,
          input.modbus.refreshIntervalMs,
          Number(input.opcUa.enabled),
          input.opcUa.bindAddress,
          input.opcUa.advertisedHost,
          input.opcUa.port,
          input.opcUa.endpointPath,
          Number(input.opcUa.allowAnonymous),
          input.opcUa.refreshIntervalMs,
          now,
        );
      this.database.connection
        .prepare("DELETE FROM data_server_device_exports")
        .run();
      const insert = this.database.connection.prepare(
        `INSERT INTO data_server_device_exports (
           device_id, modbus_enabled, modbus_unit_id, opcua_enabled
         ) VALUES (?, ?, ?, ?)`,
      );
      for (const [deviceId, item] of combined) {
        insert.run(
          deviceId,
          Number(item.modbusEnabled),
          item.unitId,
          Number(item.opcUaEnabled),
        );
      }
    })();
  }

  disableAll(): void {
    this.database.connection
      .prepare(
        `UPDATE data_server_settings
         SET modbus_enabled = 0, opcua_enabled = 0, updated_at = ?
         WHERE id = 1`,
      )
      .run(new Date().toISOString());
  }

  reset(): void {
    const now = new Date().toISOString();
    this.database.connection.transaction(() => {
      this.database.connection
        .prepare("DELETE FROM data_server_device_exports")
        .run();
      this.database.connection
        .prepare(
          `UPDATE data_server_settings SET
             modbus_enabled = 0,
             modbus_bind_address = '127.0.0.1',
             modbus_port = 1502,
             modbus_refresh_interval_ms = 1000,
             opcua_enabled = 0,
             opcua_bind_address = '127.0.0.1',
             opcua_advertised_host = '127.0.0.1',
             opcua_port = 4840,
             opcua_endpoint_path = '/ModbusDataLogger',
             opcua_allow_anonymous = 1,
             opcua_refresh_interval_ms = 1000,
             updated_at = ?
           WHERE id = 1`,
        )
        .run(now);
    })();
  }
}

export class DatabasePublicationSource
  implements ProtocolPublicationSource
{
  constructor(private readonly database: LoggerDatabase) {}

  async getPublishedDevices(): Promise<PublishedDevice[]> {
    const rows = this.database.connection
      .prepare(
        `SELECT
           d.id AS device_id,
           d.name AS device_name,
           d.enabled AS device_enabled,
           d.status AS device_status,
           rg.id AS register_id,
           rg.name AS register_name,
           rg.address,
           rg.function_code,
           rg.data_type,
           rg.byte_order,
           rg.scale,
           rg.offset,
           rg.unit,
           rg.enabled AS register_enabled,
           latest.id AS reading_id,
           latest.value,
           latest.raw_json,
           latest.quality,
           latest.timestamp AS reading_timestamp
         FROM devices AS d
         LEFT JOIN registers AS rg ON rg.device_id = d.id
         LEFT JOIN readings AS latest ON latest.id = (
           SELECT candidate.id
           FROM readings AS candidate
           WHERE candidate.register_id = rg.id
           ORDER BY candidate.id DESC
           LIMIT 1
         )
         ORDER BY d.name COLLATE NOCASE, rg.function_code, rg.address, rg.id`,
      )
      .all() as PublicationRow[];
    const devices = new Map<string, PublishedDevice>();
    for (const row of rows) {
      let device = devices.get(row.device_id);
      if (!device) {
        device = { id: row.device_id, name: row.device_name, tags: [] };
        devices.set(row.device_id, device);
      }
      if (
        !row.register_id ||
        row.register_name === null ||
        row.address === null ||
        row.function_code === null ||
        row.data_type === null ||
        row.byte_order === null ||
        row.scale === null ||
        row.offset === null ||
        row.unit === null ||
        row.register_enabled === null
      ) {
        continue;
      }
      const reading: PublishedReading | null =
        row.device_enabled !== 1 ||
        row.device_status === "offline" ||
        row.device_status === "disabled" ||
        row.reading_id === null ||
        row.quality === null ||
        row.reading_timestamp === null
          ? null
          : {
              value: row.value,
              raw: safeRawWords(row.raw_json),
              quality: row.quality,
              timestamp: row.reading_timestamp,
              hasReading: true,
            };
      const tag: PublishedTag = {
        id: row.register_id,
        name: row.register_name,
        address: row.address,
        functionCode: row.function_code,
        dataType: row.data_type,
        byteOrder: row.byte_order,
        scale: row.scale,
        offset: row.offset,
        unit: row.unit,
        enabled: row.register_enabled === 1,
        reading,
      };
      device.tags.push(tag);
    }
    return [...devices.values()];
  }
}

export class DataServerManager {
  readonly repository: DataServerSettingsRepository;
  private readonly source: DatabasePublicationSource;
  private opcUa: OpcUaPublisher;
  private monitorTimer: NodeJS.Timeout | null = null;
  private lastStatusSignatures = new Map<string, string>();
  private lastAppliedInput: DataServerSettingsInput;
  private fullyStopped = false;

  constructor(
    private readonly database: LoggerDatabase,
    private readonly logger: FastifyBaseLogger,
    private readonly pkiDirectory: string,
    opcUaAuthenticationProvider: OpcUaAuthenticationProvider,
  ) {
    this.repository = new DataServerSettingsRepository(database);
    this.source = new DatabasePublicationSource(database);
    const input = this.repository.getInput();
    this.lastAppliedInput = structuredClone(input);
    this.opcUa = new OpcUaPublisher(
      this.source,
      this.opcUaConfig(input),
      undefined,
      opcUaAuthenticationProvider,
    );
  }

  async start(): Promise<void> {
    await this.opcUa.start();
    this.fullyStopped = false;
    this.lastAppliedInput = structuredClone(this.repository.getInput());
    this.recordStatusChanges();
    this.ensureMonitor();
  }

  async reload(): Promise<void> {
    const input = this.repository.getInput();
    const opcUaChanged =
      this.fullyStopped ||
      JSON.stringify(this.opcUaConfig(input)) !==
        JSON.stringify(this.opcUaConfig(this.lastAppliedInput));
    if (opcUaChanged) {
      await this.opcUa.reload(this.opcUaConfig(input));
    }
    this.fullyStopped = false;
    this.lastAppliedInput = structuredClone(input);
    this.recordStatusChanges();
    this.ensureMonitor();
  }

  async reloadOpcUa(): Promise<void> {
    const input = this.repository.getInput();
    if (!input.opcUa.enabled || input.opcUa.allowAnonymous) return;
    await this.opcUa.reload(this.opcUaConfig(input));
    this.lastAppliedInput = structuredClone(input);
    this.recordStatusChanges();
    this.ensureMonitor();
  }

  async stop(): Promise<void> {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    await this.opcUa.stop();
    this.fullyStopped = true;
  }

  getSettings(): DataServerSettings {
    const input = this.repository.getInput();
    const opcUaStatus = this.opcUa.getStatus();
    return {
      ...input,
      modbus: {
        ...input.modbus,
        runtime: {
          state: input.modbus.enabled ? "running" : "disabled",
          message: null,
          startedAt: null,
          lastRefreshAt: null,
          connectedClients: 0,
          requestCount: 0,
        },
      },
      opcUa: {
        ...input.opcUa,
        runtime: {
          state: publicState(opcUaStatus.state, input.opcUa.enabled),
          message:
            opcUaStatus.lastError ??
            (opcUaStatus.state === "stopped" && input.opcUa.enabled
              ? "OPC UA server is stopped"
              : null),
          startedAt: opcUaStatus.startedAt,
          lastRefreshAt: opcUaStatus.lastRefreshAt,
          connectedClients: opcUaStatus.connectedClients,
          requestCount: opcUaStatus.requestCount,
        },
      },
      updatedAt: input.updatedAt,
    };
  }

  private opcUaConfig(input: DataServerSettingsInput): OpcUaPublisherConfig {
    return {
      enabled: input.opcUa.enabled,
      host: input.opcUa.bindAddress,
      advertisedHost: input.opcUa.advertisedHost,
      port: input.opcUa.port,
      endpointPath: input.opcUa.endpointPath,
      allowAnonymous: input.opcUa.allowAnonymous,
      refreshIntervalMs: input.opcUa.refreshIntervalMs,
      publishedDeviceIds: input.opcUa.publications
        .filter((publication) => publication.enabled)
        .map((publication) => publication.deviceId),
      pkiDirectory: path.resolve(this.pkiDirectory),
    };
  }

  private recordStatusChanges(): void {
    const opcUaStatus = this.opcUa.getStatus();
    const signature = JSON.stringify({
      state: opcUaStatus.state,
      lastError: opcUaStatus.lastError,
    });
    if (this.lastStatusSignatures.get("opc_ua") !== signature) {
      this.lastStatusSignatures.set("opc_ua", signature);
      const isError = opcUaStatus.state === "error" || opcUaStatus.lastError !== null;
      this.database.appendActivity({
        level: isError ? "error" : "info",
        category: "system",
        event: `data_server.opc_ua.${opcUaStatus.state}`,
        message: isError
          ? `OPC UA server: ${opcUaStatus.lastError ?? opcUaStatus.state}`
          : "OPC UA server is " + opcUaStatus.state,
        entityType: "data_server",
        entityId: "opc_ua",
        details: {
          bindAddress: opcUaStatus.host,
          port: opcUaStatus.port,
          state: opcUaStatus.state,
        },
      });
      if (isError) {
        this.logger.error(
          {
            service: "opc_ua",
            state: opcUaStatus.state,
            error: opcUaStatus.lastError,
          },
          "data server reported an error",
        );
      }
    }
  }

  private ensureMonitor(): void {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(() => this.recordStatusChanges(), 5_000);
    this.monitorTimer.unref();
  }
}
