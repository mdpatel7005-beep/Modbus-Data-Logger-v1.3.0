# Deployment and security

## Before production

1. Set `NODE_ENV=production`.
2. Set `AUTH_DISABLED=false`.
3. Generate a unique high-entropy `JWT_SECRET`.
4. Generate a different high-entropy `SETTINGS_ENCRYPTION_KEY`.
5. Set the initial administrator password and change it after first login.
6. Restrict `CORS_ORIGIN` to the exact dashboard origin.
7. Bind the collector only to the required management interface.
8. Put HTTPS at a trusted reverse proxy; the collector does not terminate TLS.
9. Keep `TRUST_PROXY=false` unless direct access to API port `4100` is blocked
   and the trusted proxy is the collector's only request source.
10. Keep the optional inbound Modbus TCP and OPC UA listeners disabled until
   client allowlists and commissioning tests are ready.
11. Firewall field-device Modbus, published Modbus TCP `1502`, OPC UA `4840`,
    API, and PostgreSQL paths from untrusted networks.
12. Run the service with a dedicated non-administrator operating-system account.
13. Back up the database, `-wal`, and `-shm` files as one consistent set.
14. Keep `SYSTEM_ADMIN_DATA_DIR` in a dedicated private persistent directory,
    outside the dashboard and any other web-served path.
15. Verify the OPC UA server certificate and approved client certificates; use
    application credentials only on an approved secure OPC UA channel.
16. Install update and OpenVPN helpers separately with fixed absolute paths and
    operating-system permissions that prevent the collector account from
    modifying them.
17. Set `APP_VERSION` to the deployed SemVer; `/health` and system
    administration report that same runtime value.
18. For WhatsApp alerts, use a dedicated Meta system-user token, approve the
    Utility template, record recipient consent, and test from a staging logger.
19. Set `LICENSE_ACTIVATION_DAYS` for the intended first-install information
    window. It is a display setting, not an entitlement or security control.

## Network placement

Use a segmented industrial control network. The collector should be able to
reach field devices, but field devices should not be directly reachable from
office or public networks. Expose the dashboard/API only through the approved
management path.

`TRUST_PROXY` defaults to `false`. Turn it on only when the collector accepts
requests exclusively from the specifically trusted reverse proxy and direct
access to port `4100` is blocked by host/container/network controls. With proxy
trust enabled, Fastify accepts forwarded client addresses for rate limiting and
activity source-IP records. If an untrusted client can reach that port, it can
forge those headers and weaken both controls.

The V1.2 data servers are disabled and bound to `127.0.0.1` by default. Docker
publishes host ports `1502` and `4840`, but the services remain unreachable
from outside the container until their in-container bind address is deliberately
changed to `0.0.0.0`. Do that only on a trusted OT/container network and after
the host, container, VLAN, and upstream firewall rules allow only approved
receiver addresses. On a native host, prefer binding the exact OT interface
rather than every interface.

When OPC UA binds a wildcard address, configure its separate advertised host as
the DNS name or IP clients use. Never advertise `0.0.0.0` or `::`, and verify
that the server certificate is valid for the advertised name/address.

Modbus itself has no authentication or encryption. The field client and the new
inbound Modbus server both perform reads only; the server rejects write
function codes. Read-only does not make public exposure safe: process values,
device maps, availability, and service behavior remain sensitive. Never expose
Modbus TCP directly to the public internet, and do not add write operations
without a separate hazard and authorization review.

OPC UA can provide secure channels and client identity, but those controls must
be commissioned. `allowAnonymous=false` makes the server validate any enabled
application user's username and password; all roles still receive read-only OPC
UA values. Never send those credentials over `SecurityPolicy#None` or another
unsecured channel. Select an approved `Sign` or `SignAndEncrypt` endpoint,
verify the server certificate, and trust client certificates only after an
out-of-band fingerprint and identity check.

The OPC UA PKI is stored beneath `SYSTEM_ADMIN_DATA_DIR/opcua-pki`. Unknown
certificates are not accepted automatically. Keep this directory private and
persistent. Dashboard HTTPS, application login, OPC UA username/password
validation, and OPC UA certificate trust are separate controls; configuring
one does not secure the others. Follow the
[data-server commissioning guide](DATA_SERVERS.md).

