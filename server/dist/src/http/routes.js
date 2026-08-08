import { z } from "zod";
import { env } from "../config/env.js";
import { HistorianSchemaConflictError, } from "../services/postgres-historian.js";
import { alarmCategoryRuleSchema, alarmGroupMemberSchema, alarmGroupRuleSchema, alarmGroupSchema, alarmRuleSchema, alarmsQuerySchema, activityQuerySchema, categoryIdParamsSchema, changePasswordSchema, createUserSchema, dataServerSettingsSchema, deviceClassificationSchema, deviceSchema, historianSchemaSyncSchema, idParamsSchema, loginSchema, postgresSettingsSchema, readingsQuerySchema, resetUserPasswordSchema, registerImportSchema, registerSchema, ruleIdParamsSchema, systemAlertsQuerySchema, updateUserSchema, whatsAppAlertSettingsSchema, } from "./schemas.js";
function csvEscape(value) {
    if (value === null || value === undefined)
        return "";
    const original = String(value);
    const text = /^[=+\-@\t\r]/.test(original) ? `'${original}` : original;
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
const ACTIVITY_EXPORT_MAX_ROWS = 1_000;
const ACTIVITY_EXPORT_DETAILS_MAX_CHARACTERS = 8_192;
export async function registerRoutes(app, dependencies) {
    const { database, auth, poller, postgresHistorian, systemAlerts, dataServers, } = dependencies;
    function parseDeviceInput(body) {
        const postgresDefaults = postgresHistorian.getPublicSettings();
        const provided = typeof body === "object" && body !== null && !Array.isArray(body)
            ? body
            : {};
        return deviceSchema.parse({
            saveIntervalMs: 1000,
            postgresRawTable: postgresDefaults.defaultRawTable,
            postgresDownsampleTable: postgresDefaults.defaultDownsampleTable,
            postgresDownsampleEnabled: postgresDefaults.autoDownsampleEnabled,
            postgresDownsampleIntervalSec: postgresDefaults.defaultDownsampleIntervalSec,
            postgresRawRetentionDays: postgresDefaults.rawRetentionDays,
            postgresDownsampleRetentionDays: postgresDefaults.downsampleRetentionDays,
            postgresMaintenanceIntervalHours: postgresDefaults.maintenanceIntervalHours,
            ...provided,
        });
    }
    function classificationAssignmentError(input) {
        if (input.categoryId && !database.getDeviceCategory(input.categoryId)) {
            return "The selected device category was not found";
        }
        if (input.groupId && !database.getDeviceGroup(input.groupId)) {
            return "The selected device group was not found";
        }
        return null;
    }
    async function authenticate(request, reply) {
        if (env.authDisabled) {
            request.principal = {
                id: "development-user",
                username: "developer",
                role: "administrator",
            };
            return;
        }
        const authorization = request.headers.authorization;
        const token = authorization?.startsWith("Bearer ")
            ? authorization.slice(7)
            : "";
        const principal = token ? await auth.verify(token) : null;
        if (!principal) {
            await reply.code(401).send({
                error: "unauthorized",
                message: "A valid access token is required",
            });
            return;
        }
        request.principal = principal;
    }
    function requireRole(...roles) {
        return async (request, reply) => {
            await authenticate(request, reply);
            if (reply.sent)
                return;
            if (!request.principal || !roles.includes(request.principal.role)) {
                await reply.code(403).send({
                    error: "forbidden",
                    message: "Your role cannot perform this action",
                });
            }
        };
    }
    app.addHook("preHandler", async (request, reply) => {
        const requestPath = request.url.split("?", 1)[0] ?? request.url;
        if (!poller.paused ||
            ["GET", "HEAD", "OPTIONS"].includes(request.method) ||
            requestPath.startsWith("/api/v1/settings/system") ||
            requestPath.startsWith("/api/v1/settings/configuration/") ||
            requestPath === "/api/v1/settings/factory-reset") {
            return;
        }
        await reply.code(503).send({
            error: "collector_administration_paused",
            message: "Configuration changes are temporarily paused for system administration",
        });
    });
    app.get("/health", async () => ({
        status: "ok",
        service: "modbus-data-logger",
        version: env.appVersion,
        time: new Date().toISOString(),
        pollingEnabled: env.pollingEnabled,
    }));
    app.post("/auth/login", {
        config: {
            rateLimit: { max: 10, timeWindow: "1 minute" },
        },
    }, async (request, reply) => {
        const credentials = loginSchema.parse(request.body);
        const result = await auth.login(credentials.username, credentials.password);
        if (!result) {
            database.appendActivity({
                level: "warning",
                category: "system",
                event: "auth.login_failed",
                message: `Failed sign-in for ${credentials.username}`,
                actorUsername: credentials.username,
                entityType: "user",
                sourceIp: request.ip,
                details: { username: credentials.username },
            });
            return reply.code(401).send({
                error: "invalid_credentials",
                message: "Username or password is incorrect",
            });
        }
        database.appendAudit({
            actorId: result.user.id,
            action: "auth.login",
            entityType: "user",
            entityId: result.user.id,
            sourceIp: request.ip,
        });
        return result;
    });
    app.post("/auth/change-password", {
        preHandler: authenticate,
        config: {
            rateLimit: { max: 5, timeWindow: "1 minute" },
        },
    }, async (request, reply) => {
        const input = changePasswordSchema.parse(request.body);
        const changed = await auth.changePassword(request.principal?.id ?? "", input.currentPassword, input.newPassword);
        if (!changed) {
            return reply.code(400).send({
                error: "password_change_failed",
                message: "The current password is incorrect",
            });
        }
        database.appendAudit({
            actorId: request.principal?.id,
            action: "auth.password_change",
            entityType: "user",
            entityId: request.principal?.id,
            sourceIp: request.ip,
        });
        await dataServers.reloadOpcUa();
        return reply.code(204).send();
    });
    app.get("/auth/me", { preHandler: authenticate }, async (request) => request.principal);
    app.get("/users", { preHandler: requireRole("administrator") }, async () => ({ items: database.listUsers() }));
    app.post("/users", { preHandler: requireRole("administrator") }, async (request, reply) => {
        const input = createUserSchema.parse(request.body);
        const user = await auth.createManagedUser(input);
        database.appendAudit({
            actorId: request.principal?.id,
            action: "user.create",
            entityType: "user",
            entityId: user.id,
            details: {
                username: user.username,
                role: user.role,
                enabled: user.enabled,
            },
            sourceIp: request.ip,
        });
        return reply.code(201).send(user);
    });
    app.patch("/users/:id", { preHandler: requireRole("administrator") }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        const input = updateUserSchema.parse(request.body);
        const user = database.updateUser(id, input, request.principal?.id ?? "");
        if (!user) {
            return reply.code(404).send({
                error: "not_found",
                message: "User was not found",
            });
        }
        database.appendAudit({
            actorId: request.principal?.id,
            action: "user.update",
            entityType: "user",
            entityId: user.id,
            details: {
                username: user.username,
                role: user.role,
                enabled: user.enabled,
            },
            sourceIp: request.ip,
        });
        await dataServers.reloadOpcUa();
        return user;
    });
    app.post("/users/:id/reset-password", {
        preHandler: requireRole("administrator"),
        config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        const { password } = resetUserPasswordSchema.parse(request.body);
        const existing = database.getUserById(id);
        if (!existing) {
            return reply.code(404).send({
                error: "not_found",
                message: "User was not found",
            });
        }
        await auth.resetManagedUserPassword(id, password);
        database.appendAudit({
            actorId: request.principal?.id,
            action: "user.password_reset",
            entityType: "user",
            entityId: id,
            details: { username: existing.username },
            sourceIp: request.ip,
        });
        await dataServers.reloadOpcUa();
        return reply.code(204).send();
    });
    app.delete("/users/:id", { preHandler: requireRole("administrator") }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        const deleted = database.deleteUser(id, request.principal?.id ?? "");
        if (!deleted) {
            return reply.code(404).send({
                error: "not_found",
                message: "User was not found",
            });
        }
        database.appendAudit({
            actorId: request.principal?.id,
            action: "user.delete",
            entityType: "user",
            entityId: id,
            details: {
                username: deleted.username,
                role: deleted.role,
            },
            sourceIp: request.ip,
        });
        await dataServers.reloadOpcUa();
        return reply.code(204).send();
    });
    app.get("/overview", { preHandler: authenticate }, async () => database.getOverview());
    app.get("/storage", { preHandler: authenticate }, async () => database.getStorageInfo());
    app.get("/activity/export", {
        preHandler: requireRole("administrator", "diagnostic"),
        config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    }, async (request, reply) => {
        const query = activityQuerySchema.parse(request.query);
        const { items, total } = database.listActivity({
            ...query,
            page: 1,
            pageSize: ACTIVITY_EXPORT_MAX_ROWS,
        });
        const headers = [
            "timestamp",
            "level",
            "category",
            "event",
            "message",
            "actorUsername",
            "entityType",
            "entityId",
            "sourceIp",
            "details",
        ];
        const csv = [
            headers.join(","),
            ...items.map((item) => headers
                .map((header) => csvEscape(header === "details"
                ? JSON.stringify(item.details).slice(0, ACTIVITY_EXPORT_DETAILS_MAX_CHARACTERS)
                : item[header]))
                .join(",")),
        ].join("\n");
        database.appendAudit({
            actorId: request.principal?.id,
            action: "activity.export",
            entityType: "activity_log",
            details: {
                count: items.length,
                available: total,
                truncated: total > items.length,
                filters: query,
            },
            sourceIp: request.ip,
        });
        return reply
            .header("content-type", "text/csv; charset=utf-8")
            .header("x-export-truncated", total > items.length ? "true" : "false")
            .header("x-export-row-limit", String(ACTIVITY_EXPORT_MAX_ROWS))
            .header("content-disposition", `attachment; filename="activity-${new Date().toISOString().slice(0, 10)}.csv"`)
            .send(csv);
    });
    app.get("/activity", { preHandler: requireRole("administrator", "diagnostic") }, async (request) => {
        const query = activityQuerySchema.parse(request.query);
        const result = database.listActivity(query);
        return {
            ...result,
            page: query.page,
            pageSize: query.pageSize,
            totalPages: result.total === 0 ? 0 : Math.ceil(result.total / query.pageSize),
        };
    });
    app.get("/devices", { preHandler: authenticate }, async () => ({
        items: database.listDevices(),
    }));
    app.get("/settings/postgres", { preHandler: requireRole("administrator") }, async () => postgresHistorian.getPublicSettings());
    app.get("/settings/data-servers", { preHandler: requireRole("administrator", "diagnostic") }, async () => dataServers.getSettings());
    app.put("/settings/data-servers", { preHandler: requireRole("administrator") }, async (request, reply) => {
        const input = dataServerSettingsSchema.parse(request.body);
        const existingDevices = new Set(database.listDevices().map((device) => device.id));
        const missing = [
            ...input.modbus.mappings,
            ...input.opcUa.publications,
        ].find((item) => !existingDevices.has(item.deviceId));
        if (missing) {
            return reply.code(400).send({
                error: "data_server_device_not_found",
                message: `Configured device ${missing.deviceId} was not found`,
            });
        }
        dataServers.repository.save(input);
        database.appendAudit({
            actorId: request.principal?.id,
            action: "data_servers.settings_update",
            entityType: "system_settings",
            entityId: "data_servers",
            details: {
                modbusEnabled: input.modbus.enabled,
                modbusBindAddress: input.modbus.bindAddress,
                modbusPort: input.modbus.port,
                modbusDeviceCount: input.modbus.mappings.filter((mapping) => mapping.enabled).length,
                opcUaEnabled: input.opcUa.enabled,
                opcUaBindAddress: input.opcUa.bindAddress,
                opcUaAdvertisedHost: input.opcUa.advertisedHost,
                opcUaPort: input.opcUa.port,
                opcUaDeviceCount: input.opcUa.publications.filter((publication) => publication.enabled).length,
                allowAnonymous: input.opcUa.allowAnonymous,
            },
            sourceIp: request.ip,
        });
        await dataServers.reload();
        return dataServers.getSettings();
    });
    app.get("/settings/device-classifications", { preHandler: authenticate }, async () => ({
        categories: database.listDeviceCategories(),
        groups: database.listDeviceGroups(),
    }));
    app.post("/settings/device-classifications/categories", { preHandler: requireRole("administrator") }, async (request, reply) => {
        const { name } = deviceClassificationSchema.parse(request.body);
        // Check for duplicate category name
        const existingCategories = database.listDeviceCategories();
        const existingCategory = existingCategories.find(c => c.name.toLowerCase() === name.toLowerCase());
        if (existingCategory) {
            return reply.code(409).send({
                error: "device_category_name_conflict",
                message: `A device category with name "${name}" already exists`,
            });
        }
        const category = database.createDeviceCategory(name);
        database.appendAudit({
            actorId: request.principal?.id,
            action: "device_category.create",
            entityType: "device_category",
            entityId: category.id,
            details: { name: category.name },
            sourceIp: request.ip,
        });
        return reply.code(201).send(category);
    });
    app.post("/settings/device-classifications/groups", { preHandler: requireRole("administrator") }, async (request, reply) => {
        const { name } = deviceClassificationSchema.parse(request.body);
        // Check for duplicate group name
        const existingGroups = database.listDeviceGroups();
        const existingGroup = existingGroups.find(g => g.name.toLowerCase() === name.toLowerCase());
        if (existingGroup) {
            return reply.code(409).send({
                error: "device_group_name_conflict",
                message: `A device group with name "${name}" already exists`,
            });
        }
        const group = database.createDeviceGroup(name);
        database.appendAudit({
            actorId: request.principal?.id,
            action: "device_group.create",
            entityType: "device_group",
            entityId: group.id,
            details: { name: group.name },
            sourceIp: request.ip,
        });
        return reply.code(201).send(group);
    });
    app.delete("/settings/device-classifications/categories/:id", { preHandler: requireRole("administrator") }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        const category = database.getDeviceCategory(id);
        if (!category) {
            return reply.code(404).send({
                error: "not_found",
                message: "Device category was not found",
            });
        }
        if (category.deviceCount > 0) {
            return reply.code(409).send({
                error: "classification_in_use",
                message: `Device category is assigned to ${category.deviceCount} device(s)`,
            });
        }
        database.deleteDeviceCategory(id);
        database.appendAudit({
            actorId: request.principal?.id,
            action: "device_category.delete",
            entityType: "device_category",
            entityId: id,
            details: { name: category.name },
            sourceIp: request.ip,
        });
        return reply.code(204).send();
    });
    app.delete("/settings/device-classifications/groups/:id", { preHandler: requireRole("administrator") }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        const group = database.getDeviceGroup(id);
        if (!group) {
            return reply.code(404).send({
                error: "not_found",
                message: "Device group was not found",
            });
        }
        if (group.deviceCount > 0) {
            return reply.code(409).send({
                error: "classification_in_use",
                message: `Device group is assigned to ${group.deviceCount} device(s)`,
            });
        }
        database.deleteDeviceGroup(id);
        database.appendAudit({
            actorId: request.principal?.id,
            action: "device_group.delete",
            entityType: "device_group",
            entityId: id,
            details: { name: group.name },
            sourceIp: request.ip,
        });
        return reply.code(204).send();
    });
    app.post("/settings/postgres/test", { preHandler: requireRole("administrator") }, async (request) => {
        const input = postgresSettingsSchema.parse(request.body);
        return postgresHistorian.testConnection(input);
    });
    app.put("/settings/postgres", { preHandler: requireRole("administrator") }, async (request, reply) => {
        const input = postgresSettingsSchema.parse(request.body);
        if (input.enabled) {
            const test = await postgresHistorian.testConnection(input);
            if (!test.ok) {
                return reply.code(400).send({
                    error: "postgres_connection_failed",
                    message: test.message,
                });
            }
        }
        await postgresHistorian.saveSettings(input);
        if (input.enabled) {
            database.recordPostgresConnectionTest(true, "Connection tested successfully when settings were applied");
        }
        database.appendAudit({
            actorId: request.principal?.id,
            action: "postgres.settings_update",
            entityType: "system_settings",
            entityId: "postgres",
            details: {
                enabled: input.enabled,
                host: input.host,
                port: input.port,
                database: input.database,
                username: input.username,
                sslMode: input.sslMode,
                historianTimezone: input.historianTimezone,
                autoDownsampleEnabled: input.autoDownsampleEnabled,
                defaultRawTable: input.defaultRawTable,
                defaultDownsampleTable: input.defaultDownsampleTable,
                defaultDownsampleIntervalSec: input.defaultDownsampleIntervalSec,
                rawRetentionDays: input.rawRetentionDays,
                downsampleRetentionDays: input.downsampleRetentionDays,
                maintenanceIntervalHours: input.maintenanceIntervalHours,
                offlineCacheEnabled: input.offlineCacheEnabled,
                offlineCacheMaxRows: input.offlineCacheMaxRows,
            },
            sourceIp: request.ip,
        });
        return postgresHistorian.getPublicSettings();
    });
    app.post("/settings/postgres/offline-cache/replay", { preHandler: requireRole("administrator") }, async (request) => {
        const result = await postgresHistorian.replayOfflineCache();
        database.appendAudit({
            actorId: request.principal?.id,
            action: "postgres.offline_cache_replay",
            entityType: "system_settings",
            entityId: "postgres",
            details: result,
            sourceIp: request.ip,
        });
        return result;
    });
    app.post("/settings/postgres/maintenance", { preHandler: requireRole("administrator") }, async (request) => {
        const result = await postgresHistorian.runMaintenance(true);
        database.appendAudit({
            actorId: request.principal?.id,
            action: "postgres.maintenance_run",
            entityType: "system_settings",
            entityId: "postgres",
            details: result,
            sourceIp: request.ip,
        });
        return result;
    });
    app.post("/devices", { preHandler: requireRole("administrator", "operator") }, async (request, reply) => {
        const input = parseDeviceInput(request.body);
        const assignmentError = classificationAssignmentError(input);
        if (assignmentError) {
            return reply.code(400).send({
                error: "invalid_device_classification",
                message: assignmentError,
            });
        }
        // Check for duplicate device name
        const existingDevice = database.listDevices().find(d => d.name.toLowerCase() === input.name.toLowerCase());
        if (existingDevice) {
            return reply.code(409).send({
                error: "device_name_conflict",
                message: `A device with name "${input.name}" already exists`,
            });
        }
        const device = database.createDevice(input);
        database.appendAudit({
            actorId: request.principal?.id,
            action: "device.create",
            entityType: "device",
            entityId: device.id,
            details: {
                name: device.name,
                protocol: device.protocol,
                categoryId: device.categoryId,
                groupId: device.groupId,
            },
            sourceIp: request.ip,
        });
        database.appendAudit({
            actorId: request.principal?.id,
            action: "device.create",
            entityType: "device",
            entityId: device.id,
            details: {
                name: device.name,
                protocol: device.protocol,
                categoryId: device.categoryId,
                groupId: device.groupId,
            },
            sourceIp: request.ip,
        });
        await poller.reload();
        return reply.code(201).send(device);
    });
    app.put("/devices/:id", { preHandler: requireRole("administrator") }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        const input = parseDeviceInput(request.body);
        const previousDevice = database.getDevice(id);
        if (!previousDevice) {
            return reply.code(404).send({
                error: "not_found",
                message: "Device was not found",
            });
        }
        const assignmentError = classificationAssignmentError(input);
        if (assignmentError) {
            return reply.code(400).send({
                error: "invalid_device_classification",
                message: assignmentError,
            });
        }
        if (input.postgresEnabled && !postgresHistorian.configured) {
            return reply.code(400).send({
                error: "postgres_not_configured",
                message: "Configure and enable Remote PostgreSQL before enabling it on a device",
            });
        }
        if (!previousDevice.postgresEnabled && input.postgresEnabled) {
            return reply.code(409).send({
                error: "postgres_connect_verification_required",
                message: "Use Connect and verify to enable PostgreSQL saving so both historian tables are checked first",
            });
        }
        const tableOwner = database.findHistorianTableOwner(input.postgresRawTable, input.postgresDownsampleTable, id);
        if (tableOwner) {
            return reply.code(409).send({
                error: "postgres_table_in_use",
                message: `Historian tables must be unique per device; they are already used by ${tableOwner.name}`,
            });
        }
        const device = database.updateDevice(id, input);
        if (!device) {
            return reply.code(404).send({
                error: "not_found",
                message: "Device was not found",
            });
        }
        database.appendAudit({
            actorId: request.principal?.id,
            action: "device.update",
            entityType: "device",
            entityId: id,
            details: {
                name: device.name,
                protocol: device.protocol,
                categoryId: device.categoryId,
                groupId: device.groupId,
            },
            sourceIp: request.ip,
        });
        postgresHistorian.forgetDevice(id);
        await poller.reload();
        return device;
    });
    app.post("/devices/:id/postgres/disconnect", { preHandler: requireRole("administrator") }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        const existing = database.getDevice(id);
        if (!existing) {
            database.appendAudit({
                actorId: request.principal?.id,
                action: "postgres.device_disconnect_rejected",
                entityType: "device",
                entityId: id,
                details: { message: "Device was not found" },
                sourceIp: request.ip,
            });
            return reply.code(404).send({
                error: "not_found",
                message: "Device was not found",
            });
        }
        const result = await postgresHistorian.disconnectDevice(id);
        database.appendAudit({
            actorId: request.principal?.id,
            action: "postgres.device_disconnect",
            entityType: "device",
            entityId: id,
            details: {
                wasConnected: existing.postgresEnabled,
                connected: result.connected,
                message: result.message,
            },
            sourceIp: request.ip,
        });
        await poller.reload();
        return result;
    });
    app.post("/devices/:id/postgres/connect", { preHandler: requireRole("administrator") }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        if (!database.getDevice(id)) {
            database.appendAudit({
                actorId: request.principal?.id,
                action: "postgres.device_connect_rejected",
                entityType: "device",
                entityId: id,
                details: { message: "Device was not found" },
                sourceIp: request.ip,
            });
            return reply.code(404).send({
                error: "not_found",
                message: "Device was not found",
            });
        }
        try {
            const result = await postgresHistorian.connectDevice(id);
            database.appendAudit({
                actorId: request.principal?.id,
                action: result.connected
                    ? "postgres.device_connect"
                    : "postgres.device_connect_attention",
                entityType: "device",
                entityId: id,
                details: {
                    connected: result.connected,
                    message: result.message,
                    schema: result.schema,
                },
                sourceIp: request.ip,
            });
            if (result.connected) {
                await poller.reload();
                return result;
            }
            return reply.code(result.schema ? 200 : 400).send(result);
        }
        catch (error) {
            const device = database.getDevice(id);
            const message = error instanceof Error
                ? error.message.slice(0, 500)
                : "Unknown PostgreSQL connection failure";
            database.appendAudit({
                actorId: request.principal?.id,
                action: error instanceof HistorianSchemaConflictError
                    ? "postgres.device_connect_rejected"
                    : "postgres.device_connect_failed",
                entityType: "device",
                entityId: id,
                details: { connected: false, message },
                sourceIp: request.ip,
            });
            if (error instanceof HistorianSchemaConflictError) {
                return reply.code(409).send({
                    connected: false,
                    message: error.message,
                    device,
                });
            }
            request.log.error({ error, deviceId: id }, "PostgreSQL device connection verification failed");
            return reply.code(502).send({
                connected: false,
                message: "Remote PostgreSQL verification failed; data saving remains disconnected",
                device,
            });
        }
    });
    app.delete("/devices/:id", { preHandler: requireRole("administrator") }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        const device = database.getDevice(id);
        if (!device) {
            return reply.code(404).send({
                error: "not_found",
                message: "Device was not found",
            });
        }
        database.deleteDevice(id);
        database.appendAudit({
            actorId: request.principal?.id,
            action: "device.delete",
            entityType: "device",
            entityId: id,
            details: { name: device.name },
            sourceIp: request.ip,
        });
        postgresHistorian.forgetDevice(id);
        await poller.reload();
        await dataServers.reload();
        return reply.code(204).send();
    });
    app.post("/devices/:id/historian-schema/sync", { preHandler: requireRole("administrator") }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        const { dropRemoved, expectedOrphanedColumns } = historianSchemaSyncSchema.parse(request.body ?? {});
        const emptyResult = (message) => ({
            ok: false,
            message,
            addedColumns: [],
            changedColumns: [],
            orphanedColumns: [],
            droppedColumns: [],
            syncedAt: null,
        });
        const device = database.getDevice(id);
        if (!device) {
            database.appendAudit({
                actorId: request.principal?.id,
                action: "postgres.historian_schema_sync_rejected",
                entityType: "device",
                entityId: id,
                details: { dropRemoved, message: "Device was not found" },
                sourceIp: request.ip,
            });
            return reply.code(404).send(emptyResult("Device was not found"));
        }
        if (!postgresHistorian.configured) {
            const message = "Configure and enable Remote PostgreSQL before synchronizing historian tables";
            database.appendAudit({
                actorId: request.principal?.id,
                action: "postgres.historian_schema_sync_rejected",
                entityType: "device",
                entityId: id,
                details: { dropRemoved, message },
                sourceIp: request.ip,
            });
            return reply.code(400).send(emptyResult(message));
        }
        try {
            const result = await postgresHistorian.syncDeviceSchema(id, dropRemoved, expectedOrphanedColumns);
            database.appendAudit({
                actorId: request.principal?.id,
                action: "postgres.historian_schema_sync",
                entityType: "device",
                entityId: id,
                details: {
                    dropRemoved,
                    ...result,
                },
                sourceIp: request.ip,
            });
            if (result.ok) {
                await poller.reload();
            }
            return result;
        }
        catch (error) {
            if (error instanceof HistorianSchemaConflictError) {
                const result = emptyResult(error.message);
                database.appendAudit({
                    actorId: request.principal?.id,
                    action: "postgres.historian_schema_sync_rejected",
                    entityType: "device",
                    entityId: id,
                    details: { dropRemoved, message: error.message },
                    sourceIp: request.ip,
                });
                return reply.code(409).send(result);
            }
            database.appendAudit({
                actorId: request.principal?.id,
                action: "postgres.historian_schema_sync_failed",
                entityType: "device",
                entityId: id,
                details: {
                    dropRemoved,
                    message: error instanceof Error
                        ? error.message.slice(0, 500)
                        : "Unknown schema synchronization failure",
                },
                sourceIp: request.ip,
            });
            throw error;
        }
    });
    app.get("/devices/:id/registers", { preHandler: authenticate }, async (request) => {
        const { id } = idParamsSchema.parse(request.params);
        return { items: database.listRegisters(id) };
    });
    app.post("/devices/:id/registers", { preHandler: requireRole("administrator") }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        if (!database.getDevice(id)) {
            return reply.code(404).send({
                error: "not_found",
                message: "Device was not found",
            });
        }
        const input = registerSchema.parse(request.body);
        // Check for duplicate register name within the same device
        const existingRegisters = database.listRegisters(id);
        const existingRegister = existingRegisters.find(r => r.name.toLowerCase() === input.name.toLowerCase());
        if (existingRegister) {
            return reply.code(409).send({
                error: "register_name_conflict",
                message: `A register with name "${input.name}" already exists for this device`,
            });
        }
        const register = database.createRegister({ ...input, deviceId: id });
        database.appendAudit({
            actorId: request.principal?.id,
            action: "register.create",
            entityType: "register",
            entityId: register.id,
            details: { deviceId: id, name: register.name },
            sourceIp: request.ip,
        });
        await poller.reload();
        return reply.code(201).send(register);
    });
    app.post("/devices/:id/registers/import", { preHandler: requireRole("administrator") }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        if (!database.getDevice(id)) {
            return reply.code(404).send({
                error: "not_found",
                message: "Device was not found",
            });
        }
        const { items: input } = registerImportSchema.parse(request.body);
        const items = database.createRegisters(id, input);
        const totalTags = database.getDevice(id)?.tagCount ?? items.length;
        database.appendAudit({
            actorId: request.principal?.id,
            action: "register.import",
            entityType: "device",
            entityId: id,
            details: {
                count: items.length,
                totalTags,
            },
            sourceIp: request.ip,
        });
        await poller.reload();
        return reply.code(201).send({
            items,
            count: items.length,
            totalTags,
        });
    });
    app.put("/registers/:id", { preHandler: requireRole("administrator") }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        const input = registerSchema.parse(request.body);
        const register = database.updateRegister(id, input);
        if (!register) {
            return reply.code(404).send({
                error: "not_found",
                message: "Register was not found",
            });
        }
        database.appendAudit({
            actorId: request.principal?.id,
            action: "register.update",
            entityType: "register",
            entityId: id,
            details: { name: register.name },
            sourceIp: request.ip,
        });
        await poller.reload();
        return register;
    });
    app.delete("/registers/:id", { preHandler: requireRole("administrator") }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        const register = database.getRegister(id);
        if (!register) {
            return reply.code(404).send({
                error: "not_found",
                message: "Register was not found",
            });
        }
        database.deleteRegister(id);
        database.appendAudit({
            actorId: request.principal?.id,
            action: "register.delete",
            entityType: "register",
            entityId: id,
            details: {
                deviceId: register.deviceId,
                name: register.name,
                historianColumn: register.historianColumn,
            },
            sourceIp: request.ip,
        });
        await poller.reload();
        return reply.code(204).send();
    });
    app.get("/registers/:id/alarm-rules", { preHandler: authenticate }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        if (!database.getRegister(id)) {
            return reply.code(404).send({
                error: "not_found",
                message: "Register was not found",
            });
        }
        return { items: database.listAlarmRules(id) };
    });
    app.post("/registers/:id/alarm-rules", { preHandler: requireRole("administrator", "operator") }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        if (!database.getRegister(id)) {
            return reply.code(404).send({
                error: "not_found",
                message: "Register was not found",
            });
        }
        const input = alarmRuleSchema.parse(request.body);
        const rule = database.createAlarmRule({ ...input, registerId: id });
        database.appendAudit({
            actorId: request.principal?.id,
            action: "alarm_rule.create",
            entityType: "alarm_rule",
            entityId: rule.id,
            details: { registerId: id, name: rule.name },
            sourceIp: request.ip,
        });
        return reply.code(201).send(rule);
    });
    app.delete("/registers/:id/alarm-rules/:ruleId", { preHandler: requireRole("administrator", "operator") }, async (request, reply) => {
        const { id, ruleId } = request.params;
        if (!database.getRegister(id)) {
            return reply.code(404).send({
                error: "not_found",
                message: "Register was not found",
            });
        }
        database.deleteAlarmRule(ruleId);
        return reply.code(204).send();
    });
    app.put("/registers/:id/alarm-rules/:ruleId", { preHandler: requireRole("administrator", "operator") }, async (request, reply) => {
        const { id, ruleId } = request.params;
        if (!database.getRegister(id)) {
            return reply.code(404).send({
                error: "not_found",
                message: "Register was not found",
            });
        }
        // Verify the rule belongs to this register
        const existingRule = database.listAlarmRules(id).find(r => r.id === ruleId);
        if (!existingRule) {
            return reply.code(404).send({
                error: "not_found",
                message: "Alarm rule was not found",
            });
        }
        const input = alarmRuleSchema.parse(request.body);
        // Use ruleId as the record ID, and id (route param) as registerId
        database.updateAlarmRule(ruleId, { ...input, id: ruleId, registerId: id });
        return reply.code(200).send(database.listAlarmRules(id).find(r => r.id === ruleId));
    });
    app.get("/readings/latest", { preHandler: authenticate }, async () => ({
        items: database.getLatestReadings(),
    }));
    app.get("/devices/:id/readings/latest", { preHandler: authenticate }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        if (!database.getDevice(id)) {
            return reply.code(404).send({
                error: "not_found",
                message: "Device was not found",
            });
        }
        const items = database.getLatestReadingsForDevice(id);
        return { items, total: items.length };
    });
    app.get("/readings", { preHandler: authenticate }, async (request) => {
        const query = readingsQuerySchema.parse(request.query);
        return { items: database.queryReadings(query) };
    });
    app.get("/readings/export.csv", { preHandler: authenticate }, async (request, reply) => {
        const query = readingsQuerySchema.parse(request.query);
        const rows = database.queryReadings({
            ...query,
            limit: Math.min(query.limit, 50_000),
        });
        const headers = [
            "timestamp",
            "deviceName",
            "categoryName",
            "groupName",
            "tagName",
            "address",
            "value",
            "unit",
            "quality",
        ];
        const csv = [
            headers.join(","),
            ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
        ].join("\n");
        database.appendAudit({
            actorId: request.principal?.id,
            action: "readings.export",
            entityType: "reading",
            details: { count: rows.length, filters: query },
            sourceIp: request.ip,
        });
        return reply
            .header("content-type", "text/csv; charset=utf-8")
            .header("content-disposition", `attachment; filename="modbus-readings-${new Date().toISOString().slice(0, 10)}.csv"`)
            .send(csv);
    });
    app.get("/alarms", { preHandler: authenticate }, async (request) => {
        const query = alarmsQuerySchema.parse(request.query);
        return { items: database.listAlarmEvents(query) };
    });
    // Alarm Group API Routes
    app.get("/alarm-groups", { preHandler: authenticate }, async () => {
        const groups = database.listAlarmGroups();
        return {
            items: groups.map((g) => ({
                id: g.id,
                name: g.name,
                description: g.description,
                created_at: g.created_at,
                updated_at: g.updated_at,
            })),
        };
    });
    app.post("/alarm-groups", { preHandler: requireRole("administrator", "operator") }, async (request, reply) => {
        const input = alarmGroupSchema.parse(request.body);
        // Check for duplicate alarm group name
        const existingGroups = database.listAlarmGroups();
        const existingGroup = existingGroups.find(g => g.name.toLowerCase() === input.name.toLowerCase());
        if (existingGroup) {
            return reply.code(409).send({
                error: "alarm_group_name_conflict",
                message: `An alarm group with name "${input.name}" already exists`,
            });
        }
        const group = database.createAlarmGroup(input.name, input.description);
        database.appendAudit({
            actorId: request.principal?.id,
            action: "alarm_group.create",
            entityType: "alarm_group",
            entityId: group.id,
            sourceIp: request.ip,
        });
        return reply.code(201).send(group);
    });
    app.get("/alarm-groups/:id", { preHandler: authenticate }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        const group = database.getAlarmGroup(id);
        if (!group) {
            return reply.code(404).send({ error: "not_found" });
        }
        const members = database.listGroupMembers(id);
        const rules = database.listAlarmGroupRules(id);
        return { ...group, members, rules };
    });
    app.put("/alarm-groups/:id", { preHandler: requireRole("administrator", "operator") }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        const input = alarmGroupSchema.parse(request.body);
        database.updateAlarmGroup(id, { name: input.name, description: input.description });
        return reply.code(204).send();
    });
    app.delete("/alarm-groups/:id", { preHandler: requireRole("administrator") }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        database.deleteAlarmGroup(id);
        return reply.code(204).send();
    });
    app.post("/alarm-groups/:id/members", { preHandler: requireRole("administrator", "operator") }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        const input = alarmGroupMemberSchema.parse(request.body);
        database.addGroupMember(id, input.registerId, input.weight);
        return reply.code(204).send();
    });
    app.delete("/alarm-groups/:id/members/:registerId", { preHandler: requireRole("administrator", "operator") }, async (request, reply) => {
        const params = request.params;
        const groupId = idParamsSchema.parse(params).id;
        database.removeGroupMember(groupId, params.registerId);
        return reply.code(204).send();
    });
    app.post("/alarm-groups/:id/rules", { preHandler: requireRole("administrator", "operator") }, async (request, reply) => {
        const groupId = idParamsSchema.parse(request.params).id;
        const input = alarmGroupRuleSchema.parse(request.body);
        const rule = database.createAlarmGroupRule({
            groupId,
            name: input.name,
            severity: input.severity,
            condition: input.condition,
            thresholdHi: input.thresholdHi ?? undefined,
            thresholdLo: input.thresholdLo ?? undefined,
            deadband: input.deadband,
        });
        return reply.code(201).send(rule);
    });
    app.delete("/alarm-groups/:id/rules/:ruleId", { preHandler: requireRole("administrator") }, async (request, reply) => {
        const params = request.params;
        database.deleteAlarmGroupRule(params.ruleId);
        return reply.code(204).send();
    });
    // Alarm Category Routes
    app.get("/alarm-categories", { preHandler: authenticate }, async () => {
        const categories = database.listAllCategoriesWithDeviceCounts();
        return { items: categories };
    });
    app.post("/categories/:categoryId/alarm-rules", { preHandler: requireRole("administrator", "operator") }, async (request, reply) => {
        const { categoryId } = categoryIdParamsSchema.parse(request.params);
        // Verify category exists
        const category = database.getDeviceCategory(categoryId);
        if (!category) {
            return reply.code(404).send({
                error: "not_found",
                message: "Category was not found",
            });
        }
        const input = alarmCategoryRuleSchema.parse(request.body);
        const rule = database.createCategoryAlarmRule({
            categoryId,
            name: input.name,
            severity: input.severity,
            condition: input.condition,
            thresholdHigh: input.thresholdHigh ?? undefined,
            thresholdLow: input.thresholdLow ?? undefined,
            aggregationType: input.aggregationType || 'sum',
            deadband: input.deadband,
        });
        database.appendAudit({
            actorId: request.principal?.id,
            action: "category_alarm_rule.create",
            entityType: "alarm_category_rule",
            entityId: rule.id,
            details: { categoryId, name: rule.name },
            sourceIp: request.ip,
        });
        return reply.code(201).send(rule);
    });
    app.get("/categories/:categoryId/alarm-rules", { preHandler: authenticate }, async (request, reply) => {
        const { categoryId } = categoryIdParamsSchema.parse(request.params);
        // Verify category exists
        const category = database.getDeviceCategory(categoryId);
        if (!category) {
            return reply.code(404).send({
                error: "not_found",
                message: "Category was not found",
            });
        }
        const rules = database.listCategoryAlarmRules(categoryId);
        return { items: rules };
    });
    app.get("/alarm-categories/:ruleId", { preHandler: authenticate }, async (request, reply) => {
        const { ruleId } = ruleIdParamsSchema.parse(request.params);
        const rule = database.getCategoryAlarmRule(ruleId);
        if (!rule) {
            return reply.code(404).send({
                error: "not_found",
                message: "Category alarm rule was not found",
            });
        }
        // Get matching registers for this category
        const matchingRegisters = database.getCategoriesWithMatchingRegisters(rule.category_id);
        return { ...rule, matchingRegisters };
    });
    app.put("/alarm-categories/:ruleId", { preHandler: requireRole("administrator", "operator") }, async (request, reply) => {
        const { ruleId } = ruleIdParamsSchema.parse(request.params);
        // Verify rule exists
        const existingRule = database.getCategoryAlarmRule(ruleId);
        if (!existingRule) {
            return reply.code(404).send({
                error: "not_found",
                message: "Category alarm rule was not found",
            });
        }
        const input = alarmCategoryRuleSchema.parse(request.body);
        database.updateCategoryAlarmRule(ruleId, {
            name: input.name,
            severity: input.severity,
            condition: input.condition,
            thresholdHigh: input.thresholdHigh ?? undefined,
            thresholdLow: input.thresholdLow ?? undefined,
            aggregationType: input.aggregationType || 'sum',
            deadband: input.deadband,
        });
        return reply.code(204).send();
    });
    app.delete("/alarm-categories/:ruleId", { preHandler: requireRole("administrator") }, async (request, reply) => {
        const { ruleId } = ruleIdParamsSchema.parse(request.params);
        return reply.code(204).send();
    });
    // Category Rule Tags — List tags for a rule
    app.get("/alarm-categories/:ruleId/tags", { preHandler: authenticate }, async (request, reply) => {
        const { ruleId } = ruleIdParamsSchema.parse(request.params);
        // Verify rule exists
        const existingRule = database.getCategoryAlarmRule(ruleId);
        if (!existingRule) {
            return reply.code(404).send({
                error: "not_found",
                message: "Category alarm rule was not found",
            });
        }
        const tags = database.listCategoryRuleTags(ruleId);
        return { items: tags };
    });
    // Category Rule Tags — Set tags for a rule (replace all)
    app.put("/alarm-categories/:ruleId/tags", { preHandler: requireRole("administrator") }, async (request, reply) => {
        const { ruleId } = ruleIdParamsSchema.parse(request.params);
        // Verify rule exists
        const existingRule = database.getCategoryAlarmRule(ruleId);
        if (!existingRule) {
            return reply.code(404).send({
                error: "not_found",
                message: "Category alarm rule was not found",
            });
        }
        const input = z.array(z.string().trim()).parse(request.body);
        // Validate all register IDs exist in the category
        const validRegisterIds = new Set();
        for (const registerId of input) {
            const register = database.getRegister(registerId);
            if (!register || register.deviceId !== existingRule.category_id) {
                return reply.code(400).send({
                    error: "invalid_register",
                    message: `Register ${registerId} is not in category ${existingRule.category_name}`,
                });
            }
            validRegisterIds.add(registerId);
        }
        database.setCategoryRuleTags(ruleId, Array.from(validRegisterIds));
        database.appendAudit({
            actorId: request.principal?.id,
            action: "category_alarm_rule.tags_update",
            entityType: "alarm_category_rule",
            entityId: ruleId,
            details: { categoryId: existingRule.category_id, tagCount: input.length },
            sourceIp: request.ip,
        });
        return reply.code(204).send();
    });
    app.post("/alarms/:id/acknowledge", { preHandler: requireRole("administrator", "operator") }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        const acknowledged = database.acknowledgeAlarm(id, request.principal?.id ?? "");
        if (!acknowledged) {
            return reply.code(404).send({
                error: "not_found",
                message: "Active unacknowledged alarm was not found",
            });
        }
        database.appendAudit({
            actorId: request.principal?.id,
            action: "alarm.acknowledge",
            entityType: "alarm",
            entityId: id,
            sourceIp: request.ip,
        });
        return reply.code(204).send();
    });
    app.get("/alerts/system", { preHandler: authenticate }, async (request) => {
        const query = systemAlertsQuerySchema.parse(request.query);
        return { items: database.listSystemAlerts(query) };
    });
    app.post("/alerts/system/:id/acknowledge", { preHandler: requireRole("administrator", "operator") }, async (request, reply) => {
        const { id } = idParamsSchema.parse(request.params);
        const acknowledged = database.acknowledgeSystemAlert(id, request.principal?.id ?? "");
        if (!acknowledged) {
            return reply.code(404).send({
                error: "not_found",
                message: "Unacknowledged system alert was not found",
            });
        }
        database.appendAudit({
            actorId: request.principal?.id,
            action: "system_alert.acknowledge",
            entityType: "system_alert",
            entityId: id,
            sourceIp: request.ip,
        });
        return reply.code(204).send();
    });
    app.get("/settings/alerts/whatsapp", { preHandler: requireRole("administrator") }, async () => systemAlerts.getPublicSettings());
    app.put("/settings/alerts/whatsapp", { preHandler: requireRole("administrator") }, async (request) => {
        const input = whatsAppAlertSettingsSchema.parse(request.body);
        const settings = systemAlerts.saveSettings(input);
        database.appendAudit({
            actorId: request.principal?.id,
            action: "whatsapp_alert_settings.update",
            entityType: "settings",
            entityId: "whatsapp_alerts",
            details: {
                enabled: settings.enabled,
                recipientCount: settings.recipients.length,
                sendRecovery: settings.sendRecovery,
                offlineDelaySeconds: settings.offlineDelaySeconds,
            },
            sourceIp: request.ip,
        });
        return settings;
    });
    app.post("/settings/alerts/whatsapp/test", {
        preHandler: requireRole("administrator"),
        config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    }, async (request) => {
        const input = request.body === undefined
            ? undefined
            : whatsAppAlertSettingsSchema.parse(request.body);
        const result = await systemAlerts.testWhatsApp(input);
        database.appendAudit({
            actorId: request.principal?.id,
            action: "whatsapp_alert_settings.test",
            entityType: "settings",
            entityId: "whatsapp_alerts",
            details: {
                ok: result.ok,
                recipientCount: result.recipientCount,
            },
            sourceIp: request.ip,
        });
        return result;
    });
}
//# sourceMappingURL=routes.js.map