import type { FastifyBaseLogger } from "fastify";
import { env } from "../config/env.js";
import type { LoggerDatabase } from "../db/database.js";
import type {
  Device,
  SystemAlertType,
  WhatsAppAlertSettings,
  WhatsAppAlertSettingsInput,
} from "../types/domain.js";
import { decryptSecret, encryptSecret } from "./secret-box.js";

const DELIVERY_INTERVAL_MS = 5_000;
const DELIVERY_BATCH_SIZE = 10;
const WHATSAPP_TIMEOUT_MS = 10_000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 5_000;

export interface PublicWhatsAppAlertSettings extends Omit<
  WhatsAppAlertSettings,
  "accessTokenEncrypted" | "updatedAt"
> {
  accessTokenConfigured: boolean;
  updatedAt: string | null;
}

export interface WhatsAppTestResult {
  ok: boolean;
  message: string;
  recipientCount: number;
}

interface WhatsAppSendResult {
  ok: boolean;
  message: string;
  providerMessageId: string | null;
  retryable: boolean;
  retryAfterMs: number | null;
}

type FetchImplementation = typeof fetch;

export class WhatsAppAlertConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppAlertConfigurationError";
  }
}

function defaultSettings(): WhatsAppAlertSettings {
  return {
    enabled: false,
    accessTokenEncrypted: null,
    recipients: [],
    graphApiVersion: "v23.0",
    phoneNumberId: "",
    templateName: "",
    language: "en_US",
    sendRecovery: true,
    offlineDelaySeconds: 60,
    lastTestAt: null,
    lastTestOk: null,
    lastTestMessage: null,
    updatedAt: new Date(0).toISOString(),
  };
}

function deliveryRecipients(settings: WhatsAppAlertSettings): string[] {
  return settings.enabled &&
    settings.accessTokenEncrypted &&
    settings.phoneNumberId &&
    settings.templateName
    ? settings.recipients
    : [];
}

function retryDelay(attempts: number): number {
  return Math.min(
    MAX_RETRY_DELAY_MS,
    DEFAULT_RETRY_DELAY_MS * 2 ** Math.min(attempts, 10),
  );
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, 86_400_000);
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.max(0, Math.min(date - Date.now(), 86_400_000))
    : null;
}