## Secrets

Never commit `.env` files. Rotate the JWT secret after suspected disclosure;
that invalidates existing tokens. Use an operating-system secret store or
container secret mechanism for production.

Simple non-empty application passwords are accepted by request. Login and
password-change routes therefore have stricter rate limits. A long unique
password is still strongly recommended for every production account.

Create individual accounts rather than sharing the initial administrator.
Monitoring-only users should be the default for view stations. Diagnostic users
can also read data-server status and the activity timeline but cannot change
configuration. The server protects the acting administrator from self-disable
or self-delete and preserves one enabled administrator.

When OPC UA anonymous access is disabled, enabled application users can also
authenticate new OPC UA sessions. Prefer a dedicated monitoring-only account,
use it only over an approved secure OPC UA channel, and rotate it like any other
service credential. Changing or administratively resetting its password
invalidates existing web bearer tokens for that account. Password change/reset
and administrator user update/delete operations restart OPC UA and close every
active OPC UA session, so plan for client reconnection during account
maintenance.

The remote PostgreSQL password is encrypted before SQLite storage and never
returned by the API. Preserve and protect `SETTINGS_ENCRYPTION_KEY`; changing
it prevents the collector from decrypting the saved password.

The Meta WhatsApp access token is protected the same way and API responses
expose only `accessTokenConfigured`. Administrators alone may read or change
the redacted settings or send a test. The outbound host is fixed to
`graph.facebook.com`, the API version and phone-number ID are allowlisted, and
recipients are validated as international numbers. Never place tokens in
template text, logs, screenshots, or support messages.

The stable subscription `installationId` is a non-secret enrollment identifier,
not a credential. Do not use it by itself to authenticate a logger to future
master software. Subscription state has no public HTTP mutation route, and an
ordinary dashboard administrator cannot mark an installation active. The
repository's trusted-master update method is an integration boundary: a future
implementation must authenticate the master, verify a signed entitlement
bound to the installation ID, reject replay and rollback, and use a protected
time source before calling it.

Only administrators can read the full customer profile and subscription record.
Other authenticated roles receive a deliberately minimal summary containing
only company name, site name, effective status, the two computed remaining-day
values, and the display message. It does not expose contact information,
address/notes, customer code, installation ID, subscription plan/reference, or
license timestamps. Treat the administrator response and encrypted backups as
customer-confidential data.

A new installation is safely `unlicensed`. Its activation due date and
remaining-days message are informational until that verified master
integration is added; the current release does not disable collection or
features when the date passes. This avoids pretending that a locally editable
countdown is licensing enforcement.

Configuration backups are encrypted and authenticated with that same key.
They exclude users, subscription state, the installation ID, and process
history, but still contain customer contact/site details, network addresses,
device maps, encrypted database/WhatsApp credentials, WhatsApp recipient
numbers, data-server bind addresses and mappings, and an OpenVPN profile. They
do not include OPC UA PKI files. Store the backup, encryption key, and a
separate protected PKI/host snapshot independently; restrict their access and
verify restores on a non-production machine. Restoring a backup does not
replace application users, passwords, subscription state, or installation
identity. WhatsApp outbound delivery, Modbus TCP publication, and OPC UA
publication remain disabled until retested.

## Privileged system helpers

The dashboard and collector do not offer SSH or arbitrary command execution.
Optional host-level changes go through two narrowly scoped external helpers:

- `SYSTEM_UPDATE_HELPER` receives only
  `apply <managed-archive> <version> <sha256>`.
- `OPENVPN_HELPER` receives only `connect <managed-profile>` or `disconnect`.

Configure helpers with absolute paths. Their files and parent directories
should be owned by root or another deployment administrator and must not be
writable by the collector account. Grant only the specific operating-system
privileges each action needs. The collector launches them without a shell,
with a minimal environment and a private working directory.

An update archive's SHA-256 digest detects corruption; it is not proof of who
published the update. The update helper must verify a trusted publisher
signature and signed manifest before changing the installation. Extract into a
new temporary directory, reject absolute paths, `..` traversal, symlinks and
special files, and never run scripts supplied by the archive. Validate every
manifest hash, use an atomic release switch, perform a health check, and retain
the previous release for automatic rollback. It must return success to the
collector only after verification and after safely copying or queuing every
artifact it still needs; the collector removes its staged copy after that
successful acceptance handshake.

