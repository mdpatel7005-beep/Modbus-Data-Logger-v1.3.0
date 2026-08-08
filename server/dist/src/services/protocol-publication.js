export function createDefaultOpcUaPublisherConfig(pkiDirectory) {
    return {
        enabled: false,
        host: "127.0.0.1",
        advertisedHost: "127.0.0.1",
        port: 4_840,
        endpointPath: "/ModbusDataLogger",
        allowAnonymous: true,
        refreshIntervalMs: 1_000,
        publishedDeviceIds: [],
        pkiDirectory,
        shutdownTimeoutMs: 5_000,
    };
}
export function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function validateNetworkPublisherConfig(config) {
    if (!config.host.trim()) {
        throw new Error("Publisher host is required");
    }
    if (!Number.isInteger(config.port) ||
        config.port < 1 ||
        config.port > 65_535) {
        throw new Error("Publisher port must be an integer from 1 to 65535");
    }
    if (!Number.isInteger(config.refreshIntervalMs) ||
        config.refreshIntervalMs < 100 ||
        config.refreshIntervalMs > 3_600_000) {
        throw new Error("Publisher refresh interval must be an integer from 100 to 3600000 ms");
    }
    if (config.shutdownTimeoutMs !== undefined &&
        (!Number.isInteger(config.shutdownTimeoutMs) ||
            config.shutdownTimeoutMs < 100 ||
            config.shutdownTimeoutMs > 60_000)) {
        throw new Error("Publisher shutdown timeout must be an integer from 100 to 60000 ms");
    }
}
export function enabledTags(device) {
    return device.tags.filter((tag) => tag.enabled);
}
/**
 * Serializes lifecycle transitions without exposing a lock implementation to
 * the protocol services.
 */
export class LifecycleQueue {
    tail = Promise.resolve();
    run(operation) {
        const result = this.tail.then(operation, operation);
        this.tail = result.catch(() => { });
        return result;
    }
}
//# sourceMappingURL=protocol-publication.js.map