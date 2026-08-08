import { ServerTCP, } from "modbus-serial";
import { registerWidth } from "../modbus/codec.js";
import { DEFAULT_MODBUS_TCP_PUBLISHER_CONFIG, LifecycleQueue, enabledTags, errorMessage, validateNetworkPublisherConfig, } from "./protocol-publication.js";
function emptyUnitImage() {
    return {
        coils: new Map(),
        discreteInputs: new Map(),
        holdingRegisters: new Map(),
        inputRegisters: new Map(),
    };
}
function reorderBytes(buffer, byteOrder) {
    if (buffer.length === 2) {
        return byteOrder === "BADC" || byteOrder === "DCBA"
            ? Buffer.from([buffer[1] ?? 0, buffer[0] ?? 0])
            : buffer;
    }
    const words = Array.from({ length: buffer.length / 2 }, (_, index) => buffer.subarray(index * 2, index * 2 + 2));
    const swapBytes = byteOrder === "BADC" || byteOrder === "DCBA";
    const swapWords = byteOrder === "CDAB" || byteOrder === "DCBA";
    const orderedWords = swapWords ? words.reverse() : words;
    return Buffer.concat(orderedWords.map((word) => swapBytes ? Buffer.from([word[1] ?? 0, word[0] ?? 0]) : word));
}
function canonicalValueBuffer(value, dataType) {
    const buffer = Buffer.alloc(registerWidth(dataType) * 2);
    switch (dataType) {
        case "bool":
            buffer.writeUInt16BE(value === 0 ? 0 : 1, 0);
            break;
        case "uint16":
            buffer.writeUInt16BE(Math.round(value), 0);
            break;
        case "int16":
            buffer.writeInt16BE(Math.round(value), 0);
            break;
        case "uint32":
            buffer.writeUInt32BE(Math.round(value), 0);
            break;
        case "int32":
            buffer.writeInt32BE(Math.round(value), 0);
            break;
        case "float32":
            buffer.writeFloatBE(value, 0);
            break;
        case "float64":
            buffer.writeDoubleBE(value, 0);
            break;
    }
    return buffer;
}
/**
 * Converts an engineering value back to source register words. This is only a
 * fallback: captured raw words are preferable because inverse scaling can be
 * lossy for integer data.
 */