function templateParameters(input: {
  state: "OFFLINE" | "RECOVERED" | "TEST" | "ALARM_ACTIVE" | "ALARM_CLEARED";
  type: SystemAlertType | "system_test";
  source: string;
  detail: string;
  timestamp: string;
}) {
  let alertType = "System test";
  if (input.type === "device_offline") alertType = "Device offline";
  else if (input.type === "postgres_offline") alertType = "Remote PostgreSQL offline";
  else if (input.type === "tag_alarm") alertType = "Tag alarm";

  return [
    input.state,
    alertType,
    input.source,
    input.detail,
    input.timestamp,
  ].map((text) => ({ type: "text" as const, text }));
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes = 65_536,
): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    return "";
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        return "";
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export class SystemAlertService {
  private deliveryTimer: NodeJS.Timeout | null = null;
  private deliveryPromise: Promise<void> | null = null;
  private stopped = false;
  private paused = false;

  constructor(
    private readonly database: LoggerDatabase,
    private readonly logger: FastifyBaseLogger,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  start(): void {
    if (this.deliveryTimer || this.stopped) return;
    this.deliveryTimer = setInterval(
      () => void this.processPendingDeliveries(),
      DELIVERY_INTERVAL_MS,
    );
    this.deliveryTimer.unref();
    this.wakeDeliveryWorker();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.deliveryTimer) clearInterval(this.deliveryTimer);
    this.deliveryTimer = null;
    await this.deliveryPromise;
  }

  async pauseAndDrain(): Promise<void> {
    this.paused = true;
    await this.deliveryPromise;
  }

  resume(): void {
    if (this.stopped) return;
    this.paused = false;
    this.reconcileIntentionalState();
    this.wakeDeliveryWorker();
  }

  getPublicSettings(): PublicWhatsAppAlertSettings {
    const settings = this.database.getWhatsAppAlertSettings();
    const current = settings ?? defaultSettings();
    return {
      enabled: current.enabled,
      recipients: current.recipients,
      graphApiVersion: current.graphApiVersion,
      phoneNumberId: current.phoneNumberId,
      templateName: current.templateName,
      language: current.language,
      sendRecovery: current.sendRecovery,
      offlineDelaySeconds: current.offlineDelaySeconds,
      accessTokenConfigured: Boolean(current.accessTokenEncrypted),
      lastTestAt: current.lastTestAt,
      lastTestOk: current.lastTestOk,
      lastTestMessage: current.lastTestMessage,
      updatedAt: settings?.updatedAt ?? null,
    };
  }

  saveSettings(input: WhatsAppAlertSettingsInput): PublicWhatsAppAlertSettings {
    const existing =
      this.database.getWhatsAppAlertSettings() ?? defaultSettings();
    const suppliedToken = input.accessToken?.trim() ?? "";
    const accessTokenEncrypted = suppliedToken
      ? encryptSecret(suppliedToken)
      : existing.accessTokenEncrypted;
    if (
      input.enabled &&
      (!accessTokenEncrypted ||
        input.recipients.length === 0 ||
        !input.phoneNumberId ||
        !input.templateName)
    ) {
      throw new WhatsAppAlertConfigurationError(
        "An access token, recipient, phone number ID, and approved template are required when WhatsApp alerts are enabled",
      );
    }
    this.database.saveWhatsAppAlertSettings(
      {
        ...input,
        accessToken: undefined,
        recipients: [...new Set(input.recipients)],
      },
      accessTokenEncrypted,
    );
    this.database.cancelUnsentSystemAlertDeliveries(
      input.enabled ? [...new Set(input.recipients)] : null,
    );
    this.wakeDeliveryWorker();
    return this.getPublicSettings();
  }

  observeDevice(device: Device, offline: boolean, detail: string): void {
    const hasEnabledTags = this.database
      .listRegisters(device.id)
      .some((register) => register.enabled);
    const shouldMonitor =
      env.pollingEnabled && device.enabled && hasEnabledTags;
    this.observe({
      type: "device_offline",
      sourceKey: `device:${device.id}`,
      sourceId: device.id,
      sourceName: device.name,
      offline: shouldMonitor && offline,
      detail:
        shouldMonitor && offline ? detail : "Device communication recovered",
      notifyRecovery: shouldMonitor,
    });
  }

  observePostgres(input: {
    intended: boolean;
    offline: boolean;
    detail: string;
  }): void {
    const settings = this.database.getPostgresSettings();
    const sourceName =
      settings?.host && settings.database
        ? `${settings.host}:${settings.port}/${settings.database}`
        : "Remote PostgreSQL";
    this.observe({
      type: "postgres_offline",
      sourceKey: "postgres:remote",
      sourceId: null,
      sourceName,
      offline: input.intended && input.offline,
      detail:
        input.intended && input.offline
          ? input.detail
          : "Remote PostgreSQL connection recovered",
      notifyRecovery: input.intended,
    });
  }

  observeTagAlarm(input: {
    opened: boolean;
    registerId: string;
    ruleName: string;
    deviceName: string;
    tagName: string;
    currentValue: number;
    thresholdValue?: number | null;
    severity: "warning" | "critical";
  }): void {
    const settings = this.database.getWhatsAppAlertSettings();
    if (!settings?.enabled) return;

    const eventKind = input.opened ? "OPENED" : "CLEARED";
    const state = input.opened ? "ALARM_ACTIVE" : "ALARM_CLEARED";
    
    // Build source name as device:register
    const sourceName = `${input.deviceName} · ${input.tagName}`;
    const sourceKey = `tag:${input.registerId}:${input.ruleName}`;
    
    // Build detail with context
    let detail = `${eventKind}: ${input.severity.toUpperCase()} alarm on ${input.ruleName}`;
    if (input.thresholdValue !== null && input.thresholdValue !== undefined) {
      const thresholdLabel = this.getThresholdLabel(input.ruleName);
      detail += `\n${thresholdLabel}: ${input.currentValue.toFixed(2)} vs threshold ${input.thresholdValue.toFixed(2)}`;
    } else {
      detail += `\nCurrent value: ${input.currentValue.toFixed(2)}`;
    }

    const transition = this.database.observeSystemAlert({
      type: "tag_alarm",
      sourceKey,
      sourceId: input.registerId,
      sourceName,
      offline: false,
      detail,
      sendRecovery: true,
      offlineDelaySeconds: 30,
    });

    if (transition.opened) {
      this.logger.warn(
        {
          alertId: transition.opened.id,
          ruleName: input.ruleName,
          deviceName: input.deviceName,
          tagName: input.tagName,
          severity: input.severity,
        },
        "tag alarm opened",
      );
    } else if (transition.resolved) {
      this.logger.info(
        {
          alertId: transition.resolved.id,
          ruleName: input.ruleName,
          deviceName: input.deviceName,
          tagName: input.tagName,
          severity: input.severity,
        },
        "tag alarm cleared",
      );
    }

    this.wakeDeliveryWorker();
  }

  private getThresholdLabel(ruleName: string): string {
    // Extract condition from rule name if possible (format: "Rule Name - Condition")
    const match = ruleName.match(/-(HI|LO|HII|LOLO|ABOVE|BELOW|OUTSIDE)\b/i);
    if (match && match[1]) {
      return `Threshold ${match[1].toUpperCase()}`;
    }
    // Default based on common patterns
    if (ruleName.toLowerCase().includes("high")) return "High Threshold";
    if (ruleName.toLowerCase().includes("low")) return "Low Threshold";
    return "Threshold";
  }

  reconcileIntentionalState(): void {
    const sources = new Map<
      string,
      {
        type: SystemAlertType;
        sourceKey: string;
        sourceId: string | null;
        sourceName: string;
      }
    >();
    for (const alert of this.database.listSystemAlerts({
      activeOnly: true,
      limit: 10_000,
    })) {
      sources.set(`${alert.type}:${alert.sourceId ?? "remote"}`, {
        type: alert.type,
        sourceKey:
          alert.type === "device_offline" && alert.sourceId
            ? `device:${alert.sourceId}`
            : "postgres:remote",
        sourceId: alert.sourceId,
        sourceName: alert.sourceName,
      });
    }
    for (const observation of this.database.listSystemAlertObservations()) {
      sources.set(
        `${observation.type}:${observation.sourceId ?? "remote"}`,
        observation,
      );
    }
    for (const source of sources.values()) {
      if (source.type === "device_offline" && source.sourceId) {
        const device = this.database.getDevice(source.sourceId);
        const hasEnabledTags = device
          ? this.database
              .listRegisters(device.id)
              .some((register) => register.enabled)
          : false;
        if (!env.pollingEnabled || !device?.enabled || !hasEnabledTags) {
          this.observe({
            type: "device_offline",
            sourceKey: source.sourceKey,
            sourceId: source.sourceId,
            sourceName: device?.name ?? source.sourceName,
            offline: false,
            detail: "Device monitoring was intentionally disabled",
            notifyRecovery: false,
          });
        }
      }
    }
    const postgresIntended = this.postgresMonitoringIntended();
    if (!postgresIntended) {
      this.observePostgres({
        intended: false,
        offline: false,
        detail: "Remote PostgreSQL monitoring was intentionally disabled",
      });
    }
  }

  postgresMonitoringIntended(): boolean {
    const postgres = this.database.getPostgresSettings();
    const globallyConfigured = postgres
      ? Boolean(
          postgres.enabled &&
          postgres.host &&
          postgres.database &&
          postgres.username,
        )
      : Boolean(env.postgresUrl);
    return Boolean(
      globallyConfigured &&
      this.database
        .listDevices()
        .some((device) => device.enabled && device.postgresEnabled),
    );
  }

  async testWhatsApp(
    draft?: WhatsAppAlertSettingsInput,
  ): Promise<WhatsAppTestResult> {
    const stored =
      this.database.getWhatsAppAlertSettings() ?? defaultSettings();
    const suppliedToken = draft?.accessToken?.trim() ?? "";
    const settings: WhatsAppAlertSettings = draft
      ? {
          ...stored,
          ...draft,
          accessTokenEncrypted: suppliedToken
            ? encryptSecret(suppliedToken)
            : stored.accessTokenEncrypted,
          recipients: [...new Set(draft.recipients)],
        }
      : stored;
    if (
      !settings.accessTokenEncrypted ||
      settings.recipients.length === 0 ||
      !settings.phoneNumberId ||
      !settings.templateName
    ) {
      const message =
        "Save an access token, recipient, phone number ID, and approved template before testing";
      this.database.recordWhatsAppAlertTest(false, message);
      return { ok: false, message, recipientCount: 0 };
    }

    const timestamp = new Date().toISOString();
    const results = await Promise.all(
      settings.recipients.map((recipient) =>
        this.sendTemplate(settings, recipient, {
          state: "TEST",
          type: "system_test",
          source: "Modbus Data Logger V1.3.0",
          detail: "WhatsApp alert configuration test",
          timestamp,
        }),
      ),
    );
    const ok = results.every((result) => result.ok);
    const message = ok
      ? `WhatsApp test accepted for ${results.length} recipient(s)`
      : (results.find((result) => !result.ok)?.message ??
        "WhatsApp test was not accepted");
    this.database.recordWhatsAppAlertTest(ok, message);
    return { ok, message, recipientCount: results.length };
  }

  async flushDeliveries(): Promise<void> {
    await this.processPendingDeliveries();
  }

  private observe(input: {
    type: SystemAlertType;
    sourceKey: string;
    sourceId: string | null;
    sourceName: string;
    offline: boolean;
    detail: string;
    notifyRecovery?: boolean;
  }): void {
    const settings =
      this.database.getWhatsAppAlertSettings() ?? defaultSettings();
    const transition = this.database.observeSystemAlert({
      ...input,
      offlineDelaySeconds: settings.offlineDelaySeconds,
      deliveryRecipients: deliveryRecipients(settings),
      sendRecovery:
        input.notifyRecovery !== false &&
        settings.enabled &&
        settings.sendRecovery,
    });
    if (transition.opened) {
      this.logger.warn(
        {
          alertId: transition.opened.id,
          alertType: transition.opened.type,
          sourceName: transition.opened.sourceName,
        },
        "system outage alert opened",
      );
      this.wakeDeliveryWorker();
    }
    if (transition.resolved) {
      this.logger.info(
        {
          alertId: transition.resolved.id,
          alertType: transition.resolved.type,
          sourceName: transition.resolved.sourceName,
        },
        "system outage alert resolved",
      );
      this.wakeDeliveryWorker();
    }
  }

  private wakeDeliveryWorker(): void {
    if (this.stopped) return;
    const immediate = setImmediate(() => void this.processPendingDeliveries());
    immediate.unref();
  }

  private async processPendingDeliveries(): Promise<void> {
    if (this.deliveryPromise) return this.deliveryPromise;
    const pending = this.performPendingDeliveries();
    this.deliveryPromise = pending;
    try {
      await pending;
    } finally {
      if (this.deliveryPromise === pending) this.deliveryPromise = null;
    }
  }

  private async performPendingDeliveries(): Promise<void> {
    if (this.paused || this.stopped) return;
    const settings = this.database.getWhatsAppAlertSettings();
    if (
      !settings?.enabled ||
      !settings.accessTokenEncrypted ||
      !settings.phoneNumberId ||
      !settings.templateName
    ) {
      return;
    }
    const deliveries =
      this.database.listDueSystemAlertDeliveries(DELIVERY_BATCH_SIZE);
    await Promise.all(
      deliveries.map(async (delivery) => {
        const result = await this.sendTemplate(settings, delivery.recipient, {
          state: delivery.eventKind === "opened" ? "OFFLINE" : "RECOVERED",
          type: delivery.alertType,
          source: delivery.sourceName,
          detail: delivery.detail,
          timestamp: new Date().toISOString(),
        });
        if (result.ok) {
          this.database.markSystemAlertDeliverySent(
            delivery.id,
            result.providerMessageId,
          );
          return;
        }
        if (!result.retryable) {
          this.database.markSystemAlertDeliveryDead(
            delivery.id,
            result.message,
          );
          return;
        }
        const delay = result.retryAfterMs ?? retryDelay(delivery.attempts);
        this.database.markSystemAlertDeliveryFailed(
          delivery.id,
          result.message,
          new Date(Date.now() + delay).toISOString(),
        );
      }),
    );
  }

  private async sendTemplate(
    settings: WhatsAppAlertSettings,
    recipient: string,
    input: {
      state: "OFFLINE" | "RECOVERED" | "TEST";
      type: SystemAlertType | "system_test";
      source: string;
      detail: string;
      timestamp: string;
    },
  ): Promise<WhatsAppSendResult> {
    let token: string;
    try {
      token = settings.accessTokenEncrypted
        ? decryptSecret(settings.accessTokenEncrypted)
        : "";
    } catch {
      return {
        ok: false,
        message: "The saved WhatsApp access token cannot be decrypted",
        providerMessageId: null,
        retryable: false,
        retryAfterMs: null,
      };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WHATSAPP_TIMEOUT_MS);
    timeout.unref();
    try {
      const response = await this.fetchImplementation(
        `https://graph.facebook.com/${settings.graphApiVersion}/${settings.phoneNumberId}/messages`,
        {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: recipient,
            type: "template",
            template: {
              name: settings.templateName,
              language: { code: settings.language },
              components: [
                {
                  type: "body",
                  parameters: templateParameters(input),
                },
              ],
            },
          }),
        },
      );
      const responseText = await readBoundedResponseText(response);
      let providerMessageId: string | null = null;
      if (response.ok) {
        try {
          const parsed = JSON.parse(responseText) as {
            messages?: Array<{ id?: unknown }>;
          };
          const candidate = parsed.messages?.[0]?.id;
          providerMessageId =
            typeof candidate === "string" ? candidate.slice(0, 500) : null;
        } catch {
          providerMessageId = null;
        }
        return {
          ok: true,
          message: "WhatsApp template was accepted by Meta",
          providerMessageId,
          retryable: false,
          retryAfterMs: null,
        };
      }
      return {
        ok: false,
        message: `WhatsApp API returned HTTP ${response.status}`,
        providerMessageId: null,
        retryable:
          [408, 425, 429].includes(response.status) || response.status >= 500,
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error && error.name === "AbortError"
            ? "WhatsApp request timed out"
            : "WhatsApp API could not be reached",
        providerMessageId: null,
        retryable: true,
        retryAfterMs: null,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
