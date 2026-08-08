export type ApiStatus = "checking" | "connected" | "unauthorized" | "offline";
export type ApiRole =
  | "administrator"
  | "operator"
  | "viewer"
  | "diagnostic";

export interface HealthResponse {
  status: string;
  service: string;
  version: string;
  time: string;
  pollingEnabled: boolean;
}

export interface ApiUser {
  id?: string;
  username: string;
  role: ApiRole;
}

export interface ApiManagedUser {
  id: string;
  username: string;
  role: ApiRole;
  enabled: boolean;
  createdAt: string;
}

export interface ApiCustomerDetails {
  companyName: string;
  customerCode: string;
  contactPerson: string;
  contactEmail: string;
  contactPhone: string;
  siteName: string;
  siteAddress: string;
  notes: string;
  updatedAt: string | null;
}

export type CustomerDetailsPayload = Omit<ApiCustomerDetails, "updatedAt">;

export interface OverviewDeviceSummary {
  id: string;
  name: string;
  protocol: "tcp" | "rtu";
  endpoint: string;
  status: "online" | "warning" | "offline" | "disabled";
  tagCount: number;
  categoryName: string | null;
  groupName: string | null;
  lastPollMs: number | null;
  lastSeenAt: string | null;
  lastError: string | null;
}

export interface OverviewSampleTrendPoint {
  bucketStart: string;
  samples: number;
}

