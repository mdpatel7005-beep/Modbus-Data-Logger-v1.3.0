import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HistorianColumnNameConflictError,
  LoggerDatabase,
} from "../src/db/database.js";

test("stores devices, registers, and readings transactionally", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "modbus-logger-"));
  context.after(() => rmSync(directory, { force: true, recursive: true }));

  const database = new LoggerDatabase(path.join(directory, "test.db"));
  context.after(() => database.close());

  const category = database.createDeviceCategory("Energy meters");
  const group = database.createDeviceGroup("Building A");
  assert.equal(category.deviceCount, 0);
  assert.equal(group.deviceCount, 0);
  assert.throws(
    () => database.createDeviceCategory("energy METERS"),
    /UNIQUE constraint failed/,
  );
  const device = database.createDevice({
    name: "Test meter",
    protocol: "tcp",
    tcpHost: "127.0.0.1",
    tcpPort: 1502,
    unitId: 1,
    pollIntervalMs: 1000,
    readBlockSize: 120,
    timeoutMs: 1000,
    retries: 1,
    categoryId: category.id,
    groupId: group.id,
    postgresEnabled: false,
    saveIntervalMs: 1000,
    postgresRawTable: "modbus_raw",
    postgresDownsampleTable: "modbus_1m",
    postgresDownsampleEnabled: true,
    postgresDownsampleIntervalSec: 60,
    postgresRawRetentionDays: 30,
    postgresDownsampleRetentionDays: 365,
    postgresMaintenanceIntervalHours: 24,
    enabled: true,
  });
  assert.equal(device.categoryId, category.id);
  assert.equal(device.categoryName, "Energy meters");
  assert.equal(device.groupId, group.id);
  assert.equal(device.groupName, "Building A");
  assert.equal(database.getDeviceCategory(category.id)?.deviceCount, 1);
  assert.equal(database.getDeviceGroup(group.id)?.deviceCount, 1);
  assert.throws(
    () => database.deleteDeviceCategory(category.id),
    /FOREIGN KEY constraint failed/,
  );
  const register = database.createRegister({
    deviceId: device.id,
    name: "Voltage",
    address: 0,
    functionCode: 3,
    dataType: "uint16",
    byteOrder: "ABCD",
    scale: 0.1,
    offset: 0,
    unit: "V",
    decimalPlaces: 3,
    enabled: true,
  });
  assert.equal(device.postgresSchemaSyncedAt, null);
  assert.equal(device.postgresSchemaDirty, true);
  assert.equal(device.postgresSchemaRevision, 0);
  assert.equal(register.decimalPlaces, 3);
  assert.equal(database.getDevice(device.id)?.postgresSchemaRevision, 1);
  assert.equal(
    database.findHistorianTableOwner(
      "modbus_raw",
      "modbus_1m",
      "another_device",
    ),
    undefined,
  );
  assert.match(register.historianColumn, /^[a-z][a-z0-9_]{0,62}$/);
  const firstSync = "2026-07-25T09:00:00.000Z";
  assert.equal(
    database.markDevicePostgresSchemaSynced(device.id, 1, firstSync),
    true,
  );
  assert.equal(
    database.getDevice(device.id)?.postgresSchemaSyncedAt,
    firstSync,
  );
  assert.equal(database.getDevice(device.id)?.postgresSchemaDirty, false);
  database.markAllPostgresSchemasDirty();
  assert.equal(
    database.getDevice(device.id)?.postgresSchemaSyncedAt,
    firstSync,
  );
  assert.equal(database.getDevice(device.id)?.postgresSchemaDirty, true);
  assert.equal(database.getDevice(device.id)?.postgresSchemaRevision, 2);
  assert.equal(
    database.markDevicePostgresSchemaSynced(
      device.id,
      1,
      "2026-07-25T09:30:00.000Z",
    ),
    false,
  );
  assert.equal(database.getDevice(device.id)?.postgresSchemaDirty, true);
  database.markDevicePostgresSchemaSynced(device.id, 2, firstSync);
  assert.equal(
    database.findHistorianTableOwner(
      "modbus_raw",
      "modbus_1m",
      "another_device",
    )?.id,
    device.id,
  );
  const renamedRegister = database.updateRegister(register.id, {
    name: "Line voltage",
    address: 0,
    functionCode: 3,
    dataType: "uint16",
    byteOrder: "ABCD",
    scale: 0.1,
    offset: 0,
    unit: "V",
    decimalPlaces: 4,
    enabled: true,
  });
  assert.equal(renamedRegister?.historianColumn, register.historianColumn);
  assert.equal(renamedRegister?.decimalPlaces, 4);
  assert.equal(
    database.getDevice(device.id)?.postgresSchemaSyncedAt,
    firstSync,
  );
  assert.equal(database.getDevice(device.id)?.postgresSchemaDirty, true);
  assert.equal(database.getDevice(device.id)?.postgresSchemaRevision, 3);
  database.insertReadings([
    {
      deviceId: device.id,
      registerId: register.id,
      value: 230.5,
      raw: [2305],
      quality: "good",
      timestamp: new Date().toISOString(),
    },
  ]);

  assert.equal(database.listDevices().length, 1);
  assert.equal(database.listRegisters(device.id).length, 1);
  const latestReadings = database.getLatestReadings(10, device.id) as Array<{
    value: number;
    tagName: string;
  }>;
  assert.equal(latestReadings.length, 1);
  assert.equal(latestReadings[0]?.value, 230.5);
  assert.equal(latestReadings[0]?.tagName, "Line voltage");
  const readings = database.queryReadings({ limit: 10 }) as Array<{
    value: number;
    tagName: string;
  }>;
  assert.equal(readings.length, 1);
  assert.equal(readings[0]?.value, 230.5);
  assert.equal(readings[0]?.tagName, "Line voltage");
  const reportReadings = database.queryReadings({
    categoryId: category.id,
    groupId: group.id,
    limit: 10,
  }) as Array<{
    categoryName: string | null;
    groupName: string | null;
  }>;
  assert.equal(reportReadings.length, 1);
  assert.equal(reportReadings[0]?.categoryName, "Energy meters");
  assert.equal(reportReadings[0]?.groupName, "Building A");
  assert.equal(
    database.queryReadings({ categoryId: "cat_missing", limit: 10 }).length,
    0,
  );

  const updatedDevice = database.updateDevice(device.id, {
    name: "Test meter",
    protocol: "tcp",
    tcpHost: "127.0.0.1",
    tcpPort: 1502,
    unitId: 1,
    pollIntervalMs: 250,
    readBlockSize: 64,
    timeoutMs: 1000,
    retries: 1,
    postgresEnabled: false,
    saveIntervalMs: 5000,
    postgresRawTable: "test_meter_raw",
    postgresDownsampleTable: "test_meter_1m",
    postgresDownsampleEnabled: false,
    postgresDownsampleIntervalSec: 60,
    postgresRawRetentionDays: 7,
    postgresDownsampleRetentionDays: 90,
    postgresMaintenanceIntervalHours: 6,
    enabled: true,
  });
  assert.equal(updatedDevice?.saveIntervalMs, 5000);
  assert.equal(updatedDevice?.postgresDownsampleEnabled, false);
  assert.equal(updatedDevice?.postgresRawRetentionDays, 7);
  assert.equal(updatedDevice?.postgresDownsampleRetentionDays, 90);
  assert.equal(updatedDevice?.postgresMaintenanceIntervalHours, 6);
  assert.equal(updatedDevice?.postgresSchemaSyncedAt, firstSync);
  assert.equal(updatedDevice?.postgresSchemaDirty, true);
  assert.equal(updatedDevice?.postgresSchemaRevision, 4);
  assert.equal(updatedDevice?.categoryId, null);
  assert.equal(updatedDevice?.categoryName, null);
  assert.equal(updatedDevice?.groupId, null);
  assert.equal(updatedDevice?.groupName, null);
  assert.equal(database.getDeviceCategory(category.id)?.deviceCount, 0);
  assert.equal(database.getDeviceGroup(group.id)?.deviceCount, 0);

  const rule = database.createAlarmRule({
    registerId: register.id,
    name: "High voltage",
    severity: "warning",
    condition: "above",
    thresholdHigh: 250,
    thresholdLow: null,
    deadband: 1,
    enabled: true,
  });
  database.openAlarm(rule, 260, "High voltage");
  database.markDevicePostgresSchemaSynced(
    device.id,
    4,
    "2026-07-25T10:00:00.000Z",
  );
  assert.equal(database.deleteRegister(register.id), true);
  assert.equal(
    database.getDevice(device.id)?.postgresSchemaSyncedAt,
    "2026-07-25T10:00:00.000Z",
  );
  assert.equal(database.getDevice(device.id)?.postgresSchemaDirty, true);
  assert.equal(database.getDevice(device.id)?.postgresSchemaRevision, 5);
  for (const table of ["readings", "alarm_rules", "alarm_events"]) {
    const row = database.connection
      .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
      .get() as { count: number };
    assert.equal(row.count, 0);
  }
  assert.equal(database.deleteDevice(device.id), true);
  assert.equal(database.listDevices().length, 0);
  assert.equal(database.deleteDeviceCategory(category.id), true);
  assert.equal(database.deleteDeviceGroup(group.id), true);
});

