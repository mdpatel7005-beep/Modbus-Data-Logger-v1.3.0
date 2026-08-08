export type Protocol = "tcp" | "rtu";
export type DeviceStatus = "online" | "warning" | "offline" | "disabled";
export type ReadingQuality = "good" | "stale" | "bad";
export type RegisterDataType =
  "bool" | "uint16" | "int16" | "uint32" | "int32" | "float32" | "float64";
export type ByteOrder = "ABCD" | "BADC" | "CDAB" | "DCBA";
export type FunctionCode = 1 | 2 | 3 | 4;
export type PostgresSslMode = "disable" | "require" | "verify-full";
export type SystemAlertType = "device_offline" | "postgres_offline" | "tag_alarm";
export type SystemAlertDeliveryStatus =
  "not_configured" | "pending" | "sent" | "failed";
export type UserRole =
  "administrator" | "operator" | "viewer" | "diagnostic";
export type SubscriptionStatus =
  | "unlicensed"
  | "trial"
  | "active"
  | "grace"
  | "expired";

export interface CustomerProfileInput {
  companyName: string;
  customerCode: string;
  contactPerson: string;
  contactEmail: string;
  contactPhone: string;
  siteName: string;
  siteAddress: string;
  notes: string;
}

export interface CustomerProfile extends CustomerProfileInput {
  updatedAt: string;
}

export interface SubscriptionSummary {
  installationId: string;
  status: SubscriptionStatus;
  plan: string | null;
  subscriptionReference: string | null;
  activationDueAt: string | null;
  activatedAt: string | null;
  expiresAt: string | null;
  graceEndsAt: string | null;
  lastCheckedAt: string | null;
  activationDaysRemaining: number | null;
  subscriptionDaysRemaining: number | null;
  message: string;
}

export interface CustomerSubscriptionSettings {
  customer: CustomerProfile;
  subscription: SubscriptionSummary;
}

export interface Device {
  id: string;
  name: string;
  protocol: Protocol;
  tcpHost: string | null;
  tcpPort: number | null;
  serialPort: string | null;
  baudRate: number | null;
  parity: "none" | "even" | "odd" | null;
  dataBits: 7 | 8 | null;
  stopBits: 1 | 2 | null;
  unitId: number;
  pollIntervalMs: number;
  readBlockSize: number;
  timeoutMs: number;
  retries: number;
  categoryId: string | null;
  categoryName: string | null;
  groupId: string | null;
  groupName: string | null;
  postgresEnabled: boolean;
  saveIntervalMs: number;
  postgresRawTable: string;
  postgresDownsampleTable: string;
  postgresDownsampleEnabled: boolean;
  postgresDownsampleIntervalSec: number;
  postgresRawRetentionDays: number;
  postgresDownsampleRetentionDays: number;
  postgresMaintenanceIntervalHours: number;
  postgresLastMaintenanceAt: string | null;
  postgresSchemaSyncedAt: string | null;
  postgresSchemaDirty: boolean;
  postgresSchemaRevision: number;
  tagCount: number;
  enabled: boolean;
  status: DeviceStatus;
  lastSeenAt: string | null;
  lastError: string | null;
  lastPollMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterDefinition {
  id: string;
  deviceId: string;
  name: string;
  address: number;
  functionCode: FunctionCode;
  dataType: RegisterDataType;
  byteOrder: ByteOrder;
  scale: number;
  offset: number;
  unit: string;
  historianColumn: string;
  decimalPlaces: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReadingInsert {
  registerId: string;
  deviceId: string;
  value: number | null;
  raw: number[];
  quality: ReadingQuality;
  timestamp: string;
}

export interface AlarmRule {
  id: string;
  registerId: string;
  name: string;
  severity: "warning" | "critical";
  condition: "above" | "below" | "inside" | "outside" | "hi" | "lo" | "hii" | "lolo";
  thresholdHigh: number | null;
  thresholdLow: number | null;
  deadband: number;
  enabled: boolean;
}

export interface CreateAlarmRuleInput {
  registerId: string;
  name: string;
  severity: "warning" | "critical";
  condition: "above" | "below" | "inside" | "outside" | "hi" | "lo" | "hii" | "lolo";
  thresholdHigh?: number | null;
  thresholdLow?: number | null;
  deadband?: number;
  enabled?: boolean;
}

export interface UpdateAlarmRuleInput extends CreateAlarmRuleInput {
  id: string;
}

export interface Principal {
  id: string;
  username: string;
  role: UserRole;
}

export interface UserSummary {
  id: string;
  username: string;
  role: UserRole;
  enabled: boolean;
  createdAt: string;
}

export type ActivityLevel = "info" | "warning" | "error";
export type ActivityCategory = "audit" | "device" | "system";

export interface ActivityEntry {
  id: number;
  timestamp: string;
  level: ActivityLevel;
  category: ActivityCategory;
  event: string;
  message: string;
  actorUsername: string | null;
  entityType: string | null;
  entityId: string | null;
  sourceIp: string | null;
  details: unknown;
}

export interface PostgresSettings {
  enabled: boolean;
  host: string;
  port: number;
  database: string;
  username: string;
  passwordEncrypted: string | null;
  sslMode: PostgresSslMode;
  historianTimezone: string;
  autoDownsampleEnabled: boolean;
  defaultRawTable: string;
  defaultDownsampleTable: string;
  defaultDownsampleIntervalSec: number;
  rawRetentionDays: number;
  downsampleRetentionDays: number;
  maintenanceIntervalHours: number;
  offlineCacheEnabled: boolean;
  offlineCacheMaxRows: number;
  lastConnectionTestAt: string | null;
  lastConnectionTestOk: boolean | null;
  lastConnectionTestMessage: string | null;
  lastMaintenanceAt: string | null;
  lastMaintenanceRawDeleted: number;
  lastMaintenanceDownsampleDeleted: number;
  lastReplayAt: string | null;
  lastReplayCount: number;
  updatedAt: string;
}

export interface PostgresSettingsInput {
  enabled: boolean;
  host: string;
  port: number;
  database: string;
  username: string;
  password?: string;
  sslMode: PostgresSslMode;
  historianTimezone: string;
  autoDownsampleEnabled: boolean;
  defaultRawTable: string;
  defaultDownsampleTable: string;
  defaultDownsampleIntervalSec: number;
  rawRetentionDays: number;
  downsampleRetentionDays: number;
  maintenanceIntervalHours: number;
  offlineCacheEnabled: boolean;
  offlineCacheMaxRows: number;
}

export interface SystemAlert {
  id: string;
  type: SystemAlertType;
  severity: "critical";
  sourceId: string | null;
  sourceName: string;
  detail: string;
  openedAt: string;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  lastObservedAt: string;
  state: "active" | "resolved";
  deliveryStatus: SystemAlertDeliveryStatus;
}

export interface WhatsAppAlertSettingsInput {
  enabled: boolean;
  recipients: string[];
  graphApiVersion: string;
  phoneNumberId: string;
  templateName: string;
  language: string;
  sendRecovery: boolean;
  offlineDelaySeconds: number;
  accessToken?: string;
}

export interface WhatsAppAlertSettings extends Omit<
  WhatsAppAlertSettingsInput,
  "accessToken"
> {
  accessTokenEncrypted: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  updatedAt: string;
}
