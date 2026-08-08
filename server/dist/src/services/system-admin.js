import { accessSync, chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { z } from "zod";
import { env } from "../config/env.js";
import { decryptSecret, encryptSecret } from "./secret-box.js";
const BACKUP_PREFIX = "modbus-data-logger-backup.v1.";
const UPDATE_MAX_BYTES = 100 * 1024 * 1024;
const VPN_MAX_BYTES = 1024 * 1024;
const BACKUP_MAX_TEXT_LENGTH = 128 * 1024 * 1024;
const BACKUP_MAX_JSON_BYTES = 90 * 1024 * 1024;
const HELPER_TIMEOUT_MS = 30_000;
const BACKUP_RECORD_LIMITS = {
    customer_profile: 1,
    device_categories: 1_000,
    device_groups: 1_000,
    devices: 2_000,
    registers: 50_000,
    alarm_rules: 50_000,
    data_server_settings: 1,
    data_server_device_exports: 2_000,
};
const idSchema = z.string().min(1).max(160);
const storedTextSchema = z.string().max(10_000);
const timestampSchema = z
    .string()
    .min(1)
    .max(100)
    .refine((value) => Number.isFinite(Date.parse(value)), "Invalid timestamp");
const nullableTimestampSchema = timestampSchema.nullable();
const sqliteBooleanSchema = z.union([z.literal(0), z.literal(1)]);
const postgresTableSchema = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const postgresIdentifierSchema = z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/);
const optionalPostgresIdentifierSchema = postgresIdentifierSchema.or(z.literal(""));
const timeZoneSchema = z
    .string()
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
}, "Invalid IANA timezone");
const classificationRowSchema = z
    .object({
    id: idSchema,
    name: z.string().min(1).max(120),
    created_at: timestampSchema,
    updated_at: timestampSchema,
})
    .strict();
const customerProfileRowSchema = z
    .object({
    id: z.literal(1),
    company_name: z.string().max(200),
    customer_code: z.string().max(64),
    contact_person: z.string().max(160),
    contact_email: z.string().max(254),
    contact_phone: z.string().max(50),
    site_name: z.string().max(200),
    site_address: z.string().max(1_000),
    notes: z.string().max(4_000),
    updated_at: timestampSchema,
})
    .strict();
const deviceRowSchema = z
    .object({
    id: idSchema,
    name: z.string().min(2).max(120),
    protocol: z.enum(["tcp", "rtu"]),
    tcp_host: z.string().min(1).max(253).nullable(),
    tcp_port: z.number().int().min(1).max(65_535).nullable(),
    serial_port: z.string().min(1).max(260).nullable(),
    baud_rate: z
        .number()
        .int()
        .refine((value) => [1200, 2400, 4800, 9600, 19_200, 38_400, 57_600, 115_200].includes(value))
        .nullable(),
    parity: z.enum(["none", "even", "odd"]).nullable(),
    data_bits: z.union([z.literal(7), z.literal(8)]).nullable(),
    stop_bits: z.union([z.literal(1), z.literal(2)]).nullable(),
    unit_id: z.number().int().min(0).max(255),
    poll_interval_ms: z.number().int().min(100).max(3_600_000),
    read_block_size: z.number().int().min(1).max(125),
    timeout_ms: z.number().int().min(100).max(60_000),
    retries: z.number().int().min(0).max(10),
    category_id: idSchema.nullable(),
    group_id: idSchema.nullable(),
    postgres_enabled: sqliteBooleanSchema,
    save_interval_ms: z.number().int().min(100).max(86_400_000),
    postgres_raw_table: postgresTableSchema,
    postgres_downsample_table: postgresTableSchema,
    postgres_downsample_enabled: sqliteBooleanSchema,
    postgres_downsample_interval_sec: z.number().int().min(10).max(86_400),
    postgres_raw_retention_days: z.number().int().min(0).max(36_500),
    postgres_downsample_retention_days: z.number().int().min(0).max(36_500),
    postgres_maintenance_interval_hours: z.number().int().min(1).max(168),
    postgres_last_maintenance_at: nullableTimestampSchema,
    postgres_schema_synced_at: nullableTimestampSchema,
    postgres_schema_dirty: sqliteBooleanSchema,
    postgres_schema_revision: z.number().int().min(0),
    enabled: sqliteBooleanSchema,
    status: z.enum(["online", "warning", "offline", "disabled"]),
    last_seen_at: nullableTimestampSchema,
    last_error: storedTextSchema.nullable(),
    last_poll_ms: z.number().int().min(0).nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
})
    .strict()
    .superRefine((row, context) => {
    if (row.protocol === "tcp" &&
        (row.tcp_host === null || row.tcp_port === null)) {
        context.addIssue({
            code: "custom",
            message: "TCP devices require a host and port",
        });
    }
    if (row.protocol === "tcp" &&
        (row.serial_port !== null ||
            row.baud_rate !== null ||
            row.parity !== null ||
            row.data_bits !== null ||
            row.stop_bits !== null)) {
        context.addIssue({
            code: "custom",
            message: "TCP devices cannot contain serial settings",
        });
    }
    if (row.protocol === "rtu" &&
        (row.serial_port === null ||
            row.baud_rate === null ||
            row.parity === null ||
            row.data_bits === null ||
            row.stop_bits === null)) {
        context.addIssue({
            code: "custom",
            message: "RTU devices require complete serial settings",
        });
    }
    if (row.protocol === "rtu" &&
        (row.tcp_host !== null || row.tcp_port !== null)) {
        context.addIssue({
            code: "custom",
            message: "RTU devices cannot contain TCP settings",
        });
    }
    if (row.postgres_raw_table === row.postgres_downsample_table) {
        context.addIssue({
            code: "custom",
            message: "Historian table names must be different",
        });
    }
    if (row.save_interval_ms < row.poll_interval_ms) {
        context.addIssue({
            code: "custom",
            message: "The database save interval cannot be shorter than the polling interval",
        });
    }
    if (row.postgres_enabled === 1 &&
        row.postgres_downsample_enabled === 1 &&
        row.postgres_downsample_interval_sec * 1000 < row.save_interval_ms) {
        context.addIssue({
            code: "custom",
            message: "The downsample interval cannot be shorter than the database save interval",
        });
    }
});
const registerRowSchema = z
    .object({
    id: idSchema,
    device_id: idSchema,
    name: z.string().min(1).max(120),
    address: z.number().int().min(0).max(65_535),
    function_code: z.union([
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
    ]),
    data_type: z.enum([
        "bool",
        "uint16",
        "int16",
        "uint32",
        "int32",
        "float32",
        "float64",
    ]),
    byte_order: z.enum(["ABCD", "BADC", "CDAB", "DCBA"]),
    scale: z.number().finite(),
    offset: z.number().finite(),
    unit: z.string().max(32),
    postgres_column_name: postgresTableSchema,
    postgres_previous_column_name: postgresTableSchema.nullable().default(null),
    decimal_places: z.number().int().min(0).max(10),
    enabled: sqliteBooleanSchema,
    created_at: timestampSchema,
    updated_at: timestampSchema,
})
    .strict();