test("uses readable historian columns and reserves pending renames", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "modbus-columns-"));
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  const database = new LoggerDatabase(path.join(directory, "columns.db"));
  context.after(() => database.close());
  const device = database.createDevice({
    name: "Column meter",
    protocol: "tcp",
    tcpHost: "127.0.0.1",
    tcpPort: 502,
    unitId: 1,
    pollIntervalMs: 1000,
    readBlockSize: 120,
    timeoutMs: 1000,
    retries: 1,
    postgresEnabled: false,
    saveIntervalMs: 1000,
    postgresRawTable: "column_meter_raw",
    postgresDownsampleTable: "column_meter_1m",
    postgresDownsampleEnabled: true,
    postgresDownsampleIntervalSec: 60,
    postgresRawRetentionDays: 30,
    postgresDownsampleRetentionDays: 365,
    postgresMaintenanceIntervalHours: 24,
    enabled: true,
  });
  const baseRegister = {
    deviceId: device.id,
    address: 0,
    functionCode: 3 as const,
    dataType: "float32" as const,
    byteOrder: "ABCD" as const,
    scale: 1,
    offset: 0,
    unit: "kW",
    decimalPlaces: 2,
    enabled: true,
  };

  const power = database.createRegister({
    ...baseRegister,
    name: "KW",
  });
  assert.equal(power.historianColumn, "kw");
  const duplicateNormalizedName = database.createRegister({
    ...baseRegister,
    name: "KW!",
    address: 2,
  });
  assert.equal(duplicateNormalizedName.historianColumn, "kw_2");
  const reservedTimestamp = database.createRegister({
    ...baseRegister,
    name: "Timestamp",
    address: 4,
  });
  assert.equal(reservedTimestamp.historianColumn, "timestamp_2");

  assert.throws(
    () =>
      database.createRegister({
        ...baseRegister,
        name: "Conflicting custom column",
        address: 6,
        historianColumn: "kw",
      }),
    HistorianColumnNameConflictError,
  );

  const renamed = database.updateRegister(power.id, {
    name: "Active power",
    historianColumn: "active_power",
    address: 0,
    functionCode: 3,
    dataType: "float32",
    byteOrder: "ABCD",
    scale: 1,
    offset: 0,
    unit: "kW",
    decimalPlaces: 3,
    enabled: true,
  });
  assert.equal(renamed?.historianColumn, "active_power");
  assert.deepEqual(database.listPendingHistorianColumnRenames(device.id), [
    { registerId: power.id, from: "kw", to: "active_power" },
  ]);
  assert.throws(
    () =>
      database.createRegister({
        ...baseRegister,
        name: "Pending-name conflict",
        address: 8,
        historianColumn: "kw",
      }),
    HistorianColumnNameConflictError,
  );

  const labelOnlyEdit = database.updateRegister(power.id, {
    name: "Active power total",
    address: 0,
    functionCode: 3,
    dataType: "float32",
    byteOrder: "ABCD",
    scale: 1,
    offset: 0,
    unit: "kW",
    decimalPlaces: 3,
    enabled: true,
  });
  assert.equal(labelOnlyEdit?.historianColumn, "active_power");
  assert.deepEqual(database.listPendingHistorianColumnRenames(device.id), [
    { registerId: power.id, from: "kw", to: "active_power" },
  ]);
  database.acknowledgeHistorianColumnRenames(
    device.id,
    database.listPendingHistorianColumnRenames(device.id),
  );
  assert.deepEqual(database.listPendingHistorianColumnRenames(device.id), []);
});

