import type { FastifyBaseLogger } from "fastify";
import { env } from "../config/env.js";
import type { LoggerDatabase } from "../db/database.js";
import {
  DeviceClient,
  groupRegisters,
  type RegisterBlock,
} from "../modbus/client.js";
import { registerWidth } from "../modbus/codec.js";
import type {
  Device,
  ReadingInsert,
  RegisterDefinition,
} from "../types/domain.js";
import { AlarmEngine } from "./alarm-engine.js";
import type { PostgresHistorian } from "./postgres-historian.js";
import type { SystemAlertService } from "./system-alerts.js";

interface PollTask {
  timer: NodeJS.Timeout | null;
  inFlight: Promise<void> | null;
  client: DeviceClient | null;
  learnedBlockSplits: Map<string, LearnedBlockSplit>;
  running: boolean;
  stopped: boolean;
}

interface LearnedBlockSplit {
  blocks: RegisterBlock[];
}

const POLLING_DRAIN_TIMEOUT_MS = 10_000;
const LIVE_READING_FLUSH_SIZE = 250;
const LIVE_READING_FLUSH_INTERVAL_MS = 1_000;
const BLOCK_FAILURE_FALLBACK_REQUESTS = 8;

function registerReadWidth(register: RegisterDefinition): number {
  return register.functionCode === 1 || register.functionCode === 2
    ? 1
    : registerWidth(register.dataType);
}

function registerBlock(registers: RegisterDefinition[]): RegisterBlock {
  const sorted = [...registers].sort(
    (left, right) => left.address - right.address || left.id.localeCompare(right.id),
  );
  const first = sorted[0] as RegisterDefinition;
  const endAddress = Math.max(
    ...sorted.map((register) => register.address + registerReadWidth(register)),
  );
  return {
    functionCode: first.functionCode,
    startAddress: first.address,
    length: endAddress - first.address,
    registers: sorted,
  };
}

function splitRegisterBlock(
  block: RegisterBlock,
): [RegisterBlock, RegisterBlock] | null {
  if (block.registers.length < 2) return null;
  const sorted = [...block.registers].sort(
    (left, right) => left.address - right.address || left.id.localeCompare(right.id),
  );
  const midpoint = sorted.length / 2;
  let splitAt = Math.floor(midpoint);
  let largestGap = Number.NEGATIVE_INFINITY;
  let closestToMiddle = Number.POSITIVE_INFINITY;
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1] as RegisterDefinition;
    const next = sorted[index] as RegisterDefinition;
    const gap =
      next.address - (previous.address + registerReadWidth(previous));
    const distanceFromMiddle = Math.abs(index - midpoint);
    if (
      gap > largestGap ||
      (gap === largestGap && distanceFromMiddle < closestToMiddle)
    ) {
      splitAt = index;
      largestGap = gap;
      closestToMiddle = distanceFromMiddle;
    }
  }
  return [
    registerBlock(sorted.slice(0, splitAt)),
    registerBlock(sorted.slice(splitAt)),
  ];
}

function registerBlockKey(block: RegisterBlock): string {
  return [
    block.functionCode,
    block.startAddress,
    block.length,
    ...block.registers.map((register) => register.id),
  ].join(":");
}

function applyLearnedBlockSplits(
  blocks: RegisterBlock[],
  learned: Map<string, LearnedBlockSplit>,
): RegisterBlock[] {
  const expanded: RegisterBlock[] = [];
  const append = (block: RegisterBlock, seen: Set<string>) => {
    const key = registerBlockKey(block);
    const replacement = learned.get(key);
    if (!replacement || seen.has(key)) {
      expanded.push(block);
      return;
    }
    const nextSeen = new Set(seen).add(key);
    for (const child of replacement.blocks) append(child, nextSeen);
  };
  for (const block of blocks) append(block, new Set());
  return expanded;
}

function failedBlockReadings(
  block: RegisterBlock,
  deviceId: string,
  timestamp: string,
): ReadingInsert[] {
  return block.registers.map((register) => ({
    registerId: register.id,
    deviceId,
    value: null,
    raw: [],
    quality: "bad",
    timestamp,
  }));
}

