import type { FastifyBaseLogger } from "fastify";
import type { LoggerDatabase } from "../db/database.js";
import type { Device, WhatsAppAlertSettings, WhatsAppAlertSettingsInput } from "../types/domain.js";
export interface PublicWhatsAppAlertSettings extends Omit<WhatsAppAlertSettings, "accessTokenEncrypted" | "updatedAt"> {
    accessTokenConfigured: boolean;
    updatedAt: string | null;
}
export interface WhatsAppTestResult {
    ok: boolean;
    message: string;
    recipientCount: number;
}
type FetchImplementation = typeof fetch;
export declare class WhatsAppAlertConfigurationError extends Error {
    constructor(message: string);
}
export declare class SystemAlertService {
    private readonly database;
    private readonly logger;
    private readonly fetchImplementation;
    private deliveryTimer;
    private deliveryPromise;
    private stopped;
    private paused;
    constructor(database: LoggerDatabase, logger: FastifyBaseLogger, fetchImplementation?: FetchImplementation);
    start(): void;
    close(): Promise<void>;
    pauseAndDrain(): Promise<void>;
    resume(): void;
    getPublicSettings(): PublicWhatsAppAlertSettings;
    saveSettings(input: WhatsAppAlertSettingsInput): PublicWhatsAppAlertSettings;
    observeDevice(device: Device, offline: boolean, detail: string): void;
    observePostgres(input: {
        intended: boolean;
        offline: boolean;
        detail: string;
    }): void;
    observeTagAlarm(input: {
        opened: boolean;
        registerId: string;
        ruleName: string;
        deviceName: string;
        tagName: string;
        currentValue: number;
        thresholdValue?: number | null;
        severity: "warning" | "critical";
    }): void;
    private getThresholdLabel;
    reconcileIntentionalState(): void;
    postgresMonitoringIntended(): boolean;
    testWhatsApp(draft?: WhatsAppAlertSettingsInput): Promise<WhatsAppTestResult>;
    flushDeliveries(): Promise<void>;
    private observe;
    private wakeDeliveryWorker;
    private processPendingDeliveries;
    private performPendingDeliveries;
    private sendTemplate;
}
export {};
