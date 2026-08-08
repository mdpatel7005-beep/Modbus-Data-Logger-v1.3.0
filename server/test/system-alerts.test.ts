import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { FastifyBaseLogger } from "fastify";

const applicationRoot = mkdtempSync(
  path.join(tmpdir(), "modbus-system-alert-http-"),
);

process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(applicationRoot, "logger.db");
process.env.AUTH_DISABLED = "false";
process.env.POLLING_ENABLED = "false";
process.env.JWT_SECRET = "system-alert-test-secret-with-32-characters";
process.env.INITIAL_ADMIN_USERNAME = "admin";
process.env.INITIAL_ADMIN_PASSWORD = "admin";
delete process.env.POSTGRES_URL;

const { LoggerDatabase } = await import("../src/db/database.js");
const { buildApplication } = await import("../src/app.js");
const { SystemAlertService } = await import("../src/services/system-alerts.js");
const { SystemAdministrationService } =
  await import("../src/services/system-admin.js");
const { PostgresHistorian } =
  await import("../src/services/postgres-historian.js");
const { decryptSecret, encryptSecret } =
  await import("../src/services/secret-box.js");

const logger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
} as unknown as FastifyBaseLogger;

function settingsInput(accessToken = "meta-secret-token") {
  return {
    enabled: true,
    recipients: ["919876543210"],
    graphApiVersion: "v23.0",
    phoneNumberId: "123456789012345",
    templateName: "modbus_system_alert",
    language: "en_US",
    sendRecovery: true,
    offlineDelaySeconds: 10,
    accessToken,
  };
}

function postgresSettingsInput(
  overrides: Partial<{
    enabled: boolean;
    host: string;
    database: string;
  }> = {},
) {
  return {
    enabled: true,
    host: "db.example.internal",
    port: 5432,
    database: "logger",
    username: "logger",
    sslMode: "require" as const,
    historianTimezone: "UTC",
    autoDownsampleEnabled: true,
    defaultRawTable: "modbus_raw",
    defaultDownsampleTable: "modbus_1m",
    defaultDownsampleIntervalSec: 60,
    rawRetentionDays: 30,
    downsampleRetentionDays: 365,
    maintenanceIntervalHours: 24,
    offlineCacheEnabled: true,
    offlineCacheMaxRows: 100_000,
    ...overrides,
  };
}

function createDevice(database: InstanceType<typeof LoggerDatabase>) {
  const device = database.createDevice({
    name: "Boiler PLC",
    protocol: "tcp",
    tcpHost: "192.0.2.10",
    tcpPort: 502,
    unitId: 1,
    pollIntervalMs: 1000,
    readBlockSize: 120,
    timeoutMs: 1000,
    retries: 1,
    postgresEnabled: false,
    saveIntervalMs: 1000,
    postgresRawTable: "boiler_raw",
    postgresDownsampleTable: "boiler_1m",
    postgresDownsampleEnabled: true,
    postgresDownsampleIntervalSec: 60,
    postgresRawRetentionDays: 30,
    postgresDownsampleRetentionDays: 365,
    postgresMaintenanceIntervalHours: 24,
    enabled: true,
  });
  database.createRegister({
    deviceId: device.id,
    name: "Temperature",
    address: 0,
    functionCode: 3,
    dataType: "uint16",
    byteOrder: "ABCD",
    scale: 0.1,
    offset: 0,
    unit: "C",
    decimalPlaces: 1,
    enabled: true,
  });
  return database.getDevice(device.id)!;
}

