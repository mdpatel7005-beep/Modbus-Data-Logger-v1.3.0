# API and device setup

Base URL: `http://localhost:4100/api/v1`

## Authentication

```bash
curl -X POST http://localhost:4100/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your-password"}'
```

Pass the returned token as `Authorization: Bearer TOKEN`. Authentication can be
disabled only for isolated development using `AUTH_DISABLED=true`.

The API uses the resolved source IP for rate limits and activity records.
`TRUST_PROXY` defaults to `false`. Set it to `true` only when direct access to
port `4100` is blocked and all requests arrive through the trusted reverse
proxy; otherwise a client can forge forwarded-address headers.

V1.2 roles are:

| Role            | API boundary |
| --------------- | ------------ |
| `administrator` | Full configuration, user administration, diagnostics, and destructive actions |
| `operator`      | Authenticated reads, device creation, and alarm acknowledgement |
| `viewer`        | Authenticated monitoring and export reads only |
| `diagnostic`    | Monitoring plus read-only data-server settings and activity diagnostics |

Every user can change their own password. User administration is
administrator-only. A disabled user's bearer token is rejected on the next API
request, and a changed role is applied from the current user record when the
token is verified. Changing or administratively resetting a password increments
that user's token version, so all previously issued bearer tokens for that user
are rejected.

## Main endpoints

| Method     | Path                                              | Purpose                                          |
| ---------- | ------------------------------------------------- | ------------------------------------------------ |
| GET        | `/health`                                         | Service liveness and version                     |
| POST       | `/auth/login`                                     | Obtain an access token                           |
| GET        | `/auth/me`                                        | Return the authenticated username and role       |
| POST       | `/auth/change-password`                           | Change the current user's password               |
| GET/POST   | `/users`                                          | List or create managed users                     |
| PATCH/DELETE | `/users/:id`                                    | Change or delete a managed user                  |
| POST       | `/users/:id/reset-password`                       | Reset a managed user's password                  |
| GET        | `/activity`                                       | Filter the web activity timeline                 |
| GET        | `/activity/export`                                | Export filtered activity as CSV                  |
| GET/PUT    | `/settings/customer`                             | Admin-only full customer/subscription settings   |
| GET        | `/settings/customer/summary`                     | Minimal customer/subscription display summary    |
| GET/PUT    | `/settings/alerts/whatsapp`                       | Read or apply redacted WhatsApp alert settings   |
| POST       | `/settings/alerts/whatsapp/test`                  | Send the configured template as a test           |
| GET/PUT    | `/settings/postgres`                              | Read or apply redacted remote historian settings |
| POST       | `/settings/postgres/test`                         | Test a draft PostgreSQL connection               |
| POST       | `/settings/postgres/maintenance`                  | Run remote retention immediately                 |
| GET        | `/settings/system`                                | Read update and OpenVPN administration state     |
| GET        | `/settings/configuration/backup`                  | Download an encrypted configuration backup       |
| POST       | `/settings/configuration/restore`                 | Restore an encrypted configuration backup        |
| POST       | `/settings/factory-reset`                         | Clear operational configuration and history      |
| POST       | `/settings/system/update/stage`                   | Stage a versioned update archive                 |
| POST       | `/settings/system/update/apply`                   | Hand the staged archive to the update helper     |
| POST       | `/settings/system/openvpn/profile`                | Save a validated self-contained OpenVPN profile  |
| PUT        | `/settings/system/openvpn`                        | Request OpenVPN connect or disconnect            |
| GET/PUT    | `/settings/data-servers`                          | Inspect or configure Modbus TCP and OPC UA       |
| GET        | `/settings/device-classifications`                | List predefined Categories and Groups            |
| POST       | `/settings/device-classifications/categories`     | Create a Category                                |
| DELETE     | `/settings/device-classifications/categories/:id` | Delete an unused Category                        |
| POST       | `/settings/device-classifications/groups`         | Create a Group                                   |
| DELETE     | `/settings/device-classifications/groups/:id`     | Delete an unused Group                           |
| GET        | `/overview`                                       | Dashboard totals and health                      |
| GET/POST   | `/devices`                                        | List or create devices                           |
| PUT/DELETE | `/devices/:id`                                    | Replace or remove a device                       |
| POST       | `/devices/:id/postgres/disconnect`                | Pause that device's remote saving                |
| POST       | `/devices/:id/postgres/connect`                   | Verify/repair tables and resume remote saving    |
| GET/POST   | `/devices/:id/registers`                          | List or create register definitions              |
| POST       | `/devices/:id/registers/import`                   | Atomically import up to 1,500 register definitions |
| GET        | `/devices/:id/readings/latest`                    | Every enabled tag and its latest value            |
| POST       | `/devices/:id/historian-schema/sync`              | Synchronize that device's remote table columns   |
| PUT/DELETE | `/registers/:id`                                  | Replace or remove a register                     |
| GET/POST   | `/registers/:id/alarm-rules`                      | List or create alarm rules                       |
| GET        | `/readings/latest`                                | Latest value for each known register             |
| GET        | `/readings`                                       | Filtered historian query                         |
| GET        | `/readings/export.csv`                            | CSV export, capped at 50,000 rows                |
| GET        | `/alarms`                                         | Alarm events                                     |
| POST       | `/alarms/:id/acknowledge`                         | Acknowledge an alarm                             |
| GET        | `/alerts/system`                                  | List device/database offline incidents           |
| POST       | `/alerts/system/:id/acknowledge`                  | Acknowledge a system-alert incident              |

