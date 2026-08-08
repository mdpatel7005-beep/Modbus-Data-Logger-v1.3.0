import { isIP } from "node:net";
import { z } from "zod";
export const loginSchema = z.object({
    username: z.string().trim().min(3).max(100),
    password: z.string().min(1).max(200),
});
export const changePasswordSchema = z.object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(1).max(200),
});
export const userRoleSchema = z.enum([
    "administrator",
    "operator",
    "viewer",
    "diagnostic",
]);
const managedUsernameSchema = z.string().trim().min(3).max(100);
export const createUserSchema = z
    .object({
    username: managedUsernameSchema,
    password: z.string().min(1).max(200),
    role: userRoleSchema,
    enabled: z.boolean().default(true),
})
    .strict();
export const updateUserSchema = z
    .object({
    username: managedUsernameSchema.optional(),
    role: userRoleSchema.optional(),
    enabled: z.boolean().optional(),
})
    .strict()
    .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one user field to update",
});
export const resetUserPasswordSchema = z
    .object({
    password: z.string().min(1).max(200),
})
    .strict();
export const customerProfileSchema = z
    .object({
    companyName: z.string().trim().max(200),
    customerCode: z
        .string()
        .trim()
        .max(64)
        .refine((value) => value === "" || /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value), "Customer code may use letters, numbers, dot, underscore, slash, and hyphen"),
    contactPerson: z.string().trim().max(160),
    contactEmail: z
        .string()
        .trim()
        .max(254)
        .refine((value) => value === "" || z.email().safeParse(value).success, "Enter a valid contact email address"),
    contactPhone: z
        .string()
        .trim()
        .max(50)
        .refine((value) => value === "" || /^\+?[0-9 ()-]{5,50}$/.test(value), "Enter a valid contact phone number"),
    siteName: z.string().trim().max(200),
    siteAddress: z.string().trim().max(1_000),
    notes: z.string().trim().max(4_000),
})
    .strict();
export const activityQuerySchema = z
    .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(250).default(50),
    level: z.enum(["info", "warning", "error"]).optional(),
    category: z.enum(["audit", "device", "system"]).optional(),
    search: z.string().trim().min(1).max(200).optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
})
    .refine((value) => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), {
    message: "The activity start time must be before the end time",
    path: ["from"],
});
const bindAddressSchema = z
    .string()
    .trim()
    .min(1)
    .max(253)
    .refine((value) => value === "localhost" || isIP(value) !== 0, "Use a local IP address, localhost, or 0.0.0.0 for all interfaces");
const advertisedHostSchema = z
    .string()
    .trim()
    .min(1)
    .max(253)
    .refine((value) => value !== "0.0.0.0" &&
    value !== "::" &&
    (isIP(value) !== 0 ||
        /^(?=.{1,253}$)(?!-)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(value)), "Use the hostname or IP address that OPC UA clients will connect to");
const dataServerDeviceMappingSchema = z
    .object({
    deviceId: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
    unitId: z.coerce.number().int().min(1).max(247),
})
    .strict();
const opcUaDevicePublicationSchema = z
    .object({
    deviceId: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
})
    .strict();
