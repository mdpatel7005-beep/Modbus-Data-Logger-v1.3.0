import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LoggerDatabase } from "../src/db/database.js";
import { PostgresHistorian } from "../src/services/postgres-historian.js";
function result(rows) {
    return {
        command: "",
        rowCount: rows.length,
        oid: 0,
        fields: [],
        rows,
    };
}
const logger = {
    info() { },
    warn() { },
    error() { },
};
class HistorianTablePool {
    tables = new Map();
    rawTimestamps = [];
    statements = [];
    rawInsertGate = null;
    onRawInsert = null;
    createTable(sql) {
        const tableName = sql.match(/CREATE TABLE "([^"]+)"/)?.[1];
        if (!tableName)
            return;
        const columns = [
            {
                column_name: "timestamp",
                data_type: "timestamp with time zone",
                numeric_precision: null,
                numeric_scale: null,
                is_nullable: "NO",
            },
        ];
        for (const match of sql.matchAll(/"([a-z][a-z0-9_]*)" NUMERIC\(30, (\d+)\)/g)) {
            columns.push({
                column_name: match[1],
                data_type: "numeric",
                numeric_precision: 30,
                numeric_scale: Number(match[2]),
                is_nullable: "YES",
            });
        }
        this.tables.set(tableName, columns);
    }
    async connect() {
        return {
            query: async (sql, parameters) => {
                this.statements.push(sql);
                if (sql.includes("FROM information_schema.columns")) {
                    const table = String(parameters?.[0]);
                    return result((this.tables.get(table) ?? []).map((column) => ({ ...column })));
                }
                if (sql.includes("FROM pg_index")) {
                    const table = String(parameters?.[0]);
                    return result(this.tables.has(table) ? [{ column_name: "timestamp" }] : []);
                }
                if (sql.startsWith("CREATE TABLE")) {
                    this.createTable(sql);
                    return result([]);
                }
                const drop = sql.match(/ALTER TABLE "([^"]+)"\s+DROP COLUMN "([^"]+)"/);
                if (drop) {
                    const [tableName, columnName] = drop.slice(1);
                    this.tables.set(tableName, (this.tables.get(tableName) ?? []).filter((column) => column.column_name !== columnName));
                    return result([]);
                }
                const insert = sql.match(/INSERT INTO "([^"]+)"/);
                if (insert) {
                    const tableName = insert[1];
                    if (tableName.endsWith("_raw")) {
                        this.onRawInsert?.();
                        await this.rawInsertGate;
                    }
                    if (!this.tables.has(tableName)) {
                        throw Object.assign(new Error(`relation "${tableName}" does not exist`), { code: "42P01" });
                    }
                    if (tableName.endsWith("_raw")) {
                        this.rawTimestamps.push(String(parameters?.[0]));
                    }
                }
                return result([]);
            },
            release() { },
        };
    }
    async end() { }
}
function reading(deviceId, registerId, timestamp, value) {
    return {
        deviceId,
        registerId,
        timestamp,
        value,
        raw: [value],
        quality: "good",
    };
}
test("disconnects writes, recreates a deleted table on connect, and resumes saving", async (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "modbus-pg-connect-"));
    context.after(() => rmSync(directory, { force: true, recursive: true }));
    const database = new LoggerDatabase(path.join(directory, "logger.db"));
    context.after(() => database.close());
    database.savePostgresSettings({
        enabled: true,
        host: "historian.example.test",
        port: 5432,
        database: "modbus_logger",
        username: "logger",
        password: "",
        sslMode: "require",
        historianTimezone: "UTC",
        autoDownsampleEnabled: true,
        defaultRawTable: "modbus_raw",
        defaultDownsampleTable: "modbus_1m",
        defaultDownsampleIntervalSec: 60,
        rawRetentionDays: 30,
        downsampleRetentionDays: 365,
        maintenanceIntervalHours: 24,
        offlineCacheEnabled: true,
        offlineCacheMaxRows: 100_000,
    }, null);
    const device = database.createDevice({
        name: "Reconnect meter",
        protocol: "tcp",
        tcpHost: "127.0.0.1",
        tcpPort: 502,
        unitId: 1,
        pollIntervalMs: 1000,
        readBlockSize: 120,
        timeoutMs: 1000,
        retries: 1,
        postgresEnabled: true,
        saveIntervalMs: 1000,
        postgresRawTable: "reconnect_meter_raw",
        postgresDownsampleTable: "reconnect_meter_1m",
        postgresDownsampleEnabled: true,
        postgresDownsampleIntervalSec: 60,
        postgresRawRetentionDays: 30,
        postgresDownsampleRetentionDays: 365,
        postgresMaintenanceIntervalHours: 24,
        enabled: true,
    });
    const register = database.createRegister({
        deviceId: device.id,
        name: "Power",
        historianColumn: "power",
        address: 0,
        functionCode: 3,
        dataType: "float32",
        byteOrder: "ABCD",
        scale: 1,
        offset: 0,
        unit: "kW",
        decimalPlaces: 2,
        enabled: true,
    });
    assert.equal(database.markDevicePostgresSchemaSynced(device.id, 1), true);
    const pool = new HistorianTablePool();
    pool.tables.set("reconnect_meter_1m", [
        {
            column_name: "timestamp",
            data_type: "timestamp with time zone",
            numeric_precision: null,
            numeric_scale: null,
            is_nullable: "NO",
        },
        {
            column_name: "power",
            data_type: "numeric",
            numeric_precision: 30,
            numeric_scale: 2,
            is_nullable: "YES",
        },
    ]);
    const historian = new PostgresHistorian(database, logger, () => pool);
    context.after(() => historian.close());
    const disconnected = await historian.disconnectDevice(device.id);
    assert.equal(disconnected.connected, false);
    assert.equal(disconnected.device.postgresEnabled, false);
    await historian.write(database.getDevice(device.id), [
        reading(device.id, register.id, "2026-07-27T00:00:00.100Z", 10),
    ]);
    assert.deepEqual(pool.rawTimestamps, []);
    assert.equal(database.getPostgresOutboxStats().queuedRows, 0);
    const firstConnect = await historian.connectDevice(device.id);
    assert.equal(firstConnect.connected, true);
    assert.equal(firstConnect.device.postgresEnabled, true);
    assert.equal(firstConnect.schema?.ok, true);
    assert.ok(pool.tables.has("reconnect_meter_raw"));
    assert.deepEqual(pool.tables.get("reconnect_meter_raw")?.map((column) => column.column_name), ["timestamp", "power"]);
    assert.equal(database.getDevice(device.id)?.postgresSchemaDirty, false);
    let releaseRawInsert = () => { };
    pool.rawInsertGate = new Promise((resolve) => {
        releaseRawInsert = resolve;
    });
    let notifyRawInsert = () => { };
    const rawInsertStarted = new Promise((resolve) => {
        notifyRawInsert = resolve;
    });
    pool.onRawInsert = notifyRawInsert;
    const inFlightWrite = historian.write(database.getDevice(device.id), [
        reading(device.id, register.id, "2026-07-27T00:00:01.100Z", 11),
    ]);
    await rawInsertStarted;
    let disconnectFinished = false;
    const inFlightDisconnect = historian
        .disconnectDevice(device.id)
        .then((result) => {
        disconnectFinished = true;
        return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disconnectFinished, false);
    releaseRawInsert();
    await inFlightWrite;
    const drainedDisconnect = await inFlightDisconnect;
    assert.equal(drainedDisconnect.connected, false);
    assert.equal(disconnectFinished, true);
    pool.rawInsertGate = null;
    pool.onRawInsert = null;
    assert.deepEqual(pool.rawTimestamps, ["2026-07-27T00:00:01.100Z"]);
    const reenabledAfterDrain = await historian.connectDevice(device.id);
    assert.equal(reenabledAfterDrain.connected, true);
    // Simulate an administrator or external process deleting the raw table.
    const olderQueuedReading = reading(device.id, register.id, "2026-07-27T00:00:01.500Z", 11.5);
    database.enqueuePostgresOutbox(device.id, olderQueuedReading.timestamp, Date.parse("2026-07-27T00:00:01.000Z"), [olderQueuedReading], 100_000);
    pool.tables.delete("reconnect_meter_raw");
    await historian.write(database.getDevice(device.id), [
        reading(device.id, register.id, "2026-07-27T00:00:02.100Z", 12),
    ]);
    assert.equal(database.getDevice(device.id)?.postgresEnabled, false);
    assert.equal(database.getDevice(device.id)?.postgresSchemaDirty, true);
    assert.equal(database.getPostgresOutboxStats().queuedRows, 2);
    const repaired = await historian.connectDevice(device.id);
    assert.equal(repaired.connected, true);
    assert.equal(repaired.schema?.ok, true);
    assert.ok(pool.tables.has("reconnect_meter_raw"));
    await historian.write(database.getDevice(device.id), [
        reading(device.id, register.id, "2026-07-27T00:00:03.100Z", 13),
    ]);
    assert.deepEqual(pool.rawTimestamps, [
        "2026-07-27T00:00:01.100Z",
        "2026-07-27T00:00:01.500Z",
        "2026-07-27T00:00:02.100Z",
        "2026-07-27T00:00:03.100Z",
    ]);
    assert.equal(database.getPostgresOutboxStats().queuedRows, 0);
});
test("connect leaves saving disabled when orphan columns need confirmation", async (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "modbus-pg-orphan-"));
    context.after(() => rmSync(directory, { force: true, recursive: true }));
    const database = new LoggerDatabase(path.join(directory, "logger.db"));
    context.after(() => database.close());
    database.savePostgresSettings({
        enabled: true,
        host: "historian.example.test",
        port: 5432,
        database: "modbus_logger",
        username: "logger",
        sslMode: "require",
        historianTimezone: "UTC",
        autoDownsampleEnabled: true,
        defaultRawTable: "modbus_raw",
        defaultDownsampleTable: "modbus_1m",
        defaultDownsampleIntervalSec: 60,
        rawRetentionDays: 30,
        downsampleRetentionDays: 365,
        maintenanceIntervalHours: 24,
        offlineCacheEnabled: true,
        offlineCacheMaxRows: 100_000,
    }, null);
    const device = database.createDevice({
        name: "Orphan meter",
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
        postgresRawTable: "orphan_meter_raw",
        postgresDownsampleTable: "orphan_meter_1m",
        postgresDownsampleEnabled: true,
        postgresDownsampleIntervalSec: 60,
        postgresRawRetentionDays: 30,
        postgresDownsampleRetentionDays: 365,
        postgresMaintenanceIntervalHours: 24,
        enabled: true,
    });
    database.createRegister({
        deviceId: device.id,
        name: "Power",
        historianColumn: "power",
        address: 0,
        functionCode: 3,
        dataType: "float32",
        byteOrder: "ABCD",
        scale: 1,
        offset: 0,
        unit: "kW",
        decimalPlaces: 2,
        enabled: true,
    });
    const pool = new HistorianTablePool();
    const columns = [
        {
            column_name: "timestamp",
            data_type: "timestamp with time zone",
            numeric_precision: null,
            numeric_scale: null,
            is_nullable: "NO",
        },
        {
            column_name: "power",
            data_type: "numeric",
            numeric_precision: 30,
            numeric_scale: 2,
            is_nullable: "YES",
        },
        {
            column_name: "old_power",
            data_type: "numeric",
            numeric_precision: 30,
            numeric_scale: 2,
            is_nullable: "YES",
        },
    ];
    pool.tables.set("orphan_meter_raw", columns.map((column) => ({ ...column })));
    pool.tables.set("orphan_meter_1m", columns.map((column) => ({ ...column })));
    const historian = new PostgresHistorian(database, logger, () => pool);
    context.after(() => historian.close());
    database.connection
        .prepare("UPDATE devices SET save_interval_ms = 120000 WHERE id = ?")
        .run(device.id);
    const invalidInterval = await historian.connectDevice(device.id);
    assert.equal(invalidInterval.connected, false);
    assert.equal(invalidInterval.schema, undefined);
    assert.match(invalidInterval.message, /Downsample interval/);
    assert.equal(database.getDevice(device.id)?.postgresEnabled, false);
    database.connection
        .prepare("UPDATE devices SET save_interval_ms = 1000 WHERE id = ?")
        .run(device.id);
    const connect = await historian.connectDevice(device.id);
    assert.equal(connect.connected, false);
    assert.equal(connect.schema?.ok, false);
    assert.deepEqual(connect.schema?.orphanedColumns.sort(), [
        "orphan_meter_1m.old_power",
        "orphan_meter_raw.old_power",
    ]);
    assert.equal(database.getDevice(device.id)?.postgresEnabled, false);
    assert.equal(database.getDevice(device.id)?.postgresSchemaDirty, true);
    assert.equal(pool.statements.some((statement) => statement.includes("DROP COLUMN")), false);
    const confirmed = await historian.syncDeviceSchema(device.id, true, [
        "orphan_meter_1m.old_power",
        "orphan_meter_raw.old_power",
    ]);
    assert.equal(confirmed.ok, true);
    assert.equal(database.getDevice(device.id)?.postgresEnabled, false);
    const reconnected = await historian.connectDevice(device.id);
    assert.equal(reconnected.connected, true);
});
//# sourceMappingURL=postgres-device-connect.test.js.map