## Dynamic Overview

`GET /overview` is authenticated and contains only configured devices and
stored collector activity. It does not return demonstration devices or a
fabricated trend when the logger is empty.

```json
{
  "devices": {
    "total": 2,
    "enabled": 1,
    "online": 1,
    "warning": 0,
    "offline": 0,
    "disabled": 1
  },
  "tags": { "active": 24, "samplesToday": 86400 },
  "alarms": { "active": 1, "critical": 0 },
  "performance": { "averagePollMs": 82, "successRate": 100 },
  "deviceSummaries": [
    {
      "id": "dev_meter",
      "name": "Main Meter",
      "protocol": "tcp",
      "status": "online",
      "endpoint": "192.168.10.20:502",
      "tagCount": 24,
      "categoryName": "Energy",
      "groupName": "Incoming",
      "lastSeenAt": "2026-07-27T10:00:00.000Z",
      "lastPollMs": 82,
      "lastError": null
    }
  ],
  "sampleTrend": [
    {
      "bucketStart": "2026-07-27T09:00:00.000Z",
      "samples": 3600
    }
  ],
  "activitySummary": {
    "lastSampleAt": "2026-07-27T10:00:00.000Z",
    "samplesLastHour": 3600,
    "samplesLast24Hours": 86400,
    "statusTransitionsLast24Hours": 2
  }
}
```

`sampleTrend` contains 24 consecutive UTC hourly buckets, including zero-count
buckets. `devices.enabled` is the sum of online, warning, and offline devices;
disabled devices are reported separately.

## User administration

All `/users` routes require an administrator. Usernames are 3 through 100
characters and unique without regard to case. Passwords are 1 through 200
characters; simple non-empty passwords are accepted, although they are not
recommended for production.

Create an enabled monitoring-only user:

```http
POST /api/v1/users
Content-Type: application/json

{
  "username": "shift-monitor",
  "password": "temporary-password",
  "role": "viewer",
  "enabled": true
}
```

`GET /users` returns `{ "items": [...] }` with `id`, `username`, `role`,
`enabled`, and `createdAt`; it never returns password hashes. Update one or more
fields with:

```http
PATCH /api/v1/users/usr_example
Content-Type: application/json

{"role":"diagnostic","enabled":true}
```

Reset a password with:

```http
POST /api/v1/users/usr_example/reset-password
Content-Type: application/json

{"password":"new-password"}
```

## Customer and subscription status

`GET /settings/customer` requires an administrator. It returns the editable
installation/customer profile together with the complete local,
server-managed subscription status:

```json
{
  "customer": {
    "companyName": "North Plant Industries",
    "customerCode": "NPI/001",
    "contactPerson": "Operations Manager",
    "contactEmail": "operations@example.test",
    "contactPhone": "+91 98765 43210",
    "siteName": "North switching station",
    "siteAddress": "Industrial estate, North Zone",
    "notes": "Primary production installation",
    "updatedAt": "2026-07-27T10:00:00.000Z"
  },
  "subscription": {
    "installationId": "installation_…",
    "status": "unlicensed",
    "plan": null,
    "subscriptionReference": null,
    "activationDueAt": "2026-08-26T10:00:00.000Z",
    "activatedAt": null,
    "expiresAt": null,
    "graceEndsAt": null,
    "lastCheckedAt": null,
    "activationDaysRemaining": 30,
    "subscriptionDaysRemaining": null,
    "message": "Activation required within 30 days."
  }
}
```

Every authenticated role can use `GET /settings/customer/summary`. Its response
contains exactly the fields needed for a shared dashboard header/status card:

```json
{
  "customer": {
    "companyName": "North Plant Industries",
    "siteName": "North switching station"
  },
  "subscription": {
    "status": "unlicensed",
    "activationDaysRemaining": 30,
    "subscriptionDaysRemaining": null,
    "message": "Activation required within 30 days."
  }
}
```

The summary deliberately omits contact details, customer code, address, notes,
installation ID, plan/reference, and all subscription timestamps. Monitoring,
operator, and diagnostic roles receive HTTP `403` from the full endpoint.

An administrator replaces the customer profile with
`PUT /settings/customer`. The body contains exactly the eight customer fields shown
above, excluding `updatedAt`. Empty strings clear optional fields. Customer
edits create a `customer_profile.update` audit/activity event listing the
changed field names.

There is deliberately no HTTP route for changing `subscription`,
`installationId`, activation dates, plan, or entitlement status. The backend
provides a trusted-master integration method for a later signed and
authenticated enrollment service. Until that integration exists, a fresh
installation remains `unlicensed`; `LICENSE_ACTIVATION_DAYS` (default `30`)
only seeds the informational activation countdown. It does not stop polling,
history, or other features.

`DELETE /users/:id` revokes later bearer-token use for the deleted account.
The server rejects deleting or disabling the acting administrator's own
account and rejects demoting, disabling, or deleting the last enabled
administrator. These conflicts return HTTP `409`.

When OPC UA anonymous access is disabled, the OPC UA server validates
username/password sessions against the same enabled application users. All
roles receive read-only OPC UA values. Use application credentials only with a
trusted server certificate and an approved secure OPC UA channel; dashboard
HTTPS does not secure a separate OPC UA connection. Password change/reset and
administrator user update/delete operations restart OPC UA, closing its active
sessions so the new credential and account state take effect immediately.

## Activity and diagnostics

`GET /activity` and `GET /activity/export` require administrator or diagnostic
access. The timeline combines successful and failed sign-ins, audit changes,
device status changes, system events, system-alert lifecycle, and data-server
service status.

Query parameters are:

- `page`, starting at 1;
- `pageSize`, from 1 through 250;
- `level`: `info`, `warning`, or `error`;
- `category`: `audit`, `device`, or `system`;
- `search`, matched against event, message, actor, entity type/ID, and source
  IP;
- ISO-8601 `from`; and
- ISO-8601 `to`.

The JSON response contains `items`, `total`, `page`, `pageSize`, and
`totalPages`. An item contains `timestamp`, `level`, `category`, `event`,
`message`, `actorUsername`, `entityType`, `entityId`, `sourceIp`, and
structured `details`.

The CSV route accepts the same filters without pagination and exports the
newest 1,000 matching entries. Each serialized details cell is capped at 8,192
characters. Response headers `x-export-row-limit` and `x-export-truncated`
report the limit and whether additional matches were omitted. Spreadsheet
formula prefixes are neutralized before CSV output. Export is rate-limited to
five requests per minute per source IP.

The local activity table retains the newest 50,000 entries. Detail keys matching
passwords, secrets, tokens, authorization, credentials, private keys, access
keys, or API keys are redacted before storage. Treat this as defense in depth
and never submit secrets as event messages.

## Modbus TCP and OPC UA data-server settings

`GET /settings/data-servers` requires an administrator or diagnostic user.
`PUT /settings/data-servers` requires an administrator. Both listeners are
disabled and loopback-bound by default.

The GET response includes saved settings, every current device's selection or
mapping, and runtime state:

