# Feature verification

This matrix separates implemented application behavior from site-specific
commissioning work.

V1.3-specific navigation, account, customer, subscription-foundation, and
server-topology changes are described in the
[V1.3 release notes](RELEASE_NOTES_V1.3.md).

| Area                                | Status                  | Verification                                                                     |
| ----------------------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| Modbus TCP reads                    | Implemented             | Connect test device; verify FC1–FC4 reads                                        |
| Modbus RTU reads                    | Implemented             | Verify port, baud, parity, data/stop bits                                        |
| Read-only Modbus TCP server         | Implemented in V1.2     | Map two devices to unique virtual units; verify FC1–FC4 and rejected writes      |
| Modbus TCP connection direction     | Clarified in V1.3       | Connect from an outside client/gateway to logger; verify logger never dials it   |
| Modbus raw-word fidelity            | Implemented in V1.2     | Compare published words and byte order with the original successful poll         |
| Modbus bad-quality limitation       | Implemented in V1.2     | Force a bad read; verify zero and the receiving application's handling           |
| Read-only OPC UA server             | Implemented in V1.2     | Browse selected devices; verify values cannot be written                         |
| OPC UA quality and timestamp        | Implemented in V1.2     | Force good/stale/bad values and compare status plus source time                  |
| OPC UA topology rebuild             | Implemented in V1.2     | Add/rename/remove a tag and verify the client reconnect procedure                |
| Safe data-server defaults           | Implemented in V1.2     | Fresh install and restore remain disabled and loopback-bound                     |
| Register decoding                   | Implemented             | Automated tests cover integers, floats, word order                               |
| Scaling and offset                  | Implemented             | Compare an engineering value with device display                                 |
| Per-device retry/timeout            | Implemented             | Disconnect device; confirm offline status                                        |
| Per-device read block size          | Implemented             | Confirm adjacent tags are grouped within configured span                         |
| Protocol-safe large-device reads    | Implemented             | Import 1,000+ mixed tags; verify every block remains within its protocol limit    |
| Failed-block tag isolation          | Implemented             | Make one address fail; verify valid neighbors continue updating on later cycles  |
| Per-device PostgreSQL save interval | Implemented             | Enter 1 second; verify API stores 1000 ms and one row per aligned bucket         |
| Save/poll interval validation       | Implemented             | Try save interval below poll interval; expect validation failure                 |
| Device Categories and Groups        | Implemented             | Create both lists in Administration/System and optionally assign them to devices |
| Classification deletion guard       | Implemented             | Attempt to delete an assigned value; expect HTTP 409                             |
| Classification report filters       | Implemented             | Filter and export; verify CSV contains only matching device readings             |
| Non-overlapping polling             | Implemented             | Review stable sample interval under slow response                                |
| SQLite historian                    | Implemented             | Restart service; confirm readings persist                                        |
| PostgreSQL wide raw historian       | Implemented             | Verify only `timestamp` plus one numeric column per device tag                   |
| Per-device PostgreSQL downsampling  | Implemented             | For a 15-minute bucket, verify one row with each tag's last good value           |
| Per-tag database decimal places     | Implemented             | Test scales 0 and 10; verify storage and existing-history rounding               |
| Editable historian columns          | Implemented             | Add `Main Power`; expect `main_power`, edit it, sync, and verify history remains |
| Guarded historian column sync       | Implemented             | Add/change safely; verify removed columns require confirmation                   |
| Historian settings                  | Implemented             | Test, save, restart, and confirm redacted settings persist                       |
| Per-device database pause/reconnect | Implemented             | Disconnect one device; verify its writes stop and configuration remains          |
| Deleted-table recovery              | Implemented             | Drop a disposable table; connect, verify recreation, and confirm writes resume   |
| PostgreSQL offline cache            | Implemented             | Stop remote DB; verify bounded local queue and ordered replay on recovery        |
| Per-device PostgreSQL retention     | Implemented             | Run cleanup using different disposable boundaries on two devices                 |
| Database timestamp timezone         | Implemented             | Select an IANA zone and verify the PostgreSQL session display                    |
| Data quality                        | Implemented             | Force a register error; confirm `bad` quality                                    |
| Retention cleanup                   | Implemented             | Test with a short retention value on disposable data                             |
| Device-selected live dashboard      | Implemented             | Select each device and verify all its tags refresh                               |
| Configuration-driven Overview       | Implemented in V1.2     | Add/disable/remove devices and confirm totals, rows, and trend use real data      |
| Complete large-device Live Data     | Implemented             | Verify 1,205 tags are returned, Waiting tags remain visible, and paging shows all |
| Contextual device Tags              | Consolidated in V1.3    | Open Tags from two devices and verify each opens with the correct device selected |
| Device edit/delete                  | Implemented             | Edit a device, verify reload, then confirm guarded deletion                      |
| Tag add/edit/delete                 | Implemented             | Rename a tag, sync, verify its column stays stable, then delete it               |
| Atomic tag CSV import/export        | Implemented             | Import 1,000+ rows; reject one bad row and verify no partial rows were inserted   |
| TimescaleDB setup guide             | Implemented             | Convert disposable device tables and inspect policy jobs                         |
| Historical query                    | Implemented             | Filter by register and ISO date range                                            |
| CSV export                          | Implemented             | Download and open a bounded export                                               |
| Threshold alarms                    | Implemented             | Create above/below/outside rule and cross threshold                              |
| Deadband clearing                   | Implemented             | Return inside deadband; confirm alarm clears                                     |
| Alarm acknowledgement               | Implemented             | Acknowledge as operator; verify audit record                                     |
| Device-offline system alerts        | Implemented in V1.1     | Exceed delay; verify one incident, acknowledgement, and automatic recovery       |
| PostgreSQL-offline system alerts    | Implemented in V1.1     | Stop enabled remote server; verify one incident and recovery                     |
| WhatsApp template notifications     | Implemented in V1.1     | Test approved template, outage/recovery, retry, redaction, and recipient dedupe  |
| Login and sign out                  | Consolidated in V1.3    | Sign out from the top-bar user menu and confirm the login screen appears         |
| Self password change                | Consolidated in V1.3    | Change from user menu; verify old web token fails and OPC UA sessions close      |
| Simple passwords                    | Implemented             | Change to `1`, sign out, and sign in successfully                                |
| Managed application users           | Implemented in V1.2     | Create, rename, disable, reset, and delete; verify OPC UA reconnect is required  |
| Monitoring-only role                | Implemented in V1.2     | Verify process reads/exports and reject every configuration write                |
| Diagnostic role                     | Implemented in V1.2     | Verify activity/data-server status reads and reject configuration writes         |
| Last-administrator guard            | Implemented in V1.2     | Try self-delete and removal of the last enabled admin; expect HTTP 409           |
| OPC UA application-user login       | Implemented in V1.2     | Disable anonymous access; authenticate an enabled user over a secure channel     |
| Web activity timeline               | Implemented in V1.2     | Export; verify 1,000-row headers, formula safety, and five/minute rate limit      |
| Activity detail redaction           | Implemented in V1.2     | Record test detail keys for password/token/private key and verify redaction      |
| Activity bounded retention          | Implemented in V1.2     | Exceed the disposable limit and verify only the newest 50,000 entries remain     |
| Consolidated navigation             | Implemented in V1.3     | Verify each configuration appears in one primary workspace with role-safe tabs   |
| Customer and site profile           | Implemented in V1.3     | Save eight profile fields, restart, and verify authorized read/edit boundaries   |
| Stable installation identity        | Implemented in V1.3     | Back up, restore, and factory-reset; verify destination installation ID persists |
| Informational activation countdown  | Implemented in V1.3     | Advance past due date; verify status changes but collection remains operational  |
| Subscription mutation boundary      | Foundation only in V1.3 | Verify no public HTTP route can alter plan, dates, status, or installation ID     |
| Encrypted configuration backup      | Implemented             | Download, restore with same key, and reject a changed-key/tampered file          |
| Guarded factory reset               | Implemented             | Verify password/phrase gates, local deletion, account and remote DB preservation |
| Update package staging              | Helper required         | Reject old/invalid archives; verify publisher signature in host helper           |
| OpenVPN client control              | Helper required         | Reject unsafe/non-client profiles; verify connect/disconnect helper              |
| Role authorization                  | Implemented             | Confirm viewer and diagnostic cannot change configuration                        |
| Audit logging                       | Implemented             | Create/delete configuration and inspect audit table                              |
| Responsive UI                       | Implemented             | Verify desktop, tablet, and phone layouts                                        |
| API validation                      | Implemented             | Submit invalid unit ID/address; expect HTTP 400                                  |
| Trusted-proxy source IP             | Implemented in V1.2     | Keep false for direct API; enable only behind a blocked, trusted proxy path       |
| Rate limiting                       | Implemented             | Exceed 300 requests/minute from one address                                      |
| Security headers/CORS               | Implemented             | Verify unapproved browser origin is rejected                                     |
| Graceful shutdown                   | Implemented             | Stop service; confirm WAL closes cleanly                                         |
| Docker packaging                    | Implemented             | Build images; verify health plus deliberate 1502/4840 binding                    |
| Device register maps                | Commissioning required  | Enter vendor-specific addresses and types                                        |
| Alarm limits                        | Commissioning required  | Approve limits with the process owner                                            |
| Sampling capacity                   | Site test required      | Soak-test real tag count and poll rates                                          |
| Backup/restore                      | Site procedure required | Perform and document a full restore drill                                        |
| TLS certificate                     | Infrastructure required | Configure at reverse proxy                                                       |
| Tag-value WhatsApp alerts           | Planned after V1.1      | Reuse threshold alarms after notification policy is approved                     |
| Cloud historian                     | Not included in V1.3    | Define destination and store-and-forward rules                                   |

