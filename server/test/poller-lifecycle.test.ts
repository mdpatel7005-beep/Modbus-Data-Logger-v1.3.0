import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyBaseLogger } from "fastify";
import type { LoggerDatabase } from "../src/db/database.js";
import {
  groupRegisters,
  type DeviceClient,
  type RegisterBlock,
} from "../src/modbus/client.js";
import { PollingService } from "../src/services/poller.js";
import type { PostgresHistorian } from "../src/services/postgres-historian.js";
import type {
  Device,
  ReadingInsert,
  RegisterDefinition,
} from "../src/types/domain.js";

const device: Device = {
  id: "dev_lifecycle",
  name: "Lifecycle device",
  protocol: "tcp",
  tcpHost: "127.0.0.1",
  tcpPort: 502,
  serialPort: null,
  baudRate: null,
  parity: null,
  dataBits: null,
  stopBits: null,
  unitId: 1,
  pollIntervalMs: 3_600_000,
  readBlockSize: 120,
  timeoutMs: 1_000,
  retries: 0,
  categoryId: null,
  categoryName: null,
  groupId: null,
  groupName: null,
  postgresEnabled: false,
  saveIntervalMs: 3_600_000,
  postgresRawTable: "lifecycle_raw",
  postgresDownsampleTable: "lifecycle_1m",
  postgresDownsampleEnabled: true,
  postgresDownsampleIntervalSec: 3_600,
  postgresRawRetentionDays: 30,
  postgresDownsampleRetentionDays: 365,
  postgresMaintenanceIntervalHours: 24,
  postgresLastMaintenanceAt: null,
  postgresSchemaSyncedAt: null,
  postgresSchemaDirty: true,
  postgresSchemaRevision: 0,
  tagCount: 0,
  enabled: true,
  status: "offline",
  lastSeenAt: null,
  lastError: null,
  lastPollMs: null,
  createdAt: "2026-07-25T00:00:00.000Z",
  updatedAt: "2026-07-25T00:00:00.000Z",
};

const database = {
  listDevices: () => [device],
  listRegisters: () => [],
} as unknown as LoggerDatabase;

const logger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
} as unknown as FastifyBaseLogger;

const historian = {
  async write() {},
} as unknown as PostgresHistorian;

function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("never starts tasks when polling is disabled, including reload", async () => {
  const poller = new PollingService(database, logger, historian, false);
  await poller.start();
  assert.equal(poller.activeDeviceCount, 0);
  await poller.reload();
  assert.equal(poller.activeDeviceCount, 0);
  await poller.resumeAndStart();
  assert.equal(poller.activeDeviceCount, 0);
});

test("serializes pause, reload, resume, and drain lifecycle operations", async () => {
  const poller = new PollingService(database, logger, historian, true);
  await poller.start();
  assert.equal(poller.activeDeviceCount, 1);

  await poller.pauseAndDrain();
  assert.equal(poller.activeDeviceCount, 0);
  await Promise.all([poller.reload(), poller.reload()]);
  assert.equal(poller.activeDeviceCount, 0);

  await poller.resumeAndStart();
  assert.equal(poller.activeDeviceCount, 1);
  await poller.stopAndDrain();
  assert.equal(poller.activeDeviceCount, 0);
});

test("aborts an active Modbus transport before administration continues", async () => {
  const register: RegisterDefinition = {
    id: "reg_lifecycle",
    deviceId: device.id,
    name: "Active power",
    historianColumn: "active_power",
    address: 0,
    functionCode: 3,
    dataType: "float32",
    byteOrder: "ABCD",
    scale: 1,
    offset: 0,
    unit: "kW",
    decimalPlaces: 2,
    enabled: true,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z",
  };
  const activeDatabase = {
    listDevices: () => [device],
    listRegisters: () => [register],
    updateDeviceHealth() {},
    insertReadings() {},
  } as unknown as LoggerDatabase;
  let signalConnectStarted = () => {};
  const connectStarted = new Promise<void>((resolve) => {
    signalConnectStarted = resolve;
  });
  let rejectConnect: (error: Error) => void = () => {};
  const blockedConnect = new Promise<void>((_resolve, reject) => {
    rejectConnect = reject;
  });
  let abortCalls = 0;
  const client = {
    async connect() {
      signalConnectStarted();
      await blockedConnect;
    },
    async abort() {
      abortCalls += 1;
      rejectConnect(new Error("transport aborted"));
    },
    async close() {},
    async readBlock() {
      return [];
    },
  } as unknown as DeviceClient;
  const poller = new PollingService(
    activeDatabase,
    logger,
    historian,
    true,
    () => client,
  );

  await poller.start();
  await connectStarted;
  await poller.pauseAndDrain(100);

  assert.equal(abortCalls, 1);
  assert.equal(poller.activeDeviceCount, 0);
  assert.equal(poller.paused, true);
});

