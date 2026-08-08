# Edge Gateway V1.3.0 release notes

V1.3 reorganizes the growing dashboard around operator tasks, adds customer
and installation identity, and makes the Modbus TCP server connection direction
explicit.

The V1.2 dynamic Overview, roles, diagnostics, and read-only industrial data
servers remain available. See [V1.2 release notes](RELEASE_NOTES_V1.2.md).

## Consolidated dashboard

Related configuration now has one primary home:

- **Data connections** contains the remote PostgreSQL historian and the Modbus
  TCP/OPC UA protocol servers.
- **Administration** contains customer and installation details, application
  users, Categories and Groups, backup/restore, update staging, OpenVPN, and
  other system settings.
- **Tags** opens in the context of the selected device instead of occupying a
  permanent navigation item.
- Alerts, reports, monitoring, and diagnostics remain separate operational
  workflows.

This removes the standalone Remote PostgreSQL, Data servers, Settings, Users,
and Account & password destinations that duplicated nearby configuration.
Role restrictions still apply inside the consolidated workspaces. In
particular, diagnostic users can inspect protocol-server status but cannot open
or change historian credentials.

## Self-account menu

The top-bar user menu is now the single place for a signed-in user to change
their own password or sign out. Administrator account management remains under
**Administration → Users**.

Password behavior is unchanged: every non-empty password is accepted, although
a long unique password is recommended for production. Changing or
administratively resetting a password invalidates that account's existing web
tokens and closes active OPC UA sessions so clients must reconnect.

## Customer, site, and installation identity

Administrators can record:

- company name and customer code;
- contact person, email, and phone;
- site name and address; and
- installation notes.

Administrators can view the full customer profile and server-managed
installation/subscription record. Every authenticated role can view a minimal
summary containing only company name, site name, effective status, remaining
activation/subscription days, and the display message. Contact information,
address/notes, customer code, installation ID, plan/reference, and entitlement
timestamps remain administrator-only. The collector creates one stable
`installationId` for future enrollment with master software. The status model
can represent plan, subscription reference, activation, expiry, grace period,
last check, and remaining days.

The initial activation countdown is informational. It defaults to 30 days and
can be seeded with `LICENSE_ACTIVATION_DAYS`. V1.3 does **not** disable polling,
history, exports, or any other feature when the countdown reaches zero.

There is no public HTTP endpoint that can activate an installation, change its
plan, or mutate entitlement dates. A trusted internal update boundary exists
for a future signed and authenticated master-software integration, but that
integration and entitlement enforcement are not included in V1.3.

Customer/site details are included in encrypted configuration backups and are
cleared by factory reset. Subscription state and `installationId` are excluded
from configuration backups and preserved by restore and factory reset, so a
configuration file or reset cannot transfer or manufacture an entitlement.

## Modbus TCP server topology

The data logger is the listening Modbus TCP **server**. An outside gateway,
SCADA system, or other consumer must act as the Modbus TCP **client** and open
the connection to the logger:

```text
outside Modbus client/gateway
            |
            | opens TCP connection and sends FC1-FC4 read request
            v
Modbus Data Logger server -> virtual unit ID -> cached device/tag value
```

Each published source device is mapped to a unique virtual unit ID. The client
selects that unit ID and reads the tag's configured coil, discrete-input,
holding-register, or input-register address. The logger does not initiate the
downstream connection from this server mode.

The V1.3 server remains deliberately read-only. FC5, FC6, FC15, and FC16 writes
are rejected. Accepting values pushed by an outside gateway would be a separate
ingestion feature and is not enabled by this release.

Both Modbus TCP and OPC UA listeners remain disabled and loopback-bound after a
new install or restore. Bind them to a reachable OT interface only after
firewall, virtual-unit, address-map, and client acceptance tests.

## API and configuration

- `GET /api/v1/settings/customer` returns the full customer/site and
  subscription record to administrators only.
- `GET /api/v1/settings/customer/summary` returns the exact minimal display
  summary to any authenticated role.
- `PUT /api/v1/settings/customer` lets an administrator replace the eight
  editable customer/site fields and creates a redacted activity event.
- `APP_VERSION` now defaults to `1.3.0`.
- `LICENSE_ACTIVATION_DAYS` defaults to `30` and controls only the initial
  informational countdown.

See [API and device setup](API.md), [deployment and security](SECURITY.md), and
[Modbus TCP and OPC UA data servers](DATA_SERVERS.md) for the complete
interfaces and commissioning controls.

## Upgrade and migration

Before upgrading, stop the collector and take a consistent backup of:

- the SQLite database together with its `-wal` and `-shm` files;
- the private `SYSTEM_ADMIN_DATA_DIR`;
- the active application and environment configuration; and
- remote PostgreSQL data under the site's existing database procedure.

After upgrading:

1. Confirm `/api/v1/health` reports `1.3.0`.
2. Sign in as an administrator and verify the consolidated navigation and each
   role's visibility.
3. Enter a disposable customer/site profile and confirm it appears after a
   collector restart.
4. Record the installation ID, remaining activation days, and unlicensed
   informational status; confirm no feature is disabled by that status.
5. Change your own password from the top-bar account menu, then sign in again.
6. Open a selected device's Tags action and confirm the correct device remains
   selected.
7. Leave both protocol servers disabled until firewall and client acceptance
   tests are ready.
8. From an isolated test client, connect to the Modbus listener, read FC1-FC4
   from mapped virtual units, and confirm every write request is rejected.
9. Back up and restore on a disposable host. Confirm customer data follows the
   backup while subscription state and installation identity remain those of
   the destination.
10. Run the full [feature verification](FEATURE_VERIFICATION.md) checklist
    before production rollout.
