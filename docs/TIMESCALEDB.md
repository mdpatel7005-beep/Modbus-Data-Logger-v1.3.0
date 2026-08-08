# TimescaleDB server setup

TimescaleDB is optional. Standard PostgreSQL supports every logger feature.
TimescaleDB can partition a device's historian tables into time chunks and
apply server-managed retention. It can also create a continuous aggregate, but
the application's physical last-value downsample table is recommended when
tags change over time.

Follow the Timescale installation instructions for the PostgreSQL version and
operating system used by the database server:

- https://docs.timescale.com/self-hosted/latest/install/

Do not replace or upgrade a production database image in place. Back up the
database, test the same change on a separate server, and follow the provider's
compatibility and upgrade instructions.

## Exact logger schema

Every device has a separate raw and downsample table. Both physical tables
contain exactly:

```text
timestamp | power_kw | energy_kwh | ...
```

For example:

```sql
CREATE TABLE public.geb_raw (
    "timestamp" TIMESTAMPTZ PRIMARY KEY,
    power_kw NUMERIC(30, 2),
    energy_kwh NUMERIC(30, 3)
);

CREATE TABLE public.geb_15m (
    "timestamp" TIMESTAMPTZ PRIMARY KEY,
    power_kw NUMERIC(30, 2),
    energy_kwh NUMERIC(30, 3)
);
```

The physical tables have no device ID, quality, JSON, raw-value, count,
minimum, maximum, average, or other metadata columns. The table name identifies
the device. `decimalPlaces` is configured independently for each tag from 0
through 10 and becomes that column's `NUMERIC(30, decimalPlaces)` scale.

In the raw table, `timestamp` is the sample instant. In the downsample table,
`timestamp` is the bucket start. A 15-minute bucket has one row, and every tag
column contains that tag's last good saved value during the bucket. If a tag
has no good value in a bucket, its column remains `NULL`.

## Choose one lifecycle owner

Do not let the application and TimescaleDB manage the same operation on the
same table.

| Operation              | Application-owned                                                              | TimescaleDB-owned                                                                  |
| ---------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Downsampling           | Enable device downsampling; the collector writes the exact physical wide table | Disable device downsampling and create a separately named continuous aggregate     |
| Raw retention          | Set the device's raw retention                                                 | Set raw retention to **Keep forever** (`0`) and add one Timescale retention policy |
| Downsample retention   | Set the device's downsample retention                                          | Set downsample retention to **Keep forever** (`0`) and add one Timescale policy    |
| Column synchronization | Use **Sync table columns** for the physical raw/downsample pair                | Manage any separately named continuous aggregate manually after tag changes        |

The application-managed path is the default recommendation because it keeps
the downsample output as an ordinary table and lets **Sync table columns**
maintain both physical tables together.

## 1. Install and enable TimescaleDB

Install TimescaleDB using the official instructions or the managed database
provider's supported extension workflow. Apply any required preload settings
and restart PostgreSQL when the installation instructions require it.

Connect to the logger database as a database administrator:

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;

SELECT extname, extversion
FROM pg_extension
WHERE extname = 'timescaledb';
```

Only an administrator should install the extension. The logger application
should use the dedicated non-superuser role described in
[Remote PostgreSQL setup](POSTGRESQL.md).

## 2. Create and populate tables with the application

1. Configure and test the server under **Data connections → Historian**.
2. Configure unique raw and downsample table names on the device.
3. Add the device's tags and set each **Database decimal places** value.
4. Select **Sync table columns** as an administrator.
5. Confirm that raw writes and last-value downsample rows are correct.
6. Back up the tables before converting them to hypertables.

After later tag additions, edits, or deletions, run **Sync table columns**
again. The safe pass adds columns and changes decimal scales but reports
removed columns without dropping them. Dropping an orphaned column requires an
explicit confirmation and permanently erases that tag's remote history.
Reducing a tag's decimal places rounds existing history in both tables.

## 3. Convert both physical tables to hypertables

Stop collection or place the device in maintenance before converting a table
that already contains data. The `timestamp` primary key satisfies the
requirement that a unique index include the time-partitioning column.

Convert the raw table:

```sql
SELECT create_hypertable(
    'public.geb_raw',
    by_range('timestamp'),
    if_not_exists => TRUE,
    migrate_data => TRUE
);
```

Convert the application's physical downsample table:

```sql
SELECT create_hypertable(
    'public.geb_15m',
    by_range('timestamp'),
    if_not_exists => TRUE,
    migrate_data => TRUE
);
```

Replace the schema and table names with the names configured for the device.
Run the conversion separately for every device table pair. Validate afterward:

```sql
SELECT hypertable_schema, hypertable_name
FROM timescaledb_information.hypertables
WHERE hypertable_schema = 'public'
ORDER BY hypertable_name;

SELECT *
FROM public.geb_raw
ORDER BY "timestamp" DESC
LIMIT 10;