OpenVPN profiles are limited to client mode and must be self-contained. The
collector applies a conservative directive allowlist and rejects quoted,
escaped, unknown, server-mode, executable, plugin/provider, external-key,
management, file-output, and process-identity options. The VPN helper should
still run OpenVPN with an independent restrictive policy and explicitly
disconnect before reporting success.

Managed update and VPN files use owner-only permissions (`0600`) beneath
directories restricted to the service account (`0700`). Do not place
`SYSTEM_ADMIN_DATA_DIR` at the filesystem root, a user home, the application
directory, the database parent directory itself, or any public/static
directory. The collector resolves canonical paths to catch symlinked ancestors
and avoids following symlinks when opening managed files.

Managed-file replacement fsyncs file contents and parent directories, and
startup removes interrupted temporary files or restores a missing target from
a previous copy. This is best-effort recovery, not a fully atomic transaction
between SQLite and the filesystem after sudden power loss. Before restore,
factory reset, or update operations, take a consistent host/volume snapshot of
the SQLite database (including WAL/SHM) and the entire system-administration
directory. Verify both database and managed-file state after an unclean
shutdown.

## Database

The local and remote historians can contain operationally sensitive process
data. Apply file-system permissions, encrypted disks, TLS, monitored free
space, and tested backups. A backup is not complete until a restore has been
verified. Follow [Remote PostgreSQL setup](POSTGRESQL.md).

Factory reset clears the customer profile, local configuration, SQLite history,
queued remote writes, previous activity/audit history, and data-server
mappings, then restores both listeners to disabled loopback defaults. It
preserves application users, subscription state, and the installation ID so
reset cannot bypass licensing. It does not drop remote PostgreSQL
tables or erase already-saved remote history. Perform remote retention,
archive, or deletion separately with an approved database procedure.

Remote PostgreSQL sessions enforce connection, statement, client-query, lock,
and idle-transaction timeouts. Restore and factory reset pause new historian
work and wait for active writes to drain; if that bounded drain cannot finish,
the operation returns `503 collector_busy`, resumes collection, and changes no
configuration.

Restore and reset also stop scheduling new Modbus polls, cancel active
connect/read promises, destroy TCP transports, and close RTU serial ports
before changing configuration. Poll draining has its own fixed bound. If a
driver cannot release in time, administration is rejected with
`503 collector_busy`; polling restarts only after the old task has actually
finished, preventing overlapping access to the same device.

## Logging

Production logs are structured JSON. They intentionally avoid raw credentials
and access tokens. Forward logs to a controlled system with retention and
access policies appropriate for the plant.

The web **Diagnostics & logs** timeline is a separate, bounded operational view
for administrators and diagnostic users. It contains usernames, source IP
addresses, entity IDs, configuration actions, device transitions, system-alert
events, and data-server state/errors. Sensitive detail-key names are redacted
and the newest 50,000 entries are retained, but redaction is defense in depth:
never place a password, token, private key, or full connection string in an
event message. Restrict activity CSV files as operationally sensitive data.
CSV export is limited to the newest 1,000 matches, caps each structured-details
cell, neutralizes spreadsheet formula prefixes, and is rate-limited to five
requests per minute per source IP. The response reports the fixed limit and
whether more matches were omitted. These bounds reduce export risk but do not
make an exported file public information.

The web timeline does not contain every low-level request, stack trace, library
warning, operating-system event, or container restart. Keep protected host and
JSON log forwarding for incident response. Configuration backup excludes the
activity timeline, and factory reset removes its previous entries.

Meta accepting a template request and returning a WhatsApp message ID means
the request was accepted; it is not proof that the handset received it.
Delivery confirmation requires a separately authenticated webhook, which is
outside V1.1. Commissioning must therefore confirm actual receipt on every
configured number. WhatsApp is also unavailable when the collector host has no
power or internet route, so retain an independent host/network monitoring
path.

## Dependency and release checks

Before each release:

```bash
npm audit --omit=dev
npm --prefix server audit --omit=dev
npm run typecheck
npm run lint
npm test
npm run build:all
```

Review advisories in the context of this deployment and update lockfiles in a
tested release branch.
