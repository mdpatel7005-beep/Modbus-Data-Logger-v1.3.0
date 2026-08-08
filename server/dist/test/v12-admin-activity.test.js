import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import SqliteDatabase from "better-sqlite3";
import { SignJWT } from "jose";
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "modbus-data-logger-v12-http-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(temporaryRoot, "http.db");
process.env.AUTH_DISABLED = "false";
process.env.POLLING_ENABLED = "false";
process.env.JWT_SECRET = "v12-test-secret-with-more-than-32-characters";
process.env.INITIAL_ADMIN_USERNAME = "admin";
process.env.INITIAL_ADMIN_PASSWORD = "admin";
delete process.env.POSTGRES_URL;
const { LoggerDatabase, MAX_ACTIVITY_LOG_ENTRIES } = await import("../src/db/database.js");
const { AuthService } = await import("../src/services/auth.js");
const { buildApplication } = await import("../src/app.js");
test("authentication fails closed for unknown users and invalidates sessions after account changes", async (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "modbus-v12-auth-"));
    context.after(() => rmSync(directory, { force: true, recursive: true }));
    const database = new LoggerDatabase(path.join(directory, "logger.db"));
    context.after(() => database.close());
    const auth = new AuthService(database);
    await auth.ensureInitialAdministrator();
    const administrator = database.getUserByUsername("admin");
    assert.ok(administrator);
    const unknownUserToken = await new SignJWT({
        username: "ghost-administrator",
        role: "administrator",
        tokenVersion: 0,
    })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer("modbus-data-logger")
        .setSubject("usr_missing")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(new TextEncoder().encode("v12-test-secret-with-more-than-32-characters"));
    assert.equal(await auth.verify(unknownUserToken), null);
    const viewer = await auth.createManagedUser({
        username: "session-monitor",
        password: "x",
        role: "viewer",
        enabled: true,
    });
    const login = await auth.login("session-monitor", "x");
    assert.ok(login);
    assert.equal((await auth.verify(login.token))?.role, "viewer");
    database.updateUser(viewer.id, { role: "diagnostic" }, administrator.id);
    assert.equal(await auth.verify(login.token), null);
    const diagnosticLogin = await auth.login("session-monitor", "x");
    assert.ok(diagnosticLogin);
    assert.equal((await auth.verify(diagnosticLogin.token))?.role, "diagnostic");
    database.updateUser(viewer.id, { enabled: false }, administrator.id);
    database.updateUser(viewer.id, { enabled: true }, administrator.id);
    assert.equal(await auth.verify(diagnosticLogin.token), null);
});
test("does not recreate a deleted bootstrap account while another admin exists", async (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "modbus-v12-bootstrap-"));
    context.after(() => rmSync(directory, { force: true, recursive: true }));
    const database = new LoggerDatabase(path.join(directory, "logger.db"));
    context.after(() => database.close());
    const auth = new AuthService(database);
    await auth.ensureInitialAdministrator();
    const bootstrap = database.getUserByUsername("admin");
    assert.ok(bootstrap);
    const replacement = await auth.createManagedUser({
        username: "replacement-admin",
        password: "replacement",
        role: "administrator",
        enabled: true,
    });
    database.deleteUser(bootstrap.id, replacement.id);
    await auth.ensureInitialAdministrator();
    assert.equal(database.getUserByUsername("admin"), undefined);
    assert.equal(database.listUsers().filter((user) => user.enabled && user.role === "administrator").length, 1);
});
test("migrates the existing user role constraint without losing accounts", (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "modbus-v12-migration-"));
    context.after(() => rmSync(directory, { force: true, recursive: true }));
    const databasePath = path.join(directory, "legacy.db");
    const legacy = new SqliteDatabase(databasePath);
    legacy
        .prepare(`CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (
          role IN ('administrator', 'operator', 'viewer')
        ),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      )`)
        .run();
    legacy
        .prepare(`INSERT INTO users (
         id, username, password_hash, role, enabled, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`)
        .run("usr_legacy", "legacy-admin", "preserved-password-hash", "administrator", 0, "2026-07-01T01:02:03.000Z");
    legacy.close();
    const database = new LoggerDatabase(databasePath);
    context.after(() => database.close());
    const migrated = database.getUserById("usr_legacy");
    assert.deepEqual(migrated, {
        id: "usr_legacy",
        username: "legacy-admin",
        password_hash: "preserved-password-hash",
        role: "administrator",
        enabled: 0,
        created_at: "2026-07-01T01:02:03.000Z",
    });
    const diagnostic = database.createUser({
        username: "diagnostic",
        passwordHash: "hash",
        role: "diagnostic",
    });
    assert.equal(diagnostic.role, "diagnostic");
    assert.deepEqual(database.connection.pragma("foreign_key_check"), []);
});
test("overview, activity redaction, status transitions, and cap use real data", (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "modbus-v12-data-"));
    context.after(() => rmSync(directory, { force: true, recursive: true }));
    const database = new LoggerDatabase(path.join(directory, "logger.db"));
    context.after(() => database.close());
    const device = database.createDevice({
        name: "Configured meter",
        protocol: "tcp",
        tcpHost: "10.20.30.40",
        tcpPort: 502,
        unitId: 1,
        pollIntervalMs: 1_000,
        readBlockSize: 120,
        timeoutMs: 2_000,
        retries: 2,
        postgresEnabled: false,
        saveIntervalMs: 1_000,
        postgresRawTable: "configured_meter_raw",
        postgresDownsampleTable: "configured_meter_1m",
        postgresDownsampleEnabled: true,
        postgresDownsampleIntervalSec: 60,
        postgresRawRetentionDays: 30,
        postgresDownsampleRetentionDays: 365,
        postgresMaintenanceIntervalHours: 24,
        enabled: true,
    });
    const register = database.createRegister({
        deviceId: device.id,
        name: "Voltage",
        address: 0,
        functionCode: 3,
        dataType: "uint16",
        byteOrder: "ABCD",
        scale: 1,
        offset: 0,
        unit: "V",
        enabled: true,
    });
    database.insertReadings([
        {
            registerId: register.id,
            deviceId: device.id,
            value: 230,
            raw: [230],
            quality: "good",
            timestamp: new Date().toISOString(),
        },
    ]);
    database.updateDeviceHealth(device.id, "online", {
        lastSeenAt: new Date().toISOString(),
        lastPollMs: 25,
    });
    database.updateDeviceHealth(device.id, "online", {
        lastSeenAt: new Date().toISOString(),
        lastPollMs: 26,
    });
    database.appendAudit({
        action: "settings.test",
        entityType: "settings",
        details: {
            safe: "visible",
            password: "must-not-appear",
            nested: { accessToken: "must-not-appear" },
        },
    });
    const overview = database.getOverview();
    assert.equal(overview.deviceSummaries.length, 1);
    assert.deepEqual(overview.deviceSummaries[0], {
        id: device.id,
        name: "Configured meter",
        protocol: "tcp",
        status: "online",
        endpoint: "10.20.30.40:502",
        tagCount: 1,
        categoryName: null,
        groupName: null,
        lastSeenAt: overview.deviceSummaries[0]?.lastSeenAt,
        lastPollMs: 26,
        lastError: null,
    });
    assert.equal(overview.sampleTrend.length, 24);
    assert.equal(overview.sampleTrend.reduce((sum, bucket) => sum + bucket.samples, 0), 1);
    assert.equal(overview.activitySummary.samplesLast24Hours, 1);
    assert.equal(overview.activitySummary.statusTransitionsLast24Hours, 1);
    const activity = database.listActivity({ page: 1, pageSize: 20 });
    assert.equal(activity.items.filter((item) => item.event === "device.status_changed")
        .length, 1);
    const audit = activity.items.find((item) => item.event === "settings.test");
    assert.deepEqual(audit?.details, {
        safe: "visible",
        password: "[redacted]",
        nested: { accessToken: "[redacted]" },
    });
    assert.equal(JSON.stringify(audit?.details).includes("must-not-appear"), false);
    const insert = database.connection.prepare(`INSERT INTO activity_log (
       timestamp, level, category, event, message, details_json
     ) VALUES (?, 'info', 'system', 'capacity.test', 'Capacity test', '{}')`);
    database.connection.transaction(() => {
        for (let index = activity.total; index < MAX_ACTIVITY_LOG_ENTRIES; index += 1) {
            insert.run(new Date().toISOString());
        }
    })();
    database.appendActivity({
        level: "info",
        category: "system",
        event: "capacity.trigger",
        message: "Trigger bounded cleanup",
    });
    const count = database.connection
        .prepare("SELECT COUNT(*) AS count FROM activity_log")
        .get();
    assert.equal(count.count, MAX_ACTIVITY_LOG_ENTRIES);
});
test("admin manages monitoring and diagnostic users with protected invariants", async () => {
    const app = await buildApplication();
    await app.ready();
    try {
        const login = await app.inject({
            method: "POST",
            url: "/api/v1/auth/login",
            payload: { username: "admin", password: "admin" },
        });
        assert.equal(login.statusCode, 200);
        const adminUser = login.json();
        const adminHeaders = {
            authorization: `Bearer ${adminUser.token}`,
        };
        const viewerResponse = await app.inject({
            method: "POST",
            url: "/api/v1/users",
            headers: adminHeaders,
            payload: {
                username: "monitor",
                password: "x",
                role: "viewer",
            },
        });
        assert.equal(viewerResponse.statusCode, 201);
        const viewer = viewerResponse.json();
        assert.equal(viewer.enabled, true);
        assert.equal("passwordHash" in viewerResponse.json(), false);
        const diagnosticResponse = await app.inject({
            method: "POST",
            url: "/api/v1/users",
            headers: adminHeaders,
            payload: {
                username: "diagnostic",
                password: "d",
                role: "diagnostic",
            },
        });
        assert.equal(diagnosticResponse.statusCode, 201);
        const viewerLogin = await app.inject({
            method: "POST",
            url: "/api/v1/auth/login",
            payload: { username: "monitor", password: "x" },
        });
        const viewerHeaders = {
            authorization: `Bearer ${viewerLogin.json().token}`,
        };
        assert.equal((await app.inject({
            method: "GET",
            url: "/api/v1/overview",
            headers: viewerHeaders,
        })).statusCode, 200);
        assert.equal((await app.inject({
            method: "GET",
            url: "/api/v1/activity",
            headers: viewerHeaders,
        })).statusCode, 403);
        assert.equal((await app.inject({
            method: "GET",
            url: "/api/v1/users",
            headers: viewerHeaders,
        })).statusCode, 403);
        const diagnosticLogin = await app.inject({
            method: "POST",
            url: "/api/v1/auth/login",
            payload: { username: "diagnostic", password: "d" },
        });
        const diagnosticHeaders = {
            authorization: `Bearer ${diagnosticLogin.json().token}`,
        };
        const maliciousLogin = await app.inject({
            method: "POST",
            url: "/api/v1/auth/login",
            payload: { username: "=2+2", password: "wrong" },
        });
        assert.equal(maliciousLogin.statusCode, 401);
        const activity = await app.inject({
            method: "GET",
            url: "/api/v1/activity?page=1&pageSize=1&category=audit",
            headers: diagnosticHeaders,
        });
        assert.equal(activity.statusCode, 200);
        assert.equal(activity.json().pageSize, 1);
        assert.ok(activity.json().total >= 1);
        assert.equal((await app.inject({
            method: "GET",
            url: "/api/v1/activity/export?category=audit",
            headers: diagnosticHeaders,
        })).headers["content-type"], "text/csv; charset=utf-8");
        const injectionSafeExport = await app.inject({
            method: "GET",
            url: "/api/v1/activity/export?category=system&search=%3D2%2B2",
            headers: diagnosticHeaders,
        });
        assert.equal(injectionSafeExport.statusCode, 200);
        assert.match(injectionSafeExport.body, /'=2\+2/);
        assert.equal((await app.inject({
            method: "POST",
            url: "/api/v1/devices",
            headers: diagnosticHeaders,
            payload: {},
        })).statusCode, 403);
        const disableSelf = await app.inject({
            method: "PATCH",
            url: `/api/v1/users/${adminUser.user.id}`,
            headers: adminHeaders,
            payload: { enabled: false },
        });
        assert.equal(disableSelf.statusCode, 409);
        assert.equal(disableSelf.json().error, "self_protection");
        const demoteLastAdmin = await app.inject({
            method: "PATCH",
            url: `/api/v1/users/${adminUser.user.id}`,
            headers: adminHeaders,
            payload: { role: "viewer" },
        });
        assert.equal(demoteLastAdmin.statusCode, 409);
        assert.equal(demoteLastAdmin.json().error, "last_administrator");
        const deleteSelf = await app.inject({
            method: "DELETE",
            url: `/api/v1/users/${adminUser.user.id}`,
            headers: adminHeaders,
        });
        assert.equal(deleteSelf.statusCode, 409);
        assert.equal(deleteSelf.json().error, "self_protection");
        const resetPassword = await app.inject({
            method: "POST",
            url: `/api/v1/users/${viewer.id}/reset-password`,
            headers: adminHeaders,
            payload: { password: "1" },
        });
        assert.equal(resetPassword.statusCode, 204);
        assert.equal((await app.inject({
            method: "GET",
            url: "/api/v1/overview",
            headers: viewerHeaders,
        })).statusCode, 401);
        assert.equal((await app.inject({
            method: "POST",
            url: "/api/v1/auth/login",
            payload: { username: "monitor", password: "1" },
        })).statusCode, 200);
        const disableViewer = await app.inject({
            method: "PATCH",
            url: `/api/v1/users/${viewer.id}`,
            headers: adminHeaders,
            payload: { enabled: false },
        });
        assert.equal(disableViewer.statusCode, 200);
        assert.equal((await app.inject({
            method: "POST",
            url: "/api/v1/auth/login",
            payload: { username: "monitor", password: "1" },
        })).statusCode, 401);
        const users = await app.inject({
            method: "GET",
            url: "/api/v1/users",
            headers: adminHeaders,
        });
        assert.equal(users.statusCode, 200);
        assert.equal(JSON.stringify(users.json()).includes("password_hash"), false);
    }
    finally {
        await app.close();
        rmSync(temporaryRoot, { force: true, recursive: true });
    }
});
//# sourceMappingURL=v12-admin-activity.test.js.map