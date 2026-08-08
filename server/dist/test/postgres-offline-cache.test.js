import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LoggerDatabase } from "../src/db/database.js";
import { isPostgresAvailabilityError, PostgresHistorian, } from "../src/services/postgres-historian.js";
const settings = {
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
};
const logger = {
    info() { },
    warn() { },
    error() { },
};
function createHistorianDevice(database) {
    const device = database.createDevice({
        name: "Historian meter",
        protocol: "tcp",
        tcpHost: "127.0.0.1",
        tcpPort: 502,
        unitId: 1,
        pollIntervalMs: 100,
        readBlockSize: 120,
        timeoutMs: 1_000,
        retries: 1,
        postgresEnabled: true,
        saveIntervalMs: 1_000,
        postgresRawTable: "historian_meter_raw",
        postgresDownsampleTable: "historian_meter_15m",
        postgresDownsampleEnabled: true,
        postgresDownsampleIntervalSec: 900,
        postgresRawRetentionDays: 30,
        postgresDownsampleRetentionDays: 365,
        postgresMaintenanceIntervalHours: 24,
        enabled: true,
    });
    const register = database.createRegister({
        deviceId: device.id,
        name: "Power",
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
    assert.equal(database.markDevicePostgresSchemaSynced(device.id, 1), true);
    return {
        device: database.getDevice(device.id),
        register,
    };
}
function reading(deviceId, registerId, timestamp, value) {
    return {
        deviceId,
        registerId,
        value,
        raw: [value],
        quality: "good",
        timestamp,
    };
}
class FakePostgresPool {
    available = false;
    failureCode = null;
    queryGate = null;
    onQuery = null;
    endCount = 0;
    rawTimestamps = new Set();
    downsampleWrites = 0;
    async connect() {
        if (!this.available) {
            throw Object.assign(new Error("connect ECONNREFUSED"), {
                code: "ECONNREFUSED",
            });
        }
        return {
            query: async (sql, values) => {
                this.onQuery?.();
                await this.queryGate;
                if (!this.available) {
                    throw Object.assign(new Error("connection terminated"), {
                        code: "08006",
                    });
                }
                if (this.failureCode) {
                    throw Object.assign(new Error("simulated PostgreSQL query error"), {
                        code: this.failureCode,
                    });
                }
                if (/INSERT INTO "historian_meter_raw"/.test(sql)) {
                    this.rawTimestamps.add(String(values?.[0]));
                }
                if (/INSERT INTO "historian_meter_15m"/.test(sql)) {
                    this.downsampleWrites += 1;
                }
                return { rows: [], rowCount: 1 };
            },
            release() { },
        };
    }
    async end() {
        this.endCount += 1;
    }
}
test("pauses new historian work and drains an in-flight write", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "modbus-pause-"));
    const database = new LoggerDatabase(path.join(directory, "pause.db"));
    const pool = new FakePostgresPool();
    pool.available = true;
    try {
        database.savePostgresSettings(settings, null);
        const { device, register } = createHistorianDevice(database);
        const historian = new PostgresHistorian(database, logger, () => pool);
        let releaseQuery = () => { };
        pool.queryGate = new Promise((resolve) => {
            releaseQuery = resolve;
        });
        let queryStarted = () => { };
        const started = new Promise((resolve) => {
            queryStarted = resolve;
        });
        pool.onQuery = queryStarted;
        const write = historian.write(device, [
            reading(device.id, register.id, "2026-07-25T00:00:00.100Z", 1),
        ]);
        await started;
        let drained = false;
        const pause = historian.pauseAndDrain().then(() => {
            drained = true;
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(drained, false);
        releaseQuery();
        await write;
        await pause;
        assert.equal(historian.paused, true);
        assert.equal(drained, true);
        const maintenance = await historian.runMaintenance(true);
        assert.equal(maintenance.skipped, true);
        assert.match(maintenance.message, /paused/i);
        const replay = await historian.replayOfflineCache();
        assert.equal(replay.status, "paused");
        const writesBeforePausedSample = pool.rawTimestamps.size;
        await historian.write(device, [
            reading(device.id, register.id, "2026-07-25T00:00:02.100Z", 2),
        ]);
        assert.equal(pool.rawTimestamps.size, writesBeforePausedSample);
        pool.queryGate = null;
        pool.onQuery = null;
        historian.resume();
        await historian.write(device, [
            reading(device.id, register.id, "2026-07-25T00:00:02.100Z", 2),
        ]);
        assert.equal(pool.rawTimestamps.size, writesBeforePausedSample + 1);
        await historian.close();
    }
    finally {
        database.close();
        rmSync(directory, { force: true, recursive: true });
    }
});
test("bounds historian drain while a remote query is blocked", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "modbus-drain-timeout-"));
    const database = new LoggerDatabase(path.join(directory, "timeout.db"));
    const pool = new FakePostgresPool();
    pool.available = true;
    try {
        database.savePostgresSettings(settings, null);
        const { device, register } = createHistorianDevice(database);
        const historian = new PostgresHistorian(database, logger, () => pool);
        let releaseQuery = () => { };
        pool.queryGate = new Promise((resolve) => {
            releaseQuery = resolve;
        });
        let queryStarted = () => { };
        const started = new Promise((resolve) => {
            queryStarted = resolve;
        });
        pool.onQuery = queryStarted;
        const write = historian.write(device, [
            reading(device.id, register.id, "2026-07-25T00:00:00.100Z", 1),
        ]);
        await started;
        await assert.rejects(historian.pauseAndDrain(10), /did not drain within 10 ms/);
        assert.equal(historian.paused, true);
        historian.resume();
        releaseQuery();
        await write;
        pool.queryGate = null;
        pool.onQuery = null;
        await historian.close();
    }
    finally {
        database.close();
        rmSync(directory, { force: true, recursive: true });
    }
});
test("clears transient maintenance and replay status on system reload", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "modbus-status-reload-"));
    const database = new LoggerDatabase(path.join(directory, "reload.db"));
    try {
        database.savePostgresSettings({ ...settings, enabled: false }, null);
        const historian = new PostgresHistorian(database, logger);
        const mutable = historian;
        mutable.lastMaintenanceAtMemory = "2026-07-25T01:00:00.000Z";
        mutable.lastReplayAtMemory = "2026-07-25T01:01:00.000Z";
        mutable.lastReplayCountMemory = 42;
        assert.equal(historian.getPublicSettings().lastMaintenanceAt, "2026-07-25T01:00:00.000Z");
        assert.equal(historian.getPublicSettings().lastReplayAt, "2026-07-25T01:01:00.000Z");
        const reloaded = await historian.reloadSettings();
        assert.equal(reloaded.lastMaintenanceAt, null);
        assert.equal(reloaded.lastReplayAt, null);
        assert.equal(reloaded.lastReplayCount, 0);
        await historian.close();
    }
    finally {
        database.close();
        rmSync(directory, { force: true, recursive: true });
    }
});
test("persists, compacts, caps, and cascades the PostgreSQL outbox", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "modbus-outbox-"));
    const databasePath = path.join(directory, "outbox.db");
    try {
        let database = new LoggerDatabase(databasePath);
        const { device, register } = createHistorianDevice(database);
        const first = reading(device.id, register.id, "2026-07-25T00:00:00.100Z", 1);
        const latestInBucket = reading(device.id, register.id, "2026-07-25T00:00:00.900Z", 2);
        database.enqueuePostgresOutbox(device.id, first.timestamp, Date.parse("2026-07-25T00:00:00.000Z"), [first], 2);
        database.enqueuePostgresOutbox(device.id, latestInBucket.timestamp, Date.parse("2026-07-25T00:00:00.000Z"), [latestInBucket], 2);
        database.enqueuePostgresOutbox(device.id, "2026-07-25T00:00:01.100Z", Date.parse("2026-07-25T00:00:01.000Z"), [reading(device.id, register.id, "2026-07-25T00:00:01.100Z", 3)], 2);
        const overflow = database.enqueuePostgresOutbox(device.id, "2026-07-25T00:00:02.100Z", Date.parse("2026-07-25T00:00:02.000Z"), [reading(device.id, register.id, "2026-07-25T00:00:02.100Z", 4)], 2);
        assert.equal(overflow.dropped, 1);
        assert.deepEqual(database.getPostgresOutboxStats(), {
            queuedRows: 2,
            oldestAt: "2026-07-25T00:00:01.100Z",
        });
        database.close();
        database = new LoggerDatabase(databasePath);
        assert.equal(database.getPostgresOutboxStats().queuedRows, 2);
        assert.equal(database.deleteDevice(device.id), true);
        assert.equal(database.getPostgresOutboxStats().queuedRows, 0);
        database.close();
    }
    finally {
        rmSync(directory, { force: true, recursive: true });
    }
});
test("queues unavailable writes and replays them before the next live sample", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "modbus-replay-"));
    const database = new LoggerDatabase(path.join(directory, "replay.db"));
    const pool = new FakePostgresPool();
    try {
        database.savePostgresSettings(settings, null);
        const { device, register } = createHistorianDevice(database);
        const historian = new PostgresHistorian(database, logger, () => pool);
        const cached = reading(device.id, register.id, "2026-07-25T00:00:00.100Z", 12.345);
        await historian.write(device, [cached]);
        assert.equal(database.getPostgresOutboxStats().queuedRows, 1);
        assert.equal(pool.rawTimestamps.size, 0);
        pool.available = true;
        const live = reading(device.id, register.id, "2026-07-25T00:00:01.100Z", 13.456);
        await historian.write(device, [live]);
        assert.deepEqual([...pool.rawTimestamps], [cached.timestamp, live.timestamp]);
        assert.equal(database.getPostgresOutboxStats().queuedRows, 0);
        assert.equal(historian.getPublicSettings().lastReplayCount, 1);
        database.enqueuePostgresOutbox(device.id, cached.timestamp, Date.parse("2026-07-25T00:00:00.000Z"), [cached], settings.offlineCacheMaxRows);
        const replay = await historian.replayOfflineCache();
        assert.equal(replay.status, "completed");
        assert.equal(replay.replayedRows, 1);
        assert.equal(pool.rawTimestamps.size, 2);
        pool.failureCode = "42P01";
        await historian.write(device, [
            reading(device.id, register.id, "2026-07-25T00:00:02.100Z", 14.567),
        ]);
        assert.equal(database.getPostgresOutboxStats().queuedRows, 1);
        assert.equal(database.getDevice(device.id)?.postgresEnabled, false);
        assert.equal(database.getDevice(device.id)?.postgresSchemaDirty, true);
        pool.failureCode = null;
        await historian.reloadSettings();
        assert.equal(pool.endCount, 1);
        await historian.close();
    }
    finally {
        database.close();
        rmSync(directory, { force: true, recursive: true });
    }
});
test("queues schema-dirty samples and pauses replay until schema synchronization", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "modbus-dirty-outbox-"));
    const database = new LoggerDatabase(path.join(directory, "dirty-outbox.db"));
    const pool = new FakePostgresPool();
    const warnings = [];
    const countingLogger = {
        info() { },
        warn(_details, message) {
            warnings.push(message);
        },
        error() { },
    };
    pool.available = true;
    try {
        database.savePostgresSettings(settings, null);
        const { device, register } = createHistorianDevice(database);
        const historian = new PostgresHistorian(database, countingLogger, () => pool);
        assert.equal(database.markDevicePostgresSchemaDirty(device.id), true);
        const dirtyDevice = database.getDevice(device.id);
        const cached = reading(device.id, register.id, "2026-07-25T00:00:00.100Z", 12.345);
        await historian.write(dirtyDevice, [cached]);
        const cachedNextBucket = reading(device.id, register.id, "2026-07-25T00:00:01.100Z", 13.456);
        await historian.write(dirtyDevice, [cachedNextBucket]);
        assert.equal(database.getPostgresOutboxStats().queuedRows, 2);
        assert.equal(pool.rawTimestamps.size, 0);
        assert.equal(warnings.filter((message) => message.includes("durable offline cache"))
            .length, 1);
        const paused = await historian.replayOfflineCache();
        assert.equal(paused.status, "paused");
        assert.equal(paused.pausedRows, 2);
        assert.equal(paused.remainingEligibleRows, 0);
        assert.equal(database.getPostgresOutboxStats().queuedRows, 2);
        assert.equal(database.markDevicePostgresSchemaSynced(device.id, dirtyDevice.postgresSchemaRevision), true);
        const replayed = await historian.replayOfflineCache();
        assert.equal(replayed.status, "completed");
        assert.equal(replayed.replayedRows, 2);
        assert.deepEqual([...pool.rawTimestamps], [cached.timestamp, cachedNextBucket.timestamp]);
        assert.equal(database.getPostgresOutboxStats().queuedRows, 0);
        await historian.close();
    }
    finally {
        database.close();
        rmSync(directory, { force: true, recursive: true });
    }
});
test("keeps schema-dirty remote writes paused when offline caching is disabled", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "modbus-no-outbox-"));
    const database = new LoggerDatabase(path.join(directory, "no-outbox.db"));
    const pool = new FakePostgresPool();
    pool.available = true;
    try {
        database.savePostgresSettings({ ...settings, offlineCacheEnabled: false }, null);
        const { device, register } = createHistorianDevice(database);
        const historian = new PostgresHistorian(database, logger, () => pool);
        assert.equal(database.markDevicePostgresSchemaDirty(device.id), true);
        await historian.write(database.getDevice(device.id), [
            reading(device.id, register.id, "2026-07-25T00:00:00.100Z", 12.345),
        ]);
        assert.equal(database.getPostgresOutboxStats().queuedRows, 0);
        assert.equal(pool.rawTimestamps.size, 0);
        await historian.close();
    }
    finally {
        database.close();
        rmSync(directory, { force: true, recursive: true });
    }
});
test("recognizes availability errors without hiding schema failures", () => {
    assert.equal(isPostgresAvailabilityError(Object.assign(new Error("connection failed"), { code: "08006" })), true);
    assert.equal(isPostgresAvailabilityError(Object.assign(new Error("undefined table"), { code: "42P01" })), false);
    assert.equal(isPostgresAvailabilityError(new Error("Query read timeout")), true);
    assert.equal(isPostgresAvailabilityError(Object.assign(new Error("connect ENETUNREACH"), {
        code: "ENETUNREACH",
    })), true);
    assert.equal(isPostgresAvailabilityError(Object.assign(new Error("connect EHOSTUNREACH"), {
        code: "EHOSTUNREACH",
    })), true);
});
//# sourceMappingURL=postgres-offline-cache.test.js.map