const alarmRuleRowSchema = z
    .object({
    id: idSchema,
    register_id: idSchema,
    name: z.string().min(2).max(120),
    severity: z.enum(["warning", "critical"]),
    condition: z.enum(["above", "below", "outside"]),
    threshold_high: z.number().finite().nullable(),
    threshold_low: z.number().finite().nullable(),
    deadband: z.number().finite().min(0),
    enabled: sqliteBooleanSchema,
    created_at: timestampSchema,
    updated_at: timestampSchema,
})
    .strict()
    .superRefine((row, context) => {
    if ((row.condition === "above" && row.threshold_high === null) ||
        (row.condition === "below" && row.threshold_low === null) ||
        (row.condition === "outside" &&
            (row.threshold_low === null || row.threshold_high === null))) {
        context.addIssue({
            code: "custom",
            message: "Alarm thresholds do not match the condition",
        });
    }
    if (row.threshold_low !== null &&
        row.threshold_high !== null &&
        row.threshold_low >= row.threshold_high) {
        context.addIssue({
            code: "custom",
            message: "The low alarm threshold must be below the high threshold",
        });
    }
});
const postgresSettingsRowSchema = z
    .object({
    id: z.literal(1),
    enabled: sqliteBooleanSchema,
    host: z.string().max(253),
    port: z.number().int().min(1).max(65_535),
    database_name: optionalPostgresIdentifierSchema,
    username: optionalPostgresIdentifierSchema,
    password_encrypted: z.string().min(1).max(8192).nullable(),
    ssl_mode: z.enum(["disable", "require", "verify-full"]),
    historian_timezone: timeZoneSchema,
    auto_downsample_enabled: sqliteBooleanSchema,
    default_raw_table: postgresTableSchema,
    default_downsample_table: postgresTableSchema,
    default_downsample_interval_sec: z.number().int().min(10).max(86_400),
    raw_retention_days: z.number().int().min(0).max(36_500),
    downsample_retention_days: z.number().int().min(0).max(36_500),
    maintenance_interval_hours: z.number().int().min(1).max(168),
    offline_cache_enabled: sqliteBooleanSchema,
    offline_cache_max_rows: z.number().int().min(1_000).max(1_000_000),
    last_connection_test_at: nullableTimestampSchema,
    last_connection_test_ok: sqliteBooleanSchema.nullable(),
    last_connection_test_message: storedTextSchema.nullable(),
    last_maintenance_at: nullableTimestampSchema,
    last_maintenance_raw_deleted: z.number().int().min(0),
    last_maintenance_downsample_deleted: z.number().int().min(0),
    last_replay_at: nullableTimestampSchema,
    last_replay_count: z.number().int().min(0),
    updated_at: timestampSchema,
})
    .strict()
    .superRefine((row, context) => {
    if (row.enabled === 1 &&
        (!row.host || !row.database_name || !row.username)) {
        context.addIssue({
            code: "custom",
            message: "Enabled PostgreSQL settings require host, database, and username",
        });
    }
    if (row.default_raw_table === row.default_downsample_table) {
        context.addIssue({
            code: "custom",
            message: "Default PostgreSQL table names must be different",
        });
    }
});
const whatsappAlertSettingsRowSchema = z
    .object({
    id: z.literal(1),
    enabled: sqliteBooleanSchema,
    access_token_encrypted: z.string().min(1).max(8192).nullable(),
    recipients_json: z.string().max(2048),
    graph_api_version: z.string().regex(/^v\d{1,2}\.\d{1,2}$/),
    phone_number_id: z.string().regex(/^\d{0,40}$/),
    template_name: z.string().regex(/^[a-z0-9_]{0,512}$/),
    language: z.string().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/),
    send_recovery: sqliteBooleanSchema,
    offline_delay_seconds: z.number().int().min(0).max(86_400),
    last_test_at: nullableTimestampSchema,
    last_test_ok: sqliteBooleanSchema.nullable(),
    last_test_message: storedTextSchema.nullable(),
    updated_at: timestampSchema,
})
    .strict()
    .superRefine((row, context) => {
    let recipients;
    try {
        recipients = JSON.parse(row.recipients_json);
    }
    catch {
        recipients = null;
    }
    const validRecipients = Array.isArray(recipients) &&
        recipients.length <= 25 &&
        recipients.every((recipient) => typeof recipient === "string" && /^[1-9]\d{7,14}$/.test(recipient));
    if (!validRecipients) {
        context.addIssue({
            code: "custom",
            message: "WhatsApp recipients are invalid",
        });
    }
    if (row.enabled === 1 &&
        (!row.access_token_encrypted ||
            !row.phone_number_id ||
            !row.template_name ||
            !Array.isArray(recipients) ||
            recipients.length === 0)) {
        context.addIssue({
            code: "custom",
            message: "Enabled WhatsApp alert settings are incomplete",
        });
    }
});
const updateStateRowSchema = z
    .object({
    id: z.literal(1),
    staged_version: z.string().max(120).nullable(),
    staged_filename: z.string().max(255).nullable(),
    staged_sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
    staged_at: nullableTimestampSchema,
    last_error: storedTextSchema.nullable(),
})
    .strict();
const openVpnStateRowSchema = z
    .object({
    id: z.literal(1),
    profile_name: z.string().max(255).nullable(),
    enabled: sqliteBooleanSchema,
    last_changed_at: nullableTimestampSchema,
    last_error: storedTextSchema.nullable(),
})
    .strict();
const dataServerBindAddressSchema = z
    .string()
    .min(1)
    .max(253)
    .refine((value) => value === "localhost" || isIP(value) !== 0, "Invalid data-server bind address");
const dataServerAdvertisedHostSchema = z
    .string()
    .min(1)
    .max(253)
    .refine((value) => value !== "0.0.0.0" &&
    value !== "::" &&
    (isIP(value) !== 0 ||
        /^(?=.{1,253}$)(?!-)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(value)), "Invalid OPC UA advertised hostname");
const dataServerSettingsRowSchema = z
    .object({
    id: z.literal(1),
    modbus_enabled: sqliteBooleanSchema,
    modbus_bind_address: dataServerBindAddressSchema,
    modbus_port: z.number().int().min(1).max(65_535),
    modbus_refresh_interval_ms: z.number().int().min(100).max(60_000),
    opcua_enabled: sqliteBooleanSchema,
    opcua_bind_address: dataServerBindAddressSchema,
    opcua_advertised_host: dataServerAdvertisedHostSchema.default("127.0.0.1"),
    opcua_port: z.number().int().min(1).max(65_535),
    opcua_endpoint_path: z
        .string()
        .min(1)
        .max(128)
        .regex(/^\/[A-Za-z0-9._~/-]*$/)
        .refine((value) => !value.includes("//") && !value.includes("..")),
    opcua_allow_anonymous: sqliteBooleanSchema,
    opcua_refresh_interval_ms: z.number().int().min(100).max(60_000),
    updated_at: timestampSchema,
})
    .strict();
const dataServerDeviceExportRowSchema = z
    .object({
    device_id: idSchema,
    modbus_enabled: sqliteBooleanSchema,
    modbus_unit_id: z.number().int().min(1).max(247),
    opcua_enabled: sqliteBooleanSchema,
})
    .strict();
const backupEnvelopeSchema = z
    .object({
    format: z.literal("modbus-data-logger-configuration"),
    version: z.literal(1),
    createdAt: timestampSchema,
    appVersion: z.string().min(1).max(120),
    data: z
        .object({
        customerProfile: z.array(customerProfileRowSchema).length(1).optional(),
        deviceCategories: z.array(classificationRowSchema).max(100_000),
        deviceGroups: z.array(classificationRowSchema).max(100_000),
        devices: z.array(deviceRowSchema).max(100_000),
        registers: z.array(registerRowSchema).max(1_000_000),
        alarmRules: z.array(alarmRuleRowSchema).max(1_000_000),
        postgresSettings: z.array(postgresSettingsRowSchema).max(1),
        whatsappAlertSettings: z
            .array(whatsappAlertSettingsRowSchema)
            .max(1)
            .default([]),
        dataServerSettings: z
            .array(dataServerSettingsRowSchema)
            .max(1)
            .default([]),
        dataServerDeviceExports: z
            .array(dataServerDeviceExportRowSchema)
            .max(100_000)
            .default([]),
        systemUpdate: updateStateRowSchema,
        openVpn: openVpnStateRowSchema,
        openVpnProfileBase64: z
            .string()
            .max(Math.ceil((VPN_MAX_BYTES * 4) / 3) + 8)
            .nullable(),
    })
        .strict(),
})
    .strict();
