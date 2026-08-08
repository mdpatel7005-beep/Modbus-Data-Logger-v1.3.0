import { z } from "zod";
import { env } from "../config/env.js";
import { SystemAdministrationError, } from "../services/system-admin.js";
const UPDATE_MAX_BYTES = 100 * 1024 * 1024;
const VPN_MAX_BYTES = 1024 * 1024;
const RESTORE_MAX_BYTES = 128 * 1024 * 1024;
const restoreSchema = z
    .object({
    backup: z.string().min(1).max(RESTORE_MAX_BYTES),
    confirmation: z.literal("RESTORE CONFIGURATION"),
})
    .strict();
const factoryResetSchema = z
    .object({
    currentPassword: z.string().min(1).max(10_000),
    confirmation: z.literal("FACTORY RESET"),
})
    .strict();
const openVpnStateSchema = z
    .object({
    enabled: z.boolean(),
})
    .strict();
function singleHeader(value) {
    return typeof value === "string" ? value.trim() : "";
}
export async function registerSystemRoutes(app, dependencies) {
    const { auth, poller, postgresHistorian, systemAdministration, systemAlerts, dataServers, } = dependencies;
    let administrationTail = Promise.resolve();
    app.addContentTypeParser("application/octet-stream", {
        parseAs: "buffer",
        bodyLimit: UPDATE_MAX_BYTES,
    }, (_request, body, done) => done(null, body));
    async function requireAdministrator(request, reply) {
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
        if (principal.role !== "administrator") {
            await reply.code(403).send({
                error: "forbidden",
                message: "Administrator access is required",
            });
        }
    }
    function auditContext(request) {
        return {
            actorId: request.principal?.id,
            sourceIp: request.ip,
        };
    }
    function sendSystemError(error, reply) {
        if (error instanceof SystemAdministrationError) {
            return reply.code(error.statusCode).send({
                error: error.code,
                message: error.message,
            });
        }
        throw error;
    }
    async function serializeAdministration(operation) {
        const previous = administrationTail;
        let release = () => { };
        const current = new Promise((resolve) => {
            release = resolve;
        });
        administrationTail = previous.then(() => current, () => current);
        await previous.catch(() => undefined);
        try {
            return await operation();
        }
        finally {
            release();
        }
    }
    async function resumeCollector() {
        let historianReloaded = false;
        let pollingRestarted = false;
        let dataServersReloaded = false;
        try {
            await postgresHistorian.reloadSettings();
            historianReloaded = true;
        }
        catch (error) {
            app.log.error({
                error: error instanceof Error ? error.message : String(error),
            }, "system configuration was applied but historian reload failed");
        }
        finally {
            postgresHistorian.resume();
            systemAlerts.resume();
        }
        try {
            await poller.resumeAndStart();
            pollingRestarted = true;
        }
        catch (error) {
            app.log.error({
                error: error instanceof Error ? error.message : String(error),
            }, "system configuration was applied but polling restart failed");
        }
        try {
            await dataServers.reload();
            dataServersReloaded = true;
        }
        catch (error) {
            app.log.error({
                error: error instanceof Error ? error.message : String(error),
            }, "system configuration was applied but data-server reload failed");
        }
        const collectorReloaded = historianReloaded && pollingRestarted && dataServersReloaded;
        return { collectorReloaded, restartRequired: !collectorReloaded };
    }
    async function withCollectorQuiesced(operation) {
        try {
            await poller.pauseAndDrain();
        }
        catch (error) {
            throw new SystemAdministrationError(503, "collector_busy", error instanceof Error
                ? error.message
                : "Modbus polling is still active; try again shortly");
        }
        try {
            await postgresHistorian.pauseAndDrain();
        }
        catch (error) {
            postgresHistorian.resume();
            await poller.resumeAndStart().catch((resumeError) => {
                app.log.error({
                    error: resumeError instanceof Error
                        ? resumeError.message
                        : String(resumeError),
                }, "polling restart failed after PostgreSQL drain was aborted");
            });
            throw new SystemAdministrationError(503, "collector_busy", error instanceof Error
                ? error.message
                : "Remote PostgreSQL work is still active; try again shortly");
        }
        await systemAlerts.pauseAndDrain();
        await dataServers.stop();
        let result;
        let operationError;
        try {
            result = await operation();
        }
        catch (error) {
            operationError = error;
        }
        const reload = await resumeCollector();
        if (operationError)
            throw operationError;
        return { result: result, ...reload };
    }
    app.get("/settings/system", { onRequest: requireAdministrator }, async () => systemAdministration.getStatus());
    app.get("/settings/configuration/backup", { onRequest: requireAdministrator }, async (request, reply) => {
        try {
            const backup = await serializeAdministration(() => systemAdministration.createConfigurationBackup(auditContext(request)));
            const date = new Date().toISOString().slice(0, 10);
            return reply
                .header("content-type", "text/plain; charset=utf-8")
                .header("content-disposition", `attachment; filename="modbus-data-logger-configuration-${date}.backup"`)
                .send(backup);
        }
        catch (error) {
            return sendSystemError(error, reply);
        }
    });
    app.post("/settings/configuration/restore", {
        bodyLimit: RESTORE_MAX_BYTES,
        onRequest: requireAdministrator,
    }, async (request, reply) => {
        const input = restoreSchema.parse(request.body);
        try {
            const outcome = await serializeAdministration(() => withCollectorQuiesced(() => systemAdministration.restoreConfigurationBackup(input.backup, auditContext(request))));
            return reply.code(200).send({
                ok: true,
                message: outcome.collectorReloaded
                    ? "Configuration restored and collector reloaded"
                    : "Configuration restored; restart the collector to apply every setting",
                restoredAt: outcome.result.restoredAt,
                collectorReloaded: outcome.collectorReloaded,
                restartRequired: outcome.restartRequired,
            });
        }
        catch (error) {
            return sendSystemError(error, reply);
        }
    });
    app.post("/settings/factory-reset", { onRequest: requireAdministrator }, async (request, reply) => {
        const input = factoryResetSchema.parse(request.body);
        const principal = request.principal;
        if (!principal ||
            !(await auth.verifyPassword(principal.id, input.currentPassword))) {
            return reply.code(403).send({
                error: "invalid_current_password",
                message: "The current administrator password is incorrect",
            });
        }
        try {
            const outcome = await serializeAdministration(() => withCollectorQuiesced(() => systemAdministration.factoryReset(auditContext(request))));
            return reply.code(200).send({
                ok: true,
                message: outcome.collectorReloaded
                    ? "Factory reset completed and collector reloaded"
                    : "Factory reset completed; restart the collector to finish applying it",
                resetAt: outcome.result.resetAt,
                collectorReloaded: outcome.collectorReloaded,
                restartRequired: outcome.restartRequired,
            });
        }
        catch (error) {
            return sendSystemError(error, reply);
        }
    });
    app.post("/settings/system/update/stage", {
        bodyLimit: UPDATE_MAX_BYTES,
        onRequest: requireAdministrator,
    }, async (request, reply) => {
        const version = singleHeader(request.headers["x-update-version"]);
        const filename = singleHeader(request.headers["x-file-name"]);
        if (!version || !filename || !Buffer.isBuffer(request.body)) {
            return reply.code(400).send({
                error: "invalid_update_upload",
                message: "A binary body, x-update-version, and x-file-name are required",
            });
        }
        const contents = request.body;
        try {
            const result = await serializeAdministration(() => systemAdministration.stageUpdate(contents, version, filename, auditContext(request)));
            return reply.code(201).send({
                message: `Update ${result.version} staged`,
                stagedVersion: result.version,
                stagedFilename: result.filename,
                stagedSha256: result.sha256,
                stagedAt: result.stagedAt,
            });
        }
        catch (error) {
            return sendSystemError(error, reply);
        }
    });
    app.post("/settings/system/update/apply", { onRequest: requireAdministrator }, async (request, reply) => {
        try {
            const result = await serializeAdministration(() => systemAdministration.applyUpdate(auditContext(request)));
            return reply.code(202).send({
                message: `Update ${result.version} accepted by the system helper`,
                accepted: true,
                stagedVersion: result.version,
            });
        }
        catch (error) {
            return sendSystemError(error, reply);
        }
    });
    app.post("/settings/system/openvpn/profile", {
        bodyLimit: VPN_MAX_BYTES,
        onRequest: requireAdministrator,
    }, async (request, reply) => {
        const filename = singleHeader(request.headers["x-file-name"]);
        if (!filename || !Buffer.isBuffer(request.body)) {
            return reply.code(400).send({
                error: "invalid_openvpn_upload",
                message: "A binary .ovpn body and x-file-name are required",
            });
        }
        const contents = request.body;
        try {
            const result = await serializeAdministration(() => systemAdministration.saveOpenVpnProfile(contents, filename, auditContext(request)));
            return reply.code(201).send({
                message: `OpenVPN profile ${result.profileName} saved`,
                ...result,
            });
        }
        catch (error) {
            return sendSystemError(error, reply);
        }
    });
    app.put("/settings/system/openvpn", { onRequest: requireAdministrator }, async (request, reply) => {
        const input = openVpnStateSchema.parse(request.body);
        try {
            const result = await serializeAdministration(() => systemAdministration.setOpenVpnEnabled(input.enabled, auditContext(request)));
            return reply.code(200).send({
                message: result.enabled
                    ? "OpenVPN connection requested"
                    : "OpenVPN disconnection requested",
                ...result,
            });
        }
        catch (error) {
            return sendSystemError(error, reply);
        }
    });
}
//# sourceMappingURL=system-routes.js.map