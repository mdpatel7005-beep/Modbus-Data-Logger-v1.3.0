import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "modbus-customer-subscription-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(temporaryRoot, "http.db");
process.env.SYSTEM_ADMIN_DATA_DIR = path.join(temporaryRoot, "system-admin");
process.env.AUTH_DISABLED = "false";
process.env.POLLING_ENABLED = "false";
process.env.JWT_SECRET =
    "customer-subscription-test-secret-more-than-32-characters";
process.env.SETTINGS_ENCRYPTION_KEY =
    "customer-subscription-encryption-key-more-than-32-characters";
process.env.INITIAL_ADMIN_USERNAME = "admin";
process.env.INITIAL_ADMIN_PASSWORD = "admin";
process.env.LICENSE_ACTIVATION_DAYS = "14";
delete process.env.POSTGRES_URL;
const { LoggerDatabase } = await import("../src/db/database.js");
const { AuthService } = await import("../src/services/auth.js");
const { SystemAdministrationService } = await import("../src/services/system-admin.js");
const { decryptSecret } = await import("../src/services/secret-box.js");
const { buildApplication } = await import("../src/app.js");
const customer = {
    companyName: "North Plant Industries",
    customerCode: "NPI/001",
    contactPerson: "Operations Manager",
    contactEmail: "operations@example.test",
    contactPhone: "+91 98765 43210",
    siteName: "North switching station",
    siteAddress: "Industrial estate, North Zone",
    notes: "Primary production installation",
};
test.after(() => rmSync(temporaryRoot, { force: true, recursive: true }));
test("customer API is authenticated, role-aware, strict, and audited", async (context) => {
    const app = await buildApplication();
    await app.ready();
    context.after(() => app.close());
    const unauthenticated = await app.inject({
        method: "GET",
        url: "/api/v1/settings/customer",
    });
    assert.equal(unauthenticated.statusCode, 401);
    const unauthenticatedSummary = await app.inject({
        method: "GET",
        url: "/api/v1/settings/customer/summary",
    });
    assert.equal(unauthenticatedSummary.statusCode, 401);
    const adminLogin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: "admin", password: "admin" },
    });
    assert.equal(adminLogin.statusCode, 200);
    const adminToken = adminLogin.json().token;
    const adminHeaders = { authorization: `Bearer ${adminToken}` };
    const initial = await app.inject({
        method: "GET",
        url: "/api/v1/settings/customer",
        headers: adminHeaders,
    });
    assert.equal(initial.statusCode, 200);
    const initialBody = initial.json();
    assert.equal(initialBody.customer.companyName, "");
    assert.match(initialBody.subscription.installationId, /^installation_/);
    assert.equal(initialBody.subscription.status, "unlicensed");
    assert.ok(initialBody.subscription.activationDaysRemaining === 14 ||
        initialBody.subscription.activationDaysRemaining === 13);
    assert.match(initialBody.subscription.message, /Activation required/);
    const initialSummary = await app.inject({
        method: "GET",
        url: "/api/v1/settings/customer/summary",
        headers: adminHeaders,
    });
    assert.equal(initialSummary.statusCode, 200);
    assert.deepEqual(initialSummary.json(), {
        customer: {
            companyName: "",
            siteName: "",
        },
        subscription: {
            status: initialBody.subscription.status,
            activationDaysRemaining: initialBody.subscription.activationDaysRemaining,
            subscriptionDaysRemaining: null,
            message: initialBody.subscription.message,
        },
    });
    const updated = await app.inject({
        method: "PUT",
        url: "/api/v1/settings/customer",
        headers: adminHeaders,
        payload: customer,
    });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual(updated.json().customer, {
        ...customer,
        updatedAt: updated.json().customer
            .updatedAt,
    });
    const forgedLicense = await app.inject({
        method: "PUT",
        url: "/api/v1/settings/customer",
        headers: adminHeaders,
        payload: {
            ...customer,
            subscription: { status: "active" },
        },
    });
    assert.equal(forgedLicense.statusCode, 400);
    const database = new LoggerDatabase(process.env.DATABASE_PATH);
    const auth = new AuthService(database);
    const viewer = await auth.createManagedUser({
        username: "monitor",
        password: "monitor",
        role: "viewer",
        enabled: true,
    });
    assert.equal(viewer.role, "viewer");
    database.close();
    const viewerLogin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: "monitor", password: "monitor" },
    });
    assert.equal(viewerLogin.statusCode, 200);
    const viewerHeaders = {
        authorization: `Bearer ${viewerLogin.json().token}`,
    };
    const viewerFull = await app.inject({
        method: "GET",
        url: "/api/v1/settings/customer",
        headers: viewerHeaders,
    });
    assert.equal(viewerFull.statusCode, 403);
    const viewerSummary = await app.inject({
        method: "GET",
        url: "/api/v1/settings/customer/summary",
        headers: viewerHeaders,
    });
    assert.equal(viewerSummary.statusCode, 200);
    assert.deepEqual(viewerSummary.json(), {
        customer: {
            companyName: customer.companyName,
            siteName: customer.siteName,
        },
        subscription: {
            status: initialBody.subscription.status,
            activationDaysRemaining: initialBody.subscription.activationDaysRemaining,
            subscriptionDaysRemaining: null,
            message: initialBody.subscription.message,
        },
    });
    assert.equal((await app.inject({
        method: "PUT",
        url: "/api/v1/settings/customer",
        headers: viewerHeaders,
        payload: customer,
    })).statusCode, 403);
    const activity = await app.inject({
        method: "GET",
        url: "/api/v1/activity?search=customer_profile.update",
        headers: adminHeaders,
    });
    assert.equal(activity.statusCode, 200);
    assert.equal(activity.json().items[0]?.event, "customer_profile.update");
});
test("trusted subscription state computes expiry without an HTTP mutation surface", (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "modbus-license-state-"));
    context.after(() => rmSync(directory, { force: true, recursive: true }));
    const databasePath = path.join(directory, "logger.db");
    const database = new LoggerDatabase(databasePath, {
        initialActivationDays: 10,
    });
    const installationId = database.getCustomerSubscriptionSettings(new Date("2026-01-01T00:00:00.000Z")).subscription.installationId;
    database.applySubscriptionStateFromTrustedMaster({
        status: "active",
        plan: "Industrial",
        subscriptionReference: "SUB-1001",
        activationDueAt: "2026-01-15T00:00:00.000Z",
        activatedAt: "2026-01-02T00:00:00.000Z",
        expiresAt: "2026-02-01T00:00:00.000Z",
        graceEndsAt: "2026-02-08T00:00:00.000Z",
        lastCheckedAt: "2026-01-10T00:00:00.000Z",
    });
    const active = database.getCustomerSubscriptionSettings(new Date("2026-01-20T00:00:00.000Z")).subscription;
    assert.equal(active.status, "active");
    assert.equal(active.activationDaysRemaining, null);
    assert.equal(active.subscriptionDaysRemaining, 12);
    assert.equal(active.installationId, installationId);
    const grace = database.getCustomerSubscriptionSettings(new Date("2026-02-02T00:00:00.000Z")).subscription;
    assert.equal(grace.status, "grace");
    assert.equal(grace.subscriptionDaysRemaining, 6);
    const expired = database.getCustomerSubscriptionSettings(new Date("2026-02-09T00:00:00.000Z")).subscription;
    assert.equal(expired.status, "expired");
    assert.equal(expired.subscriptionDaysRemaining, 0);
    database.close();
    const reopened = new LoggerDatabase(databasePath, {
        initialActivationDays: 99,
    });
    assert.equal(reopened.getCustomerSubscriptionSettings().subscription.installationId, installationId);
    reopened.close();
});
test("backup restores customer configuration while reset and restore preserve licensing", async (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "modbus-customer-backup-"));
    context.after(() => rmSync(directory, { force: true, recursive: true }));
    const database = new LoggerDatabase(path.join(directory, "logger.db"));
    const administration = new SystemAdministrationService(database, {
        dataDirectory: path.join(directory, "system-admin"),
    });
    database.saveCustomerProfile(customer);
    database.applySubscriptionStateFromTrustedMaster({
        status: "active",
        plan: "Industrial",
        subscriptionReference: "SUB-PRESERVED",
        activationDueAt: null,
        activatedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2027-01-01T00:00:00.000Z",
        graceEndsAt: "2027-01-08T00:00:00.000Z",
        lastCheckedAt: "2026-07-27T00:00:00.000Z",
    });
    const before = database.getCustomerSubscriptionSettings().subscription;
    const backup = administration.createConfigurationBackup({});
    const envelope = JSON.parse(decryptSecret(backup.slice("modbus-data-logger-backup.v1.".length)));
    assert.equal(Array.isArray(envelope.data.customerProfile), true);
    assert.equal("subscriptionState" in envelope.data, false);
    assert.equal("license" in envelope.data, false);
    database.saveCustomerProfile({ ...customer, companyName: "Changed" });
    database.applySubscriptionStateFromTrustedMaster({
        status: "expired",
        plan: "Industrial",
        subscriptionReference: "SUB-PRESERVED",
        activationDueAt: null,
        activatedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-06-01T00:00:00.000Z",
        graceEndsAt: "2026-06-08T00:00:00.000Z",
        lastCheckedAt: "2026-07-28T00:00:00.000Z",
    });
    await administration.restoreConfigurationBackup(backup, {});
    const restored = database.getCustomerSubscriptionSettings();
    assert.equal(restored.customer.companyName, customer.companyName);
    assert.equal(restored.subscription.status, "expired");
    assert.equal(restored.subscription.installationId, before.installationId);
    assert.equal(restored.subscription.lastCheckedAt, "2026-07-28T00:00:00.000Z");
    await administration.factoryReset({});
    const reset = database.getCustomerSubscriptionSettings();
    assert.equal(reset.customer.companyName, "");
    assert.equal(reset.customer.customerCode, "");
    assert.equal(reset.subscription.status, "expired");
    assert.equal(reset.subscription.installationId, before.installationId);
    database.close();
});
//# sourceMappingURL=customer-subscription.test.js.map