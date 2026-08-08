# Remote PostgreSQL setup

The collector writes device snapshots to a remote PostgreSQL server at each
device's configured save interval and maintains last-value time buckets.
Connection credentials are saved in the local SQLite configuration database
with AES-256-GCM encryption. The encryption key comes from
`SETTINGS_ENCRYPTION_KEY`.

Standard PostgreSQL is sufficient. For hypertables, columnstore, native
retention policies, continuous aggregates, and background-job monitoring, use
the optional [TimescaleDB server setup](TIMESCALEDB.md). Choose either the
application or TimescaleDB as the owner of each retention/downsampling task;
do not schedule both against the same device table.

## 1. Create a dedicated database and login

Run these commands as a PostgreSQL administrator. Replace the names and
password before use.

```sql
CREATE ROLE logger LOGIN PASSWORD 'replace-with-a-unique-password';
CREATE DATABASE modbus_logger OWNER logger;
```

Connect to `modbus_logger`, then grant only the schema permissions required for
the collector to create and maintain its historian tables:

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO logger;
GRANT CONNECT ON DATABASE modbus_logger TO logger;
```

Do not use the PostgreSQL superuser account in the logger.

## 2. Restrict network access

In `postgresql.conf`, listen only on the database server's management address
instead of every network interface:

```conf
listen_addresses = '10.20.30.15'
port = 5432
password_encryption = 'scram-sha-256'
```

Enable TLS and point PostgreSQL to the server certificate and private key:

```conf
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
```

In `pg_hba.conf`, allow only the collector computer. Replace the address,
database, and login:

```conf
# TYPE     DATABASE       USER      ADDRESS          METHOD
hostssl    modbus_logger  logger    10.20.30.25/32   scram-sha-256
```

Reload PostgreSQL after editing its configuration:

```sql
SELECT pg_reload_conf();
```

At the operating-system or network firewall, allow TCP port 5432 only from the
collector IP. Do not expose PostgreSQL directly to the public internet.

PostgreSQL documents that remote access also requires a suitable
`listen_addresses` value, `hostssl` matches only encrypted TCP connections, and
`scram-sha-256` is the strongest built-in password method:

- https://www.postgresql.org/docs/17/auth-pg-hba-conf.html
- https://www.postgresql.org/docs/17/auth-password.html
- https://www.postgresql.org/docs/17/ssl-tcp.html

## 3. Configure the logger

1. Sign in as an administrator.
2. Open **Data connections → Historian**.
3. Enter the server hostname, port, database, login, and password.
4. Choose **Verify certificate** for production. If an internal certificate
   authority is used, add its certificate to the collector host's trust store
   or provide it to Node.js with `NODE_EXTRA_CA_CERTS`.
5. Select **Test connection**. The test verifies the connection plus database
   `CONNECT` and schema `USAGE`/`CREATE` privileges.
6. Select **Save & apply**, then enable PostgreSQL on each required device.
7. Open each device's add/edit form and enter its database save interval as a
   numeric value in seconds, then choose its unique table pair, downsampling
   interval, retention periods, and cleanup frequency.
8. In the same **Historian** section, choose the IANA timezone used by
   PostgreSQL historian sessions. The time columns remain `TIMESTAMPTZ`
   absolute instants.

An existing `POSTGRES_URL` remains a supported environment fallback. Once
settings are saved from the page, the saved configuration takes precedence.

## 4. Exact table layout

Each device has its own raw and downsample table. Both contain only:

```text
timestamp | voltage | energy_kwh | ...
```

The equivalent SQL is:

```sql
CREATE TABLE public.device_raw (
    "timestamp" TIMESTAMPTZ PRIMARY KEY,
    voltage NUMERIC(30, 2),
    energy_kwh NUMERIC(30, 3)
);

CREATE TABLE public.device_15m (
    "timestamp" TIMESTAMPTZ PRIMARY KEY,
    voltage NUMERIC(30, 2),
    energy_kwh NUMERIC(30, 3)
);
```

`timestamp` and the tag columns are the complete schema. The tables do not
contain a device ID, quality, raw values, JSON, sample count, minimum, maximum,
average, first value, or other metadata. A table name identifies its device.
Each tag column is `NUMERIC(30, decimalPlaces)`, where `decimalPlaces` is
configured per tag from 0 through 10.

New tags default to a normalized tag-only name: `KW` becomes `kw` and
`Line Voltage` becomes `line_voltage`. Automatic collisions use `_2`, `_3`,
and so on rather than an internal ID. The `timestamp` name is reserved.
Current and pending column names must be unique within each device.

The raw table receives at most one row per aligned device save bucket. The
dashboard accepts the save interval in seconds and converts it to
`saveIntervalMs` for the API and stored device configuration: entering `1`
second sends `1000` milliseconds. The server requires `saveIntervalMs` to be
equal to or greater than `pollIntervalMs`, so each healthy save bucket has a
polling opportunity; a timeout or offline device can still leave a bucket
empty. Bad-quality values are not written as good tag values. Configure a
separate raw table and downsample table name for every device.

## 5. Synchronize columns after tag changes

Adding, editing, deleting, or changing the PostgreSQL column of a tag does not
silently remove remote history. After any tag change:

1. Sign in as an administrator and open **Tags**.
2. Select the device.
3. Select **Sync table columns**.
4. Review the additions, decimal-scale changes, and removed-tag columns.
5. Apply the safe sync. It adds missing columns and changes requested numeric
   scales, but does not drop orphaned columns.
6. If removed columns are reported, back up or archive their history.
7. Select the destructive confirmation only when that history may be erased.

The equivalent API safe pass is:

```http
POST /api/v1/devices/DEVICE_ID/historian-schema/sync
Content-Type: application/json