SELECT *
FROM public.geb_15m
ORDER BY "timestamp" DESC
LIMIT 10;
```

Official hypertable references:

- https://docs.timescale.com/api/latest/hypertable/create_hypertable/
- https://docs.timescale.com/use-timescale/latest/hypertables/hypertables-and-unique-indexes/

## 4. Recommended last-value downsampling

Leave downsampling enabled on the device and point it at the physical
downsample hypertable. For a 15-minute interval the collector:

1. determines the 15-minute bucket start;
2. creates or updates the one row for that bucket;
3. writes the last good value received for each tag;
4. leaves a tag `NULL` if the bucket has no good value for it.

This produces the exact required layout and supports the application's guarded
column-sync workflow.

Do not also create a continuous aggregate for that same configured output
table. Do not attach both application and Timescale retention to the same
physical table.

## 5. Optional wide continuous aggregate

Use this alternative only when TimescaleDB, rather than the application, must
own downsampling. Disable downsampling for the device and give the continuous
aggregate a different name from both application tables.

For a known, fixed tag list:

```sql
CREATE MATERIALIZED VIEW public.geb_15m_cagg
WITH (timescaledb.continuous) AS
SELECT
    time_bucket(INTERVAL '15 minutes', "timestamp") AS "timestamp",
    last(power_kw, "timestamp")
        FILTER (WHERE power_kw IS NOT NULL) AS power_kw,
    last(energy_kwh, "timestamp")
        FILTER (WHERE energy_kwh IS NOT NULL) AS energy_kwh
FROM public.geb_raw
GROUP BY time_bucket(INTERVAL '15 minutes', "timestamp")
WITH NO DATA;
```

Add a refresh policy appropriate to the expected late-data window:

```sql
SELECT add_continuous_aggregate_policy(
    'public.geb_15m_cagg',
    start_offset => INTERVAL '7 days',
    end_offset => INTERVAL '15 minutes',
    schedule_interval => INTERVAL '5 minutes'
);
```

This view has the same visible wide columns, but it is not the application's
physical downsample table and does not have a PostgreSQL primary-key
constraint. The application's **Sync table columns** action does not alter it.
When a tag is added, changed, or removed, an administrator must recreate the
continuous aggregate with the new explicit tag list and refresh it from raw
history. Ensure raw retention covers the rebuild window.

Because dynamic wide columns require that manual recreation, prefer the
application-managed physical downsample hypertable unless there is a specific
server-side requirement for continuous aggregates.

Official continuous-aggregate references:

- https://docs.timescale.com/use-timescale/latest/continuous-aggregates/create-a-continuous-aggregate/
- https://docs.timescale.com/use-timescale/latest/continuous-aggregates/refresh-policies/

## 6. Optional Timescale retention

Use these policies only after setting the matching application retention to
**Keep forever** (`0`). Example values are site choices, not defaults:

```sql
SELECT add_retention_policy(
    'public.geb_raw',
    drop_after => INTERVAL '90 days'
);

SELECT add_retention_policy(
    'public.geb_15m',
    drop_after => INTERVAL '730 days'
);
```

When using the optional continuous aggregate, attach its long-term policy to
the separately named aggregate instead of the unused physical downsample
table:

```sql
SELECT add_retention_policy(
    'public.geb_15m_cagg',
    drop_after => INTERVAL '730 days'
);
```

Retention permanently removes old chunks. It is not a backup. The continuous
aggregate refresh window and raw retention window must overlap sufficiently;
otherwise dropped raw chunks cannot be used to rebuild missing aggregate
buckets.

Official retention guidance:

- https://docs.timescale.com/use-timescale/latest/data-retention/create-a-retention-policy/
- https://docs.timescale.com/use-timescale/latest/continuous-aggregates/drop-data/

## 7. Timezone

Keep the physical column as `TIMESTAMPTZ`. PostgreSQL stores an absolute
instant; the timezone selected under **Data connections → Historian** controls
session display without changing that instant.

For an explicit local display:

```sql
SELECT
    "timestamp",
    "timestamp" AT TIME ZONE 'Asia/Kolkata' AS local_wall_time,
    power_kw,
    energy_kwh
FROM public.geb_raw
ORDER BY "timestamp" DESC
LIMIT 20;
```

Use UTC for interchange and an IANA timezone only for operator display or
calendar-based reporting.

PostgreSQL timezone reference:

- https://www.postgresql.org/docs/current/datatype-datetime.html

## 8. Security and network access

Use TLS, SCRAM authentication, and a firewall rule that permits port 5432 only
from the collector host. Do not expose PostgreSQL to the public internet.
Choose **Verify certificate** in the application for production and use a
certificate whose hostname matches the configured database hostname.

Use the dedicated logger role for collection. Do not grant it superuser,
extension-installation, role-management, or database-creation privileges.

Official PostgreSQL references:

- https://www.postgresql.org/docs/current/auth-pg-hba-conf.html
- https://www.postgresql.org/docs/current/auth-password.html
- https://www.postgresql.org/docs/current/ssl-tcp.html

## 9. Monitoring, backup, and restore

Inspect Timescale background jobs and failures:

```sql
SELECT
    job_id,
    application_name,
    schedule_interval,
    hypertable_schema,
    hypertable_name
FROM timescaledb_information.jobs
ORDER BY job_id;

SELECT *
FROM timescaledb_information.job_stats
ORDER BY job_id;
```

Monitor database reachability, write errors, row age, chunk count, policy
failures, storage growth, and backup success. Run a restore test on a separate
server before commissioning.

Back up both PostgreSQL and the collector's SQLite database. SQLite contains
the device/tag configuration, stable tag-column mapping, and encrypted
PostgreSQL password. Preserve the matching `SETTINGS_ENCRYPTION_KEY`.

For point-in-time recovery requirements, configure PostgreSQL WAL archiving:

- https://www.postgresql.org/docs/current/continuous-archiving.html

Before a TimescaleDB restore or upgrade, follow the official procedure for the
installed server and extension versions. Afterward, verify the extension,
hypertables, table schemas, retention/refresh jobs, row counts, and new writes
before resuming normal collection.