```json
{
  "modbus": {
    "enabled": false,
    "bindAddress": "127.0.0.1",
    "port": 1502,
    "refreshIntervalMs": 1000,
    "mappings": [
      {"deviceId":"dev_meter","enabled":false,"unitId":1}
    ],
    "runtime": {
      "state": "disabled",
      "message": null,
      "startedAt": null,
      "lastRefreshAt": null,
      "connectedClients": 0,
      "requestCount": 0
    }
  },
  "opcUa": {
    "enabled": false,
    "bindAddress": "127.0.0.1",
    "advertisedHost": "127.0.0.1",
    "port": 4840,
    "endpointPath": "/ModbusDataLogger",
    "allowAnonymous": true,
    "refreshIntervalMs": 1000,
    "publications": [
      {"deviceId":"dev_meter","enabled":false}
    ],
    "runtime": {
      "state": "disabled",
      "message": null,
      "startedAt": null,
      "lastRefreshAt": null,
      "connectedClients": 0,
      "requestCount": 0
    }
  },
  "updatedAt": "2026-07-27T10:00:00.000Z"
}
```

A PUT sends the same `modbus` and `opcUa` objects without either `runtime`
object. Bind addresses accept an IP address or `localhost`. OPC UA
`advertisedHost` is the hostname or IP placed in the endpoint clients receive;
it cannot be `0.0.0.0`, `::`, a URL, or a path. Set it to the externally
reachable host address when `bindAddress` is a wildcard. Ports are 1 through
65,535 and enabled services must use different ports. Refresh intervals are
100 through 60,000 milliseconds.

Every enabled Modbus mapping needs a unique virtual unit ID from 1 through 247.
At least one mapping must be selected before the Modbus listener is enabled.
At least one OPC UA publication must be selected before the OPC UA listener is
enabled. Every referenced device must exist.

For the Modbus service, `bindAddress` and `port` are where the logger listens
for inbound TCP connections. The outside gateway/application is the client and
initiates that connection; `connectedClients` is the number of those currently
connected receivers. This endpoint configures read-only cached-value
publication, not Modbus write-based ingestion.

Saving reloads the optional listeners but does not stop field polling or
historian collection. A bind, port, tag-overlap, or PKI error appears as
runtime state `error`; it does not stop the collector. See
[Modbus TCP and OPC UA data servers](DATA_SERVERS.md) for register semantics,
quality behavior, Docker binding, certificates, and commissioning.

## System alerts and WhatsApp

`GET /alerts/system?activeOnly=true&limit=250` returns durable device and
remote-database outage incidents:

```json
{
  "items": [
    {
      "id": "sal_example",
      "type": "device_offline",
      "severity": "critical",
      "sourceId": "dev_example",
      "sourceName": "Boiler PLC",
      "detail": "Connection timed out after configured retries",
      "openedAt": "2026-07-27T10:00:00.000Z",
      "lastObservedAt": "2026-07-27T10:01:00.000Z",
      "resolvedAt": null,
      "acknowledgedAt": null,
      "acknowledgedBy": null,
      "state": "active",
      "deliveryStatus": "sent"
    }
  ]
}
```

Acknowledgement records operator action; it does not resolve an active outage.
The collector sets `resolvedAt` only after communication recovers.

`GET /settings/alerts/whatsapp` requires an administrator and returns the
redacted configuration:

```json
{
  "enabled": false,
  "recipients": ["919876543210"],
  "graphApiVersion": "v23.0",
  "phoneNumberId": "123456789012345",
  "templateName": "modbus_system_alert",
  "language": "en_US",
  "sendRecovery": true,
  "offlineDelaySeconds": 30,
  "accessTokenConfigured": true,
  "lastTestAt": null,
  "lastTestOk": null,
  "lastTestMessage": null,
  "updatedAt": "2026-07-27T09:55:00.000Z"
}
```

`PUT /settings/alerts/whatsapp` accepts those configurable fields plus an
optional `accessToken`. Omitting it or sending an empty value preserves the
saved encrypted token. The API never returns that token. The test route accepts
the current draft, sends the approved template to its recipients, and returns
`{ "ok": true, "message": "...", "recipientCount": 1 }`.

See [WhatsApp and dashboard alerts](WHATSAPP_ALERTS.md) for the required
five-variable template and commissioning procedure.

## System administration

