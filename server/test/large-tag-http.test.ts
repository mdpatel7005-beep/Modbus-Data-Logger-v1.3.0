import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const applicationRoot = mkdtempSync(
  path.join(tmpdir(), "modbus-large-tag-http-"),
);

process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(applicationRoot, "logger.db");
process.env.AUTH_DISABLED = "false";
process.env.POLLING_ENABLED = "false";
process.env.JWT_SECRET = "large-tag-test-secret-with-32-characters";
process.env.INITIAL_ADMIN_USERNAME = "admin";
process.env.INITIAL_ADMIN_PASSWORD = "admin";
delete process.env.POSTGRES_URL;

const { buildApplication } = await import("../src/app.js");

function tagPayload(index: number) {
  const functionCode = ((index % 4) + 1) as 1 | 2 | 3 | 4;
  return {
    name: `Scale Tag ${index}`,
    historianColumn: `scale_tag_${index}`,
    address: Math.floor(index / 4) * 160,
    functionCode,
    dataType:
      functionCode === 1 || functionCode === 2
        ? ("bool" as const)
        : functionCode === 3
          ? ("uint16" as const)
          : ("float32" as const),
    byteOrder: "ABCD" as const,
    scale: 1,
    offset: 0,
    unit: "",
    decimalPlaces: 2,
    enabled: true,
  };
}

test("bulk imports 1000+ mixed tags atomically and returns every live tag", async (context) => {
  context.after(() =>
    rmSync(applicationRoot, { force: true, recursive: true }),
  );
  const app = await buildApplication();
  await app.ready();
  context.after(() => app.close());

  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "admin", password: "admin" },
  });
  assert.equal(login.statusCode, 200);
  const authorization = {
    authorization: `Bearer ${login.json<{ token: string }>().token}`,
  };
  const createdDevice = await app.inject({
    method: "POST",
    url: "/api/v1/devices",
    headers: authorization,
    payload: {
      name: "Large mixed map",
      protocol: "tcp",
      tcpHost: "192.0.2.80",
      tcpPort: 502,
      unitId: 1,
      pollIntervalMs: 1_000,
      readBlockSize: 120,
      timeoutMs: 2_000,
      retries: 1,
      postgresEnabled: false,
      saveIntervalMs: 1_000,
      postgresRawTable: "large_mixed_raw",
      postgresDownsampleTable: "large_mixed_1m",
      postgresDownsampleEnabled: true,
      postgresDownsampleIntervalSec: 60,
      postgresRawRetentionDays: 30,
      postgresDownsampleRetentionDays: 365,
      postgresMaintenanceIntervalHours: 24,
      enabled: false,
    },
  });
  assert.equal(createdDevice.statusCode, 201);
  const deviceId = createdDevice.json<{ id: string }>().id;

  const imported = await app.inject({
    method: "POST",
    url: `/api/v1/devices/${deviceId}/registers/import`,
    headers: authorization,
    payload: {
      items: Array.from({ length: 1_205 }, (_, index) => tagPayload(index)),
    },
  });
  assert.equal(imported.statusCode, 201, imported.body);
  const importBody = imported.json<{
    items: Array<{ id: string }>;
    count: number;
    totalTags: number;
  }>();
  assert.equal(importBody.items.length, 1_205);
  assert.equal(importBody.count, 1_205);
  assert.equal(importBody.totalTags, 1_205);

  const devicesAfterImport = await app.inject({
    method: "GET",
    url: "/api/v1/devices",
    headers: authorization,
  });
  const importedDevice = devicesAfterImport
    .json<{ items: Array<{ id: string; tagCount: number; postgresSchemaRevision: number }> }>()
    .items.find((device) => device.id === deviceId);
  assert.equal(importedDevice?.tagCount, 1_205);
  assert.equal(importedDevice?.postgresSchemaRevision, 1);

  const live = await app.inject({
    method: "GET",
    url: `/api/v1/devices/${deviceId}/readings/latest`,
    headers: authorization,
  });
  assert.equal(live.statusCode, 200);
  const liveBody = live.json<{
    items: Array<{
      registerId: string;
      value: number | null;
      quality: string;
      hasReading: number;
    }>;
    total: number;
  }>();
  assert.equal(liveBody.items.length, 1_205);
  assert.equal(liveBody.total, 1_205);
  assert.equal(
    new Set(liveBody.items.map((item) => item.registerId)).size,
    1_205,
  );
  assert.ok(
    liveBody.items.every(
      (item) =>
        item.value === null &&
        item.quality === "bad" &&
        item.hasReading === 0,
    ),
  );

  const caseOnlyNameConflict = await app.inject({
    method: "PUT",
    url: `/api/v1/registers/${importBody.items[1]?.id}`,
    headers: authorization,
    payload: {
      ...tagPayload(1),
      name: tagPayload(0).name.toLowerCase(),
    },
  });
  assert.equal(caseOnlyNameConflict.statusCode, 409);
  assert.equal(
    caseOnlyNameConflict.json<{ error: string }>().error,
    "tag_name_conflict",
  );

  const invalidBatch = await app.inject({
    method: "POST",
    url: `/api/v1/devices/${deviceId}/registers/import`,
    headers: authorization,
    payload: {
      items: [
        tagPayload(1_205),
        {
          ...tagPayload(1_206),
          functionCode: 1,
          dataType: "float32",
        },
      ],
    },
  });
  assert.equal(invalidBatch.statusCode, 400);

  const tagsAfterRollback = await app.inject({
    method: "GET",
    url: `/api/v1/devices/${deviceId}/registers`,
    headers: authorization,
  });
  assert.equal(
    tagsAfterRollback.json<{ items: unknown[] }>().items.length,
    1_205,
  );

  const fillToLimit = await app.inject({
    method: "POST",
    url: `/api/v1/devices/${deviceId}/registers/import`,
    headers: authorization,
    payload: {
      items: Array.from({ length: 295 }, (_, offset) =>
        tagPayload(1_205 + offset),
      ),
    },
  });
  assert.equal(fillToLimit.statusCode, 201, fillToLimit.body);
  assert.equal(fillToLimit.json<{ totalTags: number }>().totalTags, 1_500);

  const overLimit = await app.inject({
    method: "POST",
    url: `/api/v1/devices/${deviceId}/registers`,
    headers: authorization,
    payload: tagPayload(1_500),
  });
  assert.equal(overLimit.statusCode, 409);
  assert.equal(overLimit.json<{ error: string }>().error, "device_tag_limit");

  const finalDevices = await app.inject({
    method: "GET",
    url: "/api/v1/devices",
    headers: authorization,
  });
  const finalDevice = finalDevices
    .json<{ items: Array<{ id: string; tagCount: number; postgresSchemaRevision: number }> }>()
    .items.find((device) => device.id === deviceId);
  assert.equal(finalDevice?.tagCount, 1_500);
  assert.equal(finalDevice?.postgresSchemaRevision, 2);
});