export const dataServerSettingsSchema = z
    .object({
    modbus: z
        .object({
        enabled: z.boolean(),
        bindAddress: bindAddressSchema,
        port: z.coerce.number().int().min(1).max(65_535),
        refreshIntervalMs: z.coerce
            .number()
            .int()
            .min(100)
            .max(60_000),
        mappings: z.array(dataServerDeviceMappingSchema).max(1_000),
    })
        .strict(),
    opcUa: z
        .object({
        enabled: z.boolean(),
        bindAddress: bindAddressSchema,
        advertisedHost: advertisedHostSchema,
        port: z.coerce.number().int().min(1).max(65_535),
        endpointPath: z
            .string()
            .trim()
            .min(1)
            .max(128)
            .regex(/^\/[A-Za-z0-9._~/-]*$/, "Use an OPC UA endpoint path beginning with /")
            .refine((value) => !value.includes("//") && !value.includes(".."), "Endpoint path cannot contain // or .."),
        allowAnonymous: z.boolean(),
        refreshIntervalMs: z.coerce
            .number()
            .int()
            .min(100)
            .max(60_000),
        publications: z.array(opcUaDevicePublicationSchema).max(1_000),
    })
        .strict(),
})
    .strict()
    .superRefine((value, context) => {
    const mappingDevices = new Set();
    const enabledUnitIds = new Set();
    for (const [index, mapping] of value.modbus.mappings.entries()) {
        if (mappingDevices.has(mapping.deviceId)) {
            context.addIssue({
                code: "custom",
                path: ["modbus", "mappings", index, "deviceId"],
                message: "Each device can have only one Modbus mapping",
            });
        }
        mappingDevices.add(mapping.deviceId);
        if (mapping.enabled && enabledUnitIds.has(mapping.unitId)) {
            context.addIssue({
                code: "custom",
                path: ["modbus", "mappings", index, "unitId"],
                message: "Every enabled Modbus device needs a unique unit ID",
            });
        }
        if (mapping.enabled)
            enabledUnitIds.add(mapping.unitId);
    }
    const publishedDevices = new Set();
    for (const [index, publication] of value.opcUa.publications.entries()) {
        if (publishedDevices.has(publication.deviceId)) {
            context.addIssue({
                code: "custom",
                path: ["opcUa", "publications", index, "deviceId"],
                message: "Each device can have only one OPC UA publication setting",
            });
        }
        publishedDevices.add(publication.deviceId);
    }
    if (value.modbus.enabled &&
        !value.modbus.mappings.some((mapping) => mapping.enabled)) {
        context.addIssue({
            code: "custom",
            path: ["modbus", "mappings"],
            message: "Select at least one device before enabling Modbus TCP",
        });
    }
    if (value.opcUa.enabled &&
        !value.opcUa.publications.some((publication) => publication.enabled)) {
        context.addIssue({
            code: "custom",
            path: ["opcUa", "publications"],
            message: "Select at least one device before enabling OPC UA",
        });
    }
    if (value.modbus.enabled &&
        value.opcUa.enabled &&
        value.modbus.port === value.opcUa.port) {
        context.addIssue({
            code: "custom",
            path: ["opcUa", "port"],
            message: "Modbus TCP and OPC UA must use different TCP ports",
        });
    }
});
const postgresTableNameSchema = z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{0,62}$/, "Use a lowercase PostgreSQL table name");
const postgresIdentifierSchema = z
    .string()
    .trim()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, "Use a valid PostgreSQL identifier");