All system-administration routes require an authenticated administrator,
including upload routes. Authorization is checked before a large request body
is parsed. `APP_VERSION` is the runtime version source of truth and is returned
by both `/health` and `GET /settings/system`. The latter returns:

```json
{
  "appVersion": "1.3.0",
  "update": {
    "helperConfigured": false,
    "stagedVersion": null,
    "stagedFilename": null,
    "stagedSha256": null,
    "stagedAt": null,
    "lastError": null
  },
  "openVpn": {
    "helperConfigured": false,
    "configured": false,
    "profileName": null,
    "enabled": false,
    "lastChangedAt": null,
    "lastError": null
  }
}
```

### Encrypted configuration backup and restore

`GET /settings/configuration/backup` returns a versioned encrypted text file.
It contains customer profile, device, tag, alarm, classification, remote
PostgreSQL, encrypted WhatsApp alert, Modbus TCP/OPC UA data-server mapping,
update, and OpenVPN configuration. It intentionally excludes subscription and
license state, the stable installation ID, application users, OPC UA PKI
files, readings, alarm/system-alert history, WhatsApp delivery jobs,
audit/activity history, and the PostgreSQL retry outbox. Restored WhatsApp delivery and both
restored data-server listeners remain disabled until an administrator reviews,
tests, and explicitly enables them. Exports are bounded by record and
encrypted-size limits so the collector never creates a file larger than the
128 MB restore limit.

The file can only be decrypted with the same `SETTINGS_ENCRYPTION_KEY`. Treat
the file and that key as separate sensitive assets and test restore on a
separate machine.

Restore accepts JSON up to 128 MB:

```http
POST /api/v1/settings/configuration/restore
Content-Type: application/json

{
  "backup": "modbus-data-logger-backup.v1.…",
  "confirmation": "RESTORE CONFIGURATION"
}
```

The entire backup is authenticated and validated, including relationships,
before the database transaction starts. Restore preserves users, login
passwords, subscription state, and the installation ID. It marks devices
offline, clears transient poll state, marks every
device's PostgreSQL schema dirty for an explicit synchronization before any
later remote write, and restores any OpenVPN profile in the disconnected
state. Saved data-server bind/port/device mappings are restored, but Modbus TCP
and OPC UA are forced off to avoid opening ports on a different host. Existing
connected OpenVPN is first disconnected through the fixed helper or the restore
is aborted. Staged update metadata and packages are deliberately cleared
because update archives are not part of the backup. Polling, PostgreSQL, and
data-server work are paused and drained before the database transaction, then
independently reloaded with the restored settings. The response reports
`collectorReloaded` and `restartRequired`.

Factory reset preserves users, subscription state, and the installation ID,
but clears the customer profile and removes devices, tags, local SQLite
historian data, alarms, classifications, PostgreSQL connection settings and
retry rows, previous audit/activity history, data-server mappings, staged
updates, and the managed VPN profile. Both data servers return to disabled
loopback defaults. It intentionally does not connect to PostgreSQL to drop
remote tables or delete remote history; remote archival or deletion is a
separate operator-controlled procedure. The reset requires the exact
confirmation plus the current administrator password:

```http
POST /api/v1/settings/factory-reset
Content-Type: application/json

{
  "currentPassword": "current-password",
  "confirmation": "FACTORY RESET"
}
```

If OpenVPN is marked connected, the restricted VPN helper must disconnect it
successfully before the reset continues. A missing or failed helper aborts the
reset without clearing configuration.

### Update staging

Upload a ZIP or compressed tar archive as an
`application/octet-stream` body of at most 100 MB:

```http
POST /api/v1/settings/system/update/stage
Authorization: Bearer TOKEN
Content-Type: application/octet-stream
x-file-name: modbus-data-logger-1.3.0.tar.gz
x-update-version: 1.3.0

<archive bytes>
```

The version must be valid SemVer and newer than `APP_VERSION`. This is checked
again at apply time so an archive staged before an application upgrade cannot
become a downgrade. The collector
validates the filename, archive magic, size, and SHA-256 digest, stores the
package with owner-only permissions, and never executes content from the
archive. `POST /settings/system/update/apply` returns HTTP `202` only after it
has passed a fixed `apply` command to the executable configured by
`SYSTEM_UPDATE_HELPER` and that helper exits successfully to confirm it has
verified and safely queued or copied the package. The collector then clears
the staged package, preventing repeated apply requests. A helper that performs
installation asynchronously must retain its own protected copy before it
returns success.

