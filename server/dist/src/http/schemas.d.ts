import { z } from "zod";
export declare const loginSchema: z.ZodObject<{
    username: z.ZodString;
    password: z.ZodString;
}, z.core.$strip>;
export declare const changePasswordSchema: z.ZodObject<{
    currentPassword: z.ZodString;
    newPassword: z.ZodString;
}, z.core.$strip>;
export declare const userRoleSchema: z.ZodEnum<{
    administrator: "administrator";
    operator: "operator";
    viewer: "viewer";
    diagnostic: "diagnostic";
}>;
export declare const createUserSchema: z.ZodObject<{
    username: z.ZodString;
    password: z.ZodString;
    role: z.ZodEnum<{
        administrator: "administrator";
        operator: "operator";
        viewer: "viewer";
        diagnostic: "diagnostic";
    }>;
    enabled: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
export declare const updateUserSchema: z.ZodObject<{
    username: z.ZodOptional<z.ZodString>;
    role: z.ZodOptional<z.ZodEnum<{
        administrator: "administrator";
        operator: "operator";
        viewer: "viewer";
        diagnostic: "diagnostic";
    }>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export declare const resetUserPasswordSchema: z.ZodObject<{
    password: z.ZodString;
}, z.core.$strict>;
export declare const customerProfileSchema: z.ZodObject<{
    companyName: z.ZodString;
    customerCode: z.ZodString;
    contactPerson: z.ZodString;
    contactEmail: z.ZodString;
    contactPhone: z.ZodString;
    siteName: z.ZodString;
    siteAddress: z.ZodString;
    notes: z.ZodString;
}, z.core.$strict>;
export declare const activityQuerySchema: z.ZodObject<{
    page: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    pageSize: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    level: z.ZodOptional<z.ZodEnum<{
        error: "error";
        info: "info";
        warning: "warning";
    }>>;
    category: z.ZodOptional<z.ZodEnum<{
        audit: "audit";
        device: "device";
        system: "system";
    }>>;
    search: z.ZodOptional<z.ZodString>;
    from: z.ZodOptional<z.ZodISODateTime>;
    to: z.ZodOptional<z.ZodISODateTime>;
}, z.core.$strip>;
export declare const dataServerSettingsSchema: z.ZodObject<{
    modbus: z.ZodObject<{
        enabled: z.ZodBoolean;
        bindAddress: z.ZodString;
        port: z.ZodCoercedNumber<unknown>;
        refreshIntervalMs: z.ZodCoercedNumber<unknown>;
        mappings: z.ZodArray<z.ZodObject<{
            deviceId: z.ZodString;
            enabled: z.ZodBoolean;
            unitId: z.ZodCoercedNumber<unknown>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    opcUa: z.ZodObject<{
        enabled: z.ZodBoolean;
        bindAddress: z.ZodString;
        advertisedHost: z.ZodString;
        port: z.ZodCoercedNumber<unknown>;
        endpointPath: z.ZodString;
        allowAnonymous: z.ZodBoolean;
        refreshIntervalMs: z.ZodCoercedNumber<unknown>;
        publications: z.ZodArray<z.ZodObject<{
            deviceId: z.ZodString;
            enabled: z.ZodBoolean;
        }, z.core.$strict>>;
    }, z.core.$strict>;
}, z.core.$strict>;
export declare const postgresSettingsSchema: z.ZodObject<{
    enabled: z.ZodBoolean;
    host: z.ZodString;
    port: z.ZodCoercedNumber<unknown>;
    database: z.ZodUnion<[z.ZodString, z.ZodLiteral<"">]>;
    username: z.ZodUnion<[z.ZodString, z.ZodLiteral<"">]>;
    password: z.ZodOptional<z.ZodString>;
    sslMode: z.ZodEnum<{
        disable: "disable";
        require: "require";
        "verify-full": "verify-full";
    }>;
    historianTimezone: z.ZodDefault<z.ZodString>;
    autoDownsampleEnabled: z.ZodBoolean;
    defaultRawTable: z.ZodString;
    defaultDownsampleTable: z.ZodString;
    defaultDownsampleIntervalSec: z.ZodCoercedNumber<unknown>;
    rawRetentionDays: z.ZodCoercedNumber<unknown>;
    downsampleRetentionDays: z.ZodCoercedNumber<unknown>;
    maintenanceIntervalHours: z.ZodCoercedNumber<unknown>;
    offlineCacheEnabled: z.ZodDefault<z.ZodBoolean>;
    offlineCacheMaxRows: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
}, z.core.$strip>;
export declare const deviceSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    protocol: z.ZodLiteral<"tcp">;
    tcpHost: z.ZodString;
    tcpPort: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    name: z.ZodString;
    unitId: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    pollIntervalMs: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    readBlockSize: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    timeoutMs: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    retries: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    categoryId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    groupId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    postgresEnabled: z.ZodDefault<z.ZodBoolean>;
    saveIntervalMs: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    postgresRawTable: z.ZodDefault<z.ZodString>;
    postgresDownsampleTable: z.ZodDefault<z.ZodString>;
    postgresDownsampleEnabled: z.ZodDefault<z.ZodBoolean>;
    postgresDownsampleIntervalSec: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    postgresRawRetentionDays: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    postgresDownsampleRetentionDays: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    postgresMaintenanceIntervalHours: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    enabled: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>, z.ZodObject<{
    protocol: z.ZodLiteral<"rtu">;
    serialPort: z.ZodString;
    baudRate: z.ZodCoercedNumber<unknown>;
    parity: z.ZodDefault<z.ZodEnum<{
        none: "none";
        even: "even";
        odd: "odd";
    }>>;
    dataBits: z.ZodDefault<z.ZodUnion<readonly [z.ZodLiteral<7>, z.ZodLiteral<8>]>>;
    stopBits: z.ZodDefault<z.ZodUnion<readonly [z.ZodLiteral<1>, z.ZodLiteral<2>]>>;
    name: z.ZodString;
    unitId: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    pollIntervalMs: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    readBlockSize: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    timeoutMs: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    retries: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    categoryId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    groupId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    postgresEnabled: z.ZodDefault<z.ZodBoolean>;
    saveIntervalMs: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    postgresRawTable: z.ZodDefault<z.ZodString>;
    postgresDownsampleTable: z.ZodDefault<z.ZodString>;
    postgresDownsampleEnabled: z.ZodDefault<z.ZodBoolean>;
    postgresDownsampleIntervalSec: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    postgresRawRetentionDays: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    postgresDownsampleRetentionDays: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    postgresMaintenanceIntervalHours: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    enabled: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>], "protocol">;
export declare const registerSchema: z.ZodObject<{
    name: z.ZodString;
    historianColumn: z.ZodOptional<z.ZodString>;
    address: z.ZodCoercedNumber<unknown>;
    functionCode: z.ZodUnion<readonly [z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>, z.ZodLiteral<4>]>;
    dataType: z.ZodEnum<{
        bool: "bool";
        uint16: "uint16";
        int16: "int16";
        uint32: "uint32";
        int32: "int32";
        float32: "float32";
        float64: "float64";
    }>;
    byteOrder: z.ZodDefault<z.ZodEnum<{
        ABCD: "ABCD";
        BADC: "BADC";
        CDAB: "CDAB";
        DCBA: "DCBA";
    }>>;
    scale: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    offset: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    unit: z.ZodDefault<z.ZodString>;
    decimalPlaces: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    enabled: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export declare const registerImportSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        historianColumn: z.ZodOptional<z.ZodString>;
        address: z.ZodCoercedNumber<unknown>;
        functionCode: z.ZodUnion<readonly [z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>, z.ZodLiteral<4>]>;
        dataType: z.ZodEnum<{
            bool: "bool";
            uint16: "uint16";
            int16: "int16";
            uint32: "uint32";
            int32: "int32";
            float32: "float32";
            float64: "float64";
        }>;
        byteOrder: z.ZodDefault<z.ZodEnum<{
            ABCD: "ABCD";
            BADC: "BADC";
            CDAB: "CDAB";
            DCBA: "DCBA";
        }>>;
        scale: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
        offset: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
        unit: z.ZodDefault<z.ZodString>;
        decimalPlaces: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
        enabled: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const historianSchemaSyncSchema: z.ZodObject<{
    dropRemoved: z.ZodDefault<z.ZodBoolean>;
    expectedOrphanedColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export declare const deviceClassificationSchema: z.ZodObject<{
    name: z.ZodString;
}, z.core.$strip>;
export declare const alarmRuleSchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodString>;
    name: z.ZodString;
    severity: z.ZodEnum<{
        warning: "warning";
        critical: "critical";
    }>;
    condition: z.ZodEnum<{
        above: "above";
        below: "below";
        inside: "inside";
        outside: "outside";
        hi: "hi";
        lo: "lo";
        hii: "hii";
        lolo: "lolo";
    }>;
    thresholdHigh: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    thresholdLow: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    deadband: z.ZodDefault<z.ZodNumber>;
    enabled: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export declare const readingsQuerySchema: z.ZodObject<{
    registerId: z.ZodOptional<z.ZodString>;
    deviceId: z.ZodOptional<z.ZodString>;
    categoryId: z.ZodOptional<z.ZodString>;
    groupId: z.ZodOptional<z.ZodString>;
    from: z.ZodOptional<z.ZodISODateTime>;
    to: z.ZodOptional<z.ZodISODateTime>;
    limit: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
}, z.core.$strip>;
export declare const alarmsQuerySchema: z.ZodObject<{
    activeOnly: z.ZodDefault<z.ZodPipe<z.ZodUnion<readonly [z.ZodBoolean, z.ZodEnum<{
        true: "true";
        false: "false";
    }>]>, z.ZodTransform<boolean, boolean | "true" | "false">>>;
    limit: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
}, z.core.$strip>;
export declare const alarmGroupSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const alarmGroupRuleSchema: z.ZodObject<{
    name: z.ZodString;
    severity: z.ZodEnum<{
        warning: "warning";
        critical: "critical";
    }>;
    condition: z.ZodEnum<{
        above: "above";
        below: "below";
        outside: "outside";
        hi: "hi";
        lo: "lo";
        hii: "hii";
        lolo: "lolo";
    }>;
    thresholdHi: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    thresholdLo: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    deadband: z.ZodDefault<z.ZodNumber>;
    enabled: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export declare const alarmGroupMemberSchema: z.ZodObject<{
    registerId: z.ZodString;
    weight: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export declare const alarmCategoryRuleSchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodString>;
    name: z.ZodString;
    severity: z.ZodEnum<{
        warning: "warning";
        critical: "critical";
    }>;
    condition: z.ZodEnum<{
        above: "above";
        below: "below";
        inside: "inside";
        outside: "outside";
        hi: "hi";
        lo: "lo";
        hii: "hii";
        lolo: "lolo";
    }>;
    thresholdHigh: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    thresholdLow: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    aggregationType: z.ZodDefault<z.ZodEnum<{
        sum: "sum";
        avg: "avg";
        min: "min";
        max: "max";
    }>>;
    deadband: z.ZodDefault<z.ZodNumber>;
    enabled: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export declare const systemAlertsQuerySchema: z.ZodObject<{
    activeOnly: z.ZodDefault<z.ZodPipe<z.ZodUnion<readonly [z.ZodBoolean, z.ZodEnum<{
        true: "true";
        false: "false";
    }>]>, z.ZodTransform<boolean, boolean | "true" | "false">>>;
    limit: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
}, z.core.$strip>;
export declare const whatsAppAlertSettingsSchema: z.ZodObject<{
    enabled: z.ZodBoolean;
    recipients: z.ZodDefault<z.ZodArray<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>>;
    graphApiVersion: z.ZodDefault<z.ZodString>;
    phoneNumberId: z.ZodString;
    templateName: z.ZodString;
    language: z.ZodDefault<z.ZodString>;
    sendRecovery: z.ZodDefault<z.ZodBoolean>;
    offlineDelaySeconds: z.ZodDefault<z.ZodCoercedNumber<unknown>>;
    accessToken: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const idParamsSchema: z.ZodObject<{
    id: z.ZodString;
}, z.core.$strip>;
export declare const categoryIdParamsSchema: z.ZodObject<{
    categoryId: z.ZodString;
}, z.core.$strip>;
export declare const ruleIdParamsSchema: z.ZodObject<{
    ruleId: z.ZodString;
}, z.core.$strip>;