test(
  "polls 1,205 sparse mixed-function tags without dropping readings and flushes live data incrementally",
  { timeout: 5_000 },
  async () => {
    const functionCodes = [1, 2, 3, 4] as const;
    const registers = Array.from({ length: 1_205 }, (_, index) => {
      const functionCode = functionCodes[index % functionCodes.length] as
        | 1
        | 2
        | 3
        | 4;
      const address = Math.floor(index / functionCodes.length) * 3;
      return {
        id: `reg_large_${String(index).padStart(4, "0")}`,
        deviceId: "dev_large_cycle",
        name: `Sparse tag ${index}`,
        historianColumn: `sparse_tag_${index}`,
        address,
        functionCode,
        dataType:
          functionCode === 1 || functionCode === 2 ? "bool" : "uint16",
        byteOrder: "ABCD",
        scale: 1,
        offset: 0,
        unit: "",
        decimalPlaces: 0,
        enabled: true,
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:00.000Z",
      } satisfies RegisterDefinition;
    });
    const largeDevice: Device = {
      ...device,
      id: "dev_large_cycle",
      name: "Large sparse device",
      readBlockSize: 120,
    };
    const plannedBlocks = groupRegisters(
      registers,
      largeDevice.readBlockSize,
    );
    assert.ok(plannedBlocks.length > 1);

    const finalBlockStarted = deferredSignal();
    const releaseFinalBlock = deferredSignal();
    const cycleFinished = deferredSignal();
    const requestedBlocks: RegisterBlock[] = [];
    const insertedBatches: ReadingInsert[][] = [];
    const historianWrites: ReadingInsert[][] = [];
    let healthUpdateCount = 0;
    let closeCalls = 0;

    const largeDatabase = {
      listDevices: () => [largeDevice],
      listRegisters: () => registers,
      listAlarmRules: () => [],
      insertReadings(batch: ReadingInsert[]) {
        insertedBatches.push([...batch]);
      },
      updateDeviceHealth() {
        healthUpdateCount += 1;
        cycleFinished.resolve();
      },
    } as unknown as LoggerDatabase;
    const largeHistorian = {
      async write(_device: Device, readings: ReadingInsert[]) {
        historianWrites.push([...readings]);
      },
    } as unknown as PostgresHistorian;
    const client = {
      async connect() {},
      async abort() {},
      async close() {
        closeCalls += 1;
      },
      async readBlock(block: RegisterBlock) {
        requestedBlocks.push(block);
        if (requestedBlocks.length === plannedBlocks.length) {
          finalBlockStarted.resolve();
          await releaseFinalBlock.promise;
        }
        return block.registers.map((register) => ({
          register,
          raw: [register.address],
          value: register.address,
        }));
      },
    } as unknown as DeviceClient;
    const poller = new PollingService(
      largeDatabase,
      logger,
      largeHistorian,
      true,
      () => client,
    );

    await poller.start();
    try {
      await finalBlockStarted.promise;

      const incrementallyFlushed = insertedBatches.flat();
      assert.ok(
        incrementallyFlushed.length >= 250,
        "the live-reading threshold should flush before the final block",
      );
      assert.ok(
        incrementallyFlushed.length < registers.length,
        "the first live flush must happen before the full cycle is available",
      );
      assert.equal(historianWrites.length, 0);
      assert.equal(healthUpdateCount, 0);

      releaseFinalBlock.resolve();
      await cycleFinished.promise;

      assert.equal(requestedBlocks.length, plannedBlocks.length);
      for (const block of requestedBlocks) {
        const protocolLimit =
          block.functionCode === 1 || block.functionCode === 2 ? 2_000 : 125;
        assert.ok(block.length > 0);
        assert.ok(
          block.length <= Math.min(largeDevice.readBlockSize, protocolLimit),
          `FC${block.functionCode} block length ${block.length} exceeded its configured/protocol limit`,
        );
      }

      const expectedIds = registers.map((register) => register.id).sort();
      const liveReadings = insertedBatches.flat();
      assert.equal(liveReadings.length, registers.length);
      assert.deepEqual(
        liveReadings.map((reading) => reading.registerId).sort(),
        expectedIds,
      );
      assert.ok(
        liveReadings.every((reading) => reading.quality === "good"),
      );

      assert.equal(historianWrites.length, 1);
      const historianReadings = historianWrites[0] as ReadingInsert[];
      assert.equal(historianReadings.length, registers.length);
      assert.deepEqual(
        historianReadings.map((reading) => reading.registerId).sort(),
        expectedIds,
      );
    } finally {
      releaseFinalBlock.resolve();
      await poller.stopAndDrain();
    }

    assert.ok(closeCalls >= 1);
    assert.equal(poller.activeDeviceCount, 0);
  },
);