export interface OverviewActivitySummary {
  lastSampleAt: string | null;
  samplesLastHour: number;
  samplesLast24Hours: number;
  statusTransitionsLast24Hours: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface OverviewResponse {
  devices: {
    total: number;
    enabled: number;
    online: number;
    warning: number;
    offline: number;
    disabled: number;
  };
  tags: {
    active: number;
    samplesToday: number;
  };
  alarms: {
    active: number;
    critical: number;
  };
  performance: {
    averagePollMs: number;
    successRate: number;
  };
  deviceSummaries: OverviewDeviceSummary[];
  sampleTrend: OverviewSampleTrendPoint[];
  activitySummary: OverviewActivitySummary;
}

export interface ApiAuditEvent {
  id: string;
  timestamp: string;
  level: "info" | "warning" | "error";
  category: "audit" | "device" | "system";
  event: string;
  message: string;
  actorUsername: string | null;
  entityType: string | null;
  entityId: string | null;
  details: Record<string, unknown>;
  sourceIp: string | null;
}

export interface AuditEventFilters {
  search?: string;
  level?: "" | ApiAuditEvent["level"];
  category?: "" | ApiAuditEvent["category"];
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface AuditEventsResponse {
  items: ApiAuditEvent[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface DataServerDeviceMapping {
  deviceId: string;
  enabled: boolean;
  unitId: number;
}

export interface OpcUaDevicePublication {
  deviceId: string;
  enabled: boolean;
}

export interface DataServerRuntimeStatus {
  state: "disabled" | "starting" | "running" | "stopping" | "error";
  message: string | null;
  startedAt: string | null;
  lastRefreshAt: string | null;
  connectedClients: number;
  requestCount: number;
}

export interface ApiDataServerSettings {
  modbus: {
    enabled: boolean;
    bindAddress: string;
    port: number;
    refreshIntervalMs: number;
    mappings: DataServerDeviceMapping[];
    runtime: DataServerRuntimeStatus;
  };
  opcUa: {
    enabled: boolean;
    bindAddress: string;
    advertisedHost: string;
    port: number;
    endpointPath: string;
    allowAnonymous: boolean;
    refreshIntervalMs: number;
    publications: OpcUaDevicePublication[];
    runtime: DataServerRuntimeStatus;
  };
  updatedAt: string | null;
}

export type DataServerSettingsPayload = {
  modbus: Omit<ApiDataServerSettings["modbus"], "runtime">;
  opcUa: Omit<ApiDataServerSettings["opcUa"], "runtime">;
};

const apiBase =
  process.env.NEXT_PUBLIC_LOGGER_API_URL ?? "http://127.0.0.1:4100/api/v1";

async function apiRequest<T>(
  path: string,
  token: string | undefined,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new ApiError(
      body?.message ?? `Logger API returned ${response.status}`,
      response.status,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function fetchHealth(
  signal?: AbortSignal,
): Promise<HealthResponse> {
  return apiRequest<HealthResponse>("/health", undefined, { signal });
}

export async function fetchOverview(
  signal?: AbortSignal,
  token?: string,
): Promise<OverviewResponse> {
  const response = await fetch(`${apiBase}/overview`, {
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal,
  });

  if (!response.ok) {
    throw new ApiError(
      `Logger API returned ${response.status}`,
      response.status,
    );
  }

  return (await response.json()) as OverviewResponse;
}

export async function login(
  username: string,
  password: string,
): Promise<{ token: string; user: ApiUser }> {
  const response = await fetch(`${apiBase}/auth/login`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    throw new ApiError("Sign in failed", response.status);
  }
  return (await response.json()) as { token: string; user: ApiUser };
}

export async function fetchCurrentUser(token?: string): Promise<ApiUser> {
  return apiRequest<ApiUser>("/auth/me", token);
}



export async function fetchUsers(token?: string): Promise<ApiManagedUser[]> {
  const response = await apiRequest<{ items: ApiManagedUser[] }>(
    "/users",
    token,
  );
  return response.items;
}

export async function createUser(
  payload: {
    username: string;
    password: string;
    role: ApiRole;
    enabled?: boolean;
  },
  token?: string,
): Promise<ApiManagedUser> {
  return apiRequest<ApiManagedUser>("/users", token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateUser(
  id: string,
  payload: { username?: string; role?: ApiRole; enabled?: boolean },
  token?: string,
): Promise<ApiManagedUser> {
  return apiRequest<ApiManagedUser>(`/users/${id}`, token, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function resetUserPassword(
  id: string,
  password: string,
  token?: string,
): Promise<void> {
  await apiRequest<void>(`/users/${id}/reset-password`, token, {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export async function deleteUser(id: string, token?: string): Promise<void> {
  await apiRequest<void>(`/users/${id}`, token, { method: "DELETE" });
}

function appendAuditFilters(
  params: URLSearchParams,
  filters: AuditEventFilters,
  includePagination: boolean,
) {
  if (filters.search?.trim()) params.set("search", filters.search.trim());
  if (filters.level) params.set("level", filters.level);
  if (filters.category) params.set("category", filters.category);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (includePagination) {
    params.set("page", String(filters.page ?? 1));
    params.set("pageSize", String(filters.pageSize ?? 50));
  }
}

export async function fetchActivity(
  filters: AuditEventFilters,
  token?: string,
  signal?: AbortSignal,
): Promise<AuditEventsResponse> {
  const params = new URLSearchParams();
  appendAuditFilters(params, filters, true);
  return apiRequest<AuditEventsResponse>(
    `/activity?${params.toString()}`,
    token,
    { signal },
  );
}

export async function downloadActivityCsv(
  filters: AuditEventFilters,
  token?: string,
): Promise<{ truncated: boolean; rowLimit: number | null }> {
  const params = new URLSearchParams();
  appendAuditFilters(params, filters, false);
  const response = await fetch(
    `${apiBase}/activity/export?${params.toString()}`,
    {
      headers: {
        Accept: "text/csv",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new ApiError(
      body?.message ?? "Activity CSV could not be downloaded",
      response.status,
    );
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `modbus-activity-${new Date()
    .toISOString()
    .slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
  const rowLimit = Number(response.headers.get("x-export-row-limit"));
  return {
    truncated: response.headers.get("x-export-truncated") === "true",
    rowLimit: Number.isFinite(rowLimit) && rowLimit > 0 ? rowLimit : null,
  };
}

export async function fetchDataServerSettings(
  token?: string,
): Promise<ApiDataServerSettings> {
  return apiRequest<ApiDataServerSettings>("/settings/data-servers", token);
}

export async function saveDataServerSettings(
  payload: DataServerSettingsPayload,
  token?: string,
): Promise<ApiDataServerSettings> {
  return apiRequest<ApiDataServerSettings>("/settings/data-servers", token, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export interface ApiDevice {
  id: string;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  groupId: string | null;
  groupName: string | null;
  protocol: "tcp" | "rtu";
  tcpHost: string | null;
  tcpPort: number | null;
  serialPort: string | null;
  baudRate: number | null;
  parity: "none" | "even" | "odd" | null;
  dataBits: 7 | 8 | null;
  stopBits: 1 | 2 | null;
  unitId: number;
  pollIntervalMs: number;
  saveIntervalMs: number;
  readBlockSize: number;
  timeoutMs: number;
  retries: number;
  postgresEnabled: boolean;
  postgresDownsampleEnabled: boolean;
  postgresRawTable: string;
  postgresDownsampleTable: string;
  postgresDownsampleIntervalSec: number;
  postgresRawRetentionDays: number;
  postgresDownsampleRetentionDays: number;
  postgresMaintenanceIntervalHours: number;
  postgresSchemaSyncedAt: string | null;
  postgresSchemaDirty: boolean;
  postgresSchemaRevision: number;
  tagCount: number;
  enabled: boolean;
  status: "online" | "warning" | "offline" | "disabled";
  lastPollMs: number | null;
  rtuAddress?: string | null; // RTU device address
}

export interface ApiDeviceClassification {
  id: string;
  name: string;
  deviceCount: number;
}

export interface ApiDeviceClassifications {
  categories: ApiDeviceClassification[];
  groups: ApiDeviceClassification[];
}

export type DeviceClassificationKind = "categories" | "groups";

type DeviceClassificationSelection = {
  categoryId: string | null;
  groupId: string | null;
};

export type CreateDevicePayload = DeviceClassificationSelection &
  (
    | {
        name: string;
        protocol: "tcp";
        tcpHost: string;
        tcpPort: number;
        unitId: number;
        pollIntervalMs: number;
        saveIntervalMs: number;
        readBlockSize: number;
        timeoutMs: number;
        retries: number;
        postgresEnabled: boolean;
        postgresDownsampleEnabled: boolean;
        postgresRawTable: string;
        postgresDownsampleTable: string;
        postgresDownsampleIntervalSec: number;
        postgresRawRetentionDays: number;
        postgresDownsampleRetentionDays: number;
        postgresMaintenanceIntervalHours: number;
        enabled: boolean;
      }
    | {
        name: string;
        protocol: "rtu";
        serialPort: string;
        baudRate: number;
        parity: "none" | "even" | "odd";
        dataBits: 7 | 8;
        stopBits: 1 | 2;
        unitId: number;
        pollIntervalMs: number;
        saveIntervalMs: number;
        readBlockSize: number;
        timeoutMs: number;
        retries: number;
        postgresEnabled: boolean;
        postgresDownsampleEnabled: boolean;
        postgresRawTable: string;
        postgresDownsampleTable: string;
        postgresDownsampleIntervalSec: number;
        postgresRawRetentionDays: number;
        postgresDownsampleRetentionDays: number;
        postgresMaintenanceIntervalHours: number;
        enabled: boolean;
      }
  );

export interface ApiReading {
  id: number;
  registerId: string;
  deviceId: string;
  hasReading: 0 | 1;
  value: number | null;
  quality: "good" | "stale" | "bad";
  timestamp: string;
  tagName: string;
  unit: string;
  address: number;
  deviceName: string;
}

export interface DeviceReadingsResponse {
  items: ApiReading[];
  total: number;
}

export interface ApiAlarm {
  id: string;
  currentValue: number;
  openedAt: string;
  clearedAt: string | null;
  acknowledgedAt: string | null;
  message: string;
  ruleName: string;
  severity: "warning" | "critical";
  tagName: string;
  deviceName: string;
}

export type SystemAlertKind = "device_offline" | "postgres_offline";
export type WhatsAppDeliveryStatus =
  | "not_configured"
  | "pending"
  | "sent"
  | "failed";

export interface ApiSystemAlert {
  id: string;
  type: SystemAlertKind;
  severity: "critical";
  sourceId: string | null;
  sourceName: string;
  detail: string;
  openedAt: string;
  lastObservedAt: string;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  state: "active" | "resolved";
  deliveryStatus: WhatsAppDeliveryStatus;
}

export interface ApiWhatsAppSettings {
  enabled: boolean;
  graphApiVersion: string;
  phoneNumberId: string;
  recipients: string[];
  templateName: string;
  language: string;
  sendRecovery: boolean;
  offlineDelaySeconds: number;
  accessTokenConfigured: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  updatedAt: string | null;
}

export type WhatsAppSettingsPayload = Pick<
  ApiWhatsAppSettings,
  | "enabled"
  | "graphApiVersion"
  | "phoneNumberId"
  | "recipients"
  | "templateName"
  | "language"
  | "sendRecovery"
  | "offlineDelaySeconds"
> & {
  accessToken?: string;
};

export interface WhatsAppTestResult {
  ok: boolean;
  message: string;
  recipientCount: number;
}

export interface ApiRegister {
  id: string;
  deviceId: string;
  name: string;
  address: number;
  functionCode: 1 | 2 | 3 | 4;
  dataType:
    | "bool"
    | "uint16"
    | "int16"
    | "uint32"
    | "int32"
    | "float32"
    | "float64";
  byteOrder: "ABCD" | "BADC" | "CDAB" | "DCBA";
  scale: number;
  offset: number;
  decimalPlaces: number;
  unit: string;
  enabled: boolean;
  historianColumn?: string;
}

export interface BulkRegisterImportResult {
  items: ApiRegister[];
  count: number;
  totalTags: number;
}

export interface HistorianSchemaSyncResult {
  ok: boolean;
  message: string;
  addedColumns: string[];
  changedColumns: string[];
  orphanedColumns: string[];
  droppedColumns: string[];
  syncedAt: string | null;
}

export interface DevicePostgresConnectionResult {
  connected: boolean;
  message: string;
  device: ApiDevice;
  schema?: HistorianSchemaSyncResult;
}

export interface ApiPostgresSettings {
  enabled: boolean;
  host: string;
  port: number;
  database: string;
  username: string;
  sslMode: "disable" | "require" | "verify-full";
  autoDownsampleEnabled: boolean;
  defaultRawTable: string;
  defaultDownsampleTable: string;
  defaultDownsampleIntervalSec: number;
  rawRetentionDays: number;
  downsampleRetentionDays: number;
  maintenanceIntervalHours: number;
  historianTimezone: string;
  offlineCacheEnabled: boolean;
  offlineCacheMaxRows: number;
  offlineCacheQueuedRows: number;
  offlineCacheOldestAt: string | null;
  lastReplayAt: string | null;
  lastReplayCount: number;
  configured: boolean;
  passwordConfigured: boolean;
  source: "saved" | "environment" | "none";
  lastConnectionTestAt: string | null;
  lastConnectionTestOk: boolean | null;
  lastConnectionTestMessage: string | null;
  lastMaintenanceAt: string | null;
  lastMaintenanceRawDeleted: number;
  lastMaintenanceDownsampleDeleted: number;
  updatedAt: string | null;
}

export type PostgresSettingsPayload = Pick<
  ApiPostgresSettings,
  | "enabled"
  | "host"
  | "port"
  | "database"
  | "username"
  | "sslMode"
  | "autoDownsampleEnabled"
  | "defaultRawTable"
  | "defaultDownsampleTable"
  | "defaultDownsampleIntervalSec"
  | "rawRetentionDays"
  | "downsampleRetentionDays"
  | "maintenanceIntervalHours"
  | "historianTimezone"
  | "offlineCacheEnabled"
  | "offlineCacheMaxRows"
> & {
  password?: string;
};

export interface PostgresConnectionTestResult {
  ok: boolean;
  message: string;
  serverVersion?: string;
  database?: string;
  username?: string;
  canConnect?: boolean;
  canUseSchema?: boolean;
  canCreateTables?: boolean;
}

export interface PostgresMaintenanceResult {
  skipped: boolean;
  message: string;
  rawDeleted: number;
  downsampleDeleted: number;
  completedAt: string;
}

export interface PostgresOfflineCacheReplayResult {
  status:
    | "disabled"
    | "idle"
    | "completed"
    | "paused"
    | "unavailable"
    | "error";
  message: string;
  queuedRows: number;
  replayedRows: number;
  discardedRows: number;
  pausedRows: number;
  remainingRows: number;
  remainingEligibleRows: number;
  completedAt: string;
}

export interface ApiSystemSettings {
  appVersion: string;
  update: {
    helperConfigured: boolean;
    stagedVersion: string | null;
    stagedFilename: string | null;
    stagedSha256: string | null;
    stagedAt: string | null;
    lastError: string | null;
  };
  openVpn: {
    helperConfigured: boolean;
    configured: boolean;
    profileName: string | null;
    enabled: boolean;
    lastChangedAt: string | null;
    lastError: string | null;
  };
}

export interface SystemActionResult {
  message: string;
}

export interface ConfigurationRestoreResult extends SystemActionResult {
  ok: boolean;
  restoredAt: string;
  collectorReloaded: boolean;
  restartRequired: boolean;
}

export interface FactoryResetResult extends SystemActionResult {
  ok: boolean;
  resetAt: string;
  collectorReloaded: boolean;
  restartRequired: boolean;
}

export interface StageSystemUpdateResult extends SystemActionResult {
  stagedVersion: string;
  stagedFilename: string;
  stagedSha256: string;
  stagedAt: string;
}

export interface ApplySystemUpdateResult extends SystemActionResult {
  accepted: boolean;
  stagedVersion: string;
}

export interface OpenVpnProfileResult extends SystemActionResult {
  profileName: string;
  configured: boolean;
}

export interface OpenVpnStateResult extends SystemActionResult {
  enabled: boolean;
  changedAt: string;
}

export type CreateRegisterPayload = Omit<ApiRegister, "id" | "deviceId">;

export async function fetchDevices(token?: string): Promise<ApiDevice[]> {
  const response = await apiRequest<{ items: ApiDevice[] }>("/devices", token);
  return response.items;
}

export async function fetchDeviceClassifications(
  token?: string,
): Promise<ApiDeviceClassifications> {
  return apiRequest<ApiDeviceClassifications>(
    "/settings/device-classifications",
    token,
  );
}

export async function createDeviceClassification(
  kind: DeviceClassificationKind,
  name: string,
  token?: string,
): Promise<ApiDeviceClassification> {
  return apiRequest<ApiDeviceClassification>(
    `/settings/device-classifications/${kind}`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ name }),
    },
  );
}

export async function deleteDeviceClassification(
  kind: DeviceClassificationKind,
  id: string,
  token?: string,
): Promise<void> {
  await apiRequest<void>(
    `/settings/device-classifications/${kind}/${id}`,
    token,
    { method: "DELETE" },
  );
}

export async function createDevice(
  payload: CreateDevicePayload,
  token?: string,
): Promise<ApiDevice> {
  return apiRequest<ApiDevice>("/devices", token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateDevice(
  id: string,
  payload: CreateDevicePayload,
  token?: string,
): Promise<ApiDevice> {
  return apiRequest<ApiDevice>(`/devices/${id}`, token, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function deleteDevice(id: string, token?: string): Promise<void> {
  await apiRequest<void>(`/devices/${id}`, token, {
    method: "DELETE",
  });
}

export async function disconnectDevicePostgres(
  id: string,
  token?: string,
): Promise<DevicePostgresConnectionResult> {
  return apiRequest<DevicePostgresConnectionResult>(
    `/devices/${id}/postgres/disconnect`,
    token,
    { method: "POST" },
  );
}

export async function connectDevicePostgres(
  id: string,
  token?: string,
): Promise<DevicePostgresConnectionResult> {
  return apiRequest<DevicePostgresConnectionResult>(
    `/devices/${id}/postgres/connect`,
    token,
    { method: "POST" },
  );
}

export async function fetchLatestReadings(
  token?: string,
): Promise<ApiReading[]> {
  const response = await apiRequest<{ items: ApiReading[] }>(
    "/readings/latest",
    token,
  );
  return response.items;
}

export async function fetchDeviceReadings(
  deviceId: string,
  token?: string,
  signal?: AbortSignal,
): Promise<DeviceReadingsResponse> {
  return apiRequest<DeviceReadingsResponse>(
    `/devices/${deviceId}/readings/latest`,
    token,
    { signal },
  );
}

export async function fetchRegisters(
  deviceId: string,
  token?: string,
): Promise<ApiRegister[]> {
  const response = await apiRequest<{ items: ApiRegister[] }>(
    `/devices/${deviceId}/registers`,
    token,
  );
  return response.items;
}

export async function createRegister(
  deviceId: string,
  payload: CreateRegisterPayload,
  token?: string,
): Promise<ApiRegister> {
  return apiRequest<ApiRegister>(`/devices/${deviceId}/registers`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function importRegisters(
  deviceId: string,
  items: CreateRegisterPayload[],
  token?: string,
): Promise<BulkRegisterImportResult> {
  return apiRequest<BulkRegisterImportResult>(
    `/devices/${deviceId}/registers/import`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ items }),
    },
  );
}

export async function updateRegister(
  id: string,
  payload: CreateRegisterPayload,
  token?: string,
): Promise<ApiRegister> {
  return apiRequest<ApiRegister>(`/registers/${id}`, token, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function deleteRegister(
  id: string,
  token?: string,
): Promise<void> {
  await apiRequest<void>(`/registers/${id}`, token, {
    method: "DELETE",
  });
}

export async function syncHistorianSchema(
  deviceId: string,
  dropRemoved: boolean,
  token?: string,
  expectedOrphanedColumns?: string[],
): Promise<HistorianSchemaSyncResult> {
  return apiRequest<HistorianSchemaSyncResult>(
    `/devices/${deviceId}/historian-schema/sync`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        dropRemoved,
        ...(expectedOrphanedColumns ? { expectedOrphanedColumns } : {}),
      }),
    },
  );
}

export async function fetchPostgresSettings(
  token?: string,
): Promise<ApiPostgresSettings> {
  return apiRequest<ApiPostgresSettings>("/settings/postgres", token);
}

export async function testPostgresConnection(
  payload: PostgresSettingsPayload,
  token?: string,
): Promise<PostgresConnectionTestResult> {
  return apiRequest<PostgresConnectionTestResult>(
    "/settings/postgres/test",
    token,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export async function savePostgresSettings(
  payload: PostgresSettingsPayload,
  token?: string,
): Promise<ApiPostgresSettings> {
  return apiRequest<ApiPostgresSettings>("/settings/postgres", token, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function runPostgresMaintenance(
  token?: string,
): Promise<PostgresMaintenanceResult> {
  return apiRequest<PostgresMaintenanceResult>(
    "/settings/postgres/maintenance",
    token,
    { method: "POST" },
  );
}

export async function replayPostgresOfflineCache(
  token?: string,
): Promise<PostgresOfflineCacheReplayResult> {
  return apiRequest<PostgresOfflineCacheReplayResult>(
    "/settings/postgres/offline-cache/replay",
    token,
    { method: "POST" },
  );
}

export async function fetchSystemSettings(
  token?: string,
): Promise<ApiSystemSettings> {
  return apiRequest<ApiSystemSettings>("/settings/system", token);
}

export async function downloadConfigurationBackup(
  token?: string,
): Promise<void> {
  const response = await fetch(`${apiBase}/settings/configuration/backup`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new ApiError(
      body?.message ?? "Configuration backup could not be downloaded",
      response.status,
    );
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const disposition = response.headers.get("content-disposition") ?? "";
  const responseFilename =
    disposition.match(/filename\*?=(?:UTF-8''|")?([^";\r\n]+)/i)?.[1] ?? "";
  anchor.href = url;
  anchor.download =
    safeHeaderFilename(responseFilename.trim()) ||
    `modbus-data-logger-configuration-${new Date()
      .toISOString()
      .slice(0, 10)}.backup`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function restoreConfiguration(
  backup: string,
  token?: string,
): Promise<ConfigurationRestoreResult> {
  return apiRequest<ConfigurationRestoreResult>(
    "/settings/configuration/restore",
    token,
    {
      method: "POST",
      body: JSON.stringify({
        backup,
        confirmation: "RESTORE CONFIGURATION",
      }),
    },
  );
}

export async function factoryReset(
  currentPassword: string,
  token?: string,
): Promise<FactoryResetResult> {
  return apiRequest<FactoryResetResult>("/settings/factory-reset", token, {
    method: "POST",
    body: JSON.stringify({
      currentPassword,
      confirmation: "FACTORY RESET",
    }),
  });
}

function safeHeaderFilename(filename: string) {
  return filename.replace(/[^\x20-\x7E]|[\\/]/g, "_").slice(0, 255);
}

export async function stageSystemUpdate(
  bytes: ArrayBuffer,
  version: string,
  filename: string,
  token?: string,
): Promise<StageSystemUpdateResult> {
  return apiRequest<StageSystemUpdateResult>(
    "/settings/system/update/stage",
    token,
    {
      method: "POST",
      body: bytes,
      headers: {
        "Content-Type": "application/octet-stream",
        "x-update-version": version.trim(),
        "x-file-name": safeHeaderFilename(filename),
      },
    },
  );
}

export async function applySystemUpdate(
  token?: string,
): Promise<ApplySystemUpdateResult> {
  return apiRequest<ApplySystemUpdateResult>(
    "/settings/system/update/apply",
    token,
    { method: "POST" },
  );
}

export async function uploadOpenVpnProfile(
  bytes: ArrayBuffer,
  filename: string,
  token?: string,
): Promise<OpenVpnProfileResult> {
  return apiRequest<OpenVpnProfileResult>(
    "/settings/system/openvpn/profile",
    token,
    {
      method: "POST",
      body: bytes,
      headers: {
        "Content-Type": "application/octet-stream",
        "x-file-name": safeHeaderFilename(filename),
      },
    },
  );
}

export async function setOpenVpnEnabled(
  enabled: boolean,
  token?: string,
): Promise<OpenVpnStateResult> {
  return apiRequest<OpenVpnStateResult>("/settings/system/openvpn", token, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}

export async function fetchAlarms(token?: string): Promise<ApiAlarm[]> {
  const response = await apiRequest<{ items: ApiAlarm[] }>(
    "/alarms?activeOnly=true",
    token,
  );
  return response.items;
}

export async function acknowledgeAlarm(
  id: string,
  token?: string,
): Promise<void> {
  await apiRequest<void>(`/alarms/${id}/acknowledge`, token, {
    method: "POST",
  });
}

export async function fetchSystemAlerts(
  token?: string,
  options: { activeOnly?: boolean; limit?: number } = {},
): Promise<ApiSystemAlert[]> {
  const query = new URLSearchParams({
    activeOnly: String(options.activeOnly ?? true),
    limit: String(options.limit ?? 250),
  });
  const response = await apiRequest<{ items: ApiSystemAlert[] }>(
    `/alerts/system?${query}`,
    token,
  );
  return response.items;
}

export async function acknowledgeSystemAlert(
  id: string,
  token?: string,
): Promise<void> {
  await apiRequest<void>(
    `/alerts/system/${encodeURIComponent(id)}/acknowledge`,
    token,
    { method: "POST" },
  );
}

export async function fetchWhatsAppAlertSettings(
  token?: string,
): Promise<ApiWhatsAppSettings> {
  return apiRequest<ApiWhatsAppSettings>("/settings/alerts/whatsapp", token);
}

export async function saveWhatsAppAlertSettings(
  payload: WhatsAppSettingsPayload,
  token?: string,
): Promise<ApiWhatsAppSettings> {
  return apiRequest<ApiWhatsAppSettings>("/settings/alerts/whatsapp", token, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function testWhatsAppAlertSettings(
  payload: WhatsAppSettingsPayload,
  token?: string,
): Promise<WhatsAppTestResult> {
  return apiRequest<WhatsAppTestResult>(
    "/settings/alerts/whatsapp/test",
    token,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
  token?: string,
): Promise<void> {
  await apiRequest<void>("/auth/change-password", token, {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export async function downloadReadings(
  token?: string,
  filters?: {
    deviceId?: string;
    categoryId?: string;
    groupId?: string;
  },
): Promise<void> {
  const query = new URLSearchParams({ limit: "50000" });
  if (filters?.deviceId) query.set("deviceId", filters.deviceId);
  if (filters?.categoryId) query.set("categoryId", filters.categoryId);
  if (filters?.groupId) query.set("groupId", filters.groupId);
  const response = await fetch(`${apiBase}/readings/export.csv?${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    throw new ApiError("CSV export failed", response.status);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `modbus-${
    filters?.deviceId || filters?.categoryId || filters?.groupId
      ? "report"
      : "readings"
  }-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

// Per-register tag alarm types and functions
export interface ApiTagAlarmRule {
  id: string;
  registerId: string;
  name: string;
  severity: 'warning' | 'critical';
  condition: 'above' | 'below' | 'outside' | 'hi' | 'lo' | 'hii' | 'lolo';
  thresholdHigh: number | null;
  thresholdLow: number | null;
  deadband: number;
  enabled: boolean;
}

export interface CreateTagAlarmRulePayload {
  name: string;
  severity: 'warning' | 'critical';
  condition: 'above' | 'below' | 'inside' | 'outside' | 'hi' | 'lo' | 'hii' | 'lolo';
  thresholdHigh?: number | null;
  thresholdLow?: number | null;
  deadband?: number;
}

export async function fetchTagAlarmRules(
  registerId: string,
  token?: string,
): Promise<{ items: ApiTagAlarmRule[] }> {
  return apiRequest<{ items: ApiTagAlarmRule[] }>(
    `/registers/${registerId}/alarm-rules`,
    token,
  );
}

export async function createTagAlarmRule(
  registerId: string,
  payload: CreateTagAlarmRulePayload,
  token?: string,
): Promise<ApiTagAlarmRule> {
  return apiRequest<ApiTagAlarmRule>(
    `/registers/${registerId}/alarm-rules`,
    token,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  );
}

export async function deleteTagAlarmRule(
  registerId: string,
  ruleId: string,
  token?: string,
): Promise<void> {
  await apiRequest(`/registers/${registerId}/alarm-rules/${ruleId}`, token, {
    method: 'DELETE',
  });
}

export async function updateTagAlarmRule(
  registerId: string,
  ruleId: string,
  payload: CreateTagAlarmRulePayload,
  token?: string,
): Promise<ApiTagAlarmRule> {
  return apiRequest<ApiTagAlarmRule>(
    `/registers/${registerId}/alarm-rules/${ruleId}`,
    token,
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    },
  );
}

// Per-register tag alarm types and functions
// Alarm Group types and functions
export interface ApiAlarmGroup {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiAlarmGroupMember {
  group_id: string;
  register_id: string;
  weight: number;
}

export interface ApiAlarmGroupRule {
  id: string;
  group_id: string;
  name: string;
  severity: 'warning' | 'critical';
  condition: 'hi' | 'lo' | 'hii' | 'lolo' | 'above' | 'below' | 'outside';
  threshold_hi: number | null;
  threshold_lo: number | null;
  deadband: number;
  enabled: boolean;
}

export interface AlarmGroupDetail {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  members: ApiAlarmGroupMember[];
  rules: ApiAlarmGroupRule[];
}

export async function fetchAlarmGroups(token?: string): Promise<{ items: ApiAlarmGroup[] }> {
  return apiRequest<{ items: ApiAlarmGroup[] }>("/alarm-groups", token);
}

export async function createAlarmGroup(payload: { name: string; description?: string }, token?: string): Promise<ApiAlarmGroup> {
  return apiRequest<ApiAlarmGroup>("/alarm-groups", token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function fetchAlarmGroupDetail(id: string, token?: string): Promise<AlarmGroupDetail> {
  return apiRequest<AlarmGroupDetail>(`/alarm-groups/${id}`, token);
}

export async function updateAlarmGroup(id: string, payload: { name?: string; description?: string }, token?: string): Promise<void> {
  await apiRequest(`/alarm-groups/${id}`, token, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function deleteAlarmGroup(id: string, token?: string): Promise<void> {
  await apiRequest(`/alarm-groups/${id}`, token, {
    method: "DELETE",
  });
}

export async function addAlarmGroupMember(groupId: string, registerId: string, weight: number = 1, token?: string): Promise<void> {
  await apiRequest(`/alarm-groups/${groupId}/members`, token, {
    method: "POST",
    body: JSON.stringify({ registerId, weight }),
  });
}

export async function removeAlarmGroupMember(groupId: string, registerId: string, token?: string): Promise<void> {
  await apiRequest(`/alarm-groups/${groupId}/members/${registerId}`, token, {
    method: "DELETE",
  });
}

export async function createAlarmGroupRule(groupId: string, payload: Omit<ApiAlarmGroupRule, 'id' | 'group_id'>, token?: string): Promise<ApiAlarmGroupRule> {
  return apiRequest<ApiAlarmGroupRule>(`/alarm-groups/${groupId}/rules`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function deleteAlarmGroupRule(groupId: string, ruleId: string, token?: string): Promise<void> {
  await apiRequest(`/alarm-groups/${groupId}/rules/${ruleId}`, token, {
    method: "DELETE",
  });
}

// Category Total Alarm types and functions (Category Total Threshold Alarms)
export interface ApiAlarmCategoryRule {
  id: string;
  category_id: string;
  category_name?: string;
  name: string;
  severity: 'warning' | 'critical';
  condition: 'above' | 'below' | 'inside' | 'outside' | 'hi' | 'lo' | 'hii' | 'lolo';
  threshold_high: number | null;
  threshold_low: number | null;
  aggregation_type: 'sum' | 'avg' | 'min' | 'max';
  deadband: number;
  enabled: boolean;
  created_at?: string;
}

export interface ApiAlarmCategory {
  id: string;
  name: string;
  device_count: number;
}

export interface CreateAlarmCategoryRulePayload {
  name: string;
  severity: 'warning' | 'critical';
  condition: 'above' | 'below' | 'inside' | 'outside' | 'hi' | 'lo' | 'hii' | 'lolo';
  thresholdHigh?: number | null;
  thresholdLow?: number | null;
  aggregationType?: 'sum' | 'avg' | 'min' | 'max';
  deadband?: number;
}

export async function fetchAlarmCategories(token?: string): Promise<{ items: ApiAlarmCategory[] }> {
  return apiRequest<{ items: ApiAlarmCategory[] }>(
    '/alarm-categories',
    token,
  );
}

export async function createAlarmCategoryRule(
  categoryId: string,
  payload: CreateAlarmCategoryRulePayload,
  token?: string,
): Promise<ApiAlarmCategoryRule> {
  return apiRequest<ApiAlarmCategoryRule>(
    `/categories/${categoryId}/alarm-rules`,
    token,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  );
}

export async function fetchAlarmCategoryRules(
  categoryId: string,
  token?: string,
): Promise<{ items: ApiAlarmCategoryRule[] }> {
  return apiRequest<{ items: ApiAlarmCategoryRule[] }>(
    `/categories/${categoryId}/alarm-rules`,
    token,
  );
}

export async function fetchAlarmCategoryRuleDetail(
  categoryId: string,
  token?: string,
): Promise<ApiAlarmCategory & { matchingRegisters?: any[] }> {
  return apiRequest<any>(
    `/categories/${categoryId}`,
    token,
  );
}

export async function updateAlarmCategoryRule(
  ruleId: string,
  payload: CreateAlarmCategoryRulePayload,
  token?: string,
): Promise<void> {
  await apiRequest(
    `/alarm-categories/${ruleId}`,
    token,
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    },
  );
}

export async function deleteAlarmCategoryRule(
  ruleId: string,
  token?: string,
): Promise<void> {
  await apiRequest(
    `/alarm-categories/${ruleId}`,
    token,
    {
      method: 'DELETE',
    },
  );
}

export async function fetchAlarmCategoryRuleTags(
  ruleId: string,
  token?: string,
): Promise<{ items: string[] }> {
  return apiRequest<{ items: string[] }>(
    `/alarm-categories/${ruleId}/tags`,
    token,
  );
}

export async function updateAlarmCategoryRuleTags(
  ruleId: string,
  registerIds: string[],
  token?: string,
): Promise<void> {
  await apiRequest(
    `/alarm-categories/${ruleId}/tags`,
    token,
    {
      method: 'PUT',
      body: JSON.stringify(registerIds),
    },
  );
}

// Storage metrics
export interface ApiStorageMetrics {
  databaseFile: string | null;
  fileInfo: {
    sizeBytes: number | null;
    sizeHuman: string | null;
    exists: boolean;
    modified: string | null;
  };
  tables: Array<{
    name: string;
    rows: number;
    sizeBytes: number;
    sizeHuman: string;
  }>;
  summary: {
    totalDataSizeBytes: number;
    totalDataSizeHuman: string;
    totalRows: number;
    needsVacuum: boolean;
    diskUsage: {
      totalBytes: number | null;
      freeBytes: number | null;
      usedPercent: number | null;
      warningLevel: "ok" | "warning" | "critical";
    };
    downsampleStats: {
      enabled: boolean;
      avgSamplesPerBucket: number | null;
      stalePercentage: number | null;
      missingBuckets: number | null;
    };
  };
  readingsGrowth: {
    today: number;
    yesterday: number;
    changePercent: number | null;
  };
  postgresSettings: {
    url: string | null;
    online: boolean;
  };
}

export async function fetchStorageInfo(token?: string): Promise<ApiStorageMetrics> {
  return apiRequest<ApiStorageMetrics>("/storage", token);
}
