import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const temporaryRoot = mkdtempSync(
  path.join(tmpdir(), "modbus-system-admin-data-servers-"),
);
const databasePath = path.join(temporaryRoot, "logger.db");

process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = databasePath;
process.env.SYSTEM_ADMIN_DATA_DIR = path.join(temporaryRoot, "system-admin");
process.env.JWT_SECRET =
  "data-server-backup-test-secret-with-more-than-32-characters";
process.env.SETTINGS_ENCRYPTION_KEY =
  "data-server-backup-encryption-key-more-than-32-characters";
process.env.AUTH_DISABLED = "false";
process.env.POLLING_ENABLED = "false";
delete process.env.POSTGRES_URL;

const { LoggerDatabase } = await import("../src/db/database.js");
const { DataServerSettingsRepository } = await import(
  "../src/services/data-servers.js"
);
const { decryptSecret, encryptSecret } = await import(
  "../src/services/secret-box.js"
);
const { SystemAdministrationService } = await import(
  "../src/services/system-admin.js"
);

const backupPrefix = "modbus-data-logger-backup.v1.";

test("backs up, safely restores, and resets data-server configuration", async (context) => {
  context.after(() =>
    rmSync(temporaryRoot, { force: true, recursive: true }),
  );
  const database = new LoggerDatabase(databasePath);
  context.after(() => database.close());
  const repository = new DataServerSettingsRepository(database);
  const administration = new SystemAdministrationService(database, {
    dataDirectory: path.join(temporaryRoot, "system-admin"),
  });
  const administrator = database.createUser({
    username: "preserved-admin",
    passwordHash: "preserved-hash",
    role: "administrator",
  });
  const device = database.createDevice({
    name: "Published meter",
    protocol: "tcp",
    tcpHost: "192.0.2.20",
    tcpPort: 502,
    unitId: 1,
    pollIntervalMs: 1_000,
    readBlockSize: 120,
    timeoutMs: 2_000,
    retries: 2,
    postgresEnabled: false,
    saveIntervalMs: 1_000,
    postgresRawTable: "published_meter_raw",
    postgresDownsampleTable: "published_meter_1m",
    postgresDownsampleEnabled: true,
    postgresDownsampleIntervalSec: 60,
    postgresRawRetentionDays: 30,
    postgresDownsampleRetentionDays: 365,
    postgresMaintenanceIntervalHours: 24,
    enabled: true,
  });

  repository.save({
    modbus: {
      enabled: true,
      bindAddress: "0.0.0.0",
      port: 2_502,
      refreshIntervalMs: 750,
      mappings: [{ deviceId: device.id, enabled: true, unitId: 5 }],
    },
    opcUa: {
      enabled: true,
      bindAddress: "::1",
      advertisedHost: "logger.test.internal",
      port: 4_841,
      endpointPath: "/Plant",
      allowAnonymous: false,
      refreshIntervalMs: 1_500,
      publications: [{ deviceId: device.id, enabled: true }],
    },
  });

  const backup = administration.createConfigurationBackup({
    actorId: administrator.id,
  });
  const envelope = JSON.parse(
    decryptSecret(backup.slice(backupPrefix.length)),
  ) as {
    data: Record<string, unknown> & {
      dataServerSettings: Array<Record<string, unknown>>;
      dataServerDeviceExports: Array<Record<string, unknown>>;
    };
  };
  assert.equal("users" in envelope.data, false);
  assert.equal(envelope.data.dataServerSettings.length, 1);
  assert.equal(envelope.data.dataServerSettings[0]?.modbus_enabled, 1);
  assert.equal(envelope.data.dataServerSettings[0]?.opcua_enabled, 1);
  assert.equal(
    envelope.data.dataServerSettings[0]?.opcua_advertised_host,
    "logger.test.internal",
  );
  assert.deepEqual(envelope.data.dataServerDeviceExports, [
    {
      device_id: device.id,
      modbus_enabled: 1,
      modbus_unit_id: 5,
      opcua_enabled: 1,
    },
  ]);

  repository.reset();
  const restored = await administration.restoreConfigurationBackup(backup, {
    actorId: administrator.id,
  });
  const restoredSettings = repository.getInput();
  assert.equal(restoredSettings.modbus.enabled, false);
  assert.equal(restoredSettings.modbus.bindAddress, "0.0.0.0");
  assert.equal(restoredSettings.modbus.port, 2_502);
  assert.equal(restoredSettings.modbus.refreshIntervalMs, 750);
  assert.deepEqual(restoredSettings.modbus.mappings, [
    { deviceId: device.id, enabled: true, unitId: 5 },
  ]);
  assert.equal(restoredSettings.opcUa.enabled, false);
  assert.equal(restoredSettings.opcUa.bindAddress, "::1");
  assert.equal(restoredSettings.opcUa.port, 4_841);
  assert.equal(restoredSettings.opcUa.endpointPath, "/Plant");
  assert.equal(restoredSettings.opcUa.allowAnonymous, false);
  assert.equal(restoredSettings.opcUa.refreshIntervalMs, 1_500);
  assert.deepEqual(restoredSettings.opcUa.publications, [
    { deviceId: device.id, enabled: true },
  ]);
  assert.equal(restoredSettings.updatedAt, restored.restoredAt);

  const legacyEnvelope = structuredClone(envelope) as {
    data: Record<string, unknown>;
  };
  delete legacyEnvelope.data.dataServerSettings;
  delete legacyEnvelope.data.dataServerDeviceExports;
  const legacyBackup = `${backupPrefix}${encryptSecret(
    JSON.stringify(legacyEnvelope),
  )}`;
  await administration.restoreConfigurationBackup(legacyBackup, {
    actorId: administrator.id,
  });
  const legacyRestored = repository.getInput();
  assert.equal(legacyRestored.modbus.enabled, false);
  assert.equal(legacyRestored.modbus.bindAddress, "127.0.0.1");
  assert.equal(legacyRestored.modbus.port, 1_502);
  assert.equal(legacyRestored.opcUa.enabled, false);
  assert.equal(legacyRestored.opcUa.bindAddress, "127.0.0.1");
  assert.equal(legacyRestored.opcUa.port, 4_840);
  assert.equal(legacyRestored.opcUa.endpointPath, "/ModbusDataLogger");
  assert.equal(
    (
      database.connection
        .prepare(
          "SELECT COUNT(*) AS count FROM data_server_device_exports",
        )
        .get() as { count: number }
    ).count,
    0,
  );

  repository.save({
    modbus: {
      enabled: true,
      bindAddress: "0.0.0.0",
      port: 3_502,
      refreshIntervalMs: 500,
      mappings: [{ deviceId: device.id, enabled: true, unitId: 7 }],
    },
    opcUa: {
      enabled: true,
      bindAddress: "0.0.0.0",
      advertisedHost: "logger.test.internal",
      port: 5_840,
      endpointPath: "/BeforeReset",
      allowAnonymous: false,
      refreshIntervalMs: 500,
      publications: [{ deviceId: device.id, enabled: true }],
    },
  });
  database.appendActivity({
    level: "info",
    category: "system",
    event: "before.reset",
    message: "Must be removed by factory reset",
  });
  const reset = await administration.factoryReset({
    actorId: administrator.id,
  });
  const resetSettings = repository.getInput();
  assert.equal(resetSettings.modbus.enabled, false);
  assert.equal(resetSettings.modbus.bindAddress, "127.0.0.1");
  assert.equal(resetSettings.modbus.port, 1_502);
  assert.equal(resetSettings.modbus.refreshIntervalMs, 1_000);
  assert.deepEqual(resetSettings.modbus.mappings, []);
  assert.equal(resetSettings.opcUa.enabled, false);
  assert.equal(resetSettings.opcUa.bindAddress, "127.0.0.1");
  assert.equal(resetSettings.opcUa.port, 4_840);
  assert.equal(resetSettings.opcUa.endpointPath, "/ModbusDataLogger");
  assert.equal(resetSettings.opcUa.allowAnonymous, true);
  assert.equal(resetSettings.opcUa.refreshIntervalMs, 1_000);
  assert.deepEqual(resetSettings.opcUa.publications, []);
  assert.equal(resetSettings.updatedAt, reset.resetAt);
  assert.equal(database.getUserById(administrator.id)?.username, "preserved-admin");
  assert.deepEqual(
    database.connection
      .prepare("SELECT event FROM activity_log ORDER BY id")
      .all(),
    [{ event: "system.factory_reset" }],
  );
});
