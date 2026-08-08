# Architecture

## Runtime shape

```text
Modbus TCP devices ─┐
                    ├─> Collector service ─> SQLite historian
Modbus RTU bus ─────┘          │                  │
                              ├─> Alarm engine    ├─> Remote PostgreSQL
                              ├─> Alert service ─────> WhatsApp Cloud API
                              ├─> REST API <──────┘   raw + downsample
                              │       │
                              │       └────> Operator dashboard
                              └─> Read-only OPC UA <────── outside clients
```

The outward data servers read the collector's cached latest values. They do
not poll field equipment and cannot write back through the collector.

## Dashboard

The Vinext/React dashboard runs on port `3000`. It presents overview metrics,
device health, live readings, alarms, exports, and configuration. The
collector URL is controlled by `NEXT_PUBLIC_LOGGER_API_URL` and defaults to
`http://127.0.0.1:4100/api/v1`.

Overview totals, health rows, the 24-hour sample trend, last sample, sample
counts, and device status transitions are calculated by the collector from the
installed configuration and SQLite data. An empty logger returns an empty
state. If the collector is unreachable, the dashboard marks it unavailable
instead of inventing demonstration devices or readings.

Administrators maintain predefined Category and Group lists under
**Administration → System tools**. A device may reference one Category, one
Group, both, or neither. Device responses include the resolved names so the
Reports & export workflow can filter its device scope without duplicating
classification state in the browser. The selected IDs are passed to the CSV
export query, which applies both filters in SQLite before returning report rows.

**Administration → Users** manages application accounts and is
administrator-only. **Diagnostics & logs** is visible to administrators and
diagnostic users. **Data connections → Protocol servers** is editable by
administrators and read-only for diagnostic users.

## Collector

The Fastify service runs on port `4100`.

- Each enabled device has one non-overlapping polling loop.
- Polling uses the configured unit ID, timeout, retry count, and interval.
- A failed register read is stored with `bad` quality.
- A failed device cycle updates device health without terminating other loops.
- Successful values are decoded, scaled, inserted in one database transaction,
  and passed to the alarm engine.
- Failed device cycles are observed by the system-alert service; confirmed
  outages open one durable incident and recovery closes it.
- Device changes reload polling tasks safely.
- The optional OPC UA publisher refreshes from the latest local readings and
  maintains its own bounded lifecycle.
- A publisher bind, address-map, or PKI error is recorded but does not terminate
  polling, alarms, or historian services.

## Database Matrix

| Component | Storage Type | Description |
|-----------|--------------|-------------|
| Users | SQLite | User accounts, roles, and authentication data |
| Devices | SQLite | Device configurations including protocol settings |
| Categories/Groups | SQLite | Predefined device classification lists |
| Registers | SQLite | Tag definitions for each device |
| Readings | SQLite | Historical measurements from devices |
| Alarm Rules | SQLite | Threshold-based alarm configurations |
| Alarm Events | SQLite | Active and historical alarm events |
| System Alerts | SQLite | System-level incidents and notifications |
| WhatsApp Deliveries | SQLite | Delivery status of WhatsApp alerts |
| Audit Timeline | SQLite | Activity log for security and compliance |
| PostgreSQL Settings | SQLite | Remote database connection information |
| Data Server Mappings | SQLite | Configuration for OPC UA publishing |

## Storage

SQLite uses WAL mode, foreign keys, a five-second busy timeout, and indexes for
register/time and device/time queries. Data tables cover:

- users
- devices
- device categories and groups
- register definitions
- readings
- alarm rules and events
- system-alert incidents, debounce state, and notification deliveries
- encrypted WhatsApp notification settings
- audit events
- a bounded, web-visible activity timeline
- data-server settings and per-device publication mappings
- encrypted remote PostgreSQL settings
- a bounded remote PostgreSQL outage queue

Local SQLite retention is controlled by `RETENTION_DAYS`. Every device has its
own remote PostgreSQL save interval, downsampling switch and bucket interval,
raw/downsample retention limits, cleanup frequency, and table pair. A retention
value of `0` keeps that device's dataset indefinitely.

Remote PostgreSQL is optional. Every device owns a distinct raw/downsample
table pair. Both tables have exactly the same wide schema:

- `timestamp TIMESTAMPTZ PRIMARY KEY`
- one stable `NUMERIC(30, decimalPlaces)` column per tag

There are no device, quality, raw-register, count, minimum, maximum, average, or
other metadata columns. The table identity already identifies the device. Raw
rows use aligned device save buckets, with at most one row when a poll succeeds
in that bucket. Downsample rows use the configured bucket start as `timestamp`
and keep the last good value observed for each tag in that bucket. A tag that
has no good value in a bucket remains `NULL`.

Tag schema changes are deliberately separate from normal collection. Adding,
editing, or deleting a tag marks its device for synchronization. An
administrator uses **Sync table columns** to compare the desired and actual raw
and downsample schemas. A safe sync adds columns and applies decimal-scale
changes while reporting orphaned columns. Dropping those columns requires a
second explicit confirmation. This guard prevents a tag configuration mistake
from silently erasing remote history.

Each tag has `decimalPlaces` from 0 through 10. Remote values are rounded to
that scale. Synchronizing a lower scale alters both table columns and rounds
existing PostgreSQL history; the UI warns the administrator before applying
the change.

The Modbus poll interval and PostgreSQL save interval are independent: alarms,
live values, and local SQLite history can run at the faster poll interval while
remote writes follow the device save interval. The dashboard accepts the save
interval as numeric seconds and converts it to the API/storage field
`saveIntervalMs`. The server requires `saveIntervalMs >= pollIntervalMs`.
PostgreSQL timestamps use `TIMESTAMPTZ`; the configured IANA timezone is applied
to historian sessions for database-side display. Saved connection passwords
use AES-256-GCM with `SETTINGS_ENCRYPTION_KEY`; API responses expose only a
boolean indicating that a password exists.