export class PollingDrainTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Modbus polling did not drain within ${timeoutMs} ms; system administration was not started`,
    );
    this.name = "PollingDrainTimeoutError";
  }
}

class PollingStoppedError extends Error {
  constructor() {
    super("Modbus polling was stopped for system administration");
    this.name = "PollingStoppedError";
  }
}

async function withRetry<T>(
  operation: () => Promise<T>,
  attempts: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export class PollingService {
  private readonly tasks = new Map<string, PollTask>();
  private readonly alarmEngine: AlarmEngine;
  private started = false;
  private administrationPaused = false;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private readonly activePollOperations = new Set<Promise<void>>();
  private resumeAfterDrainPending = false;
  private systemAlerts: SystemAlertService | undefined;

  constructor(
    private readonly database: LoggerDatabase,
    private readonly logger: FastifyBaseLogger,
    private readonly postgresHistorian: PostgresHistorian,
    private readonly enabled = env.pollingEnabled,
    private readonly clientFactory: (device: Device) => DeviceClient = (
      device,
    ) => new DeviceClient(device),
  ) {
    this.alarmEngine = new AlarmEngine(database);
  }

  setSystemAlertService(systemAlerts: SystemAlertService): void {
    this.systemAlerts = systemAlerts;
    // Wire tag alarm notifications to WhatsApp alert pipeline
    if (systemAlerts) {
      this.alarmEngine.setOnTagAlarm((input) => {
        systemAlerts.observeTagAlarm(input);
      });
    }
  }

  async start(): Promise<void> {
    return this.serializeLifecycle(async () => this.startNow());
  }

  private startNow(): void {
    if (this.administrationPaused) return;
    if (this.activePollOperations.size > 0) {
      this.scheduleStartAfterDrain([...this.activePollOperations]);
      return;
    }
    if (!this.enabled) {
      this.logger.info("polling service remains disabled by configuration");
      return;
    }
    if (this.started) return;
    this.started = true;
    for (const device of this.database
      .listDevices()
      .filter((item) => item.enabled)) {
      this.startDevice(device);
    }
    this.logger.info(
      { deviceCount: this.tasks.size },
      "polling service started",
    );
  }

  async reload(): Promise<void> {
    return this.serializeLifecycle(async () => {
      await this.stopAndDrainNow();
      this.startNow();
      this.systemAlerts?.reconcileIntentionalState();
    });
  }

  async stop(): Promise<void> {
    this.administrationPaused = true;
    await this.stopAndDrain();
  }

  private stopTasks(): Promise<void>[] {
    this.started = false;
    const aborts: Promise<void>[] = [];
    for (const task of this.tasks.values()) {
      task.stopped = true;
      if (task.timer) clearTimeout(task.timer);
      if (task.client) aborts.push(task.client.abort());
    }
    this.tasks.clear();
    return aborts;
  }

  async stopAndDrain(): Promise<void> {
    return this.serializeLifecycle(async () => this.stopAndDrainNow());
  }

  async pauseAndDrain(timeoutMs = POLLING_DRAIN_TIMEOUT_MS): Promise<void> {
    this.administrationPaused = true;
    return this.serializeLifecycle(async () => {
      const aborts = this.stopTasks();
      const operations = [...this.activePollOperations, ...aborts];
      if (operations.length === 0) return;
      const drained = Promise.allSettled(operations).then(() => undefined);
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          drained,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new PollingDrainTimeoutError(timeoutMs)),
              timeoutMs,
            );
          }),
        ]);
      } catch (error) {
        this.administrationPaused = false;
        this.scheduleStartAfterDrain(operations);
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    });
  }

  async resumeAndStart(): Promise<void> {
    return this.serializeLifecycle(async () => {
      this.administrationPaused = false;
      this.startNow();
    });
  }

  private async stopAndDrainNow(): Promise<void> {
    const aborts = this.stopTasks();
    await Promise.allSettled([...this.activePollOperations, ...aborts]);
  }

  private scheduleStartAfterDrain(operations: Promise<unknown>[]): void {
    if (this.resumeAfterDrainPending) return;
    this.resumeAfterDrainPending = true;
    void Promise.allSettled(operations).then(() => {
      this.resumeAfterDrainPending = false;
      if (!this.administrationPaused) void this.start();
    });
  }

  private async serializeLifecycle(
    operation: () => Promise<void>,
  ): Promise<void> {
    const result = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = result.catch(() => undefined);
    return result;
  }

  get activeDeviceCount(): number {
    return this.tasks.size;
  }

  get paused(): boolean {
    return this.administrationPaused;
  }

  private startDevice(device: Device): void {
    const task: PollTask = {
      timer: null,
      inFlight: null,
      client: null,
      learnedBlockSplits: new Map(),
      running: false,
      stopped: false,
    };
    this.tasks.set(device.id, task);

    const schedule = () => {
      if (task.stopped) return;
      task.timer = setTimeout(async () => {
        if (task.running) {
          schedule();
          return;
        }
        await run();
      }, device.pollIntervalMs);
    };

    const run = async () => {
      if (task.stopped || task.running) return;
      task.running = true;
      const operation = this.pollDevice(device, task);
      task.inFlight = operation;
      this.activePollOperations.add(operation);
      try {
        await operation;
      } catch (error) {
        this.logger.error(
          {
            deviceId: device.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "device polling task stopped unexpectedly",
        );
      } finally {
        this.activePollOperations.delete(operation);
        if (task.inFlight === operation) task.inFlight = null;
        task.running = false;
        schedule();
      }
    };

    void run();
  }

  private async pollDevice(device: Device, task: PollTask): Promise<void> {
    const startedAt = Date.now();
    const registers = this.database
      .listRegisters(device.id)
      .filter((register) => register.enabled);
    if (registers.length === 0) {
      this.systemAlerts?.observeDevice(
        device,
        false,
        "Device has no enabled tags and is not being monitored",
      );
      return;
    }

    const client = this.clientFactory(device);
    task.client = client;
    try {
      await withRetry(() => {
        if (task.stopped) throw new PollingStoppedError();
        return client.connect();
      }, device.retries + 1);
      const readings: ReadingInsert[] = [];
      let pendingLiveReadings: ReadingInsert[] = [];
      let lastLiveFlushAt = Date.now();
      const flushLiveReadings = () => {
        if (pendingLiveReadings.length === 0) return;
        this.database.insertReadings(pendingLiveReadings);
        pendingLiveReadings = [];
        lastLiveFlushAt = Date.now();
      };

      const blocks = applyLearnedBlockSplits(
        groupRegisters(registers, device.readBlockSize),
        task.learnedBlockSplits,
      );
      for (const block of blocks) {
        if (task.stopped) throw new PollingStoppedError();
        const blockReadings = await this.readBlock(client, device, block, task);
        if (task.stopped) throw new PollingStoppedError();
        readings.push(...blockReadings);
        pendingLiveReadings.push(...blockReadings);
        if (
          pendingLiveReadings.length >= LIVE_READING_FLUSH_SIZE ||
          Date.now() - lastLiveFlushAt >= LIVE_READING_FLUSH_INTERVAL_MS
        ) {
          flushLiveReadings();
        }
        for (const reading of blockReadings) {
          if (reading.value !== null && reading.quality === "good") {
            const register = block.registers.find(
              (item) => item.id === reading.registerId,
            );
            if (register) this.alarmEngine.evaluate(register, reading.value);
          }
        }
      }

      if (task.stopped) throw new PollingStoppedError();
      flushLiveReadings();
      try {
        await this.postgresHistorian.write(device, readings);
      } catch (error) {
        this.logger.error(
          {
            deviceId: device.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "PostgreSQL historian write failed",
        );
      }
      const failedReads = readings.filter(
        (reading) => reading.quality !== "good",
      ).length;
      const status =
        failedReads === 0
          ? "online"
          : failedReads === readings.length
            ? "offline"
            : "warning";
      this.database.updateDeviceHealth(device.id, status, {
        lastSeenAt:
          failedReads < readings.length ? new Date().toISOString() : null,
        lastError:
          failedReads > 0
            ? `${failedReads} of ${readings.length} register reads failed`
            : null,
        lastPollMs: Date.now() - startedAt,
      });
      this.systemAlerts?.observeDevice(
        device,
        status === "offline",
        status === "offline"
          ? `${failedReads} of ${readings.length} register reads failed`
          : "Device communication recovered",
      );
    } catch (error) {
      if (task.stopped || error instanceof PollingStoppedError) return;
      const message =
        error instanceof Error ? error.message : "Unknown Modbus error";
      this.database.updateDeviceHealth(device.id, "offline", {
        lastError: message.slice(0, 500),
        lastPollMs: Date.now() - startedAt,
      });
      this.systemAlerts?.observeDevice(device, true, message.slice(0, 500));
      this.logger.warn(
        { deviceId: device.id, deviceName: device.name, error: message },
        "device poll failed",
      );
    } finally {
      await client.close();
      if (task.client === client) task.client = null;
    }
  }

  private async readBlock(
    client: DeviceClient,
    device: Device,
    block: RegisterBlock,
    task: PollTask,
  ): Promise<ReadingInsert[]> {
    const timestamp = new Date().toISOString();
    return this.readBlockWithFallback(
      client,
      device,
      block,
      task,
      timestamp,
      device.retries + 1,
      BLOCK_FAILURE_FALLBACK_REQUESTS,
    );
  }

  private async readBlockWithFallback(
    client: DeviceClient,
    device: Device,
    block: RegisterBlock,
    task: PollTask,
    timestamp: string,
    attempts: number,
    fallbackRequestsRemaining: number,
  ): Promise<ReadingInsert[]> {
    try {
      const results = await withRetry(() => {
        if (task.stopped) throw new PollingStoppedError();
        return client.readBlock(block);
      }, attempts);
      return results.map((result) => ({
        registerId: result.register.id,
        deviceId: device.id,
        value: result.value,
        raw: result.raw,
        quality: "good",
        timestamp,
      }));
    } catch (error) {
      if (task.stopped) throw new PollingStoppedError();
      const split =
        fallbackRequestsRemaining >= 2 ? splitRegisterBlock(block) : null;
      if (split) {
        this.logger.debug(
          {
            deviceId: device.id,
            functionCode: block.functionCode,
            startAddress: block.startAddress,
            blockLength: block.length,
            tagCount: block.registers.length,
            fallbackRequestsRemaining,
            error: error instanceof Error ? error.message : String(error),
          },
          "register block read failed; retrying smaller tag-aligned blocks",
        );
        const recovered: ReadingInsert[] = [];
        const branchRequestBudgets = [
          Math.ceil(fallbackRequestsRemaining / 2),
          Math.floor(fallbackRequestsRemaining / 2),
        ];
        for (const [index, child] of split.entries()) {
          const branchRequestBudget = branchRequestBudgets[index] as number;
          if (branchRequestBudget <= 0) {
            recovered.push(
              ...failedBlockReadings(child, device.id, timestamp),
            );
            continue;
          }
          recovered.push(
            ...(await this.readBlockWithFallback(
              client,
              device,
              child,
              task,
              timestamp,
              1,
              branchRequestBudget - 1,
            )),
          );
        }
        if (recovered.some((reading) => reading.quality === "good")) {
          task.learnedBlockSplits.set(registerBlockKey(block), {
            blocks: split,
          });
        }
        return recovered;
      }
      this.logger.debug(
        {
          deviceId: device.id,
          functionCode: block.functionCode,
          startAddress: block.startAddress,
          blockLength: block.length,
          error: error instanceof Error ? error.message : String(error),
        },
        "register block read failed",
      );
      return failedBlockReadings(block, device.id, timestamp);
    }
  }
}