test("deduplicates durable incidents, debounces outages, and orders WhatsApp recovery", async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "modbus-system-alert-"));
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  const database = new LoggerDatabase(path.join(directory, "logger.db"));
  context.after(() => database.close());
  const device = createDevice(database);
  const requests: Array<{ url: string; authorization: string; body: unknown }> =
    [];
  const service = new SystemAlertService(
    database,
    logger,
    async (url, init) => {
      requests.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        body: JSON.parse(String(init?.body)) as unknown,
      });
      return new Response(
        JSON.stringify({ messages: [{ id: `wamid.${requests.length}` }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );
  context.after(() => service.close());
  const publicSettings = service.saveSettings(settingsInput());
  assert.equal(publicSettings.accessTokenConfigured, true);
  assert.equal("accessToken" in publicSettings, false);
  const storedToken = database.connection
    .prepare(
      "SELECT access_token_encrypted FROM whatsapp_alert_settings WHERE id = 1",
    )
    .get() as { access_token_encrypted: string };
  assert.notEqual(storedToken.access_token_encrypted, "meta-secret-token");
  assert.equal(
    decryptSecret(storedToken.access_token_encrypted),
    "meta-secret-token",
  );

  const common = {
    type: "device_offline" as const,
    sourceKey: `device:${device.id}`,
    sourceId: device.id,
    sourceName: device.name,
    offline: true,
    detail: "Connection refused",
    offlineDelaySeconds: 10,
    deliveryRecipients: ["919876543210"],
    sendRecovery: true,
  };
  assert.equal(
    database.observeSystemAlert({
      ...common,
      observedAt: "2026-07-27T00:00:00.000Z",
    }).opened,
    null,
  );
  assert.equal(
    database.observeSystemAlert({
      ...common,
      observedAt: "2026-07-27T00:00:09.999Z",
    }).opened,
    null,
  );
  const first = database.observeSystemAlert({
    ...common,
    observedAt: "2026-07-27T00:00:10.000Z",
  }).opened;
  assert.ok(first);
  database.observeSystemAlert({
    ...common,
    observedAt: "2026-07-27T00:00:20.000Z",
  });
  assert.equal(
    database.listSystemAlerts({ activeOnly: true, limit: 250 }).length,
    1,
  );
  assert.equal(database.getOverview().alarms.critical, 1);

  database.observeSystemAlert({
    ...common,
    offline: false,
    detail: "Device communication recovered",
    observedAt: "2026-07-27T00:00:21.000Z",
  });
  assert.equal(
    (
      database.connection
        .prepare(
          "SELECT COUNT(*) AS count FROM system_alert_deliveries WHERE alert_id = ?",
        )
        .get(first.id) as { count: number }
    ).count,
    0,
    "an unaccepted outage is canceled without a stale recovery",
  );

  database.observeSystemAlert({
    ...common,
    observedAt: "2026-07-27T00:01:00.000Z",
  });
  const second = database.observeSystemAlert({
    ...common,
    observedAt: "2026-07-27T00:01:10.000Z",
  }).opened;
  assert.ok(second);
  await service.flushDeliveries();
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.url,
    "https://graph.facebook.com/v23.0/123456789012345/messages",
  );
  assert.equal(requests[0]?.authorization, "Bearer meta-secret-token");
  const parameters = (
    requests[0]?.body as {
      template: {
        components: Array<{ parameters: Array<{ text: string }> }>;
      };
    }
  ).template.components[0]?.parameters;
  assert.deepEqual(
    parameters?.slice(0, 4).map((parameter) => parameter.text),
    ["OFFLINE", "Device offline", "Boiler PLC", "Connection refused"],
  );

  database.observeSystemAlert({
    ...common,
    offline: false,
    detail: "Device communication recovered",
    observedAt: "2026-07-27T00:01:11.000Z",
  });
  await service.flushDeliveries();
  assert.equal(requests.length, 2);
  const recoveryParameters = (
    requests[1]?.body as {
      template: {
        components: Array<{ parameters: Array<{ text: string }> }>;
      };
    }
  ).template.components[0]?.parameters;
  assert.deepEqual(
    recoveryParameters?.slice(0, 4).map((parameter) => parameter.text),
    [
      "RECOVERED",
      "Device offline",
      "Boiler PLC",
      "Device communication recovered",
    ],
  );

  database.deleteDevice(device.id);
  assert.equal(
    database.listSystemAlerts({ activeOnly: false, limit: 250 }).length,
    2,
    "device deletion does not erase outage history",
  );
});

