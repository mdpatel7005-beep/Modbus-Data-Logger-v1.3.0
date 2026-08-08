import assert from "node:assert/strict";
import test from "node:test";
import { DeviceClient } from "../src/modbus/client.js";
const device = {
    id: "dev_transport",
    name: "Transport lifecycle",
    protocol: "tcp",
    tcpHost: "192.0.2.10",
    tcpPort: 502,
    serialPort: null,
    baudRate: null,
    parity: null,
    dataBits: null,
    stopBits: null,
    unitId: 1,
    pollIntervalMs: 1_000,
    readBlockSize: 120,
    timeoutMs: 1_000,
    retries: 2,
    categoryId: null,
    categoryName: null,
    groupId: null,
    groupName: null,
    postgresEnabled: false,
    saveIntervalMs: 1_000,
    postgresRawTable: "transport_raw",
    postgresDownsampleTable: "transport_1m",
    postgresDownsampleEnabled: false,
    postgresDownsampleIntervalSec: 60,
    postgresRawRetentionDays: 30,
    postgresDownsampleRetentionDays: 365,
    postgresMaintenanceIntervalHours: 24,
    postgresLastMaintenanceAt: null,
    postgresSchemaSyncedAt: null,
    postgresSchemaDirty: true,
    postgresSchemaRevision: 0,
    tagCount: 0,
    enabled: true,
    status: "offline",
    lastSeenAt: null,
    lastError: null,
    lastPollMs: null,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
};
test("closes the transport after an unsuccessful connection attempt", async () => {
    const client = new DeviceClient(device);
    const transport = client.client;
    let closeCalls = 0;
    let destroyCalls = 0;
    transport.connectTCP = async () => {
        throw new Error("connection timed out");
    };
    transport.close = (callback) => {
        closeCalls += 1;
        callback?.();
    };
    transport.destroy = (callback) => {
        destroyCalls += 1;
        callback?.();
    };
    await assert.rejects(client.connect(), /connection timed out/);
    assert.equal(closeCalls, 0);
    assert.equal(destroyCalls, 1);
    await client.close();
    assert.equal(closeCalls, 0);
    assert.equal(destroyCalls, 1);
});
test("closes rather than destroys an RTU transport during abort", async () => {
    const client = new DeviceClient({
        ...device,
        protocol: "rtu",
        tcpHost: null,
        tcpPort: null,
        serialPort: "/dev/tty-test",
        baudRate: 9_600,
    });
    const transport = client.client;
    let closeCalls = 0;
    let destroyCalls = 0;
    transport.close = (callback) => {
        closeCalls += 1;
        callback?.();
    };
    transport.destroy = (callback) => {
        destroyCalls += 1;
        callback?.();
    };
    await client.abort();
    assert.equal(closeCalls, 1);
    assert.equal(destroyCalls, 0);
});
test("cancels a blocked RTU read even when serial close never calls back", async () => {
    const client = new DeviceClient({
        ...device,
        protocol: "rtu",
        tcpHost: null,
        tcpPort: null,
        serialPort: "/dev/tty-test",
        baudRate: 9_600,
    }, 10);
    const transport = client.client;
    let closeCalls = 0;
    let destroyCalls = 0;
    transport.connectRTUBuffered = async () => { };
    transport.close = () => {
        closeCalls += 1;
    };
    transport.destroy = (callback) => {
        destroyCalls += 1;
        callback?.();
    };
    transport.readHoldingRegisters = () => new Promise(() => { });
    await client.connect();
    const read = client.readRegister({
        id: "reg_blocked",
        deviceId: device.id,
        name: "Blocked register",
        historianColumn: "blocked_register",
        address: 0,
        functionCode: 3,
        dataType: "uint16",
        byteOrder: "ABCD",
        scale: 1,
        offset: 0,
        unit: "",
        decimalPlaces: 0,
        enabled: true,
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:00.000Z",
    });
    const abort = client.abort();
    await assert.rejects(read, /cancelled because polling stopped/);
    await abort;
    assert.equal(closeCalls, 1);
    assert.equal(destroyCalls, 0);
});
//# sourceMappingURL=modbus-client-lifecycle.test.js.map