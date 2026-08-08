import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "modbus-data-logger-data-servers-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(temporaryRoot, "http.db");
process.env.AUTH_DISABLED = "false";
process.env.POLLING_ENABLED = "false";
process.env.JWT_SECRET = "data-server-test-secret-with-32-characters";
process.env.INITIAL_ADMIN_USERNAME = "admin";
process.env.INITIAL_ADMIN_PASSWORD = "admin";
delete process.env.POSTGRES_URL;
const { LoggerDatabase } = await import("../src/db/database.js");
const { DatabasePublicationSource, DataServerSettingsRepository, } = await import("../src/services/data-servers.js");
const { buildApplication } = await import("../src/app.js");
function deviceInput(name, unitId = 1) {
    return {
        name,
        protocol: "tcp",
        tcpHost: "192.0.2.10",
        tcpPort: 502,
        unitId,
        pollIntervalMs: 1000,
        readBlockSize: 120,
        timeoutMs: 2000,
        retries: 2,
        categoryId: null,
        groupId: null,
        postgresEnabled: false,
        saveIntervalMs: 1000,
        postgresRawTable: `${name.toLowerCase()}_raw`,
        postgresDownsampleTable: `${name.toLowerCase()}_1m`,
        postgresDownsampleEnabled: true,
        postgresDownsampleIntervalSec: 60,
        postgresRawRetentionDays: 30,
        postgresDownsampleRetentionDays: 365,
        postgresMaintenanceIntervalHours: 24,
        enabled: true,
    };
}
test("stores safe disabled defaults and publishes original cached words", async (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "modbus-data-server-repository-"));
    context.after(() => rmSync(directory, { force: true, recursive: true }));
    const database = new LoggerDatabase(path.join(directory, "logger.db"));
    context.after(() => database.close());
    const repository = new DataServerSettingsRepository(database);
    const device = database.createDevice(deviceInput("meter", 9));
    const register = database.createRegister({
        deviceId: device.id,
        name: "Power",
        address: 100,
        functionCode: 3,
        dataType: "float32",
        byteOrder: "CDAB",
        scale: 0.1,
        offset: 5,
        unit: "kW",
        decimalPlaces: 2,
        enabled: true,
    });
    database.insertReadings([
        {
            deviceId: device.id,
            registerId: register.id,
            value: 128.4,
            raw: [0x70a4, 0x4145],
            quality: "good",
            timestamp: "2026-07-27T06:00:00.000Z",
        },
    ]);
    database.updateDeviceHealth(device.id, "online", {
        lastSeenAt: "2026-07-27T06:00:00.000Z",
        lastPollMs: 25,
    });
    const defaults = repository.getInput();
    assert.equal(defaults.modbus.enabled, false);
    assert.equal(defaults.modbus.bindAddress, "127.0.0.1");
    assert.deepEqual(defaults.modbus.mappings, [
        { deviceId: device.id, enabled: false, unitId: 9 },
    ]);
    assert.deepEqual(defaults.opcUa.publications, [
        { deviceId: device.id, enabled: false },
    ]);
    repository.save({
        modbus: {
            enabled: true,
            bindAddress: "127.0.0.1",
            port: 15_502,
            refreshIntervalMs: 500,
            mappings: [{ deviceId: device.id, enabled: true, unitId: 33 }],
        },
        opcUa: {
            enabled: true,
            bindAddress: "127.0.0.1",
            advertisedHost: "logger.test.internal",
            port: 14_840,
            endpointPath: "/Plant",
            allowAnonymous: false,
            refreshIntervalMs: 750,
            publications: [{ deviceId: device.id, enabled: true }],
        },
    });
    const saved = repository.getInput();
    assert.equal(saved.modbus.mappings[0]?.unitId, 33);
    assert.equal(saved.opcUa.allowAnonymous, false);
    assert.equal(saved.opcUa.advertisedHost, "logger.test.internal");
    const published = await new DatabasePublicationSource(database).getPublishedDevices();
    assert.equal(published[0]?.name, "meter");
    assert.deepEqual(published[0]?.tags[0]?.reading?.raw, [0x70a4, 0x4145]);
    assert.equal(published[0]?.tags[0]?.reading?.quality, "good");
    database.updateDeviceHealth(device.id, "offline", {
        lastError: "Connection timed out",
        lastPollMs: 2_000,
    });
    const offlinePublished = await new DatabasePublicationSource(database).getPublishedDevices();
    assert.equal(offlinePublished[0]?.tags[0]?.reading, null);
    repository.disableAll();
    assert.equal(repository.getInput().modbus.enabled, false);
    assert.equal(repository.getInput().opcUa.enabled, false);
    repository.reset();
    assert.equal(repository.getInput().modbus.port, 1502);
    assert.equal(repository.getInput().opcUa.port, 4840);
});
test("data-server API enforces admin writes and diagnostic read-only access", async (context) => {
    context.after(() => rmSync(temporaryRoot, { force: true, recursive: true }));
    const app = await buildApplication();
    await app.ready();
    context.after(() => app.close());
    const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: "admin", password: "admin" },
    });
    assert.equal(login.statusCode, 200);
    const adminToken = login.json().token;
    const adminHeaders = { authorization: `Bearer ${adminToken}` };
    const deviceResponses = await Promise.all([
        deviceInput("meter_a", 1),
        { ...deviceInput("meter_b", 2), tcpHost: "192.0.2.11" },
    ].map((payload) => app.inject({
        method: "POST",
        url: "/api/v1/devices",
        headers: adminHeaders,
        payload,
    })));
    assert.deepEqual(deviceResponses.map((response) => response.statusCode), [201, 201]);
    const deviceIds = deviceResponses.map((response) => response.json().id);
    for (const user of [
        {
            username: "diagnostic",
            password: "d",
            role: "diagnostic",
            enabled: true,
        },
        {
            username: "monitor",
            password: "m",
            role: "viewer",
            enabled: true,
        },
    ]) {
        const response = await app.inject({
            method: "POST",
            url: "/api/v1/users",
            headers: adminHeaders,
            payload: user,
        });
        assert.equal(response.statusCode, 201);
    }
    const diagnosticLogin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: "diagnostic", password: "d" },
    });
    const viewerLogin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: "monitor", password: "m" },
    });
    const diagnosticHeaders = {
        authorization: `Bearer ${diagnosticLogin.json().token}`,
    };
    const viewerHeaders = {
        authorization: `Bearer ${viewerLogin.json().token}`,
    };
    const settings = await app.inject({
        method: "GET",
        url: "/api/v1/settings/data-servers",
        headers: adminHeaders,
    });
    assert.equal(settings.statusCode, 200);
    assert.equal(settings.json().modbus.mappings.length, 2);
    assert.equal(settings.json().modbus.runtime.state, "disabled");
    const diagnosticRead = await app.inject({
        method: "GET",
        url: "/api/v1/settings/data-servers",
        headers: diagnosticHeaders,
    });
    assert.equal(diagnosticRead.statusCode, 200);
    const viewerRead = await app.inject({
        method: "GET",
        url: "/api/v1/settings/data-servers",
        headers: viewerHeaders,
    });
    assert.equal(viewerRead.statusCode, 403);
    const payload = {
        modbus: {
            enabled: false,
            bindAddress: "127.0.0.1",
            port: 1502,
            refreshIntervalMs: 1000,
            mappings: deviceIds.map((deviceId, index) => ({
                deviceId,
                enabled: false,
                unitId: index + 1,
            })),
        },
        opcUa: {
            enabled: false,
            bindAddress: "127.0.0.1",
            advertisedHost: "127.0.0.1",
            port: 4840,
            endpointPath: "/ModbusDataLogger",
            allowAnonymous: true,
            refreshIntervalMs: 1000,
            publications: deviceIds.map((deviceId) => ({
                deviceId,
                enabled: false,
            })),
        },
    };
    const diagnosticWrite = await app.inject({
        method: "PUT",
        url: "/api/v1/settings/data-servers",
        headers: diagnosticHeaders,
        payload,
    });
    assert.equal(diagnosticWrite.statusCode, 403);
    const adminWrite = await app.inject({
        method: "PUT",
        url: "/api/v1/settings/data-servers",
        headers: adminHeaders,
        payload,
    });
    assert.equal(adminWrite.statusCode, 200);
    const duplicateUnits = await app.inject({
        method: "PUT",
        url: "/api/v1/settings/data-servers",
        headers: adminHeaders,
        payload: {
            ...payload,
            modbus: {
                ...payload.modbus,
                enabled: true,
                mappings: deviceIds.map((deviceId) => ({
                    deviceId,
                    enabled: true,
                    unitId: 7,
                })),
            },
        },
    });
    assert.equal(duplicateUnits.statusCode, 400);
});
//# sourceMappingURL=data-servers.test.js.map