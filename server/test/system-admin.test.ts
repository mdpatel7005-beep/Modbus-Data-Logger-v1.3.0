import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const temporaryRoot = mkdtempSync(
  path.join(os.tmpdir(), "modbus-system-admin-"),
);
const databasePath = path.join(temporaryRoot, "logger.db");
const systemDataPath = path.join(temporaryRoot, "system-admin");
const jwtSecret = "system-admin-test-secret-more-than-32-characters";
const encryptionKey =
  "system-admin-test-encryption-key-more-than-32-characters";
const updateHelperPath = path.join(temporaryRoot, "update-helper");
const openVpnHelperPath = path.join(temporaryRoot, "openvpn-helper");
const openVpnHelperMarker = path.join(temporaryRoot, "openvpn-helper.marker");

process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = databasePath;
process.env.SYSTEM_ADMIN_DATA_DIR = systemDataPath;
process.env.APP_VERSION = "1.1.0";
process.env.AUTH_DISABLED = "false";
process.env.POLLING_ENABLED = "false";
process.env.JWT_SECRET = jwtSecret;
process.env.SETTINGS_ENCRYPTION_KEY = encryptionKey;
process.env.INITIAL_ADMIN_USERNAME = "admin";
process.env.INITIAL_ADMIN_PASSWORD = "initial-password";
process.env.SYSTEM_UPDATE_HELPER = updateHelperPath;
process.env.OPENVPN_HELPER = openVpnHelperPath;
delete process.env.POSTGRES_URL;

const { buildApplication } = await import("../src/app.js");
const { decryptSecret, encryptSecret } =
  await import("../src/services/secret-box.js");

const backupPrefix = "modbus-data-logger-backup.v1.";