test("migrates decimal precision and schema-sync state onto existing data", (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "modbus-migration-"));
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  const databasePath = path.join(directory, "migration.db");
  const original = new LoggerDatabase(databasePath);
  const device = original.createDevice({
    name: "Existing meter",
    protocol: "tcp",
    tcpHost: "127.0.0.1",
    tcpPort: 502,
    unitId: 1,
    pollIntervalMs: 1000,
    readBlockSize: 120,
    timeoutMs: 1000,
    retries: 1,
    postgresEnabled: false,
    saveIntervalMs: 1000,
    postgresRawTable: "existing_raw",
    postgresDownsampleTable: "existing_15m",
    postgresDownsampleEnabled: true,
    postgresDownsampleIntervalSec: 900,
    postgresRawRetentionDays: 30,
    postgresDownsampleRetentionDays: 365,
    postgresMaintenanceIntervalHours: 24,
    enabled: true,
  });
  const register = original.createRegister({
    deviceId: device.id,
    name: "Existing tag",
    address: 1,
    functionCode: 3,
    dataType: "float32",
    byteOrder: "ABCD",
    scale: 1,
    offset: 0,
    unit: "",
    enabled: true,
  });
  original.connection
    .prepare("UPDATE registers SET postgres_column_name = ? WHERE id = ?")
    .run("existing_tag_123abc", register.id);
  original.connection.exec(
    "ALTER TABLE registers DROP COLUMN postgres_previous_column_name",
  );
  original.connection.exec("ALTER TABLE registers DROP COLUMN decimal_places");
  original.connection.exec(
    "ALTER TABLE devices DROP COLUMN postgres_schema_synced_at",
  );
  original.connection.exec(
    "ALTER TABLE devices DROP COLUMN postgres_schema_dirty",
  );
  original.connection.exec(
    "ALTER TABLE devices DROP COLUMN postgres_schema_revision",
  );
  original.connection.exec("DROP INDEX devices_category_idx");
  original.connection.exec("DROP INDEX devices_group_idx");
  original.connection.exec("ALTER TABLE devices DROP COLUMN category_id");
  original.connection.exec("ALTER TABLE devices DROP COLUMN group_id");
  original.close();

  const migrated = new LoggerDatabase(databasePath);
  context.after(() => migrated.close());
  assert.equal(migrated.getRegister(register.id)?.decimalPlaces, 2);
  assert.equal(
    migrated.getRegister(register.id)?.historianColumn,
    "existing_tag_123abc",
  );
  assert.equal(migrated.getDevice(device.id)?.postgresSchemaSyncedAt, null);
  assert.equal(migrated.getDevice(device.id)?.postgresSchemaDirty, true);
  assert.equal(migrated.getDevice(device.id)?.postgresSchemaRevision, 0);
  assert.equal(migrated.getDevice(device.id)?.categoryId, null);
  assert.equal(migrated.getDevice(device.id)?.categoryName, null);
  assert.equal(migrated.getDevice(device.id)?.groupId, null);
  assert.equal(migrated.getDevice(device.id)?.groupName, null);
});