## Minimum acceptance test

1. Run a 24-hour soak test against every target device.
2. Remove network/serial connectivity and verify recovery without restart.
3. Compare representative values against a calibrated display or vendor tool.
4. Cross every alarm threshold in a safe test environment.
5. Export a full shift and reconcile sample counts.
6. Restart the host during collection and verify database integrity.
7. Fill the test disk to the operational alert threshold and verify monitoring.
8. Restore a backup to a separate machine and run the dashboard from it.
9. On disposable PostgreSQL tables, add a tag and sync; then delete the tag,
   verify the safe sync reports an orphan, and confirm the destructive drop.
10. Create two Categories and two Groups, assign only some devices, and verify
    the report filters include matching devices while unassigned devices remain
    available through the unfiltered view.
11. Stop the remote PostgreSQL service for several device save intervals,
    confirm the local queue grows within its cap, restart PostgreSQL, and verify
    the original timestamps replay oldest first without duplicate rows.
12. Download a tag CSV, add several valid rows including a quoted unit, upload
    it, and confirm a duplicate-name or malformed file is rejected before any
    new tag is created.
13. Restore an encrypted configuration backup on a disposable logger using the
    same encryption key. Confirm users remain, local process history is cleared,
    remote PostgreSQL history remains, restored devices require table sync, and
    the OpenVPN client and both data servers remain disabled.
