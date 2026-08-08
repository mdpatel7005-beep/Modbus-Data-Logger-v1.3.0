# Edge Gateway V1.2 release notes

V1.2 makes the dashboard reflect the installed logger configuration, adds
read-only industrial data publishing, and separates monitoring,
troubleshooting, and administration access.

V1.1 system-alert and WhatsApp behavior is unchanged. See
[V1.1 release notes](RELEASE_NOTES_V1.1.md).

## Dynamic Overview

- Device totals, enabled/disabled state, online/warning/offline state, tag
  count, alarm count, poll performance, and device-health rows come from the
  collector database.
- The sample chart contains the most recent 24 hourly buckets from stored
  readings.
- Last sample time, last-hour and last-24-hour sample counts, and device-status
  transitions are live collector values.
- An empty or unreachable collector no longer creates demonstration devices,
  trends, or sample counts.
- Overview refreshes periodically and provides a manual refresh action.

## Users and roles

Administrators can now create, rename, enable, disable, and delete users, assign
roles, and reset another user's password from **Users**.

V1.2 supports four roles:

| Role            | Intended access |
| --------------- | --------------- |
| `administrator` | Full configuration, user administration, diagnostics, and destructive actions |
| `operator`      | Operational monitoring, device creation, and alarm acknowledgement |
| `viewer`        | Monitoring-only access to operational data and exports |
| `diagnostic`    | Monitoring plus read-only data-server status and activity diagnostics |

Monitoring-only and diagnostic users cannot change devices, tags, database
settings, data-server settings, users, or system-administration configuration.
The server prevents an administrator from deleting or disabling their own
account and preserves at least one enabled administrator.

All password fields continue to accept any non-empty value by design. Use long,
unique passwords in production. A password change or administrator reset
invalidates that user's existing web tokens. Password change/reset and
administrator account update/delete operations restart OPC UA, closing active
sessions so clients must reconnect with the current account state.

## Activity and diagnostics

- The new **Activity & diagnostics** page combines successful/failed sign-ins,
  configuration audit events, device status transitions, system-alert lifecycle
  events, and data-server service state/errors.
- Administrator and diagnostic roles can filter by level, category, text, and
  time range.
- The page refreshes automatically and can export the newest 1,000 filtered
  events as formula-safe CSV. Export is limited to five requests per minute per
  source IP and reports truncation in `x-export-truncated` and the fixed limit
  in `x-export-row-limit`.
- The local activity table is bounded to the newest 50,000 entries.
- Sensitive detail keys such as passwords, tokens, credentials, access keys,
  and private keys are redacted before activity storage.

This page is an operational view, not a replacement for protected host and
container logs. Continue forwarding production JSON logs to the site's
controlled logging system.

## Read-only data servers

### Modbus TCP

- The collector can publish selected devices as virtual Modbus units on one
  read-only Modbus TCP listener.
- Each selected device receives a unique virtual unit ID from 1 through 247.
- Enabled tags keep their original FC1, FC2, FC3, or FC4 area and zero-based
  address.
- Exact captured raw bits/words are preferred over reconstructing them from the
  engineering value.
- Gaps and bad/unread values return zero or false. Modbus cannot expose the
  logger's quality or source timestamp with the value.
- FC5, FC6, FC15, and FC16 writes are rejected.

### OPC UA

- The collector can publish selected devices and enabled tags beneath
  `Objects/Devices`.
- Tag nodes expose scaled engineering values as read-only Boolean or Double
  values.
- OPC UA status, `Quality`, and `SourceTimestamp` preserve logger quality and
  sample time.
- Changing the selected tag topology automatically rebuilds the address space;
  connected clients may need to reconnect briefly.
- Bind address and advertised client hostname/IP are separate, allowing a
  container to listen on `0.0.0.0` while advertising the reachable host name.
- Anonymous access is configurable. When it is disabled, any enabled
  application user can authenticate for the same read-only OPC UA value
  access. Credentials must be used only over an approved secure OPC UA channel.
- Server certificates, private keys, and trust lists are kept under the private
  system-administration data directory. PKI trust is separate from application
  username/password validation.

Both listeners are disabled and loopback-bound after a new install. Default
ports are `1502` and `4840`. Docker publishes those ports, but a container
listener remains unreachable externally until an administrator deliberately
binds it to `0.0.0.0` on a trusted OT/container network. Apply source-address
firewall allowlists before doing so.

`TRUST_PROXY` now defaults to `false`. Enable it only when direct access to API
port `4100` is blocked and requests can arrive exclusively through the trusted
reverse proxy; otherwise a client can forge forwarded source-address headers,
weakening rate limits and activity source-IP records.

See [Modbus TCP and OPC UA data servers](DATA_SERVERS.md) for commissioning and
the protocol limitations.

## API additions

- `GET /api/v1/overview` now returns device summaries, a 24-hour sample trend,
  and activity summary fields in addition to the original totals.
- Administrator-only user management:
  `GET/POST /api/v1/users`, `PATCH/DELETE /api/v1/users/:id`, and
  `POST /api/v1/users/:id/reset-password`.
- Administrator/diagnostic activity access:
  `GET /api/v1/activity` and `GET /api/v1/activity/export`.
- Administrator/diagnostic data-server status:
  `GET /api/v1/settings/data-servers`.
- Administrator-only data-server changes:
  `PUT /api/v1/settings/data-servers`.

## Backup, restore, and factory reset

Encrypted configuration backup now includes data-server settings, device
selections, and virtual unit mappings. It does not include the OPC UA PKI
directory, users, activity history, process readings, or audit history.

Restore preserves data-server settings and selections but forces both listeners
disabled. This prevents a restored logger from unexpectedly opening ports on a
different machine or network. Review the destination interfaces, firewall,
ports, and PKI before re-enabling them.

Factory reset clears activity history and data-server mappings and restores
both listeners to disabled loopback defaults. As before, application users are
preserved and remote PostgreSQL tables are not dropped.

## Upgrade and migration

The collector performs the V1.2 SQLite migration at startup:

- the existing user-role constraint is expanded to allow `diagnostic`;
- an activity timeline and indexes are added; and
- data-server settings and per-device publication mappings are added.

Existing users, devices, tags, local readings, alarms, and PostgreSQL
configuration are retained. Optional data servers do not start merely because
the software was upgraded.

Before upgrading, stop the collector and take a consistent backup of:

- the SQLite database together with its `-wal` and `-shm` files;
- the private `SYSTEM_ADMIN_DATA_DIR`;
- the active application and environment configuration; and
- remote PostgreSQL data under the site's existing database procedure.

After upgrading:

1. Confirm `/api/v1/health` reports `1.2.0`.
2. Sign in as an administrator and verify the Overview matches configured
   devices and known sample counts.
3. Create one disposable monitoring-only user and one diagnostic user, then
   verify their role boundaries.
4. Open **Activity & diagnostics** and verify user/configuration actions and a
   controlled device status transition.
5. Leave both data servers disabled until firewall and client acceptance tests
   are ready.
6. Commission one loopback Modbus client and one loopback OPC UA client.
7. Back up and restore to a disposable host; confirm both restored listeners
   remain disabled.
8. Run the full [feature verification](FEATURE_VERIFICATION.md) checklist
   before production rollout.
