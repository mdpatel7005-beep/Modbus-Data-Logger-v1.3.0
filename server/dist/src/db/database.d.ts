import Database from "better-sqlite3";
import type { ActivityCategory, ActivityEntry, ActivityLevel, AlarmRule, CreateAlarmRuleInput, CustomerProfile, CustomerProfileInput, Device, DeviceStatus, ReadingInsert, RegisterDefinition, PostgresSettings, PostgresSettingsInput, SystemAlert, SystemAlertType, UpdateAlarmRuleInput, UserRole, UserSummary, WhatsAppAlertSettings, WhatsAppAlertSettingsInput } from "../types/domain.js";
interface UserRow {
    id: string;
    username: string;
    password_hash: string;
    role: UserRole;
    enabled: number;
    created_at: string;
}
export interface SystemAlertTransitionRecord {
    id: string;
    type: SystemAlertType;
    sourceName: string;
    detail: string;
    occurredAt: string;
}
export interface SystemAlertTransition {
    opened: SystemAlertTransitionRecord | null;
    resolved: SystemAlertTransitionRecord | null;
}
export interface SystemAlertDelivery {
    id: number;
    alertId: string;
    alertType: SystemAlertType;
    sourceName: string;
    detail: string;
    eventKind: "opened" | "recovery";
    recipient: string;
    attempts: number;
}
export interface SystemAlertObservation {
    type: SystemAlertType;
    sourceKey: string;
    sourceId: string | null;
    sourceName: string;
}
export interface PostgresOutboxEntry {
    id: number;
    deviceId: string;
    sampleTimestamp: string;
    saveBucketMs: number;
    readingsJson: string;
    createdAt: string;
}
export interface DeviceClassification {
    id: string;
    name: string;
    deviceCount: number;
}
export interface CreateDeviceInput {
    name: string;
    protocol: "tcp" | "rtu";
    tcpHost?: string | null;
    tcpPort?: number | null;
    serialPort?: string | null;
    baudRate?: number | null;
    parity?: "none" | "even" | "odd" | null;
    dataBits?: 7 | 8 | null;
    stopBits?: 1 | 2 | null;
    unitId: number;
    pollIntervalMs: number;
    readBlockSize: number;
    timeoutMs: number;
    retries: number;
    categoryId?: string | null;
    groupId?: string | null;
    postgresEnabled: boolean;
    saveIntervalMs: number;
    postgresRawTable: string;
    postgresDownsampleTable: string;
    postgresDownsampleEnabled: boolean;
    postgresDownsampleIntervalSec: number;
    postgresRawRetentionDays: number;
    postgresDownsampleRetentionDays: number;
    postgresMaintenanceIntervalHours: number;
    enabled: boolean;
}
export interface CreateRegisterInput {
    deviceId: string;
    name: string;
    address: number;
    functionCode: 1 | 2 | 3 | 4;
    dataType: RegisterDefinition["dataType"];
    byteOrder: RegisterDefinition["byteOrder"];
    scale: number;
    offset: number;
    unit: string;
    historianColumn?: string;
    decimalPlaces?: number;
    enabled: boolean;
}
export declare const MAX_DEVICE_REGISTERS = 1500;
export declare class DeviceRegisterLimitError extends Error {
    constructor(limit?: number);
}
export declare class RegisterNameConflictError extends Error {
    constructor(name: string);
}
export interface HistorianColumnRename {
    registerId: string;
    from: string;
    to: string;
}
export declare class HistorianColumnNameConflictError extends Error {
    constructor(column: string);
}
export interface ActivityLogQuery {
    page: number;
    pageSize: number;
    level?: ActivityLevel;
    category?: ActivityCategory;
    search?: string;
    from?: string;
    to?: string;
}
export declare const MAX_ACTIVITY_LOG_ENTRIES = 50000;
export declare class UserAdministrationError extends Error {
    readonly code: "self_protection" | "last_administrator";
    constructor(code: "self_protection" | "last_administrator", message: string);
}
export declare class LoggerDatabase {
    readonly connection: Database.Database;
    constructor(databasePath: string);
    private migrate;
    private ensureCustomerRows;
    private migrateDiagnosticUserRole;
    private ensureColumn;
    private historianColumnIsReserved;
    private resolveHistorianColumn;
    close(): void;
    getCustomerProfile(): CustomerProfile;
    saveCustomerProfile(input: CustomerProfileInput): CustomerProfile;
    getPostgresSettings(): PostgresSettings | undefined;
    savePostgresSettings(input: PostgresSettingsInput, passwordEncrypted: string | null): PostgresSettings;
    recordPostgresConnectionTest(ok: boolean, message: string): void;
    recordPostgresMaintenance(rawDeleted: number, downsampleDeleted: number): void;
    recordPostgresReplay(count: number, completedAt?: string): void;
    enqueuePostgresOutbox(deviceId: string, sampleTimestamp: string, saveBucketMs: number, readings: ReadingInsert[], maxRows: number): {
        queued: boolean;
        dropped: number;
    };
    trimPostgresOutbox(maxRows: number): number;
    getPostgresOutboxStats(): {
        queuedRows: number;
        oldestAt: string | null;
    };
    getReplayablePostgresOutboxCount(): number;
    listReplayablePostgresOutbox(limit: number): PostgresOutboxEntry[];
    deletePostgresOutbox(id: number): boolean;
    getWhatsAppAlertSettings(): WhatsAppAlertSettings | undefined;
    saveWhatsAppAlertSettings(input: WhatsAppAlertSettingsInput, accessTokenEncrypted: string | null): WhatsAppAlertSettings;
    recordWhatsAppAlertTest(ok: boolean, message: string): void;
    observeSystemAlert(input: {
        type: SystemAlertType;
        sourceKey: string;
        sourceId: string | null;
        sourceName: string;
        offline: boolean;
        detail: string;
        offlineDelaySeconds: number;
        deliveryRecipients?: string[];
        sendRecovery?: boolean;
        observedAt?: string;
    }): SystemAlertTransition;
    private enqueueSystemAlertDeliveries;
    listSystemAlerts(options: {
        activeOnly: boolean;
        limit: number;
    }): SystemAlert[];
    listSystemAlertObservations(): SystemAlertObservation[];
    acknowledgeSystemAlert(id: string, userId: string): boolean;
    listDueSystemAlertDeliveries(limit: number, now?: string): SystemAlertDelivery[];
    markSystemAlertDeliverySent(id: number, providerMessageId: string | null): void;
    markSystemAlertDeliveryFailed(id: number, message: string, nextAttemptAt: string): void;
    markSystemAlertDeliveryDead(id: number, message: string): void;
    cancelUnsentSystemAlertDeliveries(recipients: string[] | null): number;
    getUserByUsername(username: string): UserRow | undefined;
    getUserById(id: string): UserRow | undefined;
    isUserRevoked(id: string): boolean;
    listUsers(): UserSummary[];
    updateUserPassword(id: string, passwordHash: string): boolean;
    getUserTokenVersion(id: string): number | undefined;
    createUser(input: {
        username: string;
        passwordHash: string;
        role: UserRole;
        enabled?: boolean;
    }): UserSummary;
    updateUser(id: string, input: {
        username?: string;
        role?: UserRole;
        enabled?: boolean;
    }, actorId: string): UserSummary | undefined;
    deleteUser(id: string, actorId: string): UserSummary | undefined;
    private countEnabledAdministrators;
    listDeviceCategories(): DeviceClassification[];
    getDeviceCategory(id: string): DeviceClassification | undefined;
    createDeviceCategory(name: string): DeviceClassification;
    deleteDeviceCategory(id: string): boolean;
    listDeviceGroups(): DeviceClassification[];
    getDeviceGroup(id: string): DeviceClassification | undefined;
    createDeviceGroup(name: string): DeviceClassification;
    deleteDeviceGroup(id: string): boolean;
    listDevices(): Device[];
    getDevice(id: string): Device | undefined;
    findHistorianTableOwner(rawTable: string, downsampleTable: string, excludeDeviceId?: string): Device | undefined;
    createDevice(input: CreateDeviceInput): Device;
    updateDevice(id: string, input: CreateDeviceInput): Device | undefined;
    deleteDevice(id: string): boolean;
    setDevicePostgresEnabled(id: string, enabled: boolean): Device | undefined;
    recordDevicePostgresMaintenance(id: string, completedAt: string): void;
    markDevicePostgresSchemaDirty(id: string): boolean;
    markDevicePostgresSchemaSynced(id: string, expectedRevision: number, syncedAt?: string): boolean;
    markAllPostgresSchemasDirty(): void;
    updateDeviceHealth(id: string, status: DeviceStatus, options: {
        lastSeenAt?: string | null;
        lastError?: string | null;
        lastPollMs?: number | null;
    }): void;
    listRegisters(deviceId?: string): RegisterDefinition[];
    getRegister(id: string): RegisterDefinition | undefined;
    createRegister(input: CreateRegisterInput): RegisterDefinition;
    createRegisters(deviceId: string, inputs: Array<Omit<CreateRegisterInput, "deviceId">>): RegisterDefinition[];
    updateRegister(id: string, input: Omit<CreateRegisterInput, "deviceId">): RegisterDefinition | undefined;
    listPendingHistorianColumnRenames(deviceId: string): HistorianColumnRename[];
    acknowledgeHistorianColumnRenames(deviceId: string, renames: HistorianColumnRename[]): void;
    deleteRegister(id: string): boolean;
    insertReadings(readings: ReadingInsert[]): void;
    getLatestReadings(limit?: number, deviceId?: string): unknown[];
    getLatestReadingsForDevice(deviceId: string): unknown[];
    private queryLatestReadings;
    queryReadings(options: {
        registerId?: string;
        deviceId?: string;
        categoryId?: string;
        groupId?: string;
        from?: string;
        to?: string;
        limit: number;
    }): unknown[];
    getOverview(): {
        devices: {
            total: number;
            enabled: number;
            online: number;
            warning: number;
            offline: number;
            disabled: number;
        };
        tags: {
            active: number;
            samplesToday: number;
        };
        alarms: {
            active: number;
            critical: number;
        };
        performance: {
            averagePollMs: number;
            successRate: number;
        };
        deviceSummaries: {
            id: string;
            name: string;
            protocol: import("../types/domain.js").Protocol;
            status: DeviceStatus;
            endpoint: string;
            tagCount: number;
            categoryName: string | null;
            groupName: string | null;
            lastSeenAt: string | null;
            lastPollMs: number | null;
            lastError: string | null;
        }[];
        sampleTrend: {
            bucketStart: string;
            samples: number;
        }[];
        activitySummary: {
            lastSampleAt: string | null;
            samplesLastHour: number;
            samplesLast24Hours: number;
            statusTransitionsLast24Hours: number;
        };
    };
    getStorageInfo(): {
        databaseFile: string;
        fileInfo: {
            sizeBytes: number | null;
            sizeHuman: string | null;
            exists: boolean;
            modified: string | null;
        };
        tables: {
            name: string;
            rows: number;
            sizeBytes: number;
            sizeHuman: string;
        }[];
        summary: {
            totalDataSizeBytes: number;
            totalDataSizeHuman: string;
            totalRows: number;
            needsVacuum: boolean;
            diskUsage: {
                totalBytes: number | null;
                freeBytes: number | null;
                usedPercent: number | null;
                warningLevel: "ok" | "warning" | "critical";
            };
            downsampleStats: {
                enabled: boolean;
                avgSamplesPerBucket: number | null;
                stalePercentage: number | null;
                missingBuckets: number | null;
            };
        };
        readingsGrowth: {
            today: number;
            yesterday: number;
            changePercent: number | null;
        };
        postgresSettings: {
            url: null;
            online: boolean;
        };
    };
    listAlarmRules(registerId: string): AlarmRule[];
    createAlarmRule(input: CreateAlarmRuleInput): AlarmRule;
    updateAlarmRule(ruleId: string, input: UpdateAlarmRuleInput): AlarmRule;
    deleteAlarmRule(ruleId: string): boolean;
    getActiveAlarm(ruleId: string): {
        id: string;
        rule_id: string;
        current_value: number;
        acknowledged_at: string | null;
    } | undefined;
    openAlarm(rule: AlarmRule, value: number, message: string): string;
    updateActiveAlarm(id: string, value: number): void;
    clearAlarm(id: string, value: number): void;
    listAlarmEvents(options: {
        activeOnly: boolean;
        limit: number;
    }): unknown[];
    acknowledgeAlarm(id: string, userId: string): boolean;
    listAlarmGroups(): Array<{
        id: string;
        name: string;
        description: string | null;
        created_at: string;
        updated_at: string;
    }>;
    getAlarmGroup(groupId: string): any | undefined;
    createAlarmGroup(name: string, description?: string): {
        id: string;
        name: string;
        description: string | null;
        created_at: string;
        updated_at: string;
    };
    updateAlarmGroup(groupId: string, updates: {
        name?: string;
        description?: string;
    }): void;
    deleteAlarmGroup(groupId: string): void;
    addGroupMember(groupId: string, registerId: string, weight?: number): void;
    removeGroupMember(groupId: string, registerId: string): void;
    listGroupMembers(groupId: string): Array<{
        group_id: string;
        register_id: string;
        weight: number;
    }>;
    createAlarmGroupRule(input: {
        groupId: string;
        name: string;
        severity: string;
        condition: string;
        thresholdHi?: number;
        thresholdLo?: number;
        deadband?: number;
    }): {
        groupId: string;
        name: string;
        severity: string;
        condition: string;
        thresholdHi?: number;
        thresholdLo?: number;
        deadband?: number;
        id: string;
    };
    listAlarmGroupRules(groupId: string): any[];
    deleteAlarmGroupRule(ruleId: string): void;
    getGroupCurrentValues(): Array<{
        register_id: string;
        value: number;
    }>;
    evaluateGroupAlarms(): void;
    openGroupAlarm(ruleId: string, groupName: string, value: number, message: string): void;
    listCategoryAlarmRules(categoryId: string): any[];
    createCategoryAlarmRule(input: {
        categoryId: string;
        name: string;
        severity: string;
        condition: string;
        thresholdHigh?: number | null;
        thresholdLow?: number | null;
        aggregationType?: string;
        deadband?: number;
    }): any;
    getCategoryAlarmRule(ruleId: string): any | undefined;
    updateCategoryAlarmRule(ruleId: string, updates: {
        name?: string;
        severity?: string;
        condition?: string;
        thresholdHigh?: number | null;
        thresholdLow?: number | null;
        aggregationType?: string;
        deadband?: number;
        enabled?: boolean;
    }): void;
    deleteCategoryAlarmRule(ruleId: string): void;
    listCategoryRuleTags(ruleId: string): string[];
    setCategoryRuleTags(ruleId: string, registerIds: string[]): void;
    listAllCategoriesWithDeviceCounts(): Array<{
        id: string;
        name: string;
        device_count: number;
    }>;
    getCategoriesWithMatchingRegisters(categoryId: string, tagNamePattern?: string): Array<{
        register_id: string;
        device_name: string;
        tag_name: string;
        address: number;
    }>;
    appendActivity(input: {
        timestamp?: string;
        level: ActivityLevel;
        category: ActivityCategory;
        event: string;
        message: string;
        actorUsername?: string | null;
        entityType?: string | null;
        entityId?: string | null;
        sourceIp?: string | null;
        details?: unknown;
    }): number;
    listActivity(options: ActivityLogQuery): {
        items: ActivityEntry[];
        total: number;
    };
    appendAudit(input: {
        actorId?: string;
        action: string;
        entityType: string;
        entityId?: string;
        details?: unknown;
        sourceIp?: string;
    }): void;
    deleteExpiredReadings(retentionDays: number): number;
}
export {};