14. On a staging host with restricted helpers, exercise update validation,
    publisher-signature rejection, rollback, OpenVPN connect/disconnect, and
    factory reset while the tunnel is active.
15. Configure an approved WhatsApp template on staging. Interrupt one device
    longer than the confirmation delay, verify exactly one opening message,
    acknowledge it, restore communication, and verify one recovery message.
16. Stop the enabled remote PostgreSQL server, confirm the dashboard and
    WhatsApp show one database incident while local caching continues, restart
    it, and verify recovery plus ordered replay.
17. On a disposable device, import at least 1,001 mixed and sparse tags. Verify
    the Live Data total and every page, confirm no Modbus request exceeds its
    protocol limit, then make one address unresponsive and verify its valid
    neighboring tags continue to update.
18. Add, disable, and remove disposable devices while watching Overview. Verify
    totals, health rows, active tags, sample buckets, and empty states use only
    collector data.
19. Create monitoring-only and diagnostic users. Attempt representative reads,
    device/tag writes, data-server writes, user administration, activity reads,
    and destructive system actions for each role.
20. Map two source devices to different Modbus virtual unit IDs. Verify FC1,
    FC2, FC3, and FC4 addresses, raw-word/byte-order decoding, and rejection of
    FC5/FC6/FC15/FC16.
21. Force a published Modbus tag to bad quality. Confirm it returns zero, then
    verify the receiving application's approved stale/bad-value strategy.
22. Connect an OPC UA client on loopback and compare engineering values,
    `Good`/`UncertainLastUsableValue`/`BadNoCommunication`, `Quality`, and
    `SourceTimestamp` against Live data.
23. Add, rename, disable, and delete a selected OPC UA tag. Confirm the address
    space rebuilds and the receiving client reconnects without operator
    intervention or lost alarm visibility.
24. On staging, verify the OPC UA server certificate, trust an approved client,
    select a secure channel, disable anonymous access, and authenticate a
    dedicated monitoring-only application user. Disable that user and verify a
    new session is rejected.
25. Bind Docker listeners to `0.0.0.0` only after applying source-address
    firewall allowlists, and set OPC UA's advertised host to the reachable host
    name/IP. Verify approved clients can connect to ports `1502` and `4840` and
    all other sources are denied.
26. Create configuration, device-status, system-alert, and data-server events.
    Filter them in **Diagnostics & logs**, export CSV, and verify secret-like
    detail keys are redacted.