test(
  "learns a failed block split and preserves seven good tags around one bad address",
  { timeout: 5_000 },
  async () => {
    const addresses = [171, 177, 179, 181, 183, 185, 187, 199];
    const splitDevice: Device = {
      ...device,
      id: "dev_split_fallback",
      name: "Split fallback device",
      readBlockSize: 120,
      pollIntervalMs: 5,
    };
    const registers = addresses.map(
      (address): RegisterDefinition => ({
        id: `reg_address_${address}`,
        deviceId: splitDevice.id,
        name: `Address ${address}`,
        historianColumn: `address_${address}`,
        address,
        functionCode: 3,
        dataType: "uint16",
        byteOrder: "ABCD",
        scale: 1,
        offset: 0,
        unit: "",
        decimalPlaces: 0,
        enabled: true,
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:00.000Z",
      }),
    );
    const twoCyclesFinished = deferredSignal();
    const requestedBlocksByCycle: RegisterBlock[][] = [];
    const insertedReadings: ReadingInsert[] = [];
    const historianWrites: ReadingInsert[][] = [];
    const healthStatuses: Device["status"][] = [];
    let closeCalls = 0;

    const splitDatabase = {
      listDevices: () => [splitDevice],
      listRegisters: () => registers,
      listAlarmRules: () => [],
      insertReadings(batch: ReadingInsert[]) {
        insertedReadings.push(...batch);
      },
      updateDeviceHealth(
        _deviceId: string,
        status: Device["status"],
      ) {
        healthStatuses.push(status);
        if (healthStatuses.length === 2) twoCyclesFinished.resolve();
      },
    } as unknown as LoggerDatabase;
    const splitHistorian = {
      async write(_device: Device, readings: ReadingInsert[]) {
        historianWrites.push([...readings]);
      },
    } as unknown as PostgresHistorian;
    const poller = new PollingService(
      splitDatabase,
      logger,
      splitHistorian,
      true,
      () => {
        const requestedBlocks: RegisterBlock[] = [];
        requestedBlocksByCycle.push(requestedBlocks);
        return {
          async connect() {},
          async abort() {},
          async close() {
            closeCalls += 1;
          },
          async readBlock(block: RegisterBlock) {
            requestedBlocks.push(block);
            if (
              block.registers.some((register) => register.address === 199)
            ) {
              throw new Error("address 199 did not respond");
            }
            return block.registers.map((register) => ({
              register,
              raw: [register.address],
              value: register.address,
            }));
          },
        } as unknown as DeviceClient;
      },
    );

    await poller.start();
    try {
      await twoCyclesFinished.promise;
      await poller.stopAndDrain();

      assert.equal(requestedBlocksByCycle.length, 2);
      const firstCycle = requestedBlocksByCycle[0] as RegisterBlock[];
      const secondCycle = requestedBlocksByCycle[1] as RegisterBlock[];
      assert.equal(firstCycle.length, 3);
      assert.deepEqual(
        firstCycle[0]?.registers.map((register) => register.address),
        addresses,
      );
      assert.deepEqual(
        firstCycle[1]?.registers.map((register) => register.address),
        addresses.slice(0, -1),
      );
      assert.deepEqual(
        firstCycle[2]?.registers.map((register) => register.address),
        [199],
      );

      assert.equal(
        secondCycle.length,
        2,
        "the next poll should skip the known-failing parent block",
      );
      assert.deepEqual(
        secondCycle[0]?.registers.map((register) => register.address),
        addresses.slice(0, -1),
      );
      assert.deepEqual(
        secondCycle[1]?.registers.map((register) => register.address),
        [199],
      );

      assert.equal(insertedReadings.length, addresses.length * 2);
      const secondCycleReadings = insertedReadings.slice(addresses.length);
      const goodReadings = secondCycleReadings.filter(
        (reading) => reading.quality === "good",
      );
      const badReadings = secondCycleReadings.filter(
        (reading) => reading.quality === "bad",
      );
      assert.equal(goodReadings.length, 7);
      assert.deepEqual(
        goodReadings
          .map((reading) => Number(reading.registerId.split("_").at(-1)))
          .sort((left, right) => left - right),
        addresses.slice(0, -1),
      );
      assert.equal(badReadings.length, 1);
      assert.equal(badReadings[0]?.registerId, "reg_address_199");
      assert.equal(badReadings[0]?.value, null);
      assert.deepEqual(badReadings[0]?.raw, []);

      assert.equal(historianWrites.length, 2);
      assert.ok(
        historianWrites.every((readings) => readings.length === addresses.length),
      );
      assert.deepEqual(healthStatuses, ["warning", "warning"]);
    } finally {
      await poller.stopAndDrain();
    }

    assert.ok(closeCalls >= 2);
    assert.equal(poller.activeDeviceCount, 0);
  },
);