export function encodeEngineeringValueAsRaw(tag, engineeringValue) {
    if (!Number.isFinite(engineeringValue))
        return [];
    if (!Number.isFinite(tag.scale) || tag.scale === 0)
        return [];
    const sourceValue = (engineeringValue - tag.offset) / tag.scale;
    if (!Number.isFinite(sourceValue))
        return [];
    try {
        const ordered = reorderBytes(canonicalValueBuffer(sourceValue, tag.dataType), tag.byteOrder);
        return Array.from({ length: ordered.length / 2 }, (_, index) => ordered.readUInt16BE(index * 2));
    }
    catch {
        return [];
    }
}
function usableRaw(tag) {
    const reading = tag.reading;
    if (!reading ||
        !reading.hasReading ||
        reading.quality === "bad" ||
        reading.value === null) {
        return [];
    }
    const width = tag.functionCode === 1 || tag.functionCode === 2
        ? 1
        : registerWidth(tag.dataType);
    if (reading.raw.length >= width &&
        reading.raw
            .slice(0, width)
            .every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)) {
        return reading.raw.slice(0, width);
    }
    return encodeEngineeringValueAsRaw(tag, reading.value);
}
function mapValue(target, address, value, label) {
    if (target.has(address)) {
        throw new Error(`Overlapping published Modbus address: ${label}`);
    }
    if (typeof value === "boolean") {
        target.set(address, value);
    }
    else {
        target.set(address, value);
    }
}
function addTagToImage(image, tag, deviceName) {
    const raw = usableRaw(tag);
    const label = `${deviceName}/${tag.name} FC${tag.functionCode} address ${tag.address}`;
    if (tag.functionCode === 1 || tag.functionCode === 2) {
        const target = tag.functionCode === 1 ? image.coils : image.discreteInputs;
        mapValue(target, tag.address, (raw[0] ?? 0) !== 0, label);
        return;
    }
    const target = tag.functionCode === 3
        ? image.holdingRegisters
        : image.inputRegisters;
    const width = registerWidth(tag.dataType);
    for (let index = 0; index < width; index += 1) {
        mapValue(target, tag.address + index, raw[index] ?? 0, label);
    }
}
export function buildModbusUnitImages(devices, mappings) {
    const images = new Map();
    const devicesById = new Map(devices.map((device) => [device.id, device]));
    const mappedDeviceIds = new Set();
    let publishedTags = 0;
    for (const mapping of mappings) {
        if (!Number.isInteger(mapping.unitId) ||
            mapping.unitId < 1 ||
            mapping.unitId > 247) {
            throw new Error(`Virtual Modbus unit ID for device ${mapping.deviceId} must be from 1 to 247`);
        }
        if (images.has(mapping.unitId)) {
            throw new Error(`Virtual Modbus unit ID ${mapping.unitId} is assigned more than once`);
        }
        if (mappedDeviceIds.has(mapping.deviceId)) {
            throw new Error(`Device ${mapping.deviceId} is assigned more than one virtual Modbus unit ID`);
        }
        const device = devicesById.get(mapping.deviceId);
        if (!device) {
            throw new Error(`Published Modbus device ${mapping.deviceId} was not found`);
        }
        mappedDeviceIds.add(mapping.deviceId);
        const image = emptyUnitImage();
        const tags = enabledTags(device);
        for (const tag of tags)
            addTagToImage(image, tag, device.name);
        publishedTags += tags.length;
        images.set(mapping.unitId, image);
    }
    return {
        images,
        publishedDevices: images.size,
        publishedTags,
    };
}
function readRange(image, area, address, length) {
    const values = image?.[area];
    return Array.from({ length }, (_, index) => values?.get(address + index) ?? 0);
}
function readonlyError() {
    return Object.assign(new Error("Published Modbus data is read-only"), {
        modbusErrorCode: 0x01,
    });
}
export async function createModbusTcpServerRuntime(vector, options, callbacks) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const server = new ServerTCP(vector, options);
        const startTimeout = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            server.close(() => { });
            reject(new Error("Modbus TCP publishing server start timed out"));
        }, 5_000);
        server.on("initialized", () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(startTimeout);
            resolve({
                getConnectedClientCount: () => server.socks.size,
                close: async (timeoutMs) => {
                    await new Promise((finish) => {
                        let closed = false;
                        const done = () => {
                            if (closed)
                                return;
                            closed = true;
                            clearTimeout(timeout);
                            finish();
                        };
                        const timeout = setTimeout(done, timeoutMs);
                        try {
                            server.close(done);
                        }
                        catch {
                            done();
                        }
                    });
                },
            });
        });
        server.on("serverError", (error) => {
            const reported = error ?? new Error("Modbus TCP server error");
            if (!settled) {
                settled = true;
                clearTimeout(startTimeout);
                reject(reported);
                return;
            }
            callbacks.onRuntimeError(reported);
        });
        server.on("socketError", (error) => {
            callbacks.onRuntimeError(error ?? new Error("Modbus TCP client socket error"));
        });
        server.on("error", (error) => {
            callbacks.onRuntimeError(error ?? new Error("Modbus TCP request error"));
        });
        server._server?.on("connection", callbacks.onConnection);
    });
}
export class ModbusTcpPublisher {
    source;
    runtimeFactory;
    lifecycle = new LifecycleQueue();
    config;
    runtime = null;
    images = new Map();
    refreshTimer = null;
    status;
    constructor(source, config = {
        ...DEFAULT_MODBUS_TCP_PUBLISHER_CONFIG,
        deviceMappings: [],
    }, runtimeFactory = createModbusTcpServerRuntime) {
        this.source = source;
        this.runtimeFactory = runtimeFactory;
        this.config = structuredClone(config);
        this.status = {
            state: config.enabled ? "stopped" : "disabled",
            host: config.host,
            port: config.port,
            startedAt: null,
            stoppedAt: null,
            lastError: null,
            lastRefreshAt: null,
            connectedClients: 0,
            totalConnections: 0,
            requestCount: 0,
            readErrors: 0,
            rejectedWrites: 0,
            publishedDevices: 0,
            publishedTags: 0,
        };
    }
    getStatus() {
        return {
            ...this.status,
            connectedClients: this.runtime?.getConnectedClientCount() ?? 0,
        };
    }
    start() {
        return this.lifecycle.run(async () => {
            if (this.runtime || this.status.state === "starting")
                return;
            await this.startUnsafe();
        });
    }
    reload(config) {
        return this.lifecycle.run(async () => {
            await this.stopUnsafe(false);
            this.config = structuredClone(config);
            this.status.host = config.host;
            this.status.port = config.port;
            await this.startUnsafe();
        });
    }
    stop() {
        return this.lifecycle.run(() => this.stopUnsafe(true));
    }
    async refresh() {
        try {
            const devices = await this.source.getPublishedDevices();
            const snapshot = buildModbusUnitImages(devices, this.config.deviceMappings);
            this.images = snapshot.images;
            this.status.publishedDevices = snapshot.publishedDevices;
            this.status.publishedTags = snapshot.publishedTags;
            this.status.lastRefreshAt = new Date().toISOString();
            if (this.status.lastError?.startsWith("Publication refresh failed:")) {
                this.status.lastError = null;
            }
        }
        catch (error) {
            // Never continue serving a stale process image when the publication
            // source or snapshot validation fails.
            this.images = new Map();
            this.status.publishedDevices = 0;
            this.status.publishedTags = 0;
            this.status.lastError = `Publication refresh failed: ${errorMessage(error)}`;
        }
    }
    createVector() {
        const countRead = (operation) => {
            this.status.requestCount += 1;
            try {
                return operation();
            }
            catch (error) {
                this.status.readErrors += 1;
                throw error;
            }
        };
        const rejectWrite = (_address, _value, _unitId, callback) => {
            this.status.requestCount += 1;
            this.status.rejectedWrites += 1;
            callback(readonlyError());
        };
        const vector = {
            getCoil: (address, unitId) => countRead(() => this.images.get(unitId)?.coils.get(address) ?? false),
            getDiscreteInput: (address, unitId) => countRead(() => this.images.get(unitId)?.discreteInputs.get(address) ??
                false),
            getHoldingRegister: (address, unitId) => countRead(() => this.images.get(unitId)?.holdingRegisters.get(address) ?? 0),
            getInputRegister: (address, unitId) => countRead(() => this.images.get(unitId)?.inputRegisters.get(address) ?? 0),
            getMultipleHoldingRegisters: (address, length, unitId) => countRead(() => readRange(this.images.get(unitId), "holdingRegisters", address, length)),
            getMultipleInputRegisters: (address, length, unitId) => countRead(() => readRange(this.images.get(unitId), "inputRegisters", address, length)),
            setCoil: rejectWrite,
            setRegister: rejectWrite,
            setRegisterArray: rejectWrite,
        };
        return vector;
    }
    scheduleRefresh() {
        if (this.status.state !== "running")
            return;
        this.refreshTimer = setTimeout(async () => {
            await this.refresh();
            this.scheduleRefresh();
        }, this.config.refreshIntervalMs);
        this.refreshTimer.unref();
    }
    async startUnsafe() {
        if (!this.config.enabled) {
            this.status.state = "disabled";
            this.status.stoppedAt = new Date().toISOString();
            return;
        }
        this.status.state = "starting";
        this.status.lastError = null;
        this.status.host = this.config.host;
        this.status.port = this.config.port;
        try {
            validateNetworkPublisherConfig(this.config);
            await this.refresh();
            if (this.status.lastError) {
                throw new Error(this.status.lastError);
            }
            this.runtime = await this.runtimeFactory(this.createVector(), {
                host: this.config.host,
                port: this.config.port,
                // modbus-serial uses 255 to accept requests for every virtual unit.
                unitID: 255,
            }, {
                onConnection: () => {
                    this.status.totalConnections += 1;
                },
                onRuntimeError: (error) => {
                    this.status.lastError = errorMessage(error);
                },
            });
            this.status.state = "running";
            this.status.startedAt = new Date().toISOString();
            this.status.stoppedAt = null;
            this.scheduleRefresh();
        }
        catch (error) {
            this.runtime = null;
            this.status.state = "error";
            this.status.lastError = errorMessage(error);
            this.status.stoppedAt = new Date().toISOString();
        }
    }
    async stopUnsafe(explicitStop) {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        const runtime = this.runtime;
        this.runtime = null;
        if (runtime) {
            this.status.state = "stopping";
            try {
                await runtime.close(this.config.shutdownTimeoutMs ?? 3_000);
            }
            catch (error) {
                this.status.lastError = `Shutdown failed: ${errorMessage(error)}`;
            }
        }
        this.status.connectedClients = 0;
        this.status.stoppedAt = new Date().toISOString();
        this.status.state =
            explicitStop && !this.config.enabled ? "disabled" : "stopped";
    }
}
//# sourceMappingURL=modbus-tcp-publisher.js.map