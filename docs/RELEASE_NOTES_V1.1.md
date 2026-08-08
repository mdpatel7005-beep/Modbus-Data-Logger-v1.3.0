# Modbus Data Logger V1.1 release notes

## New

- System-alert incidents for enabled Modbus devices that go offline.
- System-alert incidents for an enabled remote PostgreSQL server that becomes
  unavailable.
- A dashboard Alerts view with live incident state, acknowledgement, recovery,
  and delivery status.
- Optional Meta WhatsApp Cloud API notifications using an approved template.
- Administrator controls for recipients, confirmation delay, recovery
  messages, Graph API version, template, phone-number ID, and encrypted access
  token.
- A test-notification workflow before WhatsApp is enabled.
- Durable WhatsApp delivery records with retry that does not block Modbus
  polling.

## Alert behavior

- One incident is created per source and outage.
- Repeated failures update the same incident.
- Acknowledgement records operator action but does not hide an unresolved
  outage.
- Recovery resolves the incident automatically and can send one recovery
  message.
- Disabled devices and intentionally disabled PostgreSQL do not create alerts.
- Tag-value WhatsApp alerts are reserved for a later release.

## Upgrade notes

The collector migrates the local SQLite schema at startup. Keep the application
folder, SQLite database including its WAL/SHM files, system-administration
directory, and `SETTINGS_ENCRYPTION_KEY` together when upgrading. Take and
verify a backup before installing V1.1.

After upgrading:

1. Confirm `/api/v1/health` reports `1.1.0`.
2. Open **Alerts** and configure the Meta-approved template.
3. Send a test notification.
4. Simulate one disposable device outage and one PostgreSQL outage.
5. Verify one opening incident, acknowledgement, automatic recovery, and no
   duplicate messages.