function defaultDataServerSettings(updatedAt) {
    return {
        id: 1,
        modbus_enabled: 0,
        modbus_bind_address: "127.0.0.1",
        modbus_port: 1502,
        modbus_refresh_interval_ms: 1_000,
        opcua_enabled: 0,
        opcua_bind_address: "127.0.0.1",
        opcua_advertised_host: "127.0.0.1",
        opcua_port: 4_840,
        opcua_endpoint_path: "/ModbusDataLogger",
        opcua_allow_anonymous: 1,
        opcua_refresh_interval_ms: 1_000,
        updated_at: updatedAt,
    };
}
export class SystemAdministrationError extends Error {
    statusCode;
    code;
    constructor(statusCode, code, message) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }
}
const allowedOpenVpnClientDirectives = new Set([
    "allow-compression",
    "allow-pull-fqdn",
    "auth",
    "auth-nocache",
    "auth-retry",
    "auth-token-user",
    "bind",
    "block-ipv6",
    "block-outside-dns",
    "client",
    "cipher",
    "connect-retry",
    "connect-retry-max",
    "connect-timeout",
    "data-ciphers",
    "data-ciphers-fallback",
    "dev",
    "dev-type",
    "dhcp-option",
    "explicit-exit-notify",
    "fast-io",
    "float",
    "fragment",
    "hand-window",
    "ifconfig",
    "ifconfig-ipv6",
    "ifconfig-nowarn",
    "inactivity",
    "keepalive",
    "key-direction",
    "link-mtu",
    "lport",
    "mssfix",
    "mtu-disc",
    "mute",
    "mute-replay-warnings",
    "nobind",
    "passtos",
    "peer-fingerprint",
    "persist-key",
    "persist-local-ip",
    "persist-remote-ip",
    "persist-tun",
    "ping",
    "ping-exit",
    "ping-restart",
    "ping-timer-rem",
    "proto",
    "proto-force",
    "pull",
    "pull-filter",
    "rcvbuf",
    "redirect-gateway",
    "redirect-private",
    "register-dns",
    "remote",
    "remote-cert-ku",
    "remote-cert-tls",
    "remote-random",
    "remote-random-hostname",
    "remap-usr1",
    "reneg-bytes",
    "reneg-pkts",
    "reneg-sec",
    "replay-window",
    "resolv-retry",
    "route",
    "route-delay",
    "route-gateway",
    "route-ipv6",
    "route-ipv6-gateway",
    "route-method",
    "route-metric",
    "route-nopull",
    "rport",
    "setenv-safe",
    "single-session",
    "sndbuf",
    "socket-flags",
    "suppress-timestamps",
    "tls-cipher",
    "tls-ciphersuites",
    "tls-client",
    "tls-exit",
    "tls-timeout",
    "tls-version-max",
    "tls-version-min",
    "topology",
    "tran-window",
    "tun-mtu",
    "verb",
    "verify-x509-name",
    "x509-username-field",
]);
const selfContainedOpenVpnDirectives = new Map([
    ["ca", "ca"],
    ["cert", "cert"],
    ["key", "key"],
    ["tls-auth", "tls-auth"],
    ["tls-crypt", "tls-crypt"],
    ["tls-crypt-v2", "tls-crypt-v2"],
    ["auth-user-pass", "auth-user-pass"],
]);
function parseSemver(value) {
    if (value.length > 120)
        return null;
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
    if (!match || !match[1] || !match[2] || !match[3])
        return null;
    const prereleaseIdentifiers = match[4]?.split(".") ?? [];
    if (prereleaseIdentifiers.some((identifier) => /^\d+$/.test(identifier) && !/^(0|[1-9]\d*)$/.test(identifier))) {
        return null;
    }
    const prerelease = prereleaseIdentifiers.map((identifier) => /^(0|[1-9]\d*)$/.test(identifier) ? BigInt(identifier) : identifier);
    return {
        major: BigInt(match[1]),
        minor: BigInt(match[2]),
        patch: BigInt(match[3]),
        prerelease,
    };
}
function compareSemver(left, right) {
    for (const key of ["major", "minor", "patch"]) {
        if (left[key] !== right[key])
            return left[key] > right[key] ? 1 : -1;
    }
    if (left.prerelease.length === 0 && right.prerelease.length === 0)
        return 0;
    if (left.prerelease.length === 0)
        return 1;
    if (right.prerelease.length === 0)
        return -1;
    const length = Math.max(left.prerelease.length, right.prerelease.length);
    for (let index = 0; index < length; index += 1) {
        const leftIdentifier = left.prerelease[index];
        const rightIdentifier = right.prerelease[index];
        if (leftIdentifier === undefined)
            return -1;
        if (rightIdentifier === undefined)
            return 1;
        if (leftIdentifier === rightIdentifier)
            continue;
        if (typeof leftIdentifier === "bigint") {
            return typeof rightIdentifier === "bigint"
                ? leftIdentifier > rightIdentifier
                    ? 1
                    : -1
                : -1;
        }
        if (typeof rightIdentifier === "bigint")
            return 1;
        return leftIdentifier > rightIdentifier ? 1 : -1;
    }
    return 0;
}
function safeUploadFilename(value, extension) {
    const name = value.trim();
    if (!name ||
        name.length > 255 ||
        path.basename(name) !== name ||
        /[\\/]/.test(name) ||
        /[\u0000-\u001f\u007f]/.test(name) ||
        !extension.test(name)) {
        throw new SystemAdministrationError(400, "invalid_file_name", "The uploaded file name is not allowed");
    }
    return name;
}
function sha256(contents) {
    return createHash("sha256").update(contents).digest("hex");
}
function normalizeOpenVpnDirective(value) {
    return value.toLowerCase().replace(/^--/, "");
}
function parseOpenVpnDirective(line) {
    const [rawDirective] = line.split(/\s+/, 1);
    if (!rawDirective || !/^(?:--)?[A-Za-z][A-Za-z0-9-]*$/.test(rawDirective)) {
        throw new SystemAdministrationError(400, "unsafe_openvpn_profile", "Quoted, escaped, or malformed OpenVPN directives are not allowed");
    }
    const directive = normalizeOpenVpnDirective(rawDirective);
    if (!allowedOpenVpnClientDirectives.has(directive) &&
        !selfContainedOpenVpnDirectives.has(directive)) {
        throw new SystemAdministrationError(400, "unsafe_openvpn_profile", `OpenVPN directive "${directive}" is not supported by the client-profile allowlist`);
    }
    return directive;
}
function assertRegularFile(filePath) {
    if (!lstatSync(filePath).isFile()) {
        throw new SystemAdministrationError(500, "managed_file_invalid", "A managed system file is not a regular file");
    }
}
function pathIsWithin(candidate, parent) {
    const relative = path.relative(parent, candidate);
    return (relative === "" ||
        (!relative.startsWith(`..${path.sep}`) &&
            relative !== ".." &&
            !path.isAbsolute(relative)));
}
function canonicalPathForCreation(target) {
    let existingAncestor = target;
    const missingSegments = [];
    while (!existsSync(existingAncestor)) {
        const parent = path.dirname(existingAncestor);
        if (parent === existingAncestor)
            break;
        missingSegments.unshift(path.basename(existingAncestor));
        existingAncestor = parent;
    }
    return path.join(realpathSync(existingAncestor), ...missingSegments);
}
function fsyncDirectory(directory) {
    let descriptor = null;
    try {
        descriptor = openSync(directory, constants.O_RDONLY);
        fsyncSync(descriptor);
    }
    catch {
        // Some filesystems do not support directory fsync. File fsync still
        // protects contents, and deployment snapshots remain required.
    }
    finally {
        if (descriptor !== null)
            closeSync(descriptor);
    }
}
function isExecutable(filePath) {
    if (!filePath || !path.isAbsolute(filePath))
        return false;
    try {
        assertRegularFile(filePath);
        accessSync(filePath, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
function writePrivateFile(filePath, contents) {
    const descriptor = openSync(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
        writeFileSync(descriptor, contents);
        fsyncSync(descriptor);
    }
    finally {
        closeSync(descriptor);
    }
    chmodSync(filePath, 0o600);
}
function ensurePrivateDirectory(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("System administration storage must use real private directories");
    }
    chmodSync(directory, 0o700);
}
function assertUnique(values, description, normalize = (value) => value) {
    const seen = new Set();
    for (const value of values) {
        const normalized = normalize(value);
        if (seen.has(normalized)) {
            throw new SystemAdministrationError(400, "invalid_backup", `The backup contains duplicate ${description}`);
        }
        seen.add(normalized);
    }
}
export function validateOpenVpnProfile(contents) {
    if (contents.length === 0 || contents.length > VPN_MAX_BYTES) {
        throw new SystemAdministrationError(400, "invalid_openvpn_profile", "The OpenVPN profile must be between 1 byte and 1 MB");
    }
    let profile;
    try {
        profile = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    }
    catch {
        throw new SystemAdministrationError(400, "invalid_openvpn_profile", "The OpenVPN profile must contain valid UTF-8 text");
    }
    if (profile.includes("\0")) {
        throw new SystemAdministrationError(400, "invalid_openvpn_profile", "The OpenVPN profile contains invalid control data");
    }
    const lines = profile
        .replaceAll("\r\n", "\n")
        .replaceAll("\r", "\n")
        .split("\n");
    const inlineBlocks = new Set();
    const inlineBlockNames = new Set(selfContainedOpenVpnDirectives.values());
    const inlineReferences = [];
    let activeInlineBlock = null;
    let activeInlineHasContent = false;
    let clientMode = false;
    let remoteConfigured = false;
    for (const sourceLine of lines) {
        const line = sourceLine.trim();
        if (activeInlineBlock) {
            if (line.toLowerCase() === `</${activeInlineBlock}>`) {
                if (!activeInlineHasContent) {
                    throw new SystemAdministrationError(400, "invalid_openvpn_profile", `The inline ${activeInlineBlock} block is empty`);
                }
                if (inlineBlocks.has(activeInlineBlock)) {
                    throw new SystemAdministrationError(400, "invalid_openvpn_profile", `The inline ${activeInlineBlock} block is duplicated`);
                }
                inlineBlocks.add(activeInlineBlock);
                activeInlineBlock = null;
                activeInlineHasContent = false;
            }
            else if (line) {
                activeInlineHasContent = true;
            }
            continue;
        }
        const openTag = /^<([a-z0-9-]+)>$/i.exec(line);
        const blockName = openTag?.[1]?.toLowerCase();
        if (blockName && inlineBlockNames.has(blockName)) {
            activeInlineBlock = blockName;
            continue;
        }
        if (!line || line.startsWith("#") || line.startsWith(";"))
            continue;
        const directive = parseOpenVpnDirective(line);
        if (directive === "client" || directive === "tls-client") {
            clientMode = true;
        }
        if (directive === "remote")
            remoteConfigured = true;
        if (selfContainedOpenVpnDirectives.has(directive)) {
            inlineReferences.push({
                directive,
                firstArgument: line.split(/\s+/)[1]?.toLowerCase(),
            });
        }
    }
    if (activeInlineBlock) {
        throw new SystemAdministrationError(400, "invalid_openvpn_profile", `The inline ${activeInlineBlock} block is not closed`);
    }
    if (!clientMode) {
        throw new SystemAdministrationError(400, "invalid_openvpn_profile", 'The OpenVPN profile must enable client mode with "client" or "tls-client"');
    }
    if (!remoteConfigured) {
        throw new SystemAdministrationError(400, "invalid_openvpn_profile", 'The OpenVPN client profile must contain at least one "remote" directive');
    }
    for (const { directive, firstArgument } of inlineReferences) {
        const requiredBlock = selfContainedOpenVpnDirectives.get(directive);
        if (!requiredBlock)
            continue;
        const explicitlyInline = firstArgument === "[inline]" || firstArgument === "inline";
        if (!inlineBlocks.has(requiredBlock) ||
            (firstArgument !== undefined && !explicitlyInline)) {
            throw new SystemAdministrationError(400, "external_openvpn_reference", `OpenVPN directive "${directive}" must use embedded inline material`);
        }
    }
    return profile;
}
export class SystemAdministrationService {
    database;
    appVersion;
    dataDirectory;
    updateFilePath;
    openVpnProfilePath;
    systemUpdateHelper;
    openVpnHelper;
    constructor(database, options = {}) {
        this.database = database;
        this.appVersion = options.appVersion ?? env.appVersion;
        const requestedDataDirectory = path.resolve(options.dataDirectory ?? env.systemAdminDataDir);
        const unsafeDirectories = new Set([
            path.parse(requestedDataDirectory).root,
            path.resolve(process.cwd()),
            path.resolve(homedir()),
            path.dirname(env.databasePath),
        ]);
        if (unsafeDirectories.has(requestedDataDirectory) ||
            requestedDataDirectory.split(path.sep).includes("public")) {
            throw new Error("System administration data must use a dedicated non-public subdirectory");
        }
        if (existsSync(requestedDataDirectory) &&
            (!lstatSync(requestedDataDirectory).isDirectory() ||
                lstatSync(requestedDataDirectory).isSymbolicLink())) {
            throw new Error("System administration data must use a dedicated real directory");
        }
        const canonicalDataDirectory = canonicalPathForCreation(requestedDataDirectory);
        const canonicalWorkingDirectory = realpathSync(process.cwd());
        const canonicalHomeDirectory = realpathSync(homedir());
        const canonicalDatabaseDirectory = realpathSync(path.dirname(env.databasePath));
        if ([
            path.parse(canonicalDataDirectory).root,
            canonicalWorkingDirectory,
            canonicalHomeDirectory,
            canonicalDatabaseDirectory,
        ].includes(canonicalDataDirectory) ||
            canonicalDataDirectory.split(path.sep).includes("public") ||
            (pathIsWithin(canonicalDataDirectory, canonicalWorkingDirectory) &&
                !pathIsWithin(canonicalDataDirectory, canonicalDatabaseDirectory)) ||
            (pathIsWithin(canonicalDataDirectory, canonicalHomeDirectory) &&
                !pathIsWithin(canonicalDataDirectory, canonicalDatabaseDirectory))) {
            throw new Error("System administration data resolves into an unsafe shared directory");
        }
        ensurePrivateDirectory(canonicalDataDirectory);
        this.dataDirectory = canonicalDataDirectory;
        this.systemUpdateHelper =
            options.systemUpdateHelper ?? env.systemUpdateHelper;
        this.openVpnHelper = options.openVpnHelper ?? env.openVpnHelper;
        this.updateFilePath = path.join(this.dataDirectory, "updates", "staged-update.pkg");
        this.openVpnProfilePath = path.join(this.dataDirectory, "openvpn", "profile.ovpn");
        this.initialize();
    }
    initialize() {
        ensurePrivateDirectory(this.dataDirectory);
        ensurePrivateDirectory(path.dirname(this.updateFilePath));
        ensurePrivateDirectory(path.dirname(this.openVpnProfilePath));
        this.recoverInterruptedManagedFiles(this.updateFilePath);
        this.recoverInterruptedManagedFiles(this.openVpnProfilePath);
        this.database.connection.transaction(() => {
            this.database.connection
                .prepare(`CREATE TABLE IF NOT EXISTS system_update_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            staged_version TEXT,
            staged_filename TEXT,
            staged_sha256 TEXT,
            staged_at TEXT,
            last_error TEXT
          )`)
                .run();
            this.database.connection
                .prepare(`CREATE TABLE IF NOT EXISTS openvpn_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            profile_name TEXT,
            enabled INTEGER NOT NULL DEFAULT 0,
            last_changed_at TEXT,
            last_error TEXT
          )`)
                .run();
            this.database.connection
                .prepare(`INSERT OR IGNORE INTO system_update_state (
            id, staged_version, staged_filename, staged_sha256, staged_at,
            last_error
          ) VALUES (1, NULL, NULL, NULL, NULL, NULL)`)
                .run();
            this.database.connection
                .prepare(`INSERT OR IGNORE INTO openvpn_state (
            id, profile_name, enabled, last_changed_at, last_error
          ) VALUES (1, NULL, 0, NULL, NULL)`)
                .run();
        })();
    }
    getUpdateState() {
        return updateStateRowSchema.parse(this.database.connection
            .prepare("SELECT * FROM system_update_state WHERE id = 1")
            .get());
    }
    getOpenVpnState() {
        return openVpnStateRowSchema.parse(this.database.connection
            .prepare("SELECT * FROM openvpn_state WHERE id = 1")
            .get());
    }
    getStatus() {
        const update = this.getUpdateState();
        const openVpn = this.getOpenVpnState();
        const vpnProfileExists = this.managedFileExists(this.openVpnProfilePath);
        return {
            appVersion: this.appVersion,
            update: {
                helperConfigured: isExecutable(this.systemUpdateHelper),
                stagedVersion: update.staged_version,
                stagedFilename: update.staged_filename,
                stagedSha256: update.staged_sha256,
                stagedAt: update.staged_at,
                lastError: update.last_error,
            },
            openVpn: {
                helperConfigured: isExecutable(this.openVpnHelper),
                configured: vpnProfileExists && openVpn.profile_name !== null,
                profileName: vpnProfileExists ? openVpn.profile_name : null,
                enabled: Boolean(openVpn.enabled),
                lastChangedAt: openVpn.last_changed_at,
                lastError: openVpn.last_error,
            },
        };
    }
    createConfigurationBackup(audit) {
        this.assertBackupRecordLimits();
        const openVpn = this.getOpenVpnState();
        const profile = this.readManagedFile(this.openVpnProfilePath, VPN_MAX_BYTES, false);
        const normalizedOpenVpn = profile
            ? openVpn
            : {
                ...openVpn,
                profile_name: null,
                enabled: 0,
            };
        const envelope = {
            format: "modbus-data-logger-configuration",
            version: 1,
            createdAt: new Date().toISOString(),
            appVersion: this.appVersion,
            data: {
                customerProfile: this.selectAll("customer_profile"),
                deviceCategories: this.selectAll("device_categories"),
                deviceGroups: this.selectAll("device_groups"),
                devices: this.selectAll("devices"),
                registers: this.selectAll("registers"),
                alarmRules: this.selectAll("alarm_rules"),
                postgresSettings: this.selectAll("postgres_settings"),
                whatsappAlertSettings: this.selectAll("whatsapp_alert_settings"),
                dataServerSettings: this.selectAllIfExists("data_server_settings"),
                dataServerDeviceExports: this.selectAllIfExists("data_server_device_exports"),
                systemUpdate: this.getUpdateState(),
                openVpn: normalizedOpenVpn,
                openVpnProfileBase64: profile?.toString("base64") ?? null,
            },
        };
        const validated = this.validateBackupEnvelope(envelope);
        const serialized = JSON.stringify(validated);
        if (Buffer.byteLength(serialized, "utf8") > BACKUP_MAX_JSON_BYTES) {
            throw new SystemAdministrationError(413, "configuration_backup_too_large", "The configuration is too large for a restorable backup");
        }
        const encrypted = `${BACKUP_PREFIX}${encryptSecret(serialized)}`;
        if (Buffer.byteLength(encrypted, "utf8") > BACKUP_MAX_TEXT_LENGTH) {
            throw new SystemAdministrationError(413, "configuration_backup_too_large", "The encrypted configuration exceeds the restore limit");
        }
        this.database.appendAudit({
            actorId: audit.actorId,
            action: "system.configuration_backup",
            entityType: "system",
            entityId: "configuration",
            details: {
                devices: validated.data.devices.length,
                registers: validated.data.registers.length,
            },
            sourceIp: audit.sourceIp,
        });
        return encrypted;
    }
    async restoreConfigurationBackup(backup, audit) {
        const envelope = this.parseBackup(backup);
        if (this.getOpenVpnState().enabled === 1) {
            await this.setOpenVpnEnabled(false, audit);
        }
        const profileContents = envelope.data.openVpnProfileBase64
            ? Buffer.from(envelope.data.openVpnProfileBase64, "base64")
            : null;
        if (profileContents)
            validateOpenVpnProfile(profileContents);
        const restoredAt = new Date().toISOString();
        const restoredCustomerProfile = envelope.data.customerProfile?.map((profile) => ({
            ...profile,
            updated_at: restoredAt,
        }));
        const restoredDevices = envelope.data.devices.map((device) => ({
            ...device,
            status: device.enabled === 1 ? "offline" : "disabled",
            last_seen_at: null,
            last_error: null,
            last_poll_ms: null,
            postgres_last_maintenance_at: null,
            postgres_schema_synced_at: null,
            postgres_schema_dirty: 1,
            postgres_schema_revision: device.postgres_schema_revision + 1,
            updated_at: restoredAt,
        }));
        const restoredPostgresSettings = envelope.data.postgresSettings.map((settings) => ({
            ...settings,
            last_connection_test_at: null,
            last_connection_test_ok: null,
            last_connection_test_message: null,
            last_maintenance_at: null,
            last_maintenance_raw_deleted: 0,
            last_maintenance_downsample_deleted: 0,
            last_replay_at: null,
            last_replay_count: 0,
            updated_at: restoredAt,
        }));
        const restoredWhatsappAlertSettings = envelope.data.whatsappAlertSettings.map((settings) => ({
            ...settings,
            enabled: 0,
            last_test_at: null,
            last_test_ok: null,
            last_test_message: null,
            updated_at: restoredAt,
        }));
        const restoredDataServerSettings = envelope.data.dataServerSettings.length > 0
            ? envelope.data.dataServerSettings.map((settings) => ({
                ...settings,
                modbus_enabled: 0,
                opcua_enabled: 0,
                updated_at: restoredAt,
            }))
            : [defaultDataServerSettings(restoredAt)];
        this.replaceManagedFiles([
            { target: this.openVpnProfilePath, contents: profileContents },
            { target: this.updateFilePath, contents: null },
        ], () => {
            this.deleteOperationalConfiguration();
            if (restoredCustomerProfile) {
                this.database.connection
                    .prepare("DELETE FROM customer_profile")
                    .run();
                this.insertRows("customer_profile", [
                    "id",
                    "company_name",
                    "customer_code",
                    "contact_person",
                    "contact_email",
                    "contact_phone",
                    "site_name",
                    "site_address",
                    "notes",
                    "updated_at",
                ], restoredCustomerProfile);
            }
            this.insertRows("device_categories", ["id", "name", "created_at", "updated_at"], envelope.data.deviceCategories);
            this.insertRows("device_groups", ["id", "name", "created_at", "updated_at"], envelope.data.deviceGroups);
            this.insertRows("devices", [
                "id",
                "name",
                "protocol",
                "tcp_host",
                "tcp_port",
                "serial_port",
                "baud_rate",
                "parity",
                "data_bits",
                "stop_bits",
                "unit_id",
                "poll_interval_ms",
                "read_block_size",
                "timeout_ms",
                "retries",
                "category_id",
                "group_id",
                "postgres_enabled",
                "save_interval_ms",
                "postgres_raw_table",
                "postgres_downsample_table",
                "postgres_downsample_enabled",
                "postgres_downsample_interval_sec",
                "postgres_raw_retention_days",
                "postgres_downsample_retention_days",
                "postgres_maintenance_interval_hours",
                "postgres_last_maintenance_at",
                "postgres_schema_synced_at",
                "postgres_schema_dirty",
                "postgres_schema_revision",
                "enabled",
                "status",
                "last_seen_at",
                "last_error",
                "last_poll_ms",
                "created_at",
                "updated_at",
            ], restoredDevices);
            this.insertRows("registers", [
                "id",
                "device_id",
                "name",
                "address",
                "function_code",
                "data_type",
                "byte_order",
                "scale",
                "offset",
                "unit",
                "postgres_column_name",
                "postgres_previous_column_name",
                "decimal_places",
                "enabled",
                "created_at",
                "updated_at",
            ], envelope.data.registers);
            this.insertRows("alarm_rules", [
                "id",
                "register_id",
                "name",
                "severity",
                "condition",
                "threshold_high",
                "threshold_low",
                "deadband",
                "enabled",
                "created_at",
                "updated_at",
            ], envelope.data.alarmRules);
            this.insertRows("postgres_settings", [
                "id",
                "enabled",
                "host",
                "port",
                "database_name",
                "username",
                "password_encrypted",
                "ssl_mode",
                "historian_timezone",
                "auto_downsample_enabled",
                "default_raw_table",
                "default_downsample_table",
                "default_downsample_interval_sec",
                "raw_retention_days",
                "downsample_retention_days",
                "maintenance_interval_hours",
                "offline_cache_enabled",
                "offline_cache_max_rows",
                "last_connection_test_at",
                "last_connection_test_ok",
                "last_connection_test_message",
                "last_maintenance_at",
                "last_maintenance_raw_deleted",
                "last_maintenance_downsample_deleted",
                "last_replay_at",
                "last_replay_count",
                "updated_at",
            ], restoredPostgresSettings);
            this.insertRows("whatsapp_alert_settings", [
                "id",
                "enabled",
                "access_token_encrypted",
                "recipients_json",
                "graph_api_version",
                "phone_number_id",
                "template_name",
                "language",
                "send_recovery",
                "offline_delay_seconds",
                "last_test_at",
                "last_test_ok",
                "last_test_message",
                "updated_at",
            ], restoredWhatsappAlertSettings);
            if (this.tableExists("data_server_settings")) {
                this.insertRows("data_server_settings", [
                    "id",
                    "modbus_enabled",
                    "modbus_bind_address",
                    "modbus_port",
                    "modbus_refresh_interval_ms",
                    "opcua_enabled",
                    "opcua_bind_address",
                    "opcua_advertised_host",
                    "opcua_port",
                    "opcua_endpoint_path",
                    "opcua_allow_anonymous",
                    "opcua_refresh_interval_ms",
                    "updated_at",
                ], restoredDataServerSettings);
            }
            if (this.tableExists("data_server_device_exports")) {
                this.insertRows("data_server_device_exports", [
                    "device_id",
                    "modbus_enabled",
                    "modbus_unit_id",
                    "opcua_enabled",
                ], envelope.data.dataServerDeviceExports);
            }
            this.upsertUpdateState({
                id: 1,
                staged_version: null,
                staged_filename: null,
                staged_sha256: null,
                staged_at: null,
                last_error: null,
            });
            this.upsertOpenVpnState({
                ...envelope.data.openVpn,
                enabled: 0,
                last_changed_at: restoredAt,
                last_error: profileContents
                    ? "Profile restored; OpenVPN remains disabled until explicitly connected"
                    : envelope.data.openVpn.last_error,
            });
            this.database.appendAudit({
                actorId: audit.actorId,
                action: "system.configuration_restore",
                entityType: "system",
                entityId: "configuration",
                details: {
                    backupCreatedAt: envelope.createdAt,
                    devices: envelope.data.devices.length,
                    registers: envelope.data.registers.length,
                    dataServerMappings: envelope.data.dataServerDeviceExports.length,
                },
                sourceIp: audit.sourceIp,
            });
        });
        return { restoredAt, reloadRequired: true };
    }
    async factoryReset(audit) {
        if (this.getOpenVpnState().enabled === 1) {
            await this.setOpenVpnEnabled(false, audit);
        }
        const resetAt = new Date().toISOString();
        this.replaceManagedFiles([
            { target: this.openVpnProfilePath, contents: null },
            { target: this.updateFilePath, contents: null },
        ], () => {
            this.database.connection.prepare("DELETE FROM alarm_events").run();
            this.database.connection
                .prepare("DELETE FROM system_alert_deliveries")
                .run();
            this.database.connection.prepare("DELETE FROM system_alerts").run();
            this.database.connection
                .prepare("DELETE FROM system_alert_observations")
                .run();
            this.database.connection.prepare("DELETE FROM readings").run();
            if (this.tableExists("postgres_outbox")) {
                this.database.connection.prepare("DELETE FROM postgres_outbox").run();
            }
            this.database.connection.prepare("DELETE FROM alarm_rules").run();
            this.database.connection.prepare("DELETE FROM registers").run();
            this.database.connection.prepare("DELETE FROM devices").run();
            this.database.connection.prepare("DELETE FROM device_categories").run();
            this.database.connection.prepare("DELETE FROM device_groups").run();
            this.database.connection.prepare("DELETE FROM postgres_settings").run();
            this.database.connection
                .prepare("DELETE FROM whatsapp_alert_settings")
                .run();
            this.database.connection
                .prepare(`UPDATE customer_profile
             SET company_name = '', customer_code = '', contact_person = '',
                 contact_email = '', contact_phone = '', site_name = '',
                 site_address = '', notes = '', updated_at = ?
             WHERE id = 1`)
                .run(resetAt);
            this.resetDataServerConfiguration(resetAt);
            this.database.connection.prepare("DELETE FROM audit_log").run();
            this.database.connection.prepare("DELETE FROM activity_log").run();
            if (this.tableExists("sqlite_sequence")) {
                this.database.connection
                    .prepare(`DELETE FROM sqlite_sequence
               WHERE name IN (
                 'readings', 'postgres_outbox', 'system_alert_deliveries',
                 'activity_log'
               )`)
                    .run();
            }
            this.upsertUpdateState({
                id: 1,
                staged_version: null,
                staged_filename: null,
                staged_sha256: null,
                staged_at: null,
                last_error: null,
            });
            this.upsertOpenVpnState({
                id: 1,
                profile_name: null,
                enabled: 0,
                last_changed_at: resetAt,
                last_error: null,
            });
            this.database.appendAudit({
                actorId: audit.actorId,
                action: "system.factory_reset",
                entityType: "system",
                entityId: "configuration",
                details: {
                    usersPreserved: true,
                    subscriptionPreserved: true,
                    installationIdPreserved: true,
                },
                sourceIp: audit.sourceIp,
            });
        });
        return { resetAt, reloadRequired: true };
    }
    stageUpdate(contents, version, filename, audit) {
        if (contents.length === 0 || contents.length > UPDATE_MAX_BYTES) {
            throw new SystemAdministrationError(400, "invalid_update", "The update package must be between 1 byte and 100 MB");
        }
        const safeFilename = safeUploadFilename(filename, /(?:\.zip|\.tar\.gz)$/i);
        const parsedVersion = parseSemver(version);
        const currentVersion = parseSemver(this.appVersion);
        if (!parsedVersion ||
            !currentVersion ||
            compareSemver(parsedVersion, currentVersion) <= 0) {
            throw new SystemAdministrationError(400, "invalid_update_version", "The update version must be valid semver and newer than this application");
        }
        const lowerName = safeFilename.toLowerCase();
        const zipMagic = contents.length >= 4 &&
            contents[0] === 0x50 &&
            contents[1] === 0x4b &&
            ((contents[2] === 0x03 && contents[3] === 0x04) ||
                (contents[2] === 0x05 && contents[3] === 0x06) ||
                (contents[2] === 0x07 && contents[3] === 0x08));
        const gzipMagic = contents.length >= 2 && contents[0] === 0x1f && contents[1] === 0x8b;
        if ((lowerName.endsWith(".zip") && !zipMagic) ||
            (lowerName.endsWith(".tar.gz") && !gzipMagic)) {
            throw new SystemAdministrationError(400, "invalid_update_archive", "The update package magic does not match its archive extension");
        }
        const stagedAt = new Date().toISOString();
        const digest = sha256(contents);
        this.replaceManagedFiles([{ target: this.updateFilePath, contents }], () => {
            this.upsertUpdateState({
                id: 1,
                staged_version: version,
                staged_filename: safeFilename,
                staged_sha256: digest,
                staged_at: stagedAt,
                last_error: null,
            });
            this.database.appendAudit({
                actorId: audit.actorId,
                action: "system.update_stage",
                entityType: "system_update",
                entityId: version,
                details: { filename: safeFilename, sha256: digest },
                sourceIp: audit.sourceIp,
            });
        });
        return { version, filename: safeFilename, sha256: digest, stagedAt };
    }
    async applyUpdate(audit) {
        const state = this.getUpdateState();
        if (!state.staged_version ||
            !state.staged_filename ||
            !state.staged_sha256 ||
            !this.managedFileExists(this.updateFilePath)) {
            throw new SystemAdministrationError(409, "update_not_staged", "No complete update package is staged");
        }
        const stagedVersion = parseSemver(state.staged_version);
        const currentVersion = parseSemver(this.appVersion);
        if (!stagedVersion ||
            !currentVersion ||
            compareSemver(stagedVersion, currentVersion) <= 0) {
            this.recordUpdateError("The staged update is not newer than the running application");
            throw new SystemAdministrationError(409, "update_version_not_newer", "The staged update is not newer than the running application");
        }
        const contents = this.readManagedFile(this.updateFilePath, UPDATE_MAX_BYTES, true);
        if (!contents || sha256(contents) !== state.staged_sha256) {
            this.recordUpdateError("The staged update package failed integrity validation");
            throw new SystemAdministrationError(409, "update_integrity_failed", "The staged update package failed integrity validation");
        }
        if (!isExecutable(this.systemUpdateHelper) || !this.systemUpdateHelper) {
            throw new SystemAdministrationError(503, "update_helper_unavailable", "The system update helper is not configured or executable");
        }
        const stagedVersionValue = state.staged_version;
        const stagedSha256Value = state.staged_sha256;
        try {
            await this.runHelper(this.systemUpdateHelper, [
                "apply",
                this.updateFilePath,
                stagedVersionValue,
                stagedSha256Value,
            ]);
        }
        catch {
            this.recordUpdateError("The system update helper did not accept the package");
            throw new SystemAdministrationError(502, "update_helper_failed", "The system update helper did not accept the package");
        }
        this.replaceManagedFiles([{ target: this.updateFilePath, contents: null }], () => {
            this.upsertUpdateState({
                id: 1,
                staged_version: null,
                staged_filename: null,
                staged_sha256: null,
                staged_at: null,
                last_error: null,
            });
            this.database.appendAudit({
                actorId: audit.actorId,
                action: "system.update_apply",
                entityType: "system_update",
                entityId: stagedVersionValue,
                details: {
                    sha256: stagedSha256Value,
                    helperAccepted: true,
                },
                sourceIp: audit.sourceIp,
            });
        });
        return { accepted: true, version: stagedVersionValue };
    }
    saveOpenVpnProfile(contents, filename, audit) {
        validateOpenVpnProfile(contents);
        const profileName = safeUploadFilename(filename, /\.ovpn$/i);
        const savedAt = new Date().toISOString();
        const previous = this.getOpenVpnState();
        if (previous.enabled === 1) {
            throw new SystemAdministrationError(409, "openvpn_profile_active", "Disconnect OpenVPN before replacing its profile");
        }
        this.replaceManagedFiles([{ target: this.openVpnProfilePath, contents }], () => {
            this.upsertOpenVpnState({
                id: 1,
                profile_name: profileName,
                enabled: previous.enabled,
                last_changed_at: savedAt,
                last_error: null,
            });
            this.database.appendAudit({
                actorId: audit.actorId,
                action: "system.openvpn_profile_save",
                entityType: "openvpn",
                entityId: "profile",
                details: { filename: profileName },
                sourceIp: audit.sourceIp,
            });
        });
        return { profileName, configured: true, savedAt };
    }
    async setOpenVpnEnabled(enabled, audit) {
        const state = this.getOpenVpnState();
        if (enabled &&
            (!state.profile_name || !this.managedFileExists(this.openVpnProfilePath))) {
            throw new SystemAdministrationError(409, "openvpn_profile_required", "Upload a self-contained OpenVPN profile before connecting");
        }
        if (!isExecutable(this.openVpnHelper) || !this.openVpnHelper) {
            throw new SystemAdministrationError(503, "openvpn_helper_unavailable", "The OpenVPN helper is not configured or executable");
        }
        try {
            await this.runHelper(this.openVpnHelper, enabled ? ["connect", this.openVpnProfilePath] : ["disconnect"]);
        }
        catch {
            const message = `The OpenVPN helper could not ${enabled ? "connect" : "disconnect"}`;
            this.recordOpenVpnError(message);
            throw new SystemAdministrationError(502, "openvpn_helper_failed", message);
        }
        const changedAt = new Date().toISOString();
        this.upsertOpenVpnState({
            ...state,
            enabled: enabled ? 1 : 0,
            last_changed_at: changedAt,
            last_error: null,
        });
        this.database.appendAudit({
            actorId: audit.actorId,
            action: enabled ? "system.openvpn_connect" : "system.openvpn_disconnect",
            entityType: "openvpn",
            entityId: "profile",
            details: { enabled },
            sourceIp: audit.sourceIp,
        });
        return { enabled, changedAt };
    }
    validateBackupEnvelope(value) {
        let envelope;
        try {
            envelope = backupEnvelopeSchema.parse(value);
        }
        catch {
            throw new SystemAdministrationError(400, "invalid_backup", "The configuration backup is invalid or unsupported");
        }
        assertUnique(envelope.data.deviceCategories.map((row) => row.id), "category IDs");
        assertUnique(envelope.data.deviceCategories.map((row) => row.name), "category names", (value) => value.toLowerCase());
        assertUnique(envelope.data.deviceGroups.map((row) => row.id), "group IDs");
        assertUnique(envelope.data.deviceGroups.map((row) => row.name), "group names", (value) => value.toLowerCase());
        assertUnique(envelope.data.devices.map((row) => row.id), "device IDs");
        assertUnique(envelope.data.registers.map((row) => row.id), "register IDs");
        assertUnique(envelope.data.alarmRules.map((row) => row.id), "alarm rule IDs");
        const categoryIds = new Set(envelope.data.deviceCategories.map((row) => row.id));
        const groupIds = new Set(envelope.data.deviceGroups.map((row) => row.id));
        const deviceIds = new Set(envelope.data.devices.map((row) => row.id));
        const registerIds = new Set(envelope.data.registers.map((row) => row.id));
        assertUnique(envelope.data.dataServerDeviceExports.map((row) => row.device_id), "data-server device mappings");
        for (const mapping of envelope.data.dataServerDeviceExports) {
            if (!deviceIds.has(mapping.device_id)) {
                throw new SystemAdministrationError(400, "invalid_backup", "A data-server mapping references an unknown device");
            }
        }
        assertUnique(envelope.data.dataServerDeviceExports
            .filter((row) => row.modbus_enabled === 1)
            .map((row) => String(row.modbus_unit_id)), "enabled Modbus server unit IDs");
        const dataServerSettings = envelope.data.dataServerSettings[0];
        if (dataServerSettings?.modbus_enabled === 1 &&
            !envelope.data.dataServerDeviceExports.some((mapping) => mapping.modbus_enabled === 1)) {
            throw new SystemAdministrationError(400, "invalid_backup", "Enabled Modbus server settings require an exported device mapping");
        }
        if (dataServerSettings?.opcua_enabled === 1 &&
            !envelope.data.dataServerDeviceExports.some((mapping) => mapping.opcua_enabled === 1)) {
            throw new SystemAdministrationError(400, "invalid_backup", "Enabled OPC UA server settings require a published device");
        }
        const historianTableOwners = new Map();
        for (const device of envelope.data.devices) {
            if ((device.category_id && !categoryIds.has(device.category_id)) ||
                (device.group_id && !groupIds.has(device.group_id))) {
                throw new SystemAdministrationError(400, "invalid_backup", "A device classification reference is invalid");
            }
            if (device.postgres_enabled === 1 ||
                device.postgres_schema_synced_at !== null) {
                for (const tableName of [
                    device.postgres_raw_table,
                    device.postgres_downsample_table,
                ]) {
                    const owner = historianTableOwners.get(tableName);
                    if (owner && owner !== device.id) {
                        throw new SystemAdministrationError(400, "invalid_backup", "Historian table names must be unique across configured devices");
                    }
                    historianTableOwners.set(tableName, device.id);
                }
            }
        }
        for (const register of envelope.data.registers) {
            if (!deviceIds.has(register.device_id)) {
                throw new SystemAdministrationError(400, "invalid_backup", "A register device reference is invalid");
            }
        }
        for (const rule of envelope.data.alarmRules) {
            if (!registerIds.has(rule.register_id)) {
                throw new SystemAdministrationError(400, "invalid_backup", "An alarm rule register reference is invalid");
            }
        }
        assertUnique(envelope.data.registers.map((row) => `${row.device_id}\0${row.name}`), "register names for a device");
        assertUnique(envelope.data.registers.flatMap((row) => [
            `${row.device_id}\0${row.postgres_column_name}`,
            ...(row.postgres_previous_column_name
                ? [`${row.device_id}\0${row.postgres_previous_column_name}`]
                : []),
        ]), "current or pending historian columns for a device");
        for (const settings of envelope.data.postgresSettings) {
            if (settings.password_encrypted) {
                try {
                    decryptSecret(settings.password_encrypted);
                }
                catch {
                    throw new SystemAdministrationError(400, "invalid_backup", "The saved PostgreSQL secret cannot be decrypted with this key");
                }
            }
        }
        for (const settings of envelope.data.whatsappAlertSettings) {
            if (settings.access_token_encrypted) {
                try {
                    decryptSecret(settings.access_token_encrypted);
                }
                catch {
                    throw new SystemAdministrationError(400, "invalid_backup", "The saved WhatsApp access token cannot be decrypted with this key");
                }
            }
        }
        const encodedProfile = envelope.data.openVpnProfileBase64;
        const profile = encodedProfile
            ? Buffer.from(encodedProfile, "base64")
            : null;
        if ((profile === null) !== (envelope.data.openVpn.profile_name === null) ||
            (envelope.data.openVpn.enabled === 1 && profile === null) ||
            (encodedProfile !== null &&
                profile?.toString("base64") !== encodedProfile)) {
            throw new SystemAdministrationError(400, "invalid_backup", "The OpenVPN backup state is inconsistent");
        }
        if (envelope.data.openVpn.profile_name) {
            safeUploadFilename(envelope.data.openVpn.profile_name, /\.ovpn$/i);
        }
        if (profile)
            validateOpenVpnProfile(profile);
        return envelope;
    }
    parseBackup(backup) {
        if (typeof backup !== "string" ||
            backup.length > BACKUP_MAX_TEXT_LENGTH ||
            !backup.startsWith(BACKUP_PREFIX)) {
            throw new SystemAdministrationError(400, "invalid_backup", "The configuration backup is invalid or unsupported");
        }
        try {
            const decrypted = decryptSecret(backup.slice(BACKUP_PREFIX.length));
            return this.validateBackupEnvelope(JSON.parse(decrypted));
        }
        catch (error) {
            if (error instanceof SystemAdministrationError)
                throw error;
            throw new SystemAdministrationError(400, "invalid_backup", "The configuration backup cannot be decrypted or parsed");
        }
    }
    assertBackupRecordLimits() {
        for (const [table, maximum] of Object.entries(BACKUP_RECORD_LIMITS)) {
            if (!this.tableExists(table))
                continue;
            const row = this.database.connection
                .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
                .get();
            if (row.count > maximum) {
                throw new SystemAdministrationError(413, "configuration_backup_too_large", `The ${table} table exceeds the configuration backup record limit`);
            }
        }
    }
    selectAll(table) {
        return this.database.connection
            .prepare(`SELECT * FROM ${table}`)
            .all();
    }
    selectAllIfExists(table) {
        return this.tableExists(table) ? this.selectAll(table) : [];
    }
    insertRows(table, columns, rows) {
        if (rows.length === 0)
            return;
        const placeholders = columns.map(() => "?").join(", ");
        const statement = this.database.connection.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`);
        for (const row of rows) {
            statement.run(...columns.map((column) => row[column]));
        }
    }
    tableExists(table) {
        return Boolean(this.database.connection
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(table));
    }
    deleteOperationalConfiguration() {
        if (this.tableExists("data_server_device_exports")) {
            this.database.connection
                .prepare("DELETE FROM data_server_device_exports")
                .run();
        }
        this.database.connection.prepare("DELETE FROM alarm_events").run();
        this.database.connection
            .prepare("DELETE FROM system_alert_deliveries")
            .run();
        this.database.connection.prepare("DELETE FROM system_alerts").run();
        this.database.connection
            .prepare("DELETE FROM system_alert_observations")
            .run();
        this.database.connection.prepare("DELETE FROM readings").run();
        if (this.tableExists("postgres_outbox")) {
            this.database.connection.prepare("DELETE FROM postgres_outbox").run();
        }
        this.database.connection.prepare("DELETE FROM alarm_rules").run();
        this.database.connection.prepare("DELETE FROM registers").run();
        this.database.connection.prepare("DELETE FROM devices").run();
        this.database.connection.prepare("DELETE FROM device_categories").run();
        this.database.connection.prepare("DELETE FROM device_groups").run();
        this.database.connection.prepare("DELETE FROM postgres_settings").run();
        this.database.connection
            .prepare("DELETE FROM whatsapp_alert_settings")
            .run();
        if (this.tableExists("data_server_settings")) {
            this.database.connection.prepare("DELETE FROM data_server_settings").run();
        }
    }
    resetDataServerConfiguration(updatedAt) {
        if (!this.tableExists("data_server_settings"))
            return;
        if (this.tableExists("data_server_device_exports")) {
            this.database.connection
                .prepare("DELETE FROM data_server_device_exports")
                .run();
        }
        const settings = defaultDataServerSettings(updatedAt);
        this.database.connection
            .prepare(`INSERT INTO data_server_settings (
           id, modbus_enabled, modbus_bind_address, modbus_port,
           modbus_refresh_interval_ms, opcua_enabled, opcua_bind_address,
           opcua_advertised_host, opcua_port, opcua_endpoint_path,
           opcua_allow_anonymous, opcua_refresh_interval_ms, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           modbus_enabled = excluded.modbus_enabled,
           modbus_bind_address = excluded.modbus_bind_address,
           modbus_port = excluded.modbus_port,
           modbus_refresh_interval_ms = excluded.modbus_refresh_interval_ms,
           opcua_enabled = excluded.opcua_enabled,
           opcua_bind_address = excluded.opcua_bind_address,
           opcua_advertised_host = excluded.opcua_advertised_host,
           opcua_port = excluded.opcua_port,
           opcua_endpoint_path = excluded.opcua_endpoint_path,
           opcua_allow_anonymous = excluded.opcua_allow_anonymous,
           opcua_refresh_interval_ms = excluded.opcua_refresh_interval_ms,
           updated_at = excluded.updated_at`)
            .run(settings.id, settings.modbus_enabled, settings.modbus_bind_address, settings.modbus_port, settings.modbus_refresh_interval_ms, settings.opcua_enabled, settings.opcua_bind_address, settings.opcua_advertised_host, settings.opcua_port, settings.opcua_endpoint_path, settings.opcua_allow_anonymous, settings.opcua_refresh_interval_ms, settings.updated_at);
    }
    upsertUpdateState(state) {
        this.database.connection
            .prepare(`INSERT INTO system_update_state (
          id, staged_version, staged_filename, staged_sha256, staged_at,
          last_error
        ) VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          staged_version = excluded.staged_version,
          staged_filename = excluded.staged_filename,
          staged_sha256 = excluded.staged_sha256,
          staged_at = excluded.staged_at,
          last_error = excluded.last_error`)
            .run(state.staged_version, state.staged_filename, state.staged_sha256, state.staged_at, state.last_error);
    }
    upsertOpenVpnState(state) {
        this.database.connection
            .prepare(`INSERT INTO openvpn_state (
          id, profile_name, enabled, last_changed_at, last_error
        ) VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          profile_name = excluded.profile_name,
          enabled = excluded.enabled,
          last_changed_at = excluded.last_changed_at,
          last_error = excluded.last_error`)
            .run(state.profile_name, state.enabled, state.last_changed_at, state.last_error);
    }
    recordUpdateError(message) {
        this.database.connection
            .prepare("UPDATE system_update_state SET last_error = ? WHERE id = 1")
            .run(message);
    }
    recordOpenVpnError(message) {
        this.database.connection
            .prepare("UPDATE openvpn_state SET last_error = ? WHERE id = 1")
            .run(message);
    }
    managedFileExists(filePath) {
        if (!existsSync(filePath))
            return false;
        assertRegularFile(filePath);
        return true;
    }
    readManagedFile(filePath, maximumBytes, required) {
        if (!this.managedFileExists(filePath)) {
            if (required) {
                throw new SystemAdministrationError(409, "managed_file_missing", "A required managed system file is missing");
            }
            return null;
        }
        const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const metadata = fstatSync(descriptor);
            if (!metadata.isFile()) {
                throw new SystemAdministrationError(409, "managed_file_invalid", "A managed system file is not a regular file");
            }
            if (metadata.size > maximumBytes) {
                throw new SystemAdministrationError(409, "managed_file_too_large", "A managed system file exceeds its allowed size");
            }
            return readFileSync(descriptor);
        }
        finally {
            closeSync(descriptor);
        }
    }
    recoverInterruptedManagedFiles(target) {
        const directory = path.dirname(target);
        const baseName = path.basename(target);
        const entries = readdirSync(directory);
        const temporary = entries
            .filter((entry) => entry.startsWith(`${baseName}.new-`))
            .map((entry) => path.join(directory, entry));
        const previous = entries
            .filter((entry) => entry.startsWith(`${baseName}.previous-`))
            .map((entry) => path.join(directory, entry));
        const recoveredFiles = temporary.length > 0 || previous.length > 0;
        for (const filePath of temporary)
            rmSync(filePath, { force: true });
        if (!existsSync(target) && previous.length > 0) {
            const restore = previous.shift();
            if (restore) {
                assertRegularFile(restore);
                renameSync(restore, target);
                chmodSync(target, 0o600);
            }
        }
        for (const filePath of previous)
            rmSync(filePath, { force: true });
        if (recoveredFiles)
            fsyncDirectory(directory);
    }
    replaceManagedFiles(replacements, databaseMutation) {
        const prepared = replacements.map((replacement) => {
            ensurePrivateDirectory(path.dirname(replacement.target));
            const temporary = replacement.contents === null
                ? null
                : `${replacement.target}.new-${randomUUID()}`;
            if (temporary && replacement.contents) {
                writePrivateFile(temporary, replacement.contents);
            }
            return {
                ...replacement,
                temporary,
                previous: `${replacement.target}.previous-${randomUUID()}`,
                hadPrevious: false,
            };
        });
        let committed = false;
        try {
            for (const item of prepared) {
                if (existsSync(item.target)) {
                    assertRegularFile(item.target);
                    renameSync(item.target, item.previous);
                    item.hadPrevious = true;
                }
                if (item.temporary) {
                    renameSync(item.temporary, item.target);
                    chmodSync(item.target, 0o600);
                }
                fsyncDirectory(path.dirname(item.target));
            }
            this.database.connection.transaction(databaseMutation)();
            committed = true;
        }
        finally {
            if (!committed) {
                for (const item of [...prepared].reverse()) {
                    rmSync(item.target, { force: true });
                    if (item.hadPrevious && existsSync(item.previous)) {
                        renameSync(item.previous, item.target);
                    }
                }
            }
            for (const item of prepared) {
                if (committed)
                    rmSync(item.previous, { force: true });
                if (item.temporary)
                    rmSync(item.temporary, { force: true });
                fsyncDirectory(path.dirname(item.target));
            }
        }
    }
    async runHelper(executable, arguments_) {
        await new Promise((resolve, reject) => {
            const child = spawn(executable, arguments_, {
                cwd: this.dataDirectory,
                env: {
                    LANG: "C",
                    LC_ALL: "C",
                    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
                },
                shell: false,
                stdio: "ignore",
            });
            const timeout = setTimeout(() => {
                child.kill("SIGKILL");
                reject(new Error("System helper timed out"));
            }, HELPER_TIMEOUT_MS);
            timeout.unref();
            child.once("error", (error) => {
                clearTimeout(timeout);
                reject(error);
            });
            child.once("exit", (code, signal) => {
                clearTimeout(timeout);
                if (code === 0) {
                    resolve();
                }
                else {
                    reject(new Error(`System helper exited with ${code ?? `signal ${signal ?? "unknown"}`}`));
                }
            });
        });
    }
}
//# sourceMappingURL=system-admin.js.map