# WhatsApp and dashboard alerts

Modbus Data Logger V1.1 opens system-alert incidents for:

- an enabled Modbus device that remains offline beyond the configured
  confirmation delay;
- the enabled remote PostgreSQL server becoming unavailable.

Tag-value thresholds remain in the existing alarm engine and are not sent to
WhatsApp in this release.

## Alert lifecycle

An outage creates one active incident per source. Repeated failed polls update
that incident instead of creating duplicate dashboard rows or repeated
WhatsApp messages. An operator can acknowledge the incident, but
acknowledgement does not close it. The collector resolves it automatically
after the device or database recovers.

The confirmation delay filters short communication interruptions. An optional
recovery message tells recipients when service returns. Dashboard incidents
are stored locally, so they survive collector and host restarts. WhatsApp
delivery attempts are recorded separately from the incident and are retried
without blocking Modbus polling.

Disabled devices and an intentionally disabled remote PostgreSQL connection do
not create offline incidents.

## Meta prerequisites

Use the official WhatsApp Business Platform Cloud API. Before configuring the
logger, prepare:

1. a Meta business portfolio;
2. a WhatsApp Business Account and registered business phone number;
3. the business phone number ID;
4. a system-user access token with the
   `whatsapp_business_messaging` permission;
5. recipient consent to receive operational WhatsApp notifications;
6. an approved Utility message template.

Meta's official Cloud API collection documents the phone-number ID, bearer
token, permissions, and `/{Phone-Number-ID}/messages` endpoint:

- https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api

## Required template

Create an approved template such as `modbus_system_alert`. Its body must
contain five variables in this exact order:

```text
Modbus Data Logger: {{1}}
Type: {{2}}
Source: {{3}}
Detail: {{4}}
Time: {{5}}
```

The collector supplies:

1. state: `OFFLINE`, `RECOVERED`, or `TEST`;
2. alert type: `Device offline` or `Remote PostgreSQL offline`;
3. source: the device name or configured database server;
4. detail: the most recent safe error summary;
5. timestamp: the event time.

Template names use lowercase letters, numbers, and underscores. The selected
language must match the approved template exactly, for example `en_US`.

## Configure the logger

1. Sign in as an administrator.
2. Open **Alerts**.
3. Under **WhatsApp notifications**, enter the Graph API version, business
   phone number ID, access token, recipients, template name, and language.
4. Enter recipients in international format using digits only, for example
   `919876543210`.
5. Set an offline confirmation delay appropriate for the plant network.
6. Choose whether to send recovery messages.
7. Save, then select **Send test alert**.
8. Enable WhatsApp only after every intended recipient receives the approved
   template.

Leaving the token field blank during a later edit preserves the saved token.
The token is encrypted in local SQLite storage and is never returned by the
API. The Graph host is fixed to `graph.facebook.com`; only the validated API
version, phone-number ID, and message content are variable.

## Commissioning recommendations

- Start with a 30–60 second confirmation delay, then tune it using real
  network behavior.
- Send one opening message and one recovery message per incident; avoid
  frequent reminders that can hide new events.
- Use a dedicated operations recipient list, not personal numbers that have
  not opted in.
- Test device and PostgreSQL outages separately in a safe environment.
- Confirm dashboard acknowledgement, automatic recovery, WhatsApp delivery,
  and restart persistence before relying on the channel.
- Keep another independent monitoring path for host power loss. This
  application cannot send WhatsApp when the collector host itself is powered
  off or has no internet route.