SHA-256 provides integrity checking only; it does not authenticate the
publisher. The external helper must independently verify a trusted publisher
signature and signed manifest before installation. It must also extract into
a temporary directory with path-traversal and symlink defenses, reject
arbitrary archive scripts, install atomically, and roll back after any failed
health check. See [Deployment and security](SECURITY.md).

### OpenVPN profile

Upload a UTF-8 `.ovpn` file, at most 1 MB, using
`application/octet-stream` and the `x-file-name` header. The profile must be a
client profile, include a `remote`, and contain certificate, key,
authentication, and other referenced material inline. Only a conservative
client-directive allowlist is accepted; quoted or escaped directive names and
unknown options are rejected. This blocks executable, module/provider,
external-file, management, server-mode, and process-privilege options.

Use `PUT /settings/system/openvpn` with `{"enabled":true}` or
`{"enabled":false}`. The collector only invokes the absolute executable from
`OPENVPN_HELPER` with a fixed `connect <managed-profile>` or `disconnect`
argument list; it provides no shell, SSH, or arbitrary-command endpoint.
Replacing the profile while it is marked connected is rejected.

## Address convention

Addresses are zero-based protocol offsets:

| Manual notation        | Function code | API address |
| ---------------------- | ------------: | ----------: |
| Coil 00001             |             1 |           0 |
| Discrete input 10001   |             2 |           0 |
| Input register 30001   |             4 |           0 |
| Holding register 40001 |             3 |           0 |

Some vendor manuals already use zero-based addresses. Confirm the convention
with the actual device map before commissioning.

## Data types and byte order

Supported data types are `bool`, `uint16`, `int16`, `uint32`, `int32`,
`float32`, and `float64`. Supported byte orders are:

- `ABCD`: big-endian words and bytes
- `BADC`: byte-swapped
- `CDAB`: word-swapped
- `DCBA`: word- and byte-swapped

Engineering value is calculated as:

```text
value = decoded_raw × scale + offset
```

Each register also accepts `decimalPlaces`, an integer from `0` through `10`
with a default of `2`. This controls the PostgreSQL type of that tag's column:
`NUMERIC(30, decimalPlaces)`. It does not change Modbus decoding or the
full-precision local SQLite value.

## Historian query

`GET /readings` accepts:

- `registerId`
- `deviceId`
- `categoryId`
- `groupId`
- ISO-8601 `from`
- ISO-8601 `to`
- `limit` from 1 to 50,000

The same filters are accepted by `GET /readings/export.csv`. CSV exports include
the device's Category and Group names. All timestamps are stored as UTC ISO-8601
values.

## Device Categories and Groups

Categories and Groups are separate predefined lists managed from
**Administration → System tools**. They are descriptive classifications, not
part of Modbus addressing or the PostgreSQL table schema. An authenticated user
can load both lists with:

```http
GET /api/v1/settings/device-classifications
```

```json
{
  "categories": [
    { "id": "cat_energy", "name": "Energy meter", "deviceCount": 4 }
  ],
  "groups": [{ "id": "grp_utility", "name": "Utility room", "deviceCount": 2 }]
}
```

Creating or deleting list values requires the administrator role:

```http
POST /api/v1/settings/device-classifications/categories
Content-Type: application/json

{"name":"Energy meter"}
```

Use the corresponding `/groups` path for a Group. Names are trimmed, limited
to 120 characters, and unique without regard to letter case. Delete with
`DELETE /settings/device-classifications/categories/:id` or the corresponding
`/groups/:id` path. Deleting a value that is still assigned returns HTTP `409`;
clear or change the affected device assignments first.

Device create and update payloads accept nullable `categoryId` and `groupId`.
Omit them or send `null` to leave a device unassigned. Device responses include
`categoryId`, `categoryName`, `groupId`, and `groupName`; all four are nullable.
Existing databases migrate with existing devices unassigned.

The Reports & export page uses these fields to filter the device scope by
Category and Group. **Export report CSV** passes the selected IDs to the
authenticated reading export endpoint, so the downloaded rows contain only
devices matching both filters.

