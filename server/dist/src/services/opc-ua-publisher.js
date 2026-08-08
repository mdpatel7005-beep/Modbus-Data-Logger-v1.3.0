import { randomUUID, X509Certificate } from "node:crypto";
import { copyFile, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, sep } from "node:path";
import { LifecycleQueue, enabledTags, errorMessage, validateNetworkPublisherConfig, } from "./protocol-publication.js";
function selectedDevices(devices, publishedDeviceIds) {
    if (publishedDeviceIds.length === 0)
        return [];
    const selectedIds = new Set(publishedDeviceIds);
    if (selectedIds.size !== publishedDeviceIds.length) {
        throw new Error("An OPC UA device is selected more than once");
    }
    const selected = devices.filter((device) => selectedIds.has(device.id));
    if (selected.length !== selectedIds.size) {
        const found = new Set(selected.map((device) => device.id));
        const missing = publishedDeviceIds.find((id) => !found.has(id));
        throw new Error(`Published OPC UA device ${missing ?? ""} was not found`);
    }
    return selected;
}
function validateOpcUaConfig(config) {
    validateNetworkPublisherConfig(config);
    const advertisedHost = config.advertisedHost?.trim();
    if (advertisedHost !== undefined &&
        (advertisedHost.length === 0 ||
            advertisedHost.includes("://") ||
            advertisedHost.includes("/") ||
            advertisedHost.includes("?") ||
            advertisedHost.includes("#"))) {
        throw new Error("OPC UA advertised host must be a hostname or IP address without a URL scheme or path");
    }
    if ((config.host === "0.0.0.0" || config.host === "::") &&
        !advertisedHost) {
        throw new Error("OPC UA advertised host is required when binding to all interfaces");
    }
    if (!config.endpointPath.startsWith("/") ||
        config.endpointPath.includes("?") ||
        config.endpointPath.includes("#")) {
        throw new Error("OPC UA endpoint path must start with / and cannot contain ? or #");
    }
    if (!config.pkiDirectory.trim() || !isAbsolute(config.pkiDirectory)) {
        throw new Error("OPC UA PKI directory must be an absolute path");
    }
    if (config.pkiDirectory.split(sep).includes("public")) {
        throw new Error("OPC UA PKI directory cannot be inside a public folder");
    }
}
function nodeIdPart(value) {
    return encodeURIComponent(value);
}
function readingTimestamp(reading) {
    if (!reading?.timestamp)
        return null;
    const timestamp = new Date(reading.timestamp);
    return Number.isNaN(timestamp.valueOf()) ? null : timestamp;
}
function countPublishedTags(devices) {
    return devices.reduce((count, device) => count + enabledTags(device).length, 0);
}
function certificateCoversHost(server, host) {
    const certificate = new X509Certificate(server.getCertificate());
    return isIP(host)
        ? certificate.checkIP(host) !== undefined
        : certificate.checkHost(host, { subject: "never" }) !== undefined;
}
function invalidateCertificateCaches(server) {
    server.invalidateCachedCertificates();
    for (const endpoint of server.endpoints) {
        endpoint.invalidateCertificates();
    }
}
async function removeIfPresent(filename) {
    try {
        await unlink(filename);
    }
    catch (error) {
        if (!(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ENOENT") {
            throw error;
        }
    }
}
/**
 * Ensures a persisted certificate covers every explicitly configured server
 * identity. Self-signed certificates are rotated using the existing private
 * key. CA/GDS certificates are never replaced automatically.
 */
export async function ensureOpcUaCertificateIdentity(server, advertisedHost) {
    const missing = server.checkCertificateSAN();
    if (missing.length === 0 &&
        certificateCoversHost(server, advertisedHost)) {
        return false;
    }
    if (server.certificateFile === "<in-memory>" ||
        server.certificateFile === "<unknown>") {
        throw new Error(`OPC UA certificate does not cover ${advertisedHost}; provision a replacement certificate before enabling this endpoint`);
    }
    const backupFile = `${server.certificateFile}.rotation-backup-${randomUUID()}`;
    await copyFile(server.certificateFile, backupFile);
    try {
        await server.regenerateSelfSignedCertificate();
        invalidateCertificateCaches(server);
        const remaining = server.checkCertificateSAN();
        if (remaining.length > 0 ||
            !certificateCoversHost(server, advertisedHost)) {
            throw new Error(`regenerated certificate still lacks ${[
                ...new Set([...remaining, advertisedHost]),
            ].join(", ")}`);
        }
        // A leftover public-certificate backup is preferable to rolling back a
        // successfully verified identity solely because cleanup failed.
        await removeIfPresent(backupFile).catch(() => { });
        return true;
    }
    catch (error) {
        // Restore the known-good certificate if generation or verification fails.
        await copyFile(backupFile, server.certificateFile);
        invalidateCertificateCaches(server);
        await removeIfPresent(backupFile).catch(() => { });
        const message = error instanceof Error ? error.message : String(error);
        if (/not self-signed/i.test(message)) {
            throw new Error(`OPC UA CA/GDS certificate does not cover ${advertisedHost}; provision a replacement certificate with the advertised host in its SAN`);
        }
        throw new Error(`OPC UA self-signed certificate rotation failed for ${advertisedHost}; the previous certificate was restored: ${message}`);
    }
}
function topologySignature(devices) {
    return JSON.stringify(devices
        .map((device) => ({
        id: device.id,
        name: device.name,
        tags: enabledTags(device)
            .map((tag) => ({
            id: tag.id,
            name: tag.name,
            dataType: tag.dataType,
            unit: tag.unit,
        }))
            .sort((left, right) => left.id.localeCompare(right.id)),
    }))
        .sort((left, right) => left.id.localeCompare(right.id)));
}
export async function createOpcUaServerRuntime(config, devices, callbacks) {
    const { DataType, DataValue, OPCUACertificateManager, OPCUAServer, RegisterServerMethod, StatusCodes, Variant, } = await import("node-opcua");
    const certificateManager = new OPCUACertificateManager({
        rootFolder: config.pkiDirectory,
        name: "pki",
        automaticallyAcceptUnknownCertificate: false,
    });
    await certificateManager.initialize();
    const server = new OPCUAServer({
        host: config.host,
        hostname: config.advertisedHost?.trim() || config.host,
        alternateHostname: [
            ...new Set([config.advertisedHost?.trim() || config.host, config.host].filter((host) => host !== "0.0.0.0" && host !== "::")),
        ],
        port: config.port,
        resourcePath: config.endpointPath,
        allowAnonymous: config.allowAnonymous,
        registerServerMethod: RegisterServerMethod.HIDDEN,
        serverCertificateManager: certificateManager,
        serverInfo: {
            applicationName: "Modbus Data Logger OPC UA Server",
            applicationUri: "urn:modbus-data-logger:opcua-server",
            productUri: "urn:modbus-data-logger",
        },
        buildInfo: {
            productName: "Modbus Data Logger",
            manufacturerName: "Modbus Data Logger",
        },
        ...(callbacks.authenticateUser
            ? {
                userManager: {
                    isValidUserAsync: (username, password, callback) => {
                        callbacks
                            .authenticateUser(username, password)
                            .then((isAuthorized) => callback(null, isAuthorized), (error) => callback(error instanceof Error
                            ? error
                            : new Error(String(error))));
                    },
                },
            }
            : {}),
    });
    const statusForReading = (reading) => {
        if (!reading?.hasReading || reading.quality === "bad") {
            return StatusCodes.BadNoCommunication;
        }
        if (reading.quality === "stale") {
            return StatusCodes.UncertainLastUsableValue;
        }
        return StatusCodes.Good;
    };
    const engineeringValue = (tag, reading) => {
        const value = reading?.hasReading &&
            reading.quality !== "bad" &&
            reading.value !== null &&
            Number.isFinite(reading.value)
            ? reading.value
            : 0;
        return tag.dataType === "bool" ? value !== 0 : value;
    };
    try {
        await server.initialize();
        const advertisedHost = config.advertisedHost?.trim() || config.host;
        if (await ensureOpcUaCertificateIdentity(server, advertisedHost)) {
            callbacks.onCertificateRegenerated?.(advertisedHost);
        }
        const addressSpace = server.engine.addressSpace;
        if (!addressSpace) {
            throw new Error("OPC UA address space was not initialized");
        }
        const namespace = addressSpace.getOwnNamespace();
        const devicesFolder = namespace.addFolder(addressSpace.rootFolder.objects, {
            browseName: "Devices",
            nodeId: `ns=${namespace.index};s=Devices`,
        });
        for (const device of devices) {
            const devicePart = nodeIdPart(device.id);
            const deviceFolder = namespace.addFolder(devicesFolder, {
                browseName: device.name,
                nodeId: `ns=${namespace.index};s=Devices/${devicePart}`,
            });
            for (const tag of enabledTags(device)) {
                const tagPart = nodeIdPart(tag.id);
                const tagNodeId = `ns=${namespace.index};s=Devices/${devicePart}/${tagPart}`;
                const dataType = tag.dataType === "bool" ? DataType.Boolean : DataType.Double;
                const valueNode = namespace.addVariable({
                    browseName: tag.name,
                    componentOf: deviceFolder,
                    nodeId: tagNodeId,
                    dataType,
                    description: tag.unit
                        ? `${tag.name} (${tag.unit})`
                        : tag.name,
                    accessLevel: "CurrentRead",
                    userAccessLevel: "CurrentRead",
                    minimumSamplingInterval: config.refreshIntervalMs,
                    value: {
                        timestamped_get: () => {
                            const reading = callbacks.getReading(tag.id);
                            const sourceTimestamp = readingTimestamp(reading);
                            return new DataValue({
                                value: {
                                    dataType,
                                    value: engineeringValue(tag, reading),
                                },
                                statusCode: statusForReading(reading),
                                ...(sourceTimestamp ? { sourceTimestamp } : {}),
                            });
                        },
                    },
                });
                namespace.addVariable({
                    browseName: "Quality",
                    propertyOf: valueNode,
                    nodeId: `${tagNodeId}/Quality`,
                    dataType: DataType.String,
                    accessLevel: "CurrentRead",
                    userAccessLevel: "CurrentRead",
                    minimumSamplingInterval: config.refreshIntervalMs,
                    value: {
                        get: () => {
                            const reading = callbacks.getReading(tag.id);
                            const quality = reading?.hasReading
                                ? reading.quality
                                : "bad";
                            return new Variant({
                                dataType: DataType.String,
                                value: quality,
                            });
                        },
                    },
                });
                namespace.addVariable({
                    browseName: "SourceTimestamp",
                    propertyOf: valueNode,
                    nodeId: `${tagNodeId}/SourceTimestamp`,
                    dataType: DataType.DateTime,
                    accessLevel: "CurrentRead",
                    userAccessLevel: "CurrentRead",
                    minimumSamplingInterval: config.refreshIntervalMs,
                    value: {
                        get: () => new Variant({
                            dataType: DataType.DateTime,
                            value: readingTimestamp(callbacks.getReading(tag.id)) ??
                                new Date(0),
                        }),
                    },
                });
            }
        }
        server.on("openSecureChannelFailure", () => {
            callbacks.onRuntimeError(new Error("OPC UA secure channel negotiation failed"));
        });
        await server.start();
    }
    catch (error) {
        try {
            if (server.initialized)
                await server.shutdown(100);
        }
        catch {
            // Preserve the original startup error.
        }
        await certificateManager.dispose().catch(() => { });
        throw error;
    }
    return {
        getEndpointUrl: () => server.getEndpointUrl(),
        getConnectedClientCount: () => server.currentSessionCount,
        getCurrentChannelCount: () => server.currentChannelCount,
        getCurrentSessionCount: () => server.currentSessionCount,
        getCurrentSubscriptionCount: () => server.currentSubscriptionCount,
        getRequestCount: () => server.transactionsCount,
        close: async (timeoutMs) => {
            let timeout = null;
            const timedOut = new Promise((_resolve, reject) => {
                timeout = setTimeout(() => reject(new Error("OPC UA server shutdown timed out")), timeoutMs);
            });
            try {
                await Promise.race([
                    server.shutdown(Math.max(0, timeoutMs - 250)),
                    timedOut,
                ]);
            }
            finally {
                if (timeout)
                    clearTimeout(timeout);
                await certificateManager.dispose().catch(() => { });
            }
        },
    };
}
export class OpcUaPublisher {
    source;
    runtimeFactory;
    authenticationProvider;
    lifecycle = new LifecycleQueue();
    config;
    runtime = null;
    readings = new Map();
    publishedTopology = "";
    refreshTimer = null;
    status;
    constructor(source, config, runtimeFactory = createOpcUaServerRuntime, authenticationProvider) {
        this.source = source;
        this.runtimeFactory = runtimeFactory;
        this.authenticationProvider = authenticationProvider;
        this.config = structuredClone(config);
        this.status = {
            state: config.enabled ? "stopped" : "disabled",
            host: config.host,
            port: config.port,
            endpointUrl: null,
            connectedClients: 0,
            currentChannels: 0,
            currentSessions: 0,
            currentSubscriptions: 0,
            requestCount: 0,
            publishedDevices: 0,
            publishedTags: 0,
            lastCertificateRotationAt: null,
            startedAt: null,
            stoppedAt: null,
            lastError: null,
            lastRefreshAt: null,
        };
    }
    getStatus() {
        const runtime = this.runtime;
        return {
            ...this.status,
            endpointUrl: runtime?.getEndpointUrl() ?? this.status.endpointUrl,
            connectedClients: runtime?.getConnectedClientCount() ?? 0,
            currentChannels: runtime?.getCurrentChannelCount() ?? 0,
            currentSessions: runtime?.getCurrentSessionCount() ?? 0,
            currentSubscriptions: runtime?.getCurrentSubscriptionCount() ?? 0,
            requestCount: runtime?.getRequestCount() ?? this.status.requestCount,
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
            const devices = selectedDevices(await this.source.getPublishedDevices(), this.config.publishedDeviceIds);
            const readings = new Map();
            for (const device of devices) {
                for (const tag of enabledTags(device)) {
                    if (tag.reading)
                        readings.set(tag.id, tag.reading);
                }
            }
            this.readings = readings;
            this.status.publishedDevices = devices.length;
            this.status.publishedTags = countPublishedTags(devices);
            this.status.lastRefreshAt = new Date().toISOString();
            if (this.status.lastError?.startsWith("Publication refresh failed:")) {
                this.status.lastError = null;
            }
            if (this.runtime &&
                this.status.state === "running" &&
                topologySignature(devices) !== this.publishedTopology) {
                await this.lifecycle.run(async () => {
                    if (!this.runtime || this.status.state !== "running")
                        return;
                    await this.stopUnsafe(false);
                    await this.startUnsafe();
                });
            }
        }
        catch (error) {
            // Existing nodes remain available, but all values immediately become
            // BadNoCommunication instead of exposing stale process data.
            this.readings = new Map();
            this.status.publishedDevices = 0;
            this.status.publishedTags = 0;
            this.status.lastError = `Publication refresh failed: ${errorMessage(error)}`;
        }
    }
    scheduleRefresh() {
        if (this.status.state !== "running")
            return;
        if (this.refreshTimer)
            clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(async () => {
            this.refreshTimer = null;
            await this.refresh();
            if (!this.refreshTimer)
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
            validateOpcUaConfig(this.config);
            if (!this.config.allowAnonymous && !this.authenticationProvider) {
                throw new Error("OPC UA anonymous access is disabled but no authentication provider is configured");
            }
            const devices = selectedDevices(await this.source.getPublishedDevices(), this.config.publishedDeviceIds);
            this.readings = new Map(devices.flatMap((device) => enabledTags(device)
                .filter((tag) => tag.reading !== null)
                .map((tag) => [tag.id, tag.reading])));
            this.status.publishedDevices = devices.length;
            this.status.publishedTags = countPublishedTags(devices);
            this.publishedTopology = topologySignature(devices);
            this.status.lastRefreshAt = new Date().toISOString();
            this.runtime = await this.runtimeFactory(this.config, devices, {
                getReading: (tagId) => this.readings.get(tagId) ?? null,
                ...(this.authenticationProvider
                    ? {
                        authenticateUser: (username, password) => this.authenticationProvider.validateCredentials(username, password),
                    }
                    : {}),
                onCertificateRegenerated: () => {
                    this.status.lastCertificateRotationAt =
                        new Date().toISOString();
                },
                onRuntimeError: (error) => {
                    this.status.lastError = errorMessage(error);
                },
            });
            this.status.state = "running";
            this.status.endpointUrl = this.runtime.getEndpointUrl();
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
                await runtime.close(this.config.shutdownTimeoutMs ?? 5_000);
            }
            catch (error) {
                this.status.lastError = `Shutdown failed: ${errorMessage(error)}`;
            }
        }
        this.status.connectedClients = 0;
        this.status.currentChannels = 0;
        this.status.currentSessions = 0;
        this.status.currentSubscriptions = 0;
        this.status.stoppedAt = new Date().toISOString();
        this.status.state =
            explicitStop && !this.config.enabled ? "disabled" : "stopped";
    }
}
//# sourceMappingURL=opc-ua-publisher.js.map