test("secures updates, VPN, encrypted backup restore, and factory reset", async (context) => {
  context.after(() => rmSync(temporaryRoot, { force: true, recursive: true }));
  const app = await buildApplication();
  await app.ready();
  context.after(() => app.close());

  const publicTarget = path.join(temporaryRoot, "public");
  const linkedParent = path.join(temporaryRoot, "linked-parent");
  mkdirSync(publicTarget);
  symlinkSync(publicTarget, linkedParent, "dir");
  const { LoggerDatabase } = await import("../src/db/database.js");
  const { SystemAdministrationService } =
    await import("../src/services/system-admin.js");
  const pathTestDatabase = new LoggerDatabase(
    path.join(temporaryRoot, "path-test.db"),
  );
  assert.throws(
    () =>
      new SystemAdministrationService(pathTestDatabase, {
        dataDirectory: path.join(linkedParent, "private"),
      }),
    /unsafe shared directory/,
  );
  pathTestDatabase.close();

  const health = await app.inject({
    method: "GET",
    url: "/api/v1/health",
  });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json<{ version: string }>().version, "1.1.0");

  const noAuthentication = await app.inject({
    method: "GET",
    url: "/api/v1/settings/system",
  });
  assert.equal(noAuthentication.statusCode, 401);
  const unauthenticatedOversizedUpload = await app.inject({
    method: "POST",
    url: "/api/v1/settings/system/openvpn/profile",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": "plant.ovpn",
    },
    payload: Buffer.alloc(1024 * 1024 + 1, 0x41),
  });
  assert.equal(unauthenticatedOversizedUpload.statusCode, 401);

  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "admin", password: "initial-password" },
  });
  assert.equal(login.statusCode, 200);
  const token = login.json<{ token: string }>().token;
  let authorization = { authorization: `Bearer ${token}` };

  const operatorCreate = await app.inject({
    method: "POST",
    url: "/api/v1/users",
    headers: authorization,
    payload: {
      username: "operator",
      password: "operator",
      role: "operator",
    },
  });
  assert.equal(operatorCreate.statusCode, 201);
  const operatorLogin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "operator", password: "operator" },
  });
  assert.equal(operatorLogin.statusCode, 200);
  const operatorToken = operatorLogin.json<{ token: string }>().token;
  const operatorStatus = await app.inject({
    method: "GET",
    url: "/api/v1/settings/system",
    headers: { authorization: `Bearer ${operatorToken}` },
  });
  assert.equal(operatorStatus.statusCode, 403);
  const operatorDelete = await app.inject({
    method: "DELETE",
    url: `/api/v1/users/${operatorCreate.json<{ id: string }>().id}`,
    headers: authorization,
  });
  assert.equal(operatorDelete.statusCode, 204);

  const initialStatus = await app.inject({
    method: "GET",
    url: "/api/v1/settings/system",
    headers: authorization,
  });
  assert.equal(initialStatus.statusCode, 200);
  assert.deepEqual(initialStatus.json(), {
    appVersion: "1.1.0",
    update: {
      helperConfigured: false,
      stagedVersion: null,
      stagedFilename: null,
      stagedSha256: null,
      stagedAt: null,
      lastError: null,
    },
    openVpn: {
      helperConfigured: false,
      configured: false,
      profileName: null,
      enabled: false,
      lastChangedAt: null,
      lastError: null,
    },
  });

  const oldUpdate = await app.inject({
    method: "POST",
    url: "/api/v1/settings/system/update/stage",
    headers: {
      ...authorization,
      "content-type": "application/octet-stream",
      "x-file-name": "logger.zip",
      "x-update-version": "1.1.0",
    },
    payload: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  });
  assert.equal(oldUpdate.statusCode, 400);

  const disguisedUpdate = await app.inject({
    method: "POST",
    url: "/api/v1/settings/system/update/stage",
    headers: {
      ...authorization,
      "content-type": "application/octet-stream",
      "x-file-name": "logger.zip",
      "x-update-version": "1.2.0",
    },
    payload: Buffer.from("not a zip"),
  });
  assert.equal(disguisedUpdate.statusCode, 400);

  const stagedUpdate = await app.inject({
    method: "POST",
    url: "/api/v1/settings/system/update/stage",
    headers: {
      ...authorization,
      "content-type": "application/octet-stream",
      "x-file-name": "logger.zip",
      "x-update-version": "1.2.0",
    },
    payload: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  });
  assert.equal(stagedUpdate.statusCode, 201);
  assert.match(
    stagedUpdate.json<{ stagedSha256: string }>().stagedSha256,
    /^[a-f0-9]{64}$/,
  );
  const stagedUpdatePath = path.join(
    systemDataPath,
    "updates",
    "staged-update.pkg",
  );
  assert.equal(statSync(stagedUpdatePath).mode & 0o777, 0o600);

  const applyWithoutHelper = await app.inject({
    method: "POST",
    url: "/api/v1/settings/system/update/apply",
    headers: authorization,
  });
  assert.equal(applyWithoutHelper.statusCode, 503);

  writeFileSync(updateHelperPath, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  chmodSync(updateHelperPath, 0o700);
  const rejectedByHelper = await app.inject({
    method: "POST",
    url: "/api/v1/settings/system/update/apply",
    headers: authorization,
  });
  assert.equal(rejectedByHelper.statusCode, 502);
  assert.equal(existsSync(stagedUpdatePath), true);
  const rejectedUpdateStatus = await app.inject({
    method: "GET",
    url: "/api/v1/settings/system",
    headers: authorization,
  });
  assert.match(
    rejectedUpdateStatus.json<{
      update: { lastError: string | null };
    }>().update.lastError ?? "",
    /did not accept/i,
  );

  writeFileSync(
    updateHelperPath,
    '#!/bin/sh\n[ "$1" = "apply" ] || exit 2\n[ -f "$2" ] || exit 3\nexit 0\n',
    { mode: 0o700 },
  );
  chmodSync(updateHelperPath, 0o700);
  const acceptedByHelper = await app.inject({
    method: "POST",
    url: "/api/v1/settings/system/update/apply",
    headers: authorization,
  });
  assert.equal(acceptedByHelper.statusCode, 202);
  assert.equal(existsSync(stagedUpdatePath), false);
  const repeatedApply = await app.inject({
    method: "POST",
    url: "/api/v1/settings/system/update/apply",
    headers: authorization,
  });
  assert.equal(repeatedApply.statusCode, 409);

  const unsafeProfile = await app.inject({
    method: "POST",
    url: "/api/v1/settings/system/openvpn/profile",
    headers: {
      ...authorization,
      "content-type": "application/octet-stream",
      "x-file-name": "plant.ovpn",
    },
    payload: Buffer.from("client\nscript-security 2\nup /tmp/run.sh\n"),
  });
  assert.equal(unsafeProfile.statusCode, 400);
  const prefixedUnsafeProfile = await app.inject({
    method: "POST",
    url: "/api/v1/settings/system/openvpn/profile",
    headers: {
      ...authorization,
      "content-type": "application/octet-stream",
      "x-file-name": "plant.ovpn",
    },
    payload: Buffer.from(
      "client\n--plugin /tmp/plugin.so\nconfig /etc/openvpn/other.conf\n",
    ),
  });
  assert.equal(prefixedUnsafeProfile.statusCode, 400);

  for (const bypassProfile of [
    "client\nremote vpn.example.test 1194\niproute /tmp/evil\n",
    "client\nremote vpn.example.test 1194\npkcs11-providers /tmp/evil.so\n",
    "client\nremote vpn.example.test 1194\nproviders /tmp/evil\n",
    'client\nremote vpn.example.test 1194\n"plugin" /tmp/evil.so\n',
    'client\nremote vpn.example.test 1194\n"ca" /tmp/external.pem\n',
  ]) {
    const rejectedBypass = await app.inject({
      method: "POST",
      url: "/api/v1/settings/system/openvpn/profile",
      headers: {
        ...authorization,
        "content-type": "application/octet-stream",
        "x-file-name": "bypass.ovpn",
      },
      payload: Buffer.from(bypassProfile),
    });
    assert.equal(rejectedBypass.statusCode, 400);
  }

  for (const serverProfile of [
    "client\nremote vpn.example.test 1194\nserver 10.8.0.0 255.255.255.0\n",
    "client\nremote vpn.example.test 1194\nserver-bridge 10.8.0.4 255.255.255.0 10.8.0.50 10.8.0.100\n",
    "client\nremote vpn.example.test 1194\nmode server\n",
    "client\nremote vpn.example.test 1194\ntls-server\n",
  ]) {
    const rejectedServerProfile = await app.inject({
      method: "POST",
      url: "/api/v1/settings/system/openvpn/profile",
      headers: {
        ...authorization,
        "content-type": "application/octet-stream",
        "x-file-name": "server.ovpn",
      },
      payload: Buffer.from(serverProfile),
    });
    assert.equal(rejectedServerProfile.statusCode, 400);
  }

  const missingClientMode = await app.inject({
    method: "POST",
    url: "/api/v1/settings/system/openvpn/profile",
    headers: {
      ...authorization,
      "content-type": "application/octet-stream",
      "x-file-name": "plant.ovpn",
    },
    payload: Buffer.from(
      "dev tun\nremote vpn.example.test 1194\n<ca>\nTEST-CA\n</ca>\n",
    ),
  });
  assert.equal(missingClientMode.statusCode, 400);

  const externalProfile = await app.inject({
    method: "POST",
    url: "/api/v1/settings/system/openvpn/profile",
    headers: {
      ...authorization,
      "content-type": "application/octet-stream",
      "x-file-name": "plant.ovpn",
    },
    payload: Buffer.from("client\nca /etc/openvpn/plant-ca.pem\n"),
  });
  assert.equal(externalProfile.statusCode, 400);

  const validProfile = Buffer.from(
    "client\ndev tun\nremote vpn.example.test 1194\n<ca>\nTEST-CA\n</ca>\n",
  );
  const savedProfile = await app.inject({
    method: "POST",
    url: "/api/v1/settings/system/openvpn/profile",
    headers: {
      ...authorization,
      "content-type": "application/octet-stream",
      "x-file-name": "plant.ovpn",
    },
    payload: validProfile,
  });
  assert.equal(savedProfile.statusCode, 201);
  const vpnProfilePath = path.join(systemDataPath, "openvpn", "profile.ovpn");
  assert.equal(statSync(vpnProfilePath).mode & 0o777, 0o600);

  const connectWithoutHelper = await app.inject({
    method: "PUT",
    url: "/api/v1/settings/system/openvpn",
    headers: authorization,
    payload: { enabled: true },
  });
  assert.equal(connectWithoutHelper.statusCode, 503);

  const postgresSettings = await app.inject({
    method: "PUT",
    url: "/api/v1/settings/postgres",
    headers: authorization,
    payload: {
      enabled: false,
      host: "db.internal.example",
      port: 5432,
      database: "modbus_logger",
      username: "logger",
      password: "database-password",
      sslMode: "require",
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
    },
  });
  assert.equal(postgresSettings.statusCode, 200);

  const categoryResponse = await app.inject({
    method: "POST",
    url: "/api/v1/settings/device-classifications/categories",
    headers: authorization,
    payload: { name: "Energy" },
  });
  assert.equal(categoryResponse.statusCode, 201);
  const categoryId = categoryResponse.json<{ id: string }>().id;
  const groupResponse = await app.inject({
    method: "POST",
    url: "/api/v1/settings/device-classifications/groups",
    headers: authorization,
    payload: { name: "Utility room" },
  });
  assert.equal(groupResponse.statusCode, 201);
  const groupId = groupResponse.json<{ id: string }>().id;

  const deviceResponse = await app.inject({
    method: "POST",
    url: "/api/v1/devices",
    headers: authorization,
    payload: {
      name: "Backup meter",
      protocol: "tcp",
      tcpHost: "192.0.2.40",
      tcpPort: 502,
      unitId: 1,
      pollIntervalMs: 1000,
      saveIntervalMs: 1000,
      readBlockSize: 64,
      timeoutMs: 1500,
      retries: 2,
      categoryId,
      groupId,
      postgresEnabled: false,
      postgresRawTable: "backup_meter_raw",
      postgresDownsampleTable: "backup_meter_1m",
      postgresDownsampleEnabled: true,
      postgresDownsampleIntervalSec: 60,
      postgresRawRetentionDays: 30,
      postgresDownsampleRetentionDays: 365,
      postgresMaintenanceIntervalHours: 24,
      enabled: false,
    },
  });
  assert.equal(deviceResponse.statusCode, 201);
  const deviceId = deviceResponse.json<{ id: string }>().id;

  const registerResponse = await app.inject({
    method: "POST",
    url: `/api/v1/devices/${deviceId}/registers`,
    headers: authorization,
    payload: {
      name: "Power",
      address: 10,
      functionCode: 3,
      dataType: "float32",
      byteOrder: "CDAB",
      scale: 1,
      offset: 0,
      unit: "kW",
      decimalPlaces: 3,
      enabled: true,
    },
  });
  assert.equal(registerResponse.statusCode, 201);
  const registerId = registerResponse.json<{ id: string }>().id;

  const ruleResponse = await app.inject({
    method: "POST",
    url: `/api/v1/registers/${registerId}/alarm-rules`,
    headers: authorization,
    payload: {
      name: "High power",
      severity: "warning",
      condition: "above",
      thresholdHigh: 100,
      thresholdLow: null,
      deadband: 2,
      enabled: true,
    },
  });
  assert.equal(ruleResponse.statusCode, 201);

  const backupResponse = await app.inject({
    method: "GET",
    url: "/api/v1/settings/configuration/backup",
    headers: authorization,
  });
  assert.equal(backupResponse.statusCode, 200);
  const backup = backupResponse.body;
  assert.equal(backup.startsWith(backupPrefix), true);
  assert.throws(() => JSON.parse(backup));
  const envelope = JSON.parse(
    decryptSecret(backup.slice(backupPrefix.length)),
  ) as {
    data: Record<string, unknown> & {
      devices: Array<Record<string, unknown>>;
      postgresSettings: Array<Record<string, unknown>>;
      openVpn: { enabled: number };
    };
  };
  assert.equal("users" in envelope.data, false);
  assert.equal("readings" in envelope.data, false);
  assert.equal("alarmEvents" in envelope.data, false);
  assert.equal("auditLog" in envelope.data, false);
  assert.equal("postgresOutbox" in envelope.data, false);
  assert.equal(envelope.data.devices.length, 1);
  assert.match(
    String(envelope.data.postgresSettings[0]?.password_encrypted),
    /^v1\./,
  );

  const passwordChange = await app.inject({
    method: "POST",
    url: "/api/v1/auth/change-password",
    headers: authorization,
    payload: {
      currentPassword: "initial-password",
      newPassword: "preserved-password",
    },
  });
  assert.equal(passwordChange.statusCode, 204);
  const invalidatedSession = await app.inject({
    method: "GET",
    url: "/api/v1/settings/system",
    headers: authorization,
  });
  assert.equal(invalidatedSession.statusCode, 401);
  const refreshedLogin = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "admin", password: "preserved-password" },
  });
  assert.equal(refreshedLogin.statusCode, 200);
  authorization = {
    authorization: `Bearer ${
      refreshedLogin.json<{ token: string }>().token
    }`,
  };

  const extraCategory = await app.inject({
    method: "POST",
    url: "/api/v1/settings/device-classifications/categories",
    headers: authorization,
    payload: { name: "Temporary category" },
  });
  assert.equal(extraCategory.statusCode, 201);

  const stageBeforeRestore = async () =>
    app.inject({
      method: "POST",
      url: "/api/v1/settings/system/update/stage",
      headers: {
        ...authorization,
        "content-type": "application/octet-stream",
        "x-file-name": "logger-1.2.0.zip",
        "x-update-version": "1.2.0",
      },
      payload: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    });
  assert.equal((await stageBeforeRestore()).statusCode, 201);
  const staleVersionDatabase = new Database(databasePath);
  staleVersionDatabase
    .prepare(
      "UPDATE system_update_state SET staged_version = '1.1.0' WHERE id = 1",
    )
    .run();
  staleVersionDatabase.close();
  const staleApply = await app.inject({
    method: "POST",
    url: "/api/v1/settings/system/update/apply",
    headers: authorization,
  });
  assert.equal(staleApply.statusCode, 409);
  assert.equal(existsSync(stagedUpdatePath), true);
  assert.equal((await stageBeforeRestore()).statusCode, 201);

  const activeVpnEnvelope = structuredClone(envelope);
  activeVpnEnvelope.data.openVpn.enabled = 1;
  const portableDevice = activeVpnEnvelope.data.devices[0]!;
  portableDevice.postgres_enabled = 0;
  portableDevice.postgres_schema_synced_at = "2026-07-25T10:00:00.000Z";
  portableDevice.postgres_schema_dirty = 0;
  portableDevice.postgres_schema_revision = 7;
  portableDevice.postgres_last_maintenance_at = "2026-07-25T09:00:00.000Z";
  portableDevice.status = "online";
  portableDevice.last_seen_at = "2026-07-25T10:00:00.000Z";
  portableDevice.last_error = "old host state";
  portableDevice.last_poll_ms = 88;
  const portablePostgresSettings = activeVpnEnvelope.data.postgresSettings[0]!;
  portablePostgresSettings.last_connection_test_at = "2026-07-25T08:00:00.000Z";
  portablePostgresSettings.last_connection_test_ok = 1;
  portablePostgresSettings.last_connection_test_message = "old test";
  portablePostgresSettings.last_maintenance_at = "2026-07-25T08:30:00.000Z";
  portablePostgresSettings.last_maintenance_raw_deleted = 44;
  portablePostgresSettings.last_maintenance_downsample_deleted = 55;
  portablePostgresSettings.last_replay_at = "2026-07-25T08:45:00.000Z";
  portablePostgresSettings.last_replay_count = 66;
  const activeVpnBackup = `${backupPrefix}${encryptSecret(
    JSON.stringify(activeVpnEnvelope),
  )}`;
  const restoreResponse = await app.inject({
    method: "POST",
    url: "/api/v1/settings/configuration/restore",
    headers: authorization,
    payload: {
      backup: activeVpnBackup,
      confirmation: "RESTORE CONFIGURATION",
    },
  });
  assert.equal(restoreResponse.statusCode, 200);
  const restoredAt = restoreResponse.json<{ restoredAt: string }>().restoredAt;
  assert.equal(existsSync(stagedUpdatePath), false);
  assert.equal(
    restoreResponse.json<{ collectorReloaded: boolean }>().collectorReloaded,
    true,
  );
  const statusAfterRestore = await app.inject({
    method: "GET",
    url: "/api/v1/settings/system",
    headers: authorization,
  });
  assert.equal(
    statusAfterRestore.json<{
      openVpn: { enabled: boolean; lastError: string | null };
    }>().openVpn.enabled,
    false,
  );
  assert.equal(
    statusAfterRestore.json<{
      update: { stagedVersion: string | null };
    }>().update.stagedVersion,
    null,
  );
  assert.match(
    statusAfterRestore.json<{
      openVpn: { enabled: boolean; lastError: string | null };
    }>().openVpn.lastError ?? "",
    /restored/i,
  );
  const devicesAfterRestore = await app.inject({
    method: "GET",
    url: "/api/v1/devices",
    headers: authorization,
  });
  const portableRestoredDevice = devicesAfterRestore.json<{
    items: Array<{
      status: string;
      postgresSchemaSyncedAt: string | null;
      postgresSchemaDirty: boolean;
      postgresSchemaRevision: number;
      lastSeenAt: string | null;
      lastError: string | null;
      lastPollMs: number | null;
    }>;
  }>().items[0]!;
  assert.equal(portableRestoredDevice.status, "disabled");
  assert.equal(portableRestoredDevice.postgresSchemaSyncedAt, null);
  assert.equal(portableRestoredDevice.postgresSchemaDirty, true);
  assert.equal(portableRestoredDevice.postgresSchemaRevision, 8);
  assert.equal(portableRestoredDevice.lastSeenAt, null);
  assert.equal(portableRestoredDevice.lastError, null);
  assert.equal(portableRestoredDevice.lastPollMs, null);
  const normalizedRuntime = new Database(databasePath, { readonly: true });
  assert.deepEqual(
    normalizedRuntime
      .prepare(
        `SELECT
             postgres_last_maintenance_at,
             updated_at
           FROM devices
           WHERE id = ?`,
      )
      .get(deviceId),
    {
      postgres_last_maintenance_at: null,
      updated_at: restoredAt,
    },
  );
  assert.deepEqual(
    normalizedRuntime
      .prepare(
        `SELECT
             last_connection_test_at,
             last_connection_test_ok,
             last_connection_test_message,
             last_maintenance_at,
             last_maintenance_raw_deleted,
             last_maintenance_downsample_deleted,
             last_replay_at,
             last_replay_count,
             updated_at
           FROM postgres_settings
           WHERE id = 1`,
      )
      .get(),
    {
      last_connection_test_at: null,
      last_connection_test_ok: null,
      last_connection_test_message: null,
      last_maintenance_at: null,
      last_maintenance_raw_deleted: 0,
      last_maintenance_downsample_deleted: 0,
      last_replay_at: null,
      last_replay_count: 0,
      updated_at: restoredAt,
    },
  );
  normalizedRuntime.close();

  const restoredClassifications = await app.inject({
    method: "GET",
    url: "/api/v1/settings/device-classifications",
    headers: authorization,
  });
  assert.equal(restoredClassifications.statusCode, 200);
  assert.deepEqual(
    restoredClassifications
      .json<{ categories: Array<{ name: string }> }>()
      .categories.map((item) => item.name),
    ["Energy"],
  );
  const loginWithPreservedPassword = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "admin", password: "preserved-password" },
  });
  assert.equal(loginWithPreservedPassword.statusCode, 200);

  const invalidEnvelope = structuredClone(envelope);
  invalidEnvelope.data.devices[0]!.category_id = "cat_missing";
  const invalidBackup = `${backupPrefix}${encryptSecret(
    JSON.stringify(invalidEnvelope),
  )}`;
  const invalidRestore = await app.inject({
    method: "POST",
    url: "/api/v1/settings/configuration/restore",
    headers: authorization,
    payload: {
      backup: invalidBackup,
      confirmation: "RESTORE CONFIGURATION",
    },
  });
  assert.equal(invalidRestore.statusCode, 400);
  const configurationAfterRejectedRestore = await app.inject({
    method: "GET",
    url: "/api/v1/settings/device-classifications",
    headers: authorization,
  });
  assert.deepEqual(
    configurationAfterRejectedRestore
      .json<{ categories: Array<{ name: string }> }>()
      .categories.map((item) => item.name),
    ["Energy"],
  );

  const oversizedConfiguration = new Database(databasePath);
  oversizedConfiguration
    .prepare(
      `WITH RECURSIVE sequence(value) AS (
           VALUES(1)
           UNION ALL
           SELECT value + 1 FROM sequence WHERE value < 1000
         )
         INSERT INTO device_categories (id, name, created_at, updated_at)
         SELECT
           'cat_bulk_' || value,
           'Bulk category ' || value,
           '2026-07-25T00:00:00.000Z',
           '2026-07-25T00:00:00.000Z'
         FROM sequence`,
    )
    .run();
  oversizedConfiguration.close();
  const oversizedBackup = await app.inject({
    method: "GET",
    url: "/api/v1/settings/configuration/backup",
    headers: authorization,
  });
  assert.equal(oversizedBackup.statusCode, 413);

  const resetWithoutConfirmation = await app.inject({
    method: "POST",
    url: "/api/v1/settings/factory-reset",
    headers: authorization,
    payload: {
      currentPassword: "preserved-password",
      confirmation: "factory reset",
    },
  });
  assert.equal(resetWithoutConfirmation.statusCode, 400);

  const resetWithWrongPassword = await app.inject({
    method: "POST",
    url: "/api/v1/settings/factory-reset",
    headers: authorization,
    payload: {
      currentPassword: "wrong-password",
      confirmation: "FACTORY RESET",
    },
  });
  assert.equal(resetWithWrongPassword.statusCode, 403);

  const activeVpnDatabase = new Database(databasePath);
  activeVpnDatabase
    .prepare("UPDATE openvpn_state SET enabled = 1 WHERE id = 1")
    .run();
  activeVpnDatabase.close();
  const replaceActiveProfile = await app.inject({
    method: "POST",
    url: "/api/v1/settings/system/openvpn/profile",
    headers: {
      ...authorization,
      "content-type": "application/octet-stream",
      "x-file-name": "replacement.ovpn",
    },
    payload: validProfile,
  });
  assert.equal(replaceActiveProfile.statusCode, 409);
  const restoreWhileVpnCannotDisconnect = await app.inject({
    method: "POST",
    url: "/api/v1/settings/configuration/restore",
    headers: authorization,
    payload: {
      backup,
      confirmation: "RESTORE CONFIGURATION",
    },
  });
  assert.equal(restoreWhileVpnCannotDisconnect.statusCode, 503);
  const resetWhileVpnCannotDisconnect = await app.inject({
    method: "POST",
    url: "/api/v1/settings/factory-reset",
    headers: authorization,
    payload: {
      currentPassword: "preserved-password",
      confirmation: "FACTORY RESET",
    },
  });
  assert.equal(resetWhileVpnCannotDisconnect.statusCode, 503);
  assert.equal(existsSync(vpnProfilePath), true);

  writeFileSync(
    openVpnHelperPath,
    `#!/bin/sh
if [ "$1" = "disconnect" ]; then
  sleep 0.05
  printf disconnect > '${openVpnHelperMarker}'
  exit 0
fi
if [ "$1" = "connect" ] && [ -f "$2" ]; then
  exit 0
fi
exit 2
`,
    { mode: 0o700 },
  );
  chmodSync(openVpnHelperPath, 0o700);
  const disconnectRequest = app.inject({
    method: "PUT",
    url: "/api/v1/settings/system/openvpn",
    headers: authorization,
    payload: { enabled: false },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const serializedProfileReplacement = app.inject({
    method: "POST",
    url: "/api/v1/settings/system/openvpn/profile",
    headers: {
      ...authorization,
      "content-type": "application/octet-stream",
      "x-file-name": "replacement.ovpn",
    },
    payload: validProfile,
  });
  const [disconnectResponse, replacementResponse] = await Promise.all([
    disconnectRequest,
    serializedProfileReplacement,
  ]);
  assert.equal(disconnectResponse.statusCode, 200);
  assert.equal(replacementResponse.statusCode, 201);
  assert.equal(readFileSync(openVpnHelperMarker, "utf8"), "disconnect");

  const activeRestoreDatabase = new Database(databasePath);
  activeRestoreDatabase
    .prepare("UPDATE openvpn_state SET enabled = 1 WHERE id = 1")
    .run();
  activeRestoreDatabase.close();
  rmSync(openVpnHelperMarker, { force: true });
  const activeRestore = await app.inject({
    method: "POST",
    url: "/api/v1/settings/configuration/restore",
    headers: authorization,
    payload: {
      backup,
      confirmation: "RESTORE CONFIGURATION",
    },
  });
  assert.equal(activeRestore.statusCode, 200);
  assert.equal(readFileSync(openVpnHelperMarker, "utf8"), "disconnect");

  const direct = new Database(databasePath);
  direct.prepare("UPDATE openvpn_state SET enabled = 1 WHERE id = 1").run();
  direct
    .prepare(
      `INSERT INTO postgres_outbox (
          device_id, sample_timestamp, save_bucket_ms, readings_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      deviceId,
      "2026-07-25T12:00:00.000Z",
      1_000,
      "[]",
      "2026-07-25T12:00:00.000Z",
    );
  direct.close();

  const resetResponse = await app.inject({
    method: "POST",
    url: "/api/v1/settings/factory-reset",
    headers: authorization,
    payload: {
      currentPassword: "preserved-password",
      confirmation: "FACTORY RESET",
    },
  });
  assert.equal(resetResponse.statusCode, 200);
  assert.match(resetResponse.json<{ message: string }>().message, /reset/i);
  assert.equal(existsSync(stagedUpdatePath), false);
  assert.equal(existsSync(vpnProfilePath), false);

  const inspection = new Database(databasePath, { readonly: true });
  assert.equal(
    (
      inspection.prepare("SELECT COUNT(*) AS count FROM users").get() as {
        count: number;
      }
    ).count,
    1,
  );
  for (const table of [
    "device_categories",
    "device_groups",
    "devices",
    "registers",
    "readings",
    "alarm_rules",
    "alarm_events",
    "postgres_settings",
    "postgres_outbox",
  ]) {
    assert.equal(
      (
        inspection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          count: number;
        }
      ).count,
      0,
    );
  }
  assert.deepEqual(
    inspection.prepare("SELECT action FROM audit_log").all() as Array<{
      action: string;
    }>,
    [{ action: "system.factory_reset" }],
  );
  inspection.close();

  const loginAfterReset = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "admin", password: "preserved-password" },
  });
  assert.equal(loginAfterReset.statusCode, 200);
});
