import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LoggerDatabase } from "../src/db/database.js";
import { PostgresHistorian } from "../src/services/postgres-historian.js";
const logger = {
    info() { },
    warn() { },
    error() { },
};
function result(rows) {
    return {
        command: "",
        rowCount: rows.length,
        oid: 0,
        fields: [],
        rows,
    };
}
test("renames historian columns in both tables and clears pending state", async (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "modbus-pg-rename-"));
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
        name: "Rename meter",
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
        postgresRawTable: "rename_meter_raw",
        postgresDownsampleTable: "rename_meter_1m",
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
        historianColumn: "power_old",
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
    database.updateRegister(register.id, {
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
    const timestamp = {
        column_name: "timestamp",
        data_type: "timestamp with time zone",
        numeric_precision: null,
        numeric_scale: null,
        is_nullable: "NO",
    };
    const oldPower = {
        column_name: "power_old",
        data_type: "numeric",
        numeric_precision: 30,
        numeric_scale: 2,
        is_nullable: "YES",
    };
    const tables = new Map([
        ["rename_meter_raw", [{ ...timestamp }, { ...oldPower }]],
        ["rename_meter_1m", [{ ...timestamp }, { ...oldPower }]],
    ]);
    const statements = [];
    const client = {
        async query(sql, parameters) {
            statements.push(sql);
            if (sql.includes("FROM information_schema.columns")) {
                return result((tables.get(String(parameters?.[0])) ?? []).map((column) => ({
                    ...column,
                })));
            }
            if (sql.includes("FROM pg_index")) {
                return result([{ column_name: "timestamp" }]);
            }
            const rename = sql.match(/ALTER TABLE "([^"]+)"\s+RENAME COLUMN "([^"]+)"\s+TO "([^"]+)"/);
            if (rename) {
                const [, tableName, from, to] = rename;
                const column = tables
                    .get(tableName ?? "")
                    ?.find((item) => item.column_name === from);
                if (!column)
                    throw new Error("rename source was not found");
                column.column_name = to ?? "";
            }
            return result([]);
        },
        release() { },
    };
    const pool = {
        async connect() {
            return client;
        },
        async end() { },
    };
    const historian = new PostgresHistorian(database, logger, () => pool);
    context.after(() => historian.close());
    const sync = await historian.syncDeviceSchema(device.id);
    assert.equal(sync.ok, true);
    assert.deepEqual(sync.orphanedColumns, []);
    assert.deepEqual(sync.addedColumns, []);
    assert.deepEqual(sync.changedColumns.sort(), [
        "rename_meter_1m.power_old -> power",
        "rename_meter_raw.power_old -> power",
    ]);
    assert.equal(statements.filter((sql) => sql.includes("RENAME COLUMN")).length, 2);
    assert.deepEqual(database.listPendingHistorianColumnRenames(device.id), []);
    assert.equal(database.getDevice(device.id)?.postgresSchemaDirty, false);
    assert.deepEqual(tables.get("rename_meter_raw")?.map((column) => column.column_name), ["timestamp", "power"]);
    assert.deepEqual(tables.get("rename_meter_1m")?.map((column) => column.column_name), ["timestamp", "power"]);
});
//# sourceMappingURL=historian-schema-rename.test.js.map