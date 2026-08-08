# Edge Gateway V1.3.0

A production-oriented Modbus TCP/RTU collector, local historian, alarm engine,
read-only Modbus TCP/OPC UA publisher, and responsive operator dashboard.

## Included

- Modbus TCP and Modbus RTU polling with grouped reads, timeouts, and retries
- Coils, discrete inputs, holding registers, and input registers
- Boolean, signed/unsigned integer, float, scaling, offset, and byte order
- SQLite WAL storage, indexed history, retention cleanup, and CSV export
- Optional per-device PostgreSQL raw and downsample tables with exactly one
  timestamp column plus one numeric column per tag
- Live status, device health, alarm rules, acknowledgement, and audit events
- Configuration-driven Overview totals, health rows, and 24-hour sample trend
- Durable device/database offline incidents on the dashboard
- Optional Meta WhatsApp Cloud API alerts with encrypted credentials
- JWT authentication with administrator, operator, monitoring-only, and
  diagnostic roles
- Administrator user management plus searchable web activity diagnostics
- Consolidated Data connections and Administration workspaces with contextual
  tag management and a self-account menu
- Customer and site profile plus a stable installation identity and
  informational subscription/activation status
- Optional read-only Modbus TCP and OPC UA data servers for selected devices
- Device-selected live values plus device/tag add, edit, and delete screens
- Administration-managed device Categories and Groups with report filters
- Validated CSV template, download, and bulk tag import for each device
- Per-tag PostgreSQL decimal places and guarded historian-column synchronization
- Encrypted remote PostgreSQL setup, connection testing, retention, and cleanup
- Bounded local PostgreSQL outage queue with ordered catch-up replay
- Encrypted configuration backup/restore and guarded factory reset
- Restricted update-package staging and self-contained OpenVPN client controls
- Request validation, CORS allow-listing, security headers, and rate limiting
- Responsive dashboard, VS Code tasks, tests, and Docker definitions

The web dashboard and collector are intentionally separate. Serial ports and
plant-network Modbus traffic remain on the local collector; the dashboard talks
to it through a versioned API.

V1.3 removes duplicated configuration destinations and groups related work into
**Data connections** and **Administration**. Tags open in the context of their
device, while password change and sign-out remain available from the signed-in
user menu. Administrators can record customer/site details and view a stable
installation ID plus informational activation/subscription dates. This release
does not enforce entitlements and does not expose a public API for changing
subscription state; a trusted master-software integration is still future work.
See the [V1.3 release notes](docs/RELEASE_NOTES_V1.3.md).

V1.2 replaces fixed Overview examples with the installed devices and stored
sample activity, adds monitoring-only and diagnostic accounts, and adds a
searchable activity page. It can also republish the latest cached values to
outside applications through read-only Modbus TCP and OPC UA listeners. Both
listeners are disabled and loopback-bound by default. See
[Modbus TCP and OPC UA data servers](docs/DATA_SERVERS.md) and the
[V1.2 release notes](docs/RELEASE_NOTES_V1.2.md).

V1.1 adds system alerts for enabled devices and the configured remote
PostgreSQL server becoming unavailable. One incident is kept open per outage,
operators can acknowledge it, and recovery closes it automatically. WhatsApp
delivery uses an administrator-configured, Meta-approved template and does not
block Modbus polling. See [WhatsApp and dashboard alerts](docs/WHATSAPP_ALERTS.md).

## Requirements

- Node.js 22.13 or later
- npm 10 or later
- For Modbus RTU: a serial adapter and its operating-system driver

## Start in Visual Studio Code

1. Open this folder in Visual Studio Code.
2. Open the Command Palette and choose **Tasks: Run Task**.
3. Run **Install all dependencies** once.
4. Run **Start Edge Gateway**.
5. Open `http://localhost:3000`.

The collector listens on `http://localhost:4100`. With the default development
configuration, sign in with:

- Username: `admin`
- Password: `change-me-before-production`

Open the signed-in user menu in the top bar to change that password before
entering real device information. Simple non-empty passwords are accepted,
although a long unique password is recommended. Sign out from the same menu to
return to the login screen. Changing or administratively resetting a password
invalidates that user's existing web tokens and restarts OPC UA so existing
OPC UA sessions are closed. For an isolated development workstation, copy
`server/.env.example` to `server/.env` to use the documented local settings.

## Terminal start

```bash
npm install
npm --prefix server install
npm run dev

## External Network Access

To access the dashboard from other PCs on your local network:

1. Create `.env.local` file with:
   ```
   NEXT_PUBLIC_LOGGER_API_URL=http://YOUR_SERVER_IP:4100/api/v1
   LOG_LEVEL=debug
   ```

2. Ensure `server/.env` has `HOST=0.0.0.0` (already set by default)

3. Access the dashboard at: http://YOUR_SERVER_IP:3000

The collector API will be available at: http://YOUR_SERVER_IP:4100
```