When remote PostgreSQL is unavailable, the optional SQLite outbox keeps one
snapshot per device save bucket. Availability failures are queued durably;
schema, permission, and data errors remain visible. Replay processes bounded
batches oldest first and uses timestamp upserts, so retrying an accepted sample
does not create a duplicate. A device awaiting column synchronization continues
to queue current samples while its replay is paused.

## Read-only publication services

The OPC UA server builds a separate read-only address space under
`Objects/Devices/<device>/<tag>`. It publishes scaled engineering values,
logger quality mapped to OPC UA status, and the source timestamp. Tag topology
changes rebuild that address space and can briefly require client reconnection.
Its socket bind address is separate from the hostname/IP advertised in endpoint
URLs, which supports container/NAT deployment without advertising a wildcard.
The PKI directory is stored below the private system-administration data
directory.

Both listeners default to disabled on loopback. Settings and mappings are in
SQLite, while runtime connection/request state remains in memory. Configuration
backup includes the settings and mappings but excludes OPC UA certificate and
private-key files. See [Data servers](DATA_SERVERS.md).

## Activity timeline

Successful sign-ins and audit actions are mirrored into a web activity table;
failed sign-ins are recorded as warning system events. Device status
transitions, system-alert open/recovery events, and data-server state/error
changes also append events. Entries are categorized as `audit`, `device`, or
`system` and leveled as `info`, `warning`, or `error`.

The table keeps the newest 50,000 entries. Structured details are bounded and
sensitive key names are redacted before storage. Administrator and diagnostic
roles can filter, page, and export the timeline. Host logs remain the source
for low-level process and dependency diagnostics.

## System alerts and notification delivery

System alerts are separate from tag alarm rules because device and PostgreSQL
outages do not have a register or threshold. A single active incident is
deduplicated by alert type and source. Persistent debounce state prevents brief
failures from opening an incident. Acknowledgement is operator metadata; only a
healthy observation resolves the incident.

PostgreSQL health monitoring runs only when remote logging is enabled,
configured, and used by at least one connected device. Availability failures
open the global remote-database incident. Intentional disablement,
administrator pauses, schema-repair errors, and tag-column changes do not.

WhatsApp uses a separate durable delivery queue. The alert service writes the
incident and delivery intent locally before contacting Meta. A background
worker sends an approved template to the fixed `graph.facebook.com` host,
records Meta's accepted message ID, and retries eligible temporary failures.
Polling never waits for WhatsApp. Dashboard alerts continue to work when the
WhatsApp channel is disabled or unavailable.

## Tag Value Alerts

The alarm engine supports group-wise tag value alerts including:
- Hi/Lo alarms (high/low threshold violations)
- HiHi/LoLo alarms (severe high/low threshold violations) 
- Group-level alert aggregation where a single alert represents the total number of active alarms across all devices in a group
- Device-specific thresholds with configurable hysteresis
- Alarm history tracking for each tag and group

## System administration boundary

Configuration backup exports an authenticated, AES-256-GCM encrypted envelope
containing classifications, devices, tags, alarm rules, PostgreSQL settings,
WhatsApp alert settings, data-server settings/mappings, and the managed OpenVPN
client profile. It excludes users, OPC UA PKI files, local readings,
alarm/system-alert history, notification deliveries, audit/activity history,
and queued process samples. Restore validates the complete envelope before
replacing configuration, preserves user accounts, restores WhatsApp outbound
delivery disabled until it is retested, and forces both data servers disabled
until their network exposure is reviewed. Factory reset requires the current
administrator password plus an exact phrase; it clears local operational data,
previous activity, data-server mappings, and managed files but does not drop
remote PostgreSQL tables.

The collector never exposes a general shell or SSH control. Optional software
updates and OpenVPN connect/disconnect actions cross into the operating system
only through fixed-path, separately installed helpers. The update helper owns
publisher-signature verification, atomic release switching, health checks, and
rollback. The VPN helper owns the privileged OpenVPN process; the collector
accepts only a restricted, self-contained client profile.

## Authentication and authorization

The login endpoint returns a signed HS256 access token. API routes validate that
token against the current user record and enforce four roles:

- `administrator`: all configuration and destructive actions
- `operator`: monitoring, device creation, and alarm acknowledgement
- `viewer`: monitoring-only process data and export
- `diagnostic`: monitoring plus read-only data-server status and activity
  diagnostics

Administrators can create, rename, enable, disable, delete, and reset passwords
for managed accounts. Self-disable/self-delete and removal of the last enabled
administrator are blocked.

If OPC UA anonymous access is disabled, its user manager validates the same
enabled application usernames and passwords. Every application role receives
the same read-only OPC UA data access. This authentication is separate from OPC
UA certificate trust and must be used only over an approved secure channel.
Changing or administratively resetting a password increments that user's token
version, invalidating all existing web bearer tokens for the account. Password
change/reset and administrator account update/delete routes also restart the
OPC UA listener, closing active OPC UA sessions so the current credentials,
enabled state, and username are enforced on reconnect.

Development may explicitly set `AUTH_DISABLED=true`. Production rejects that
setting.

## Scaling guidance

SQLite is the authoritative local store for a single collector instance and
moderate tag counts. Remote PostgreSQL provides longer-term raw and downsampled
history. Before increasing load, validate the exact device mix, sampling rate,
network reliability, retention, and database capacity. For a rough planning
example, 500 tags at one-second sampling produces 86,400 wide rows, containing
up to 43.2 million tag values, per device per day.
