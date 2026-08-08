import type { OpcUaPublisherConfig, ProtocolPublicationSource, PublishedDevice, PublishedReading, PublisherStatusBase } from "./protocol-publication.js";
export interface OpcUaPublisherStatus extends PublisherStatusBase {
    host: string;
    port: number;
    endpointUrl: string | null;
    connectedClients: number;
    currentChannels: number;
    currentSessions: number;
    currentSubscriptions: number;
    requestCount: number;
    publishedDevices: number;
    publishedTags: number;
    lastCertificateRotationAt: string | null;
}
export interface OpcUaServerRuntime {
    getEndpointUrl(): string;
    getConnectedClientCount(): number;
    getCurrentChannelCount(): number;
    getCurrentSessionCount(): number;
    getCurrentSubscriptionCount(): number;
    getRequestCount(): number;
    close(timeoutMs: number): Promise<void>;
}
export interface OpcUaRuntimeCallbacks {
    getReading(tagId: string): PublishedReading | null;
    authenticateUser?(username: string, password: string): Promise<boolean>;
    onCertificateRegenerated?(advertisedHost: string): void;
    onRuntimeError(error: unknown): void;
}
export interface OpcUaAuthenticationProvider {
    validateCredentials(username: string, password: string): Promise<boolean>;
}
export type OpcUaRuntimeFactory = (config: OpcUaPublisherConfig, devices: PublishedDevice[], callbacks: OpcUaRuntimeCallbacks) => Promise<OpcUaServerRuntime>;
interface CertificateManagedOpcUaServer {
    certificateFile: string;
    getCertificate(): Buffer;
    checkCertificateSAN(): string[];
    regenerateSelfSignedCertificate(): Promise<void>;
    invalidateCachedCertificates(): void;
    endpoints: Array<{
        invalidateCertificates(): void;
    }>;
}
/**
 * Ensures a persisted certificate covers every explicitly configured server
 * identity. Self-signed certificates are rotated using the existing private
 * key. CA/GDS certificates are never replaced automatically.
 */
export declare function ensureOpcUaCertificateIdentity(server: CertificateManagedOpcUaServer, advertisedHost: string): Promise<boolean>;
export declare function createOpcUaServerRuntime(config: OpcUaPublisherConfig, devices: PublishedDevice[], callbacks: OpcUaRuntimeCallbacks): Promise<OpcUaServerRuntime>;
export declare class OpcUaPublisher {
    private readonly source;
    private readonly runtimeFactory;
    private readonly authenticationProvider?;
    private readonly lifecycle;
    private config;
    private runtime;
    private readings;
    private publishedTopology;
    private refreshTimer;
    private status;
    constructor(source: ProtocolPublicationSource, config: OpcUaPublisherConfig, runtimeFactory?: OpcUaRuntimeFactory, authenticationProvider?: OpcUaAuthenticationProvider | undefined);
    getStatus(): OpcUaPublisherStatus;
    start(): Promise<void>;
    reload(config: OpcUaPublisherConfig): Promise<void>;
    stop(): Promise<void>;
    refresh(): Promise<void>;
    private scheduleRefresh;
    private startUnsafe;
    private stopUnsafe;
}
export {};