const timeZoneSchema = z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((value) => {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
        return true;
    }
    catch {
        return false;
    }
}, "Use a valid IANA timezone such as UTC or Asia/Kolkata");
export const postgresSettingsSchema = z
    .object({
    enabled: z.boolean(),
    host: z.string().trim().max(253),
    port: z.coerce.number().int().min(1).max(65535),
    database: postgresIdentifierSchema.or(z.literal("")),
    username: postgresIdentifierSchema.or(z.literal("")),
    password: z.string().max(500).optional(),
    sslMode: z.enum(["disable", "require", "verify-full"]),
    historianTimezone: timeZoneSchema.default("UTC"),
    autoDownsampleEnabled: z.boolean(),
    defaultRawTable: postgresTableNameSchema,
    defaultDownsampleTable: postgresTableNameSchema,
    defaultDownsampleIntervalSec: z.coerce.number().int().min(10).max(86_400),
    rawRetentionDays: z.coerce.number().int().min(0).max(36_500),
    downsampleRetentionDays: z.coerce.number().int().min(0).max(36_500),
    maintenanceIntervalHours: z.coerce.number().int().min(1).max(168),
    offlineCacheEnabled: z.boolean().default(true),
    offlineCacheMaxRows: z.coerce
        .number()
        .int()
        .min(1_000)
        .max(1_000_000)
        .default(100_000),
})
    .superRefine((value, context) => {
    if (value.enabled && (!value.host || !value.database || !value.username)) {
        context.addIssue({
            code: "custom",
            path: ["host"],
            message: "Host, database, and username are required when PostgreSQL is enabled",
        });
    }
    if (value.defaultRawTable === value.defaultDownsampleTable) {
        context.addIssue({
            code: "custom",
            path: ["defaultDownsampleTable"],
            message: "Raw and downsample table names must be different",
        });
    }
});
const commonDeviceFields = {
    name: z.string().trim().min(2).max(120),
    unitId: z.coerce.number().int().min(0).max(255).default(1),
    pollIntervalMs: z.coerce.number().int().min(100).max(3_600_000).default(1000),
    readBlockSize: z.coerce.number().int().min(1).max(125).default(120),
    timeoutMs: z.coerce.number().int().min(100).max(60_000).default(2000),
    retries: z.coerce.number().int().min(0).max(10).default(2),
    categoryId: z.string().trim().min(1).max(100).nullable().default(null),
    groupId: z.string().trim().min(1).max(100).nullable().default(null),
    postgresEnabled: z.boolean().default(false),
    saveIntervalMs: z.coerce
        .number()
        .int()
        .min(100)
        .max(86_400_000)
        .default(1000),
    postgresRawTable: postgresTableNameSchema.default("modbus_raw"),
    postgresDownsampleTable: postgresTableNameSchema.default("modbus_1m"),
    postgresDownsampleEnabled: z.boolean().default(true),
    postgresDownsampleIntervalSec: z.coerce
        .number()
        .int()
        .min(10)
        .max(86_400)
        .default(60),
    postgresRawRetentionDays: z.coerce
        .number()
        .int()
        .min(0)
        .max(36_500)
        .default(30),
    postgresDownsampleRetentionDays: z.coerce
        .number()
        .int()
        .min(0)
        .max(36_500)
        .default(365),
    postgresMaintenanceIntervalHours: z.coerce
        .number()
        .int()
        .min(1)
        .max(168)
        .default(24),
    enabled: z.boolean().default(true),
};
export const deviceSchema = z
    .discriminatedUnion("protocol", [
    z.object({
        ...commonDeviceFields,
        protocol: z.literal("tcp"),
        tcpHost: z.string().trim().min(1).max(253),
        tcpPort: z.coerce.number().int().min(1).max(65535).default(502),
    }),
    z.object({
        ...commonDeviceFields,
        protocol: z.literal("rtu"),
        serialPort: z.string().trim().min(1).max(260),
        baudRate: z.coerce
            .number()
            .int()
            .refine((value) => [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].includes(value), "Unsupported baud rate"),
        parity: z.enum(["none", "even", "odd"]).default("none"),
        dataBits: z.union([z.literal(7), z.literal(8)]).default(8),
        stopBits: z.union([z.literal(1), z.literal(2)]).default(1),
    }),
])
    .refine((value) => value.saveIntervalMs >= value.pollIntervalMs, {
    message: "Database save interval must be equal to or longer than the polling interval",
    path: ["saveIntervalMs"],
})
    .refine((value) => value.postgresRawTable !== value.postgresDownsampleTable, {
    message: "Raw and downsample table names must be different",
    path: ["postgresDownsampleTable"],
})
    .refine((value) => !value.postgresEnabled ||
    !value.postgresDownsampleEnabled ||
    value.postgresDownsampleIntervalSec * 1000 >= value.saveIntervalMs, {
    message: "Downsample interval must be equal to or longer than the save interval",
    path: ["postgresDownsampleIntervalSec"],
});
export const registerSchema = z
    .object({
    name: z.string().trim().min(1).max(120),
    historianColumn: z
        .string()
        .trim()
        .min(1)
        .max(63)
        .regex(/^[a-z][a-z0-9_]*$/, "Use lowercase letters, numbers, and underscores, starting with a letter")
        .refine((value) => value !== "timestamp", {
        message: "timestamp is reserved for the historian time column",
    })
        .optional(),
    address: z.coerce.number().int().min(0).max(65535),
    functionCode: z.union([
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
    ]),
    dataType: z.enum([
        "bool",
        "uint16",
        "int16",
        "uint32",
        "int32",
        "float32",
        "float64",
    ]),
    byteOrder: z.enum(["ABCD", "BADC", "CDAB", "DCBA"]).default("ABCD"),
    scale: z.coerce.number().finite().default(1),
    offset: z.coerce.number().finite().default(0),
    unit: z.string().trim().max(32).default(""),
    decimalPlaces: z.coerce.number().int().min(0).max(10).default(2),
    enabled: z.boolean().default(true),
})
    .superRefine((value, context) => {
    if ((value.functionCode === 1 || value.functionCode === 2) &&
        value.dataType !== "bool") {
        context.addIssue({
            code: "custom",
            path: ["dataType"],
            message: "Coils and discrete inputs must use the bool data type",
        });
    }
    const width = value.functionCode === 1 || value.functionCode === 2
        ? 1
        : value.dataType === "float64"
            ? 4
            : ["uint32", "int32", "float32"].includes(value.dataType)
                ? 2
                : 1;
    if (value.address + width > 65_536) {
        context.addIssue({
            code: "custom",
            path: ["address"],
            message: `${value.dataType} exceeds the Modbus address range at this starting address`,
        });
    }
});
export const registerImportSchema = z
    .object({
    items: z.array(registerSchema).min(1).max(1_500),
})
    .superRefine((value, context) => {
    const names = new Map();
    const columns = new Map();
    value.items.forEach((item, index) => {
        const name = item.name.toLocaleLowerCase();
        const previousName = names.get(name);
        if (previousName !== undefined) {
            context.addIssue({
                code: "custom",
                path: ["items", index, "name"],
                message: `Tag name duplicates item ${previousName + 1}`,
            });
        }
        else {
            names.set(name, index);
        }
        if (item.historianColumn) {
            const previousColumn = columns.get(item.historianColumn);
            if (previousColumn !== undefined) {
                context.addIssue({
                    code: "custom",
                    path: ["items", index, "historianColumn"],
                    message: `Historian column duplicates item ${previousColumn + 1}`,
                });
            }
            else {
                columns.set(item.historianColumn, index);
            }
        }
    });
});
export const historianSchemaSyncSchema = z.object({
    dropRemoved: z.boolean().default(false),
    expectedOrphanedColumns: z
        .array(z.string().trim().min(1).max(255))
        .max(1_500)
        .optional(),
});
export const deviceClassificationSchema = z.object({
    name: z.string().trim().min(1).max(120),
});
export const alarmRuleSchema = z
    .object({
    id: z.string().optional(),
    name: z.string().trim().min(2).max(120),
    severity: z.enum(["warning", "critical"]),
    condition: z.enum(["above", "below", "inside", "outside", "hi", "lo", "hii", "lolo"]),
    thresholdHigh: z.number().finite().nullable().default(null),
    thresholdLow: z.number().finite().nullable().default(null),
    deadband: z.number().finite().min(0).default(0),
    enabled: z.boolean().default(true),
})
    .superRefine((value, context) => {
    if ((value.condition === "above" ||
        value.condition === "hi" ||
        value.condition === "hii" ||
        value.condition === "outside") &&
        value.thresholdHigh === null) {
        context.addIssue({
            code: "custom",
            path: ["thresholdHigh"],
            message: "A high threshold is required",
        });
    }
    if ((value.condition === "below" ||
        value.condition === "lo" ||
        value.condition === "lolo" ||
        value.condition === "outside") &&
        value.thresholdLow === null) {
        context.addIssue({
            code: "custom",
            path: ["thresholdLow"],
            message: "A low threshold is required",
        });
    }
    if (value.condition === "inside" &&
        (value.thresholdHigh === null || value.thresholdLow === null)) {
        context.addIssue({
            code: "custom",
            path: ["thresholdHigh"],
            message: "Both high and low thresholds are required for inside range",
        });
        if (value.thresholdLow === null) {
            context.addIssue({
                code: "custom",
                path: ["thresholdLow"],
                message: "Both high and low thresholds are required for inside range",
            });
        }
    }
    if (value.thresholdHigh !== null &&
        value.thresholdLow !== null &&
        value.thresholdLow >= value.thresholdHigh) {
        context.addIssue({
            code: "custom",
            path: ["thresholdLow"],
            message: "Low threshold must be below high threshold",
        });
    }
});
export const readingsQuerySchema = z.object({
    registerId: z.string().optional(),
    deviceId: z.string().optional(),
    categoryId: z.string().optional(),
    groupId: z.string().optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    limit: z.coerce.number().int().min(1).max(50_000).default(1000),
});
export const alarmsQuerySchema = z.object({
    activeOnly: z
        .union([z.boolean(), z.enum(["true", "false"])])
        .transform((value) => value === true || value === "true")
        .default(false),
    limit: z.coerce.number().int().min(1).max(5000).default(250),
});
// Alarm Group schemas
export const alarmGroupSchema = z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().optional(),
});
export const alarmGroupRuleSchema = z
    .object({
    name: z.string().trim().min(2).max(120),
    severity: z.enum(["warning", "critical"]),
    condition: z.enum(["hi", "lo", "hii", "lolo", "above", "below", "outside"]),
    thresholdHi: z.number().finite().nullable().default(null),
    thresholdLo: z.number().finite().nullable().default(null),
    deadband: z.number().finite().min(0).default(0),
    enabled: z.boolean().default(true),
})
    .superRefine((value, context) => {
    if ((value.condition === "above" || value.condition === "outside") &&
        value.thresholdHi === null) {
        context.addIssue({
            code: "custom",
            path: ["thresholdHi"],
            message: "A high threshold is required for this condition",
        });
    }
    if ((value.condition === "below" || value.condition === "outside") &&
        value.thresholdLo === null) {
        context.addIssue({
            code: "custom",
            path: ["thresholdLo"],
            message: "A low threshold is required for this condition",
        });
    }
});
export const alarmGroupMemberSchema = z.object({
    registerId: z.string().trim().min(1),
    weight: z.number().finite().min(0).default(1),
});
// Alarm Category schemas
export const alarmCategoryRuleSchema = z.object({
    id: z.string().optional(),
    name: z.string().trim().min(2).max(120),
    severity: z.enum(["warning", "critical"]),
    condition: z.enum(["above", "below", "inside", "outside", "hi", "lo", "hii", "lolo"]),
    thresholdHigh: z.number().finite().nullable().default(null),
    thresholdLow: z.number().finite().nullable().default(null),
    aggregationType: z.enum(["sum", "avg", "min", "max"]).default("sum"),
    deadband: z.number().finite().min(0).default(0),
    enabled: z.boolean().default(true),
})
    .superRefine((value, context) => {
    if ((value.condition === "above" ||
        value.condition === "hi" ||
        value.condition === "hii" ||
        value.condition === "outside") &&
        value.thresholdHigh === null) {
        context.addIssue({
            code: "custom",
            path: ["thresholdHigh"],
            message: "A high threshold is required for this condition",
        });
    }
    if ((value.condition === "below" ||
        value.condition === "lo" ||
        value.condition === "lolo" ||
        value.condition === "outside") &&
        value.thresholdLow === null) {
        context.addIssue({
            code: "custom",
            path: ["thresholdLow"],
            message: "A low threshold is required for this condition",
        });
    }
    if (value.condition === "inside" &&
        (value.thresholdHigh === null || value.thresholdLow === null)) {
        context.addIssue({
            code: "custom",
            path: ["thresholdHigh"],
            message: "Both high and low thresholds are required for inside range",
        });
        if (value.thresholdLow === null) {
            context.addIssue({
                code: "custom",
                path: ["thresholdLow"],
                message: "Both high and low thresholds are required for inside range",
            });
        }
    }
    if (value.thresholdHigh !== null &&
        value.thresholdLow !== null &&
        value.thresholdLow >= value.thresholdHigh) {
        context.addIssue({
            code: "custom",
            path: ["thresholdLow"],
            message: "Low threshold must be below high threshold",
        });
    }
});
export const systemAlertsQuerySchema = z.object({
    activeOnly: z
        .union([z.boolean(), z.enum(["true", "false"])])
        .transform((value) => value === true || value === "true")
        .default(false),
    limit: z.coerce.number().int().min(1).max(1000).default(250),
});
const whatsAppRecipientSchema = z
    .string()
    .trim()
    .regex(/^\+?[1-9]\d{7,14}$/, "Use an international WhatsApp number, for example 919876543210")
    .transform((value) => value.replace(/^\+/, ""));
