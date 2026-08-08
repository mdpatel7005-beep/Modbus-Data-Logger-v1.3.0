import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import SqliteDatabase from "better-sqlite3";

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "modbus-data-logger-http-"),
);

process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(temporaryRoot, "logger.db");
process.env.AUTH_DISABLED = "false";
process.env.POLLING_ENABLED = "false";
process.env.JWT_SECRET = "test-secret-with-more-than-32-characters";
process.env.INITIAL_ADMIN_USERNAME = "admin";
process.env.INITIAL_ADMIN_PASSWORD = "change-me-before-production";
delete process.env.POSTGRES_URL;

const { buildApplication } = await import("../src/app.js");

test("supports login, password, device, tag, and device-live workflows", async () => {
  const app = await buildApplication();
  await app.ready();

  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "admin",
        password: "change-me-before-production",
      },
    });
    assert.equal(login.statusCode, 200);
    const token = login.json<{ token: string }>().token;
    let authorization = { authorization: `Bearer ${token}` };

    const currentPrincipal = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: authorization,
    });
    assert.equal(currentPrincipal.statusCode, 200);
    assert.deepEqual(currentPrincipal.json(), {
      id: currentPrincipal.json<{ id: string }>().id,
      username: "admin",
      role: "administrator",
    });

    const categoryResponse = await app.inject({
      method: "POST",
      url: "/api/v1/settings/device-classifications/categories",
      headers: authorization,
      payload: { name: "Energy meters" },
    });
    assert.equal(categoryResponse.statusCode, 201);
    const category = categoryResponse.json<{
      id: string;
      name: string;
      deviceCount: number;
    }>();
    assert.equal(category.name, "Energy meters");
    assert.equal(category.deviceCount, 0);

    const groupResponse = await app.inject({
      method: "POST",
      url: "/api/v1/settings/device-classifications/groups",
      headers: authorization,
      payload: { name: "Building A" },
    });
    assert.equal(groupResponse.statusCode, 201);
    const deviceGroup = groupResponse.json<{
      id: string;
      name: string;
      deviceCount: number;
    }>();
    assert.equal(deviceGroup.name, "Building A");
    assert.equal(deviceGroup.deviceCount, 0);

    const duplicateCategory = await app.inject({
      method: "POST",
      url: "/api/v1/settings/device-classifications/categories",
      headers: authorization,
      payload: { name: "energy METERS" },
    });
    assert.equal(duplicateCategory.statusCode, 409);
    assert.deepEqual(duplicateCategory.json(), {
      error: "conflict",
      message: "The record conflicts with existing configuration",
    });

    const passwordChange = await app.inject({
      method: "POST",
      url: "/api/v1/auth/change-password",
      headers: authorization,
      payload: {
        currentPassword: "change-me-before-production",
        newPassword: "1",
      },
    });
    assert.equal(passwordChange.statusCode, 204);

    const newLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: "admin",
        password: "1",
      },
    });
    assert.equal(newLogin.statusCode, 200);
    const invalidatedSession = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: authorization,
    });
    assert.equal(invalidatedSession.statusCode, 401);
    authorization = {
      authorization: `Bearer ${newLogin.json<{ token: string }>().token}`,
    };

    const postgresSettings = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/postgres",
      headers: authorization,
      payload: {
        enabled: false,
        host: "db.example.internal",
        port: 5432,
        database: "modbus_logger",
        username: "logger",
        password: "simple:remote@password",
        sslMode: "require",
        historianTimezone: "Asia/Kolkata",
        autoDownsampleEnabled: true,
        defaultRawTable: "modbus_raw",
        defaultDownsampleTable: "modbus_1m",
        defaultDownsampleIntervalSec: 60,
        rawRetentionDays: 30,
        downsampleRetentionDays: 365,
        maintenanceIntervalHours: 24,
      },
    });
    assert.equal(postgresSettings.statusCode, 200);
    assert.equal(
      postgresSettings.json<{ passwordConfigured: boolean }>()
        .passwordConfigured,
      true,
    );
    assert.equal("password" in postgresSettings.json(), false);

    const savedPostgresSettings = await app.inject({
      method: "GET",
      url: "/api/v1/settings/postgres",
      headers: authorization,
    });
    assert.equal(savedPostgresSettings.statusCode, 200);
    assert.equal(
      savedPostgresSettings.json<{ host: string }>().host,
      "db.example.internal",
    );
    assert.equal(
      savedPostgresSettings.json<{ historianTimezone: string }>()
        .historianTimezone,
      "Asia/Kolkata",
    );
    assert.equal("password" in savedPostgresSettings.json(), false);

    const maintenance = await app.inject({
      method: "POST",
      url: "/api/v1/settings/postgres/maintenance",
      headers: authorization,
    });
    assert.equal(maintenance.statusCode, 200);
    assert.equal(maintenance.json<{ skipped: boolean }>().skipped, true);

    const invalidClassificationDevice = await app.inject({
      method: "POST",
      url: "/api/v1/devices",
      headers: authorization,
      payload: {
        name: "Invalid classification meter",
        protocol: "tcp",
        tcpHost: "192.0.2.9",
        tcpPort: 502,
        unitId: 1,
        pollIntervalMs: 1000,
        readBlockSize: 64,
        timeoutMs: 1500,
        retries: 2,
        categoryId: "cat_missing",
        groupId: null,
        postgresEnabled: false,
        postgresRawTable: "invalid_classification_raw",
        postgresDownsampleTable: "invalid_classification_1m",
        enabled: false,
      },
    });
    assert.equal(invalidClassificationDevice.statusCode, 400);
    assert.equal(
      invalidClassificationDevice.json<{ error: string }>().error,
      "invalid_device_classification",
    );

    const deviceResponse = await app.inject({
      method: "POST",
      url: "/api/v1/devices",
      headers: authorization,
      payload: {
        name: "Test Energy Meter",
        protocol: "tcp",
        tcpHost: "192.0.2.10",
        tcpPort: 502,
        unitId: 1,
        pollIntervalMs: 1000,
        readBlockSize: 64,
        timeoutMs: 1500,
        retries: 2,
        categoryId: category.id,
        groupId: deviceGroup.id,
        postgresEnabled: false,
        postgresRawTable: "modbus_raw",
        postgresDownsampleTable: "modbus_1m",
        postgresDownsampleIntervalSec: 60,
        enabled: false,
      },
    });
    assert.equal(deviceResponse.statusCode, 201);
    const device = deviceResponse.json<{
      id: string;
      readBlockSize: number;
      saveIntervalMs: number;
      postgresRawRetentionDays: number;
      postgresSchemaDirty: boolean;
      postgresSchemaRevision: number;
      categoryId: string | null;
      categoryName: string | null;
      groupId: string | null;
      groupName: string | null;
    }>();
    assert.equal(device.readBlockSize, 64);
    assert.equal(device.saveIntervalMs, 1000);
    assert.equal(device.postgresRawRetentionDays, 30);
    assert.equal(device.postgresSchemaDirty, true);
    assert.equal(device.postgresSchemaRevision, 0);
    assert.equal(device.categoryId, category.id);
    assert.equal(device.categoryName, "Energy meters");
    assert.equal(device.groupId, deviceGroup.id);
    assert.equal(device.groupName, "Building A");

    const assignedClassifications = await app.inject({
      method: "GET",
      url: "/api/v1/settings/device-classifications",
      headers: authorization,
    });
    assert.equal(assignedClassifications.statusCode, 200);
    assert.deepEqual(assignedClassifications.json(), {
      categories: [{ id: category.id, name: "Energy meters", deviceCount: 1 }],
      groups: [{ id: deviceGroup.id, name: "Building A", deviceCount: 1 }],
    });

    const classifiedExport = await app.inject({
      method: "GET",
      url: `/api/v1/readings/export.csv?categoryId=${category.id}&groupId=${deviceGroup.id}&limit=50000`,
      headers: authorization,
    });
    assert.equal(classifiedExport.statusCode, 200);
    assert.match(
      classifiedExport.body,
      /^timestamp,deviceName,categoryName,groupName,tagName,address,value,unit,quality/,
    );

    const deleteAssignedCategory = await app.inject({
      method: "DELETE",
      url: `/api/v1/settings/device-classifications/categories/${category.id}`,
      headers: authorization,
    });
    assert.equal(deleteAssignedCategory.statusCode, 409);
    const deleteAssignedGroup = await app.inject({
      method: "DELETE",
      url: `/api/v1/settings/device-classifications/groups/${deviceGroup.id}`,
      headers: authorization,
    });
    assert.equal(deleteAssignedGroup.statusCode, 409);

    const invalidGroupAssignment = await app.inject({
      method: "PUT",
      url: `/api/v1/devices/${device.id}`,
      headers: authorization,
      payload: {
        ...deviceResponse.json<Record<string, unknown>>(),
        groupId: "grp_missing",
      },
    });
    assert.equal(invalidGroupAssignment.statusCode, 400);
    assert.match(
      invalidGroupAssignment.json<{ message: string }>().message,
      /group was not found/,
    );

    const tagResponse = await app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/registers`,
      headers: authorization,
      payload: {
        name: "L1 Voltage",
        address: 0,
        functionCode: 3,
        dataType: "float32",
        byteOrder: "ABCD",
        scale: 1,
        offset: 0,
        unit: "V",
        decimalPlaces: 3,
        enabled: true,
      },
    });
    assert.equal(tagResponse.statusCode, 201);
    const tag = tagResponse.json<{
      id: string;
      historianColumn: string;
      decimalPlaces: number;
    }>();
    assert.equal(tag.historianColumn, "l1_voltage");
    assert.equal(tag.decimalPlaces, 3);

    const conflictingHistorianColumn = await app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/registers`,
      headers: authorization,
      payload: {
        name: "Collision probe",
        historianColumn: "l1_voltage",
        address: 2,
        functionCode: 3,
        dataType: "uint16",
        byteOrder: "ABCD",
        scale: 1,
        offset: 0,
        unit: "",
        decimalPlaces: 0,
        enabled: true,
      },
    });
    assert.equal(conflictingHistorianColumn.statusCode, 409);
    assert.equal(
      conflictingHistorianColumn.json<{ error: string }>().error,
      "historian_column_conflict",
    );

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
    const operatorEdit = await app.inject({
      method: "PUT",
      url: `/api/v1/registers/${tag.id}`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: {
        name: "Operator edit",
        address: 0,
        functionCode: 3,
        dataType: "float32",
        byteOrder: "ABCD",
        scale: 1,
        offset: 0,
        unit: "V",
        decimalPlaces: 2,
        enabled: true,
      },
    });
    assert.equal(operatorEdit.statusCode, 403);

    const operatorTagCreate = await app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/registers`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: {
        name: "Operator-created tag",
        address: 2,
        functionCode: 3,
        dataType: "uint16",
        byteOrder: "ABCD",
        scale: 1,
        offset: 0,
        unit: "",
        decimalPlaces: 0,
        enabled: true,
      },
    });
    assert.equal(operatorTagCreate.statusCode, 403);

    const operatorClassificationCreate = await app.inject({
      method: "POST",
      url: "/api/v1/settings/device-classifications/groups",
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { name: "Operator group" },
    });
    assert.equal(operatorClassificationCreate.statusCode, 403);

    const operatorSchemaSync = await app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/historian-schema/sync`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { dropRemoved: false },
    });
    assert.equal(operatorSchemaSync.statusCode, 403);

    const unconfiguredSchemaSync = await app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/historian-schema/sync`,
      headers: authorization,
      payload: {},
    });
    assert.equal(unconfiguredSchemaSync.statusCode, 400);
    assert.deepEqual(
      Object.keys(unconfiguredSchemaSync.json()).sort(),
      [
        "addedColumns",
        "changedColumns",
        "droppedColumns",
        "message",
        "ok",
        "orphanedColumns",
        "syncedAt",
      ].sort(),
    );
    assert.equal(unconfiguredSchemaSync.json<{ ok: boolean }>().ok, false);

    const tagEdit = await app.inject({
      method: "PUT",
      url: `/api/v1/registers/${tag.id}`,
      headers: authorization,
      payload: {
        name: "Line Voltage",
        historianColumn: "line_voltage",
        address: 0,
        functionCode: 3,
        dataType: "float32",
        byteOrder: "CDAB",
        scale: 0.1,
        offset: 0,
        unit: "V",
        decimalPlaces: 4,
        enabled: true,
      },
    });
    assert.equal(tagEdit.statusCode, 200);
    assert.equal(
      tagEdit.json<{ historianColumn: string }>().historianColumn,
      "line_voltage",
    );
    assert.equal(tagEdit.json<{ decimalPlaces: number }>().decimalPlaces, 4);

    const deviceEdit = await app.inject({
      method: "PUT",
      url: `/api/v1/devices/${device.id}`,
      headers: authorization,
      payload: {
        name: "Test Energy Meter",
        protocol: "tcp",
        tcpHost: "192.0.2.10",
        tcpPort: 502,
        unitId: 1,
        pollIntervalMs: 250,
        readBlockSize: 64,
        timeoutMs: 1500,
        retries: 2,
        categoryId: category.id,
        groupId: deviceGroup.id,
        postgresEnabled: false,
        saveIntervalMs: 1000,
        postgresRawTable: "test_energy_raw",
        postgresDownsampleTable: "test_energy_1m",
        postgresDownsampleEnabled: true,
        postgresDownsampleIntervalSec: 60,
        postgresRawRetentionDays: 7,
        postgresDownsampleRetentionDays: 90,
        postgresMaintenanceIntervalHours: 6,
        enabled: false,
      },
    });
    assert.equal(deviceEdit.statusCode, 200);
    assert.equal(
      deviceEdit.json<{ saveIntervalMs: number }>().saveIntervalMs,
      1000,
    );
    assert.equal(
      deviceEdit.json<{ postgresRawRetentionDays: number }>()
        .postgresRawRetentionDays,
      7,
    );
    const editedDevice = deviceEdit.json<Record<string, unknown>>();

    const disabledHistorianIntervals = await app.inject({
      method: "PUT",
      url: `/api/v1/devices/${device.id}`,
      headers: authorization,
      payload: {
        ...editedDevice,
        saveIntervalMs: 120_000,
        postgresDownsampleEnabled: true,
        postgresDownsampleIntervalSec: 60,
      },
    });
    assert.equal(disabledHistorianIntervals.statusCode, 200);

    const saveFasterThanPoll = await app.inject({
      method: "PUT",
      url: `/api/v1/devices/${device.id}`,
      headers: authorization,
      payload: {
        ...editedDevice,
        pollIntervalMs: 1000,
        saveIntervalMs: 500,
      },
    });
    assert.equal(saveFasterThanPoll.statusCode, 400);

    const tagsResponse = await app.inject({
      method: "GET",
      url: `/api/v1/devices/${device.id}/registers`,
      headers: authorization,
    });
    assert.equal(tagsResponse.statusCode, 200);
    assert.equal(tagsResponse.json<{ items: unknown[] }>().items.length, 1);

    const liveResponse = await app.inject({
      method: "GET",
      url: `/api/v1/devices/${device.id}/readings/latest`,
      headers: authorization,
    });
    assert.equal(liveResponse.statusCode, 200);
    const liveBody = liveResponse.json<{
      items: Array<{
        id: number;
        registerId: string;
        deviceId: string;
        value: number | null;
        rawJson: string;
        quality: string;
        timestamp: string;
        tagName: string;
        unit: string;
        address: number;
        deviceName: string;
        hasReading: number;
      }>;
      total: number;
    }>();
    assert.equal(liveBody.total, 1);
    assert.equal(liveBody.items.length, 1);
    assert.deepEqual(
      {
        ...liveBody.items[0],
        timestampIsValid: Number.isFinite(
          Date.parse(liveBody.items[0]?.timestamp ?? ""),
        ),
        timestamp: undefined,
      },
      {
        id: 0,
        registerId: tag.id,
        deviceId: device.id,
        value: null,
        rawJson: "[]",
        quality: "bad",
        timestamp: undefined,
        tagName: "Line Voltage",
        unit: "V",
        address: 0,
        deviceName: "Test Energy Meter",
        hasReading: 0,
        timestampIsValid: true,
      },
    );

    const unconfiguredPostgres = await app.inject({
      method: "POST",
      url: "/api/v1/devices",
      headers: authorization,
      payload: {
        name: "PostgreSQL Test Device",
        protocol: "tcp",
        tcpHost: "192.0.2.11",
        tcpPort: 502,
        unitId: 2,
        pollIntervalMs: 1000,
        readBlockSize: 120,
        timeoutMs: 2000,
        retries: 2,
        postgresEnabled: true,
        postgresRawTable: "modbus_raw",
        postgresDownsampleTable: "modbus_1m",
        postgresDownsampleIntervalSec: 60,
        enabled: false,
      },
    });
    assert.equal(unconfiguredPostgres.statusCode, 400);

    const operatorDisconnect = await app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/postgres/disconnect`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    assert.equal(operatorDisconnect.statusCode, 403);

    const disconnect = await app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/postgres/disconnect`,
      headers: authorization,
    });
    assert.equal(disconnect.statusCode, 200);
    assert.equal(disconnect.json<{ connected: boolean }>().connected, false);
    assert.equal(
      disconnect.json<{ device: { postgresEnabled: boolean } }>().device
        .postgresEnabled,
      false,
    );
    const repeatDisconnect = await app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/postgres/disconnect`,
      headers: authorization,
    });
    assert.equal(repeatDisconnect.statusCode, 200);
    assert.equal(
      repeatDisconnect.json<{ connected: boolean }>().connected,
      false,
    );

    const connectWithoutGlobalConfiguration = await app.inject({
      method: "POST",
      url: `/api/v1/devices/${device.id}/postgres/connect`,
      headers: authorization,
    });
    assert.equal(connectWithoutGlobalConfiguration.statusCode, 400);
    assert.equal(
      connectWithoutGlobalConfiguration.json<{ connected: boolean }>()
        .connected,
      false,
    );
    assert.equal(
      connectWithoutGlobalConfiguration.json<{
        device: { postgresEnabled: boolean; postgresSchemaDirty: boolean };
      }>().device.postgresEnabled,
      false,
    );
    assert.equal(
      connectWithoutGlobalConfiguration.json<{
        device: { postgresEnabled: boolean; postgresSchemaDirty: boolean };
      }>().device.postgresSchemaDirty,
      true,
    );

    const auditInspection = new SqliteDatabase(
      process.env.DATABASE_PATH as string,
      { readonly: true },
    );
    const connectionAuditActions = auditInspection
      .prepare(
        `SELECT action
         FROM audit_log
         WHERE entity_id = ?
           AND action IN (
             'postgres.device_disconnect',
             'postgres.device_connect_attention'
           )
         ORDER BY rowid`,
      )
      .all(device.id) as Array<{ action: string }>;
    auditInspection.close();
    assert.deepEqual(
      connectionAuditActions.map((row) => row.action),
      [
        "postgres.device_disconnect",
        "postgres.device_disconnect",
        "postgres.device_connect_attention",
      ],
    );

    const deleteTag = await app.inject({
      method: "DELETE",
      url: `/api/v1/registers/${tag.id}`,
      headers: authorization,
    });
    assert.equal(deleteTag.statusCode, 204);
    const tagsAfterDelete = await app.inject({
      method: "GET",
      url: `/api/v1/devices/${device.id}/registers`,
      headers: authorization,
    });
    assert.deepEqual(tagsAfterDelete.json(), { items: [] });

    const deleteDevice = await app.inject({
      method: "DELETE",
      url: `/api/v1/devices/${device.id}`,
      headers: authorization,
    });
    assert.equal(deleteDevice.statusCode, 204);
    const devicesAfterDelete = await app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: authorization,
    });
    assert.deepEqual(devicesAfterDelete.json(), { items: [] });

    const deleteCategory = await app.inject({
      method: "DELETE",
      url: `/api/v1/settings/device-classifications/categories/${category.id}`,
      headers: authorization,
    });
    assert.equal(deleteCategory.statusCode, 204);
    const deleteGroup = await app.inject({
      method: "DELETE",
      url: `/api/v1/settings/device-classifications/groups/${deviceGroup.id}`,
      headers: authorization,
    });
    assert.equal(deleteGroup.statusCode, 204);
  } finally {
    await app.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
