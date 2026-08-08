# Modbus TCP and OPC UA data servers

V1.2 can republish the collector's latest cached values to other industrial
applications. These listeners do not poll field equipment. An outside client
reads the logger's local value image, so connecting more clients does not add
Modbus traffic to the source devices.

Both data servers are:

- read-only;
- disabled by default;
- bound to `127.0.0.1` by default;
- independently selectable per source device; and
- non-critical to collection: a listener error is reported without stopping
  polling, alarms, SQLite, or PostgreSQL logging.

Configure them under **Data connections → Protocol servers**. An administrator
can change and enable the services. A diagnostic user can inspect the
configuration and runtime status but cannot save changes.

## Choose the receiving protocol

| Requirement                               | Modbus TCP | OPC UA |
| ----------------------------------------- | ---------- | ------ |
| Original Modbus bits/register words       | Yes        | No     |
| Scaled engineering value                  | Decode it  | Yes    |
| Explicit logger quality                   | No         | Yes    |
| Source sample timestamp                   | No         | Yes    |
| Read-only publication                     | Yes        | Yes    |
| Multiple source devices on one listener   | Unit IDs   | Folders |
| Protocol authentication/encryption        | No         | Application user plus site PKI/OPC UA security |

Use Modbus TCP for a receiving application that expects the original register
map. Prefer OPC UA when the receiver must distinguish a real zero from a bad or
missing value, or when it requires a source timestamp.

## Modbus TCP server

Default listener: `127.0.0.1:1502`

Port `1502` is used instead of privileged port `502`. If a receiver requires
port `502`, prefer an approved firewall/NAT redirect. Do not run the collector
as root merely to bind a low port.

### Connection direction

The logger is the Modbus TCP **server/listener** on this port. The outside
gateway, SCADA system, or other receiving application must operate as the
Modbus TCP **client/master** and initiate the TCP connection to the logger.
After connecting, that client selects one of the configured virtual unit IDs
and issues FC1, FC2, FC3, or FC4 reads. The logger does not open an outbound
connection to that receiving gateway.

This publication listener is separate from device collection:

```text
Field device/server <── polls ── Logger client
                                  │
                                  └── cached values ──> Logger server <── reads ── Outside gateway/client
```

If an outside gateway is itself only a Modbus server/slave, it cannot connect
to this listener because both sides would wait for a client. Configure that
gateway as a normal Modbus TCP **Device** instead, so the logger polls it.

### Device and address mapping

Assign every published source device a unique **virtual unit ID** from 1 to
247. This unit ID identifies the source device on the V1.2 listener; it does not
have to match that device's field-side unit ID.

Every enabled tag keeps its zero-based source area and address:

| Logger function code | Published area     | Client read |
| -------------------- | ------------------ | ----------- |
| FC1                  | Coils              | FC1         |
| FC2                  | Discrete inputs    | FC2         |
| FC3                  | Holding registers  | FC3         |
| FC4                  | Input registers    | FC4         |

For example, an FC3 tag at logger address `100` is read from address `100` on
the device's virtual unit ID. A multi-register type occupies its original
consecutive words. Apply the tag's configured data type, byte order, scale, and
offset in the receiving client exactly as on the logger.

The publisher prefers the exact raw bits/words captured during the source poll.
If those words are unavailable but a good engineering value exists, it attempts
to reconstruct the source words from the data type, byte order, scale, and
offset. Reconstruction can be lossy for integer values; captured raw data is
the normal and preferred path.

### Quality limitation and writes

An unassigned virtual unit, an unmapped address gap, a tag without a reading, a
tag with `bad` quality, and every tag on an offline or disabled source device
all read as `0` or `false`. Standard Modbus register responses do not carry the
logger's quality or source timestamp, so a client cannot distinguish any of
those cases from a genuine process zero. Use OPC UA for quality-aware
integrations.

FC5, FC6, FC15, and FC16 writes are rejected with an illegal-function
exception. Publishing never provides a path to write through to field
equipment.

An integration where the outside gateway *pushes* values by writing FC5, FC6,
FC15, or FC16 is not enabled in V1.2. It requires a separate, explicitly
commissioned ingestion design rather than relaxing the publication server:

- a dedicated inbound device/tag namespace and an allowlist of writable
  coil/holding-register addresses;
- atomic validation of unit ID, address range, type, word order, and complete
  multi-register values before accepting a write;
- defined quality and timestamp rules, historian/save-interval behavior, and
  restart persistence for received values;
- protection against conflicts between polled values and externally written
  values;
- network allowlists or a secured gateway because Modbus TCP itself provides
  no authentication, identity, encryption, or replay protection; and
- rate limits, activity auditing, alarms, and integration tests for partial,
  duplicate, malformed, and concurrent writes.

