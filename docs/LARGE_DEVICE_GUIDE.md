# Large Modbus devices and 1,000+ tags

Modbus Data Logger V1.2 supports configuring, polling, importing, and displaying
up to 1,500 tags per device. This application limit is below PostgreSQL's hard
1,600-column table limit because the current historian uses one timestamp
column plus one physical column per tag.

The hard column count is not a production capacity guarantee. PostgreSQL row
size, numeric values, indexes, TimescaleDB operations, network latency, and
downsampling can establish a lower practical limit. Before enabling one wide
historian table for a 1,000+ tag device, run a representative write,
downsampling, retention, backup, and restore soak test. Split the map into
multiple logical devices/tables if that test cannot meet the required cycle
time and retention.

## How reads are performed

A Modbus request is never configured with a quantity of 1,000. Holding and
input register requests are limited to 125 registers and are split
automatically. Function codes are kept in separate blocks.

If a multi-tag block fails, the collector retries smaller tag-aligned blocks
within a bounded recovery budget. A valid tag therefore remains readable when
another address in the same original block is unsupported. Successful learned
splits are reused for later polling cycles and cleared when the device
configuration is reloaded.

Recommended starting values:

- dense register map: read block size 60–125;
- sparse map or strict TCP/serial gateway: read block size 16–64;
- response timeout: 500–2,000 ms on a local plant network;
- retries: 0 or 1 while commissioning a large map;
- polling interval: start at 2–5 seconds for 1,000 tags, then reduce it only
  after measuring the complete cycle time.

The next poll is scheduled after the current cycle finishes. A 500 ms
configured interval cannot produce 500 ms updates when the full set of Modbus
requests takes two seconds.

## Importing tags

The Tags page accepts one CSV containing up to 1,500 rows and 2 MB. The server
validates the complete file, inserts it in one transaction, marks the
PostgreSQL schema dirty once, and reloads polling once. Any invalid row rejects
the complete import; it never leaves a partially imported tag map.

After importing, use **Sync table columns** before reconnecting PostgreSQL
saving.

## Live Data

The selected-device endpoint returns every enabled configured tag, including a
tag that has not received its first reading. The dashboard displays those rows
as **Waiting** and pages the table in groups of 100. Refresh requests are
serialized so a slow response cannot be overwritten by an older request.

## Capacity planning

Local SQLite history still stores one reading per enabled tag per completed
poll. Estimate the daily row count as:

```text
enabled tags × 86,400 ÷ actual poll-cycle seconds
```

For example, 1,000 tags at one completed cycle per second produce 86.4 million
local rows per day. Use a realistic poll interval, short local retention, and
remote PostgreSQL/TimescaleDB retention and downsampling for large
installations.

For more than 1,500 tags, split the equipment into multiple logical devices and
tables. Splitting can also be appropriate below 1,500 when the remote
historian's capacity test requires it. A future normalized historian can remove
the physical wide-table column limit.

## A tag remains Bad after fallback

If other tags recover but one tag remains **Bad**, verify that tag against the
vendor register map:

1. zero-based versus one-based address;
2. function code 1, 2, 3, or 4;
3. data width and data type;
4. unit ID;
5. gateway timeout and whether another Modbus master is using the same serial
   gateway.

Changing the read block size cannot make an unsupported individual address
valid.