{"dropRemoved":false}
```

Use a destructive payload only after reviewing the returned
`orphanedColumns`, and echo that exact list from the safe pass:

```json
{
  "dropRemoved": true,
  "expectedOrphanedColumns": ["device_raw.old_tag", "device_15m.old_tag"]
}
```

The collector rejects the destructive request if the list changed before
confirmation. A dropped column permanently erases that tag's raw and
downsample history. Re-adding a tag later cannot recover it.

A requested column-name change is not processed as a removal. The collector
stores the previous name and, during the safe pass, uses transactional
`ALTER TABLE ... RENAME COLUMN` on both raw and downsample tables. If both
names already exist remotely, synchronization stops rather than merging
values automatically.

Changing `decimalPlaces` alters the corresponding column in both tables to
`NUMERIC(30, newScale)`. Reducing the scale rounds existing history. Increasing
it reduces the number of integer digits available within precision 30, so
review unusually large values and take a backup before synchronization.

## 6. Automatic downsampling

Automatic downsampling is enabled and sized separately for every device. Each
bucket contains the last good saved value for every tag seen during that
bucket. The bucket start is stored in the `timestamp` primary-key column. A tag
with no good value during the bucket is `NULL`. For example, a 15-minute
interval creates at most one row for 10:00–10:14:59, and each tag column
contains that tag's last good value from that interval.

Available intervals include 10 seconds, 1 minute, 5 minutes, 15 minutes, 1
hour, and 1 day. Values under **Data connections → Historian** are defaults
copied to new devices; editing those defaults does not silently change existing
devices.

The exact column name is shown and can be edited on the Tags page. A new tag
defaults to a lowercase, underscore-separated name derived only from its tag
name, without an internal ID suffix. Editing only the tag label preserves the
current column. Editing the PostgreSQL column and then synchronizing issues a
transactional rename in both tables, preserving the column's history. A
duplicate raw timestamp is not inserted twice.

### Device disconnect and table recovery

Use the device editor's **Disconnect database** action before planned database
maintenance. It pauses new remote rows for only that device and preserves its
historian settings and offline queue. After maintenance, select **Connect &
verify tables**. The collector checks the configured raw and downsample table
names against the device's current tags, creates either table when it is
missing, adds missing columns, and starts saving only when the complete schema
check succeeds.

If a table or tag column is deleted unexpectedly, the first affected write
automatically disconnects that device and marks its schema for repair. With
the offline cache enabled, the failed sample remains queued. Repair with
**Connect & verify tables**; queued rows then replay oldest first before new
rows. Existing unexpected columns are not deleted automatically. Review them
from **Tags → Sync table columns**, confirm any intentional removal, and then
reconnect the device.

## 7. Automatic retention

Each device add/edit form has three retention controls:

- **Raw retention days** deletes rows older than the raw limit.
- **Downsample retention days** deletes summary rows older than the summary
  limit.
- **Cleanup frequency** controls how often the collector checks retention.

Use `0` to retain a table indefinitely. Every device tracks its own cleanup due
time. Cleanup also runs once when the collector starts and can be started
manually with **Run cleanup now**. Missing tables are safely skipped. The
status card shows the last run and deletion counts.

Retention compares each table's `timestamp` with its configured age. Retention
is deletion, not backup. PostgreSQL still needs autovacuum so space
from deleted rows can be reused. Leave autovacuum enabled and monitor table
growth, disk space, dead tuples, connection usage, and backup success:

- https://www.postgresql.org/docs/17/routine-vacuuming.html

## 8. Offline remote-database cache

Enable **Offline cache** under **Data connections → Historian** when the
collector must continue accepting process samples during a remote database
outage. The queue is stored durably in the local SQLite database and keeps at
most one device
snapshot per configured database save bucket.

Set **Maximum queued rows** from the expected outage duration and available
local disk. When the limit is reached, the oldest queued snapshots are removed
first and the collector writes a warning to its log. Monitor the queue count
and oldest sample shown on the page; a full local disk can still prevent new
samples from being cached.

The collector queues samples only for remote-availability failures such as a
refused connection, timeout, DNS failure, or server shutdown. SQL permission,
schema, and data errors are reported instead of being hidden in the queue.
When connectivity returns, eligible rows replay oldest first in bounded
batches. Remote writes use the device timestamp primary key, so retrying an
already accepted row updates that timestamp rather than creating a duplicate.

A device whose PostgreSQL columns require synchronization continues caching
current samples, but its replay remains paused. Open **Tags**, select the
device, and run **Sync table columns** before replaying it. Disabled devices
also remain paused. Use **Replay queued data now** after correcting a problem
or wait for the next successful historian write to trigger catch-up.

Collector-created PostgreSQL sessions use bounded connection, statement,
client-query, advisory-lock, and idle-transaction waits. This prevents a
blocked remote server from holding configuration restore or factory reset
indefinitely. If active historian work cannot drain within the administration
window, the requested administration action is rejected without changing
configuration and collection resumes.

The queue protects a limited communications outage; it is not a process
historian backup. Configuration restore and factory reset deliberately clear
queued rows. Back up SQLite consistently and size the queue with spare disk
capacity and an operational alert well below the configured maximum.

## 9. Backup and recovery

Use scheduled logical or physical backups appropriate to the site. For systems
that cannot lose a full backup interval, configure WAL archiving and
point-in-time recovery. Regularly restore a backup to another server and verify
that raw and downsample tables are readable:

- https://www.postgresql.org/docs/17/continuous-archiving.html

Back up the collector's SQLite database as well because it contains device,
tag, alarm, and encrypted PostgreSQL configuration records. Preserve the
matching `SETTINGS_ENCRYPTION_KEY`; a different key cannot decrypt the saved
database password.