## Grouped reads and PostgreSQL historian

Each device accepts `readBlockSize` from 1 to 125. The collector groups nearby
enabled tags with the same Modbus function code into one read up to that span.
It always separates function codes and enforces the Modbus protocol limit, so a
1,000-tag device becomes multiple safe requests rather than one oversized
request. If one grouped request fails, the collector uses a bounded,
tag-aligned split to recover valid neighboring tags. A successful split plan
is reused on later polls until the device configuration reloads.

Coils and discrete inputs require the `bool` data type. Multi-register values
are rejected when their configured starting address and width would cross the
end of the Modbus address range.

### Large tag import and Live Data

`POST /devices/:id/registers/import` accepts:

```json
{
  "items": [
    {
      "name": "Bus Voltage",
      "historianColumn": "bus_voltage",
      "address": 107,
      "functionCode": 3,
      "dataType": "float32",
      "byteOrder": "CDAB",
      "scale": 1,
      "offset": 0,
      "unit": "kV",
      "decimalPlaces": 2,
      "enabled": true
    }
  ]
}
```

The device may have at most 1,500 tags after the import. The complete payload
is validated and inserted in one transaction; a duplicate or invalid row
rejects the entire import. A successful response contains `items`, `count`,
and the device's resulting `totalTags`. This is the application collection
limit, not a guarantee that one 1,500-column PostgreSQL/TimescaleDB wide table
will meet a site's row-size, write, retention, and downsampling targets. Soak
test the intended remote schema and split it across logical devices/tables when
required.

`GET /devices/:id/readings/latest` returns `{ "items": [...], "total": N }`
without a 1,000-row cutoff. Every enabled tag is present. A tag awaiting its
first sample has `value: null` and `hasReading: 0`; a sampled tag has
`hasReading: 1`. See [Large Modbus devices and 1,000+ tags](LARGE_DEVICE_GUIDE.md)
for commissioning and storage guidance.

Optional per-device PostgreSQL fields are:

- `postgresEnabled`
- `saveIntervalMs` from 100 ms to 24 hours
- `postgresRawTable`
- `postgresDownsampleTable`
- `postgresDownsampleEnabled`
- `postgresDownsampleIntervalSec`
- `postgresRawRetentionDays`
- `postgresDownsampleRetentionDays`
- `postgresMaintenanceIntervalHours`

Table names must start with a lowercase letter and contain only lowercase
letters, digits, and underscores. Each enabled device must use a unique raw and
downsample table pair. Configure the remote server through `/settings/postgres`
or the dashboard before PostgreSQL can be enabled for a device.

`pollIntervalMs` controls Modbus polling and the local SQLite history.
`saveIntervalMs` independently limits remote PostgreSQL writes. The dashboard
labels this field **Database save interval (seconds)** and accepts a numeric
seconds value, then multiplies it by `1000` before sending the existing
`saveIntervalMs` API field. For example, entering `1` sends
`saveIntervalMs: 1000` and writes at most one device row in each aligned
one-second bucket even when the device is polled more often. The API remains
millisecond-based for backward compatibility.

`saveIntervalMs` must be equal to or greater than `pollIntervalMs`; the
collector rejects a device payload that attempts to save more frequently than
it polls. A timeout or offline device can still leave a bucket empty.

Both PostgreSQL tables use the same minimal wide layout:

```sql
CREATE TABLE example (
    "timestamp" TIMESTAMPTZ PRIMARY KEY,
    power_kw NUMERIC(30, 2),
    energy_kwh NUMERIC(30, 4)
);
```

`timestamp` and one numeric column per tag are the only columns. There are no
device identifiers, quality fields, JSON maps, counts, or other aggregate
metadata. The raw table stores at most one row per aligned device save bucket.
The downsample table stores one row per configured bucket and retains the last
good value for each tag in that bucket. For example, a 15-minute interval
produces at most one row per 15-minute bucket.

Register create and update requests may include `historianColumn`, using a
lowercase PostgreSQL identifier such as `power_kw`. When omitted during create,
the collector derives it only from the tag name; `Main Power` becomes
`main_power`, without an internal ID suffix. When omitted during update, the
current column is preserved. Register responses include the exact
`historianColumn` and `decimalPlaces`. Explicitly changing the column queues a
history-preserving rename for the next schema synchronization. Automatic
name collisions use `_2`, `_3`, and so on; an explicitly requested duplicate
returns `409 historian_column_conflict`. Current and pending names are
reserved per device, and `timestamp` is reserved for sample time. The
collector rounds values to the configured decimal places before remote
storage.