Such writes should ingest values into a separate logger cache/historian path.
They must not write through to field equipment unless a later safety-reviewed
control feature explicitly defines and authorizes that behavior.

Overlapping enabled tags in the same function-code address space prevent the
listener from starting. Correct the tag map and check the runtime message under
**Data connections → Protocol servers**.

### Commissioning

1. Leave **Enable Modbus TCP server** off while assigning mappings.
2. Select only the required devices.
3. Give every selected device a unique virtual unit ID from 1 to 247.
4. Set the bind address and port.
5. Save and confirm the runtime state is `running`.
6. From an allowlisted client, read one coil and representative 16-, 32-, and
   64-bit values.
7. Compare the reconstructed engineering values against Live data.
8. Force a disposable tag read failure and confirm the receiver's handling of
   the documented zero limitation.
9. Attempt one harmless write and verify the server rejects it.

The refresh interval controls how often the published image is copied from the
logger's latest local readings. It accepts 100 through 60,000 milliseconds. It
does not change field polling or historian save intervals.

## OPC UA server

Default endpoint:

```text
opc.tcp://127.0.0.1:4840/ModbusDataLogger
```

V1.2 implements OPC UA over `opc.tcp`; it does not implement legacy
Windows/COM OPC DA.

The port and endpoint path are configurable. The path must begin with `/`.
Each selected device publishes all of its enabled tags below:

```text
Objects
└── Devices
    └── <device browse name>
        └── <tag browse name>
            ├── Quality
            └── SourceTimestamp
```

Tag node IDs are derived from the logger's stable internal device and tag IDs;
the displayed browse names are the configured device and tag names. Boolean
tags publish OPC UA Boolean values. Other supported tag types publish scaled
engineering values as Double values.

The tag is read-only and its `DataValue` carries the source timestamp and
status:

| Logger state      | Published value | OPC UA status                  |
| ----------------- | --------------- | ------------------------------ |
| `good`            | Current value   | `Good`                         |
| `stale`           | Last value      | `UncertainLastUsableValue`      |
| `bad`, unread, offline, or disabled | `0`/`false` | `BadNoCommunication` |

The `Quality` string and `SourceTimestamp` DateTime properties expose the same
metadata for clients that prefer explicit properties. The timestamp is the
source sample time, not the time at which the OPC UA client read the node. An
unread tag has no valid `DataValue` source timestamp and its explicit
`SourceTimestamp` property uses the Unix epoch as an invalid/no-sample
sentinel; check the status before using the timestamp.

**Bind address** controls the local socket. **Client hostname or IP**
(`advertisedHost` in the API) controls the hostname placed in the OPC UA
endpoint URL. Use the DNS name or IP address that clients actually use, without
`opc.tcp://`, a port, or a path. A wildcard such as `0.0.0.0` or `::` is valid
for binding but is not a connectable advertised host. When binding to all
interfaces, set a non-wildcard advertised host and ensure the commissioned
server certificate is valid for that name or address.

A selected device rename, or adding, removing, renaming, enabling, disabling,
or changing the type or engineering unit of one of its tags, automatically
rebuilds the isolated OPC UA address space. Existing sessions or subscriptions
may need to reconnect during that brief listener restart. Include this
reconnect behavior in receiving-application testing.

### Anonymous access, user credentials, and PKI

**Allow anonymous clients** controls anonymous OPC UA sessions. When it is off,
the client must present the username and password of any enabled Modbus Data
Logger application user. Administrator, operator, monitoring-only, and
diagnostic accounts all receive the same read-only OPC UA value access; their
dashboard role never grants an OPC UA write because every published node is
read-only.

Changing or administratively resetting a password invalidates that user's
existing web bearer tokens. Password change/reset and administrator user
update/delete operations restart the OPC UA listener, which closes all active
OPC UA sessions. Clients must reconnect and authenticate against the current
username, password, and enabled state. Plan for this brief interruption when
managing users on a production logger.

Never send application credentials over an OPC UA endpoint using an unsecured
channel or `SecurityPolicy#None`. Commission a trusted server certificate and
configure the client to use an approved `Sign` or `SignAndEncrypt` endpoint
before disabling anonymous access. The anonymous toggle does not select a
message-security policy, encrypt a channel, or trust an unknown certificate.
Application username/password validation and certificate trust are separate
security layers.

The server keeps its certificate, private key, rejected certificates, and trust
lists beneath:

```text
SYSTEM_ADMIN_DATA_DIR/opcua-pki
```

The directory is created automatically and must be private, persistent, and
outside every web-served path. Unknown certificates are not automatically
trusted. The exact generated trust-store subtree can vary with the OPC UA
library release, so use the `trusted` and `rejected` directories created below
this root rather than pre-creating a guessed layout.

For a certificate-based site:

1. Keep the listener on loopback or a staging VLAN.
2. Start the OPC UA server once so it creates its server certificate and PKI
   tree.
3. Record and independently verify the server-certificate fingerprint in the
   receiving client.
4. Make one client connection so an untrusted client certificate is placed in
   the generated rejected store.
5. Verify that client certificate's subject, issuer, validity, key usage, and
   fingerprint through an approved out-of-band procedure.
6. Move only the verified certificate into the generated trusted-certificate
   store, preserving restrictive ownership and permissions.
7. Restart or resave the OPC UA server and configure the client to use an
   approved `Sign` or `SignAndEncrypt` endpoint.
8. Create a dedicated enabled application user with only the monitoring role
   needed by the site, then prove a username/password OPC UA session on
   staging.
9. Disable anonymous access and verify the certificate chain, secure-channel
   policy, credential rejection, and read-only behavior.

Do not copy the PKI private key to a client. Back up the complete private
`SYSTEM_ADMIN_DATA_DIR` with the SQLite/WAL snapshot, and protect the backup as
a sensitive credential. Configuration backup files include data-server
settings but not the generated PKI directory.

## Docker and on-premises binding

Docker Compose publishes host ports `1502` and `4840`, but the application
defaults still bind both listeners to `127.0.0.1` inside the collector
container. This deliberately prevents remote access after a fresh install.
Compose publishes only those two container ports. If a site changes a
listener's configured port, it must also add the same explicit collector port
mapping in `docker-compose.yml`, update every firewall layer, and recreate the
container; otherwise the listener can run but remains unreachable from outside
the container.

To commission a container listener:

1. Place the collector on a trusted OT/container network.
2. Add host and upstream firewall allowlists for only the approved receiver
   addresses.
3. In **Data connections → Protocol servers**, change that listener's bind
   address to `0.0.0.0`.
   For OPC UA, also set **Client hostname or IP** to the Docker host DNS name or
   IP used by clients.
4. Select its devices, enable it, and save.
5. Confirm the runtime state and connect through the advertised Docker host
   address, not the container's loopback address.

`0.0.0.0` listens on every IPv4 interface in that network namespace. On a
native on-premises host, prefer the exact OT interface address when practical.
Never bind either service broadly on an internet-facing host. Modbus TCP has no
authentication or encryption and must not be exposed to the public internet.

Remote administration through OpenVPN does not replace protocol firewalling.
Allow only the required VPN/client subnet and continue to deny all other
sources.

## Backup, restore, and factory reset

Encrypted configuration backup includes bind addresses, ports, selected
devices, virtual unit IDs, OPC UA advertised host/endpoint settings, and the
anonymous-access choice. A restore preserves those settings and mappings but
forces both listeners **disabled**. Review the destination host's interfaces,
advertised name, port conflicts, firewall, and certificate trust before
re-enabling either service.

Factory reset removes device mappings and returns both services to disabled,
loopback-bound defaults. It also clears the web activity history while
preserving application login accounts.

## Diagnostics

The **Data connections → Protocol servers** page reports, for each listener:

- `disabled`, `starting`, `running`, `stopping`, or `error`;
- the last runtime message;
- start and last-refresh time;
- connected client count; and
- request count.

The **Diagnostics & logs** page records data-server configuration changes and
service state/error transitions. Administrator and diagnostic roles can filter
this timeline and export it as CSV.

When a listener does not start:

1. Confirm it is enabled and at least one device is selected.
2. Confirm every enabled Modbus mapping has a unique unit ID.
3. Check that no other process owns the configured port.
4. Check the bind address exists inside the host or container.
5. For OPC UA, ensure the advertised host is a reachable non-wildcard DNS name
   or IP without a URL scheme, port, or path.
6. For Modbus, check for overlapping tag addresses in the same function-code
   area.
7. For OPC UA, verify `SYSTEM_ADMIN_DATA_DIR` is writable and private, and
   review PKI trust.
8. Read the runtime message and matching system event in **Activity &
   diagnostics**.

## Acceptance checklist

- [ ] Services remain disabled and loopback-bound after a clean install.
- [ ] Only intended devices are selected for each protocol.
- [ ] Modbus virtual unit IDs are documented in the site register map.
- [ ] Representative raw words decode correctly in the receiving Modbus client.
- [ ] The receiver has a defined response to Modbus zero-on-bad behavior.
- [ ] OPC UA values, status codes, quality properties, and timestamps agree
      with Live data.
- [ ] OPC UA clients recover from an automatic topology rebuild.
- [ ] Anonymous access and every accepted certificate are approved.
- [ ] Host, container, VLAN, and upstream firewall allowlists are verified.
- [ ] Listener failure does not stop polling or local/remote historian writes.
- [ ] Restore leaves both listeners disabled until recommissioned.