## Add the first device

Use **Devices → Add device** in the dashboard. Set the read block size there;
nearby tags in the same Modbus register area are read together without exceeding
that limit. Then open that device's **Tags** action to add register addresses,
data types, byte order, scaling, and units.

Administrators can create the predefined **Categories** and **Groups** under
**Administration → System**. Assigning either value to a device is optional, so
existing or uncategorized devices continue to work normally. The Reports &
export page can filter its device scope by Category, Group, or both, then
download a CSV containing readings from the matching devices. A list value
cannot be deleted while a device is using it; clear or change those device
assignments first.

For PostgreSQL, open **Data connections → Historian** in the dashboard. Enter
the remote host, port, database, login, password, and TLS mode; test the
connection; then save and enable it. The values on that page are defaults for
new devices.
Configure each device's PostgreSQL save interval, automatic downsampling,
raw/downsample retention, cleanup frequency, and unique table names in its
add/edit form. Enter the database save interval as a numeric value in seconds
in the dashboard. For example, `1` second is sent to and stored by the API as
`saveIntervalMs: 1000`. The save interval must be equal to or longer than the
device polling interval. A one-second setting targets one raw row per aligned
one-second bucket when the device supplies a successful poll in that bucket.
Both tables have the same intentionally minimal wide shape:

```text
timestamp | power_kw | energy_kwh | ...
```

In SQL, `timestamp` is `TIMESTAMPTZ PRIMARY KEY` and each tag is
`NUMERIC(30, decimalPlaces)`. There are no device, quality, raw-value, or
aggregate metadata columns in either table. A downsample interval such as 15
minutes writes one row per bucket and keeps the last good value seen for each
tag during that bucket.

New tags default to a readable PostgreSQL column derived only from the tag
name: `KW` becomes `kw` and `Main Power` becomes `main_power`. No internal tag
ID is appended. The exact column can be edited from the Tags page. Existing
installations keep their current column names until an administrator explicitly
changes one; the next **Sync table columns** operation renames that column in
both historian tables so its saved values are retained.

Set each tag's **Database decimal places** from 0 through 10. After adding,
editing, or deleting tags, an administrator must select **Sync table columns**
on the Tags page. The safe sync adds new columns, renames explicitly edited
columns, and changes decimal scales, but reports removed tag columns without
dropping them. Dropping a reported column requires a second explicit
confirmation because it permanently erases that tag's remote history. Back up
or archive that history first. Reducing decimal places rounds existing values
when the column scale is changed.

Device edit provides a per-device remote-saving control. **Disconnect
database** first closes that device's write gate without deleting its
PostgreSQL configuration or cached samples. **Connect & verify tables** checks
both wide historian tables and every current tag column, recreates missing
tables or columns, and resumes saving only after the schema is fully valid.
**Verify & repair tables** performs the same check while saving is already
connected. If a table or tag column disappears during a live write, saving for
that device is stopped automatically, the schema is marked for repair, and the
failed sample is retained when the offline cache is enabled.

The Tags page can also download the selected device's tags as CSV, or download
an empty template when the device has no tags. Upload validates every row and
rejects duplicate names before insertion. Imports are limited to 1,500 tags and
2 MB per file. The complete import is committed in one transaction and polling
is reloaded once, so a rejected file never leaves a partial device map.

Large devices are automatically divided into protocol-safe reads of no more
than 125 registers. Failed blocks are split along tag boundaries so one
unsupported address does not hide valid neighboring tags. See the
[large-device guide](docs/LARGE_DEVICE_GUIDE.md) before commissioning a
1,000-tag device.

## Forward data and separate user access

Open **Data connections → Protocol servers** to publish selected devices without
creating another poll against field equipment. The Modbus TCP server keeps each
tag's original FC1/FC2/FC3/FC4 area and raw address and separates source devices
with virtual unit IDs. An outside gateway or application acts as the client and
initiates the connection to this listener; the logger does not connect outward
to it.
The OPC UA server publishes scaled, read-only engineering values with quality
and source timestamps below `Objects/Devices`.

Defaults are safe: Modbus TCP uses `127.0.0.1:1502`, OPC UA uses
`opc.tcp://127.0.0.1:4840/ModbusDataLogger`, and both are disabled. Docker
publishes those ports, but external access still requires deliberately changing
the listener bind address to `0.0.0.0` inside the container. Do that only on a
trusted OT/container network after adding firewall allowlists. For OPC UA, set
**Client hostname or IP** to the reachable Docker host name/address rather than
the wildcard bind address.

As an administrator, use **Administration → Users** to create separate accounts:

- **Monitoring only** can view operational data and exports.
- **Diagnostic** adds read-only protocol-server status plus the searchable
  **Diagnostics & logs** timeline and CSV export.
- **Operator** adds limited operational actions such as device creation and
  alarm acknowledgement.
- **Administrator** controls configuration, users, and destructive actions.

When OPC UA anonymous access is disabled, any enabled application user may open
a read-only OPC UA session with their username and password. Use those
credentials only over an approved secure OPC UA policy/channel with verified
certificate trust.

The collector encrypts the saved database password. Docker Compose includes a
PostgreSQL service and persistent volume.

Choose the database timestamp timezone under **Data connections → Historian**.
PostgreSQL columns remain `TIMESTAMPTZ`; the selection controls the historian
session's display timezone without changing the stored instant.

When the remote PostgreSQL server is unavailable, the optional offline cache
stores one durable local sample per device save interval, up to the configured
row limit. Older rows replay first after the connection recovers. Samples for
a device awaiting table-column synchronization remain queued but paused until
an administrator completes that synchronization. Queue depth, oldest sample,
last replay, and a manual replay action are shown under
**Data connections → Historian**.

Administrator tools under **Administration → System tools** provide an encrypted
configuration-only backup, restore with an exact confirmation phrase, and a
password-confirmed factory reset. A configuration restore replaces operational
configuration and clears local readings, alarm/system-alert events, WhatsApp
delivery jobs, and queued remote samples; users and passwords are preserved.
WhatsApp and data-server configuration are included in the encrypted backup,
but WhatsApp delivery and both data-server listeners are restored disabled
until an administrator tests and explicitly enables them. OPC UA PKI files and
activity history are not part of the configuration backup. Factory reset clears
local configuration/history, previous activity, data-server mappings, and
managed update/VPN files, preserves login accounts, and deliberately leaves
remote PostgreSQL tables untouched.

Software update and OpenVPN actions require separately installed, fixed-path
host helpers. The dashboard cannot execute arbitrary commands or enable SSH.
Update archives are staged with version, format, and SHA-256 integrity checks;
the privileged helper must independently verify a trusted publisher signature
and provide atomic install/rollback. OpenVPN accepts only a self-contained
client profile and starts or stops it through the restricted helper.

Modbus addresses in the API are zero-based offsets. For example, documentation
register `40001` normally maps to API address `0` with function code `3`.

## Quality checks

```bash
npm run typecheck
npm run lint
npm test
npm run build:all
```

## Production configuration

Copy `server/.env.example` to `server/.env` and set:

- `NODE_ENV=production`
- `AUTH_DISABLED=false`
- a random `JWT_SECRET` with at least 32 characters
- a separate random `SETTINGS_ENCRYPTION_KEY` with at least 32 characters
- a strong `INITIAL_ADMIN_PASSWORD`
- `LICENSE_ACTIVATION_DAYS=30` (or the intended informational
  first-install activation window)
- the exact dashboard origin in `CORS_ORIGIN`
- `TRUST_PROXY=false` unless port `4100` is unreachable directly and every
  request comes through the specifically trusted reverse proxy
- a durable `DATABASE_PATH`
- `POSTGRES_URL` only when using environment-managed PostgreSQL fallback

The collector refuses to start in production with development authentication
settings. Place TLS at a trusted reverse proxy and block direct access to port
`4100` before enabling `TRUST_PROXY`; otherwise forwarded source-address
headers can be forged and make rate limits or activity source IPs unreliable.
Restrict the API to the plant management network, keep the OPC UA PKI directory
private and persistent, and back up SQLite and PostgreSQL storage. Never expose
the Modbus listener to the public internet.

See:

- [Architecture](docs/ARCHITECTURE.md)
- [API and device setup](docs/API.md)
- [Modbus TCP and OPC UA data servers](docs/DATA_SERVERS.md)
- [Remote PostgreSQL setup](docs/POSTGRESQL.md)
- [TimescaleDB server setup](docs/TIMESCALEDB.md)
- [Deployment and security](docs/SECURITY.md)
- [Feature verification](docs/FEATURE_VERIFICATION.md)
- [V1.3 release notes](docs/RELEASE_NOTES_V1.3.md)
- [V1.2 release notes](docs/RELEASE_NOTES_V1.2.md)
- [V1.1 release notes](docs/RELEASE_NOTES_V1.1.md)

## Project structure

```text
app/                 Operator dashboard
server/src/modbus/   Modbus transport and register decoding
server/src/services/ Polling, authentication, alarms, and data publishing
server/src/db/       SQLite schema and repository
server/src/http/     Versioned REST API
server/test/         Collector tests
docs/                Operations and verification guides
.vscode/             Run, build, test, and debug tasks
```