Device responses include `postgresSchemaDirty`,
`postgresSchemaRevision`, and `postgresSchemaSyncedAt`. The dirty flag survives
restarts. The timestamp is the last fully successful synchronization and is
preserved while later tag changes are waiting for another sync.

### Pause, verify, and reconnect a device

An administrator can temporarily stop remote writes without removing the
device's table names, retention settings, tag map, or queued samples:

```http
POST /api/v1/devices/:id/postgres/disconnect
Authorization: Bearer TOKEN
```

To resume, use the verified connection route rather than setting
`postgresEnabled` directly:

```http
POST /api/v1/devices/:id/postgres/connect
Authorization: Bearer TOKEN
```

The collector keeps the device disconnected while it connects to PostgreSQL,
checks the raw and downsample tables, recreates either missing table, adds any
missing current tag columns, and validates the resulting schema. It sets
`connected: true` and reopens writes only after the complete check succeeds.
Orphaned columns still require the guarded confirmation flow below; they are
never removed by reconnect. A live PostgreSQL `undefined_table` (`42P01`) or
`undefined_column` (`42703`) error also closes the device write gate and marks
its schema dirty so an administrator can repair it with the same route.

### Synchronize historian columns

Changing tag configuration does not silently drop remote columns. After a tag
add, edit, delete, or historian-column rename, an administrator calls:

```http
POST /api/v1/devices/:id/historian-schema/sync
Content-Type: application/json

{"dropRemoved":false}
```

The safe first pass adds missing columns, changes required
`NUMERIC(30, decimalPlaces)` scales, applies a queued name change with
transactional `ALTER TABLE ... RENAME COLUMN` in both tables, and reports
columns whose tags were removed. A queued rename therefore does not appear as
an orphan and retains its existing values. If both the old and new names
already exist, the collector stops instead of guessing how to merge them. The
response is:

```json
{
  "ok": false,
  "message": "Historian tables contain columns that are no longer configured; confirm removal to finish synchronization",
  "addedColumns": ["meter_raw.new_tag", "meter_15m.new_tag"],
  "changedColumns": ["meter_raw.flow_rate -> NUMERIC(30, 2)"],
  "orphanedColumns": ["meter_raw.old_tag", "meter_15m.old_tag"],
  "droppedColumns": [],
  "syncedAt": null
}
```

Changing a numeric scale updates both raw and downsample columns. Reducing
`decimalPlaces` rounds existing history. If `orphanedColumns` is non-empty,
back up or archive those columns first. After an explicit administrator
confirmation, echo the exact list returned by the safe pass:

```json
{
  "dropRemoved": true,
  "expectedOrphanedColumns": ["meter_raw.old_tag", "meter_15m.old_tag"]
}
```

The collector rejects the destructive call if that list changed in the
meantime. Dropping a column permanently erases its remote history from both
tables and cannot be undone by adding the tag again.

This route is administrator-only. It validates the actual remote schema and
returns `addedColumns`, `changedColumns`, `orphanedColumns`, `droppedColumns`,
and `syncedAt` so the dashboard can show exactly what occurred. On an orphan
preview, `ok` is false; `syncedAt` is null for a never-synchronized device or
the preserved time of its previous successful sync.

PostgreSQL settings endpoints require the administrator role. Responses never
contain the saved password; `passwordConfigured` indicates whether one exists.
Omitting or sending an empty password when updating keeps the existing secret.
The collector tests an enabled connection before applying it.
`historianTimezone` accepts an IANA timezone such as `UTC` or `Asia/Kolkata`;
historian time columns remain timezone-aware `TIMESTAMPTZ` values.

Device and register updates and deletes require the administrator role and are
audited. Deleting configuration cascades through dependent local SQLite
history and alarm records. It intentionally does not drop remote PostgreSQL
tables, preventing an accidental configuration deletion from erasing remote
history.

Application login and password-change fields accept any non-empty password.
Authentication and password-change endpoints have stricter per-IP rate limits.
