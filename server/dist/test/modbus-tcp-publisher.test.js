import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import ModbusRTUModule from "modbus-serial";
import { decodeRegisters } from "../src/modbus/codec.js";
import { buildModbusUnitImages, ModbusTcpPublisher, encodeEngineeringValueAsRaw, } from "../src/services/modbus-tcp-publisher.js";
const ModbusRTU = ModbusRTUModule;
async function freePort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    const port = address.port;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    return port;
}
function publishedDevice() {
    return {
        id: "device-a",
        name: "Boiler PLC",
        tags: [
            {
                id: "coil",
                name: "Run",
                address: 10,
                functionCode: 1,
                dataType: "bool",
                byteOrder: "ABCD",
                scale: 1,
                offset: 0,
                unit: "",
                enabled: true,
                reading: {
                    value: 1,
                    raw: [1],
                    quality: "good",
                    timestamp: "2026-07-27T00:00:00.000Z",
                    hasReading: true,
                },
            },
            {
                id: "trip",
                name: "Trip",
                address: 20,
                functionCode: 2,
                dataType: "bool",
                byteOrder: "ABCD",
                scale: 1,
                offset: 0,
                unit: "",
                enabled: true,
                reading: {
                    value: 1,
                    raw: [1],
                    quality: "good",
                    timestamp: "2026-07-27T00:00:00.000Z",
                    hasReading: true,
                },
            },
            {
                id: "power",
                name: "Power",
                address: 100,
                functionCode: 3,
                dataType: "float32",
                byteOrder: "CDAB",
                scale: 0.1,
                offset: 5,
                unit: "kW",
                enabled: true,
                reading: {
                    value: 128.4,
                    raw: [0x70a4, 0x4145],
                    quality: "good",
                    timestamp: "2026-07-27T00:00:00.000Z",
                    hasReading: true,
                },
            },
            {
                id: "pressure",
                name: "Pressure",
                address: 200,
                functionCode: 4,
                dataType: "uint16",
                byteOrder: "ABCD",
                scale: 1,
                offset: 0,
                unit: "bar",
                enabled: true,
                reading: {
                    value: 55,
                    raw: [55],
                    quality: "good",
                    timestamp: "2026-07-27T00:00:00.000Z",
                    hasReading: true,
                },
            },
            {
                id: "bad-input",
                name: "Bad input",
                address: 202,
                functionCode: 4,
                dataType: "uint16",
                byteOrder: "ABCD",
                scale: 1,
                offset: 0,
                unit: "",
                enabled: true,
                reading: {
                    value: 999,
                    raw: [999],
                    quality: "bad",
                    timestamp: "2026-07-27T00:00:00.000Z",
                    hasReading: true,
                },
            },
        ],
    };
}
function secondPublishedDevice() {
    return {
        id: "device-b",
        name: "Chiller PLC",
        tags: [
            {
                id: "run-b",
                name: "Run",
                address: 10,
                functionCode: 1,
                dataType: "bool",
                byteOrder: "ABCD",
                scale: 1,
                offset: 0,
                unit: "",
                enabled: true,
                reading: {
                    value: 0,
                    raw: [0],
                    quality: "good",
                    timestamp: "2026-07-27T00:00:00.000Z",
                    hasReading: true,
                },
            },
            {
                id: "trip-b",
                name: "Trip",
                address: 20,
                functionCode: 2,
                dataType: "bool",
                byteOrder: "ABCD",
                scale: 1,
                offset: 0,
                unit: "",
                enabled: true,
                reading: {
                    value: 0,
                    raw: [0],
                    quality: "good",
                    timestamp: "2026-07-27T00:00:00.000Z",
                    hasReading: true,
                },
            },
            {
                id: "power-b",
                name: "Power",
                address: 100,
                functionCode: 3,
                dataType: "uint16",
                byteOrder: "ABCD",
                scale: 1,
                offset: 0,
                unit: "kW",
                enabled: true,
                reading: {
                    value: 2_222,
                    raw: [2_222],
                    quality: "good",
                    timestamp: "2026-07-27T00:00:00.000Z",
                    hasReading: true,
                },
            },
            {
                id: "pressure-b",
                name: "Pressure",
                address: 200,
                functionCode: 4,
                dataType: "uint16",
                byteOrder: "ABCD",
                scale: 1,
                offset: 0,
                unit: "bar",
                enabled: true,
                reading: {
                    value: 77,
                    raw: [77],
                    quality: "good",
                    timestamp: "2026-07-27T00:00:00.000Z",
                    hasReading: true,
                },
            },
        ],
    };
}
function config(port) {
    return {
        enabled: true,
        host: "127.0.0.1",
        port,
        refreshIntervalMs: 60_000,
        deviceMappings: [{ deviceId: "device-a", unitId: 7 }],
        shutdownTimeoutMs: 1_000,
    };
}
async function closeClient(client) {
    await new Promise((resolve) => client.close(resolve));
}
function isIllegalFunction(error) {
    return (error instanceof Error &&
        error.modbusCode === 0x01);
}
test("inverse scaling fallback preserves configured Modbus encoding", () => {
    const words = encodeEngineeringValueAsRaw({
        dataType: "float32",
        byteOrder: "CDAB",
        scale: 0.1,
        offset: 5,
    }, 6.234);
    const decoded = decodeRegisters(words, "float32", "CDAB");
    assert(Math.abs(decoded * 0.1 + 5 - 6.234) < 0.000_01);
});
test("builds a complete virtual unit image for 1,500 published tags", () => {
    const device = {
        id: "device-large",
        name: "Large meter",
        tags: Array.from({ length: 1_500 }, (_, index) => ({
            id: `tag-${index}`,
            name: `Tag ${index}`,
            address: index,
            functionCode: 3,
            dataType: "uint16",
            byteOrder: "ABCD",
            scale: 1,
            offset: 0,
            unit: "",
            enabled: true,
            reading: {
                value: index,
                raw: [index],
                quality: "good",
                timestamp: "2026-07-27T00:00:00.000Z",
                hasReading: true,
            },
        })),
    };
    const snapshot = buildModbusUnitImages([device], [{ deviceId: device.id, unitId: 7 }]);
    assert.equal(snapshot.publishedDevices, 1);
    assert.equal(snapshot.publishedTags, 1_500);
    assert.equal(snapshot.images.get(7)?.holdingRegisters.size, 1_500);
    assert.equal(snapshot.images.get(7)?.holdingRegisters.get(1_499), 1_499);
});
test("an outside client selects virtual units, reads FC1/2/3/4, and has FC5/6/15/16 rejected", async () => {
    const port = await freePort();
    let devices = [publishedDevice(), secondPublishedDevice()];
    let sourceUnavailable = false;
    const source = {
        getPublishedDevices: async () => {
            if (sourceUnavailable)
                throw new Error("source unavailable");
            return structuredClone(devices);
        },
    };
    const publisher = new ModbusTcpPublisher(source, {
        ...config(port),
        deviceMappings: [
            { deviceId: "device-a", unitId: 7 },
            { deviceId: "device-b", unitId: 12 },
        ],
    });
    const client = new ModbusRTU();
    try {
        await publisher.start();
        assert.equal(publisher.getStatus().state, "running");
        client.setID(7);
        await client.connectTCP("127.0.0.1", { port });
        assert.deepEqual((await client.readCoils(10, 2)).data.slice(0, 2), [true, false]);
        assert.deepEqual((await client.readDiscreteInputs(20, 2)).data.slice(0, 2), [true, false]);
        assert.deepEqual((await client.readHoldingRegisters(99, 4)).data, [0, 0x70a4, 0x4145, 0]);
        assert.deepEqual((await client.readInputRegisters(200, 3)).data, [55, 0, 0]);
        client.setID(12);
        assert.deepEqual((await client.readCoils(10, 1)).data.slice(0, 1), [false]);
        assert.deepEqual((await client.readDiscreteInputs(20, 1)).data.slice(0, 1), [false]);
        assert.deepEqual((await client.readHoldingRegisters(100, 1)).data, [2_222]);
        assert.deepEqual((await client.readInputRegisters(200, 1)).data, [77]);
        client.setID(7);
        const changed = publishedDevice();
        const power = changed.tags.find((tag) => tag.id === "power");
        assert(power?.reading);
        power.reading.raw = [0, 1234];
        power.reading.value = 123.4;
        devices = [changed, secondPublishedDevice()];
        await publisher.refresh();
        assert.deepEqual((await client.readHoldingRegisters(100, 2)).data, [0, 1234]);
        sourceUnavailable = true;
        await publisher.refresh();
        assert.deepEqual((await client.readHoldingRegisters(100, 2)).data, [0, 0]);
        assert.equal(publisher.getStatus().publishedDevices, 0);
        assert.equal(publisher.getStatus().publishedTags, 0);
        assert.match(publisher.getStatus().lastError ?? "", /Publication refresh failed: source unavailable/);
        sourceUnavailable = false;
        await publisher.refresh();
        assert.deepEqual((await client.readHoldingRegisters(100, 2)).data, [0, 1234]);
        assert.equal(publisher.getStatus().lastError, null);
        await assert.rejects(client.writeCoil(10, false), isIllegalFunction);
        await assert.rejects(client.writeRegister(100, 42), isIllegalFunction);
        await assert.rejects(client.writeCoils(10, [false]), isIllegalFunction);
        await assert.rejects(client.writeRegisters(100, [1, 2]), isIllegalFunction);
        const status = publisher.getStatus();
        assert(status.requestCount >= 16);
        assert.equal(status.rejectedWrites, 4);
        assert.equal(status.connectedClients, 1);
        assert.equal(status.publishedDevices, 2);
        assert.equal(status.publishedTags, 9);
    }
    finally {
        await closeClient(client).catch(() => { });
        await publisher.stop();
    }
    assert.equal(publisher.getStatus().state, "stopped");
    assert.equal(publisher.getStatus().connectedClients, 0);
});
test("configuration errors are reported without throwing or binding a server", async () => {
    const port = await freePort();
    const source = {
        getPublishedDevices: async () => [publishedDevice()],
    };
    const publisher = new ModbusTcpPublisher(source, {
        ...config(port),
        deviceMappings: [
            { deviceId: "device-a", unitId: 7 },
            { deviceId: "device-a", unitId: 8 },
        ],
    });
    await publisher.start();
    assert.equal(publisher.getStatus().state, "error");
    assert.match(publisher.getStatus().lastError ?? "", /more than one virtual Modbus unit ID/);
    await publisher.stop();
});
//# sourceMappingURL=modbus-tcp-publisher.test.js.map