test("retries transient Meta failures, makes permanent failures dead, and cancels removed recipients", async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "modbus-alert-retry-"));
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  const database = new LoggerDatabase(path.join(directory, "logger.db"));
  context.after(() => database.close());
  let responseStatus = 500;
  const service = new SystemAlertService(
    database,
    logger,
    async () =>
      new Response("{}", {
        status: responseStatus,
        headers: responseStatus === 429 ? { "retry-after": "1" } : undefined,
      }),
  );
  context.after(() => service.close());
  service.saveSettings({
    ...settingsInput(),
    recipients: ["919876543210", "919876543211"],
    offlineDelaySeconds: 0,
  });
  const transition = database.observeSystemAlert({
    type: "postgres_offline",
    sourceKey: "postgres:remote",
    sourceId: null,
    sourceName: "db.example:5432/logger",
    offline: true,
    detail: "Connection refused",
    offlineDelaySeconds: 0,
    deliveryRecipients: ["919876543210", "919876543211"],
    observedAt: "2026-07-27T01:00:00.000Z",
  });
  assert.ok(transition.opened);
  await service.flushDeliveries();
  assert.deepEqual(
    database.connection
      .prepare(
        `SELECT status, attempts FROM system_alert_deliveries
         ORDER BY recipient`,
      )
      .all(),
    [
      { status: "failed", attempts: 1 },
      { status: "failed", attempts: 1 },
    ],
  );

  service.saveSettings({
    ...settingsInput(),
    recipients: ["919876543210"],
    offlineDelaySeconds: 0,
    accessToken: "",
  });
  assert.equal(
    (
      database.connection
        .prepare(
          "SELECT COUNT(*) AS count FROM system_alert_deliveries WHERE recipient = ?",
        )
        .get("919876543211") as { count: number }
    ).count,
    0,
  );
  database.connection
    .prepare(
      "UPDATE system_alert_deliveries SET next_attempt_at = ? WHERE status = 'failed'",
    )
    .run(new Date(0).toISOString());
  responseStatus = 400;
  await service.flushDeliveries();
  assert.deepEqual(
    database.connection
      .prepare("SELECT status, attempts FROM system_alert_deliveries")
      .all(),
    [{ status: "dead", attempts: 2 }],
  );

  service.saveSettings({
    ...settingsInput(),
    enabled: false,
    recipients: ["919876543210"],
    accessToken: "",
  });
  assert.equal(
    (
      database.connection
        .prepare(
          "SELECT COUNT(*) AS count FROM system_alert_deliveries WHERE status IN ('pending', 'failed')",
        )
        .get() as { count: number }
    ).count,
    0,
  );
});

test("tests an unsaved WhatsApp draft without persisting its token or endpoint fields", async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "modbus-alert-draft-"));
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  const database = new LoggerDatabase(path.join(directory, "logger.db"));
  context.after(() => database.close());
  let requestedUrl = "";
  let authorization = "";
  const service = new SystemAlertService(
    database,
    logger,
    async (url, init) => {
      requestedUrl = String(url);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(
        JSON.stringify({ messages: [{ id: "wamid.draft" }] }),
        { status: 200 },
      );
    },
  );
  context.after(() => service.close());
  service.saveSettings({
    ...settingsInput("saved-token"),
    enabled: false,
    phoneNumberId: "111111111111111",
  });

  const result = await service.testWhatsApp({
    ...settingsInput("draft-token"),
    enabled: false,
    phoneNumberId: "222222222222222",
  });
  assert.deepEqual(result, {
    ok: true,
    message: "WhatsApp test accepted for 1 recipient(s)",
    recipientCount: 1,
  });
  assert.equal(
    requestedUrl,
    "https://graph.facebook.com/v23.0/222222222222222/messages",
  );
  assert.equal(authorization, "Bearer draft-token");
  assert.equal(
    database.getWhatsAppAlertSettings()?.phoneNumberId,
    "111111111111111",
  );
  assert.equal(
    decryptSecret(
      database.getWhatsAppAlertSettings()?.accessTokenEncrypted ?? "",
    ),
    "saved-token",
  );
});