test(
  "hard-limits adaptive fallback requests when every nested block fails",
  { timeout: 5_000 },
  async () => {
    const failedDevice: Device = {
      ...device,
      id: "dev_failed_fallback",
      name: "Failed fallback device",
    };
    const registers = Array.from(
      { length: 32 },
      (_, index): RegisterDefinition => ({
        id: `reg_failed_${index}`,
        deviceId: failedDevice.id,
        name: `Failed address ${index}`,
        historianColumn: `failed_address_${index}`,
        address: index * 2,
        functionCode: 3,
        dataType: "uint16",
        byteOrder: "ABCD",
        scale: 1,
        offset: 0,
        unit: "",
        decimalPlaces: 0,
        enabled: true,
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:00.000Z",
      }),
    );
    const cycleFinished = deferredSignal();
    const requestedBlocks: RegisterBlock[] = [];
    const insertedReadings: ReadingInsert[] = [];
    const failedDatabase = {
      listDevices: () => [failedDevice],
      listRegisters: () => registers,
      listAlarmRules: () => [],
      insertReadings(batch: ReadingInsert[]) {
        insertedReadings.push(...batch);
      },
      updateDeviceHealth() {
        cycleFinished.resolve();
      },
    } as unknown as LoggerDatabase;
    const client = {
      async connect() {},
      async abort() {},
      async close() {},
      async readBlock(block: RegisterBlock) {
        requestedBlocks.push(block);
        throw new Error("device rejected every block");
      },
    } as unknown as DeviceClient;
    const poller = new PollingService(
      failedDatabase,
      logger,
      historian,
      true,
      () => client,
    );

    await poller.start();
    try {
      await cycleFinished.promise;
      assert.ok(
        requestedBlocks.length <= 1 + 8,
        `expected one parent plus at most eight fallback requests, received ${requestedBlocks.length}`,
      );
      assert.equal(insertedReadings.length, registers.length);
      assert.ok(
        insertedReadings.every((reading) => reading.quality === "bad"),
      );
    } finally {
      await poller.stopAndDrain();
    }
  },
);