export const whatsAppAlertSettingsSchema = z
    .object({
    enabled: z.boolean(),
    recipients: z.array(whatsAppRecipientSchema).max(25).default([]),
    graphApiVersion: z
        .string()
        .trim()
        .regex(/^v\d{1,2}\.\d{1,2}$/, "Use a Graph API version such as v23.0")
        .default("v23.0"),
    phoneNumberId: z
        .string()
        .trim()
        .regex(/^\d*$/, "Phone number ID must contain digits only")
        .max(40),
    templateName: z
        .string()
        .trim()
        .regex(/^[a-z0-9_]*$/, "Template name must use lowercase letters, numbers, and underscores")
        .max(512),
    language: z
        .string()
        .trim()
        .regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/, "Use a language code such as en_US")
        .default("en_US"),
    sendRecovery: z.boolean().default(true),
    offlineDelaySeconds: z.coerce.number().int().min(0).max(86_400).default(60),
    accessToken: z.string().trim().max(4096).optional(),
})
    .superRefine((value, context) => {
    if (value.enabled && value.recipients.length === 0) {
        context.addIssue({
            code: "custom",
            path: ["recipients"],
            message: "At least one WhatsApp recipient is required",
        });
    }
    if (value.enabled && !value.phoneNumberId) {
        context.addIssue({
            code: "custom",
            path: ["phoneNumberId"],
            message: "A Meta WhatsApp phone number ID is required",
        });
    }
    if (value.enabled && !value.templateName) {
        context.addIssue({
            code: "custom",
            path: ["templateName"],
            message: "An approved Meta template name is required",
        });
    }
});
export const idParamsSchema = z.object({
    id: z.string().min(5).max(100),
});
export const categoryIdParamsSchema = z.object({
    categoryId: z.string().trim().min(5).max(100),
});
export const ruleIdParamsSchema = z.object({
    ruleId: z.string().trim().min(5).max(100),
});
//# sourceMappingURL=schemas.js.map