test("PostgreSQL monitoring opens only for availability failures and resolves on a successful probe", async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "modbus-pg-alert-"));
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  const database = new LoggerDatabase(path.join(directory, "logger.db"));
  context.after(() => database.close());
  const alerts = new SystemAlertService(database, logger);
  context.after(() => alerts.close());
  alerts.saveSettings({
    ...settingsInput(),
    enabled: false,
    recipients: [],
    accessToken: "",
    offlineDelaySeconds: 0,
  });
  database.savePostgresSettings(postgresSettingsInput(), null);
  const device = createDevice(database);
  database.updateDeviceHealth(device.id, "online", {
    lastSeenAt: "2026-07-27T02:00:00.000Z",
  });
  database.updateDeviceHealth(device.id, "offline", {
    lastError: "Connection refused",
  });
  assert.equal(
    database.getDevice(device.id)?.lastSeenAt,
    "2026-07-27T02:00:00.000Z",
    "a failed poll preserves the last successful observation",
  );
  database.setDevicePostgresEnabled(device.id, true);
  let failureCode: string | null = "ECONNREFUSED";
  const pool = {
    async query() {
      if (failureCode) {
        throw Object.assign(new Error("probe failed"), { code: failureCode });
      }
      return { rows: [{ "?column?": 1 }] };
    },
    async end() {},
  };
  const historian = new PostgresHistorian(
    database,
    logger,
    () => pool as never,
    alerts,
  );
  context.after(() => historian.close());

  assert.deepEqual(await historian.checkAvailability(), {
    monitored: true,
    online: false,
  });
  await historian.checkAvailability();
  assert.equal(
    database.listSystemAlerts({ activeOnly: true, limit: 250 }).length,
    1,
  );

  failureCode = "28P01";
  assert.deepEqual(await historian.checkAvailability(), {
    monitored: true,
    online: null,
  });
  assert.equal(
    database.listSystemAlerts({ activeOnly: true, limit: 250 }).length,
    1,
    "an authentication/configuration error is not recovery or a new outage",
  );

  failureCode = null;
  assert.deepEqual(await historian.checkAvailability(), {
    monitored: true,
    online: true,
  });
  assert.equal(
    database.listSystemAlerts({ activeOnly: true, limit: 250 }).length,
    0,
  );

  database.setDevicePostgresEnabled(device.id, false);
  failureCode = "ECONNREFUSED";
  assert.deepEqual(await historian.checkAvailability(), {
    monitored: false,
    online: null,
  });
  assert.equal(
    database.listSystemAlerts({ activeOnly: true, limit: 250 }).length,
    0,
  );
});

test("PostgreSQL settings disable and target replacement immediately resolve stale outages and cancel unsent alerts", async (context) => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "modbus-pg-settings-alert-"),
  );
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  const database = new LoggerDatabase(path.join(directory, "logger.db"));
  context.after(() => database.close());
  const alerts = new SystemAlertService(database, logger, async () => {
    throw new Error("a canceled delivery must never be sent");
  });
  context.after(() => alerts.close());
  alerts.saveSettings({ ...settingsInput(), offlineDelaySeconds: 0 });
  await alerts.pauseAndDrain();
  database.savePostgresSettings(postgresSettingsInput(), null);
  const device = createDevice(database);
  database.setDevicePostgresEnabled(device.id, true);
  const pool = {
    async query() {
      return { rows: [{ "?column?": 1 }] };
    },
    async end() {},
  };
  const historian = new PostgresHistorian(
    database,
    logger,
    () => pool as never,
    alerts,
  );
  context.after(() => historian.close());

  const openOutage = (observedAt: string) => {
    const transition = database.observeSystemAlert({
      type: "postgres_offline",
      sourceKey: "postgres:remote",
      sourceId: null,
      sourceName: "db.example.internal:5432/logger",
      offline: true,
      detail: "Connection refused",
      offlineDelaySeconds: 0,
      deliveryRecipients: ["919876543210"],
      sendRecovery: true,
      observedAt,
    });
    assert.ok(transition.opened);
    return transition.opened;
  };
  const unsentCount = () =>
    (
      database.connection
        .prepare(
          `SELECT COUNT(*) AS count
           FROM system_alert_deliveries
           WHERE status IN ('pending', 'failed')`,
        )
        .get() as { count: number }
    ).count;

  openOutage("2026-07-27T03:00:00.000Z");
  assert.equal(unsentCount(), 1);
  await historian.saveSettings(postgresSettingsInput({ enabled: false }));
  assert.equal(
    database.listSystemAlerts({ activeOnly: true, limit: 250 }).length,
    0,
  );
  assert.equal(unsentCount(), 0);

  await historian.saveSettings(postgresSettingsInput());
  openOutage("2026-07-27T03:01:00.000Z");
  assert.equal(unsentCount(), 1);
  await historian.saveSettings(
    postgresSettingsInput({
      host: "replacement.example.internal",
      database: "replacement_logger",
    }),
  );
  assert.equal(
    database.listSystemAlerts({ activeOnly: true, limit: 250 }).length,
    0,
  );
  assert.equal(unsentCount(), 0);
  const incidents = database.listSystemAlerts({
    activeOnly: false,
    limit: 250,
  });
  assert.equal(incidents.length, 2);
  assert.ok(incidents.every((incident) => incident.resolvedAt !== null));
});

test("a late failure from the replaced PostgreSQL pool cannot reopen a resolved outage", async (context) => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "modbus-pg-generation-alert-"),
  );
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  const database = new LoggerDatabase(path.join(directory, "logger.db"));
  context.after(() => database.close());
  const alerts = new SystemAlertService(database, logger, async () => {
    throw new Error("a stale delivery must never be sent");
  });
  context.after(() => alerts.close());
  alerts.saveSettings({ ...settingsInput(), offlineDelaySeconds: 0 });
  await alerts.pauseAndDrain();
  database.savePostgresSettings(postgresSettingsInput(), null);
  const device = createDevice(database);
  database.setDevicePostgresEnabled(device.id, true);

  let markOldProbeStarted = () => {};
  const oldProbeStarted = new Promise<void>((resolve) => {
    markOldProbeStarted = resolve;
  });
  let rejectOldProbe = (error: Error) => {
    void error;
  };
  const oldProbe = new Promise<never>((_resolve, reject) => {
    rejectOldProbe = reject;
  });
  const oldPool = {
    query() {
      markOldProbeStarted();
      return oldProbe;
    },
    async end() {},
  };
  const replacementPool = {
    async query() {
      return { rows: [{ "?column?": 1 }] };
    },
    async end() {},
  };
  let poolsCreated = 0;
  const historian = new PostgresHistorian(
    database,
    logger,
    () => {
      poolsCreated += 1;
      return (poolsCreated === 1 ? oldPool : replacementPool) as never;
    },
    alerts,
  );
  context.after(() => historian.close());

  const opened = database.observeSystemAlert({
    type: "postgres_offline",
    sourceKey: "postgres:remote",
    sourceId: null,
    sourceName: "db.example.internal:5432/logger",
    offline: true,
    detail: "Connection refused",
    offlineDelaySeconds: 0,
    deliveryRecipients: ["919876543210"],
    sendRecovery: true,
    observedAt: "2026-07-27T03:02:00.000Z",
  });
  assert.ok(opened.opened);

  const staleAvailabilityCheck = historian.checkAvailability();
  await oldProbeStarted;
  await historian.saveSettings(
    postgresSettingsInput({
      host: "replacement.example.internal",
      database: "replacement_logger",
    }),
  );

  rejectOldProbe(
    Object.assign(new Error("old target refused the connection"), {
      code: "ECONNREFUSED",
    }),
  );
  assert.deepEqual(await staleAvailabilityCheck, {
    monitored: true,
    online: false,
  });

  assert.equal(
    database.listSystemAlerts({ activeOnly: true, limit: 250 }).length,
    0,
  );
  const unsent = database.connection
    .prepare(
      `SELECT COUNT(*) AS count
       FROM system_alert_deliveries
       WHERE status IN ('pending', 'failed')`,
    )
    .get() as { count: number };
  assert.equal(unsent.count, 0);
  const incidents = database.listSystemAlerts({
    activeOnly: false,
    limit: 250,
  });
  assert.equal(incidents.length, 1);
  assert.ok(incidents[0]?.resolvedAt);
  assert.deepEqual(await historian.checkAvailability(), {
    monitored: true,
    online: true,
  });
});

test("configuration backups include encrypted WhatsApp settings, accept V1 backups, and reset operational alert data", async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "modbus-alert-backup-"));
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  const database = new LoggerDatabase(path.join(directory, "logger.db"));
  context.after(() => database.close());
  const service = new SystemAlertService(database, logger);
  context.after(() => service.close());
  service.saveSettings({ ...settingsInput(), offlineDelaySeconds: 0 });
  database.observeSystemAlert({
    type: "postgres_offline",
    sourceKey: "postgres:remote",
    sourceId: null,
    sourceName: "Remote PostgreSQL",
    offline: true,
    detail: "Connection refused",
    offlineDelaySeconds: 0,
    deliveryRecipients: [],
  });
  const administration = new SystemAdministrationService(database, {
    appVersion: "1.1.0",
    dataDirectory: path.join(directory, "system-admin"),
  });
  const backup = administration.createConfigurationBackup({});
  const encoded = backup.replace(/^modbus-data-logger-backup\.v1\./, "");
  const envelope = JSON.parse(decryptSecret(encoded)) as {
    data: {
      whatsappAlertSettings?: Array<{
        enabled: number;
        access_token_encrypted: string;
      }>;
      systemAlerts?: unknown;
      systemAlertDeliveries?: unknown;
    };
  };
  assert.equal(envelope.data.whatsappAlertSettings?.length, 1);
  assert.equal(envelope.data.whatsappAlertSettings?.[0]?.enabled, 1);
  assert.notEqual(
    envelope.data.whatsappAlertSettings?.[0]?.access_token_encrypted,
    "meta-secret-token",
  );
  assert.equal("systemAlerts" in envelope.data, false);
  assert.equal("systemAlertDeliveries" in envelope.data, false);

  delete envelope.data.whatsappAlertSettings;
  const legacyBackup = `modbus-data-logger-backup.v1.${encryptSecret(
    JSON.stringify(envelope),
  )}`;
  await administration.restoreConfigurationBackup(legacyBackup, {});
  assert.equal(database.getWhatsAppAlertSettings(), undefined);

  service.saveSettings(settingsInput());
  await administration.restoreConfigurationBackup(backup, {});
  assert.equal(database.getWhatsAppAlertSettings()?.enabled, false);
  assert.equal(
    Boolean(database.getWhatsAppAlertSettings()?.accessTokenEncrypted),
    true,
  );
  assert.equal(
    database.listSystemAlerts({ activeOnly: false, limit: 250 }).length,
    0,
  );

  await administration.factoryReset({});
  assert.equal(database.getWhatsAppAlertSettings(), undefined);
  assert.equal(
    database.listSystemAlerts({ activeOnly: false, limit: 250 }).length,
    0,
  );
});

test("system alert and WhatsApp APIs enforce RBAC without leaking access tokens", async (context) => {
  const app = await buildApplication();
  await app.ready();
  context.after(() => app.close());

  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "admin", password: "admin" },
  });
  assert.equal(login.statusCode, 200);
  const loginBody = login.json<{
    token: string;
    user: { id: string };
  }>();
  const administrator = { authorization: `Bearer ${loginBody.token}` };
  async function createAndLoginRole(role: "operator" | "viewer") {
    const username = `alert-${role}`;
    const password = `${role}-password`;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/users",
      headers: administrator,
      payload: { username, password, role, enabled: true },
    });
    assert.equal(created.statusCode, 201);
    const roleLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username, password },
    });
    assert.equal(roleLogin.statusCode, 200);
    return {
      authorization: `Bearer ${
        roleLogin.json<{ token: string }>().token
      }`,
    };
  }
  const operator = await createAndLoginRole("operator");
  const viewer = await createAndLoginRole("viewer");

  const save = await app.inject({
    method: "PUT",
    url: "/api/v1/settings/alerts/whatsapp",
    headers: administrator,
    payload: { ...settingsInput(), enabled: false },
  });
  assert.equal(save.statusCode, 200);
  assert.equal(
    save.json<{ accessTokenConfigured: boolean }>().accessTokenConfigured,
    true,
  );
  assert.equal(save.body.includes("meta-secret-token"), false);
  assert.equal(save.body.includes('"accessToken":'), false);

  const getAsViewer = await app.inject({
    method: "GET",
    url: "/api/v1/settings/alerts/whatsapp",
    headers: viewer,
  });
  assert.equal(getAsViewer.statusCode, 403);
  const putAsOperator = await app.inject({
    method: "PUT",
    url: "/api/v1/settings/alerts/whatsapp",
    headers: operator,
    payload: { ...settingsInput(), enabled: false },
  });
  assert.equal(putAsOperator.statusCode, 403);
  const testAsViewer = await app.inject({
    method: "POST",
    url: "/api/v1/settings/alerts/whatsapp/test",
    headers: viewer,
    payload: { ...settingsInput(), enabled: false },
  });
  assert.equal(testAsViewer.statusCode, 403);

  const direct = new LoggerDatabase(process.env.DATABASE_PATH!);
  const opened = direct.observeSystemAlert({
    type: "device_offline",
    sourceKey: "device:api-test",
    sourceId: "api-test",
    sourceName: "API test device",
    offline: true,
    detail: "Timed out",
    offlineDelaySeconds: 0,
  }).opened;
  direct.close();
  assert.ok(opened);

  const listAsViewer = await app.inject({
    method: "GET",
    url: "/api/v1/alerts/system?activeOnly=true&limit=250",
    headers: viewer,
  });
  assert.equal(listAsViewer.statusCode, 200);
  assert.equal(listAsViewer.json<{ items: unknown[] }>().items.length, 1);
  const acknowledgeAsViewer = await app.inject({
    method: "POST",
    url: `/api/v1/alerts/system/${opened.id}/acknowledge`,
    headers: viewer,
  });
  assert.equal(acknowledgeAsViewer.statusCode, 403);
  const acknowledgeAsOperator = await app.inject({
    method: "POST",
    url: `/api/v1/alerts/system/${opened.id}/acknowledge`,
    headers: operator,
  });
  assert.equal(acknowledgeAsOperator.statusCode, 204);
});
