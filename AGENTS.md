# Modbus Data Logger - Agent Instructions

This document helps AI coding agents understand the codebase and be immediately productive.

## Quick Start

### Build & Run
```bash
# Install dependencies once
npm run dev          # Starts dashboard (port 3000) + collector (port 4100)

# VS Code tasks also available:
# - "Install all dependencies"
# - "Start Modbus Data Logger" (background task)
```

### Login Credentials (Development)
- Username: `admin`
- Password: `change-me-before-production`

---

## Architecture Overview

### Component Separation
| Component | Technology | Port | Purpose |
|-----------|------------|------|---------|
| **Dashboard** | Vinext/React | 3000 | Web UI for monitoring/configuration |
| **Collector** | Fastify | 4100 | Modbus polling, SQLite storage, API server |

**Critical**: The dashboard and collector are separate processes. Serial ports and plant-network Modbus traffic remain on the collector; the dashboard talks to it through the versioned API.

### Data Flow Pipeline
```
Modbus Polling → Decode → Scale → Store (SQLite) → 
  ├─ PostgreSQL sync (optional)
  ├─ Modbus TCP/OPC UA publication (optional)
  └─ Alarm evaluation → WhatsApp alerts (optional)
```

---

## Key Conventions

### 1. Environment Variables
All environment variables are in `server/src/config/env.ts` with Zod validation.

**Production requirements**:
- `AUTH_DISABLED` must be `false`
- `JWT_SECRET` must be ≥32 characters
- `SETTINGS_ENCRYPTION_KEY` must be set if encrypting database
- Missing any requirement causes startup failure

### 2. Authentication Pattern
Roles (hierarchy): `administrator > operator > viewer, diagnostic`

Tokens are versioned—changing a user's password invalidates all existing tokens for that user.

### 3. Database Structure
**SQLite (local)**: WAL mode with foreign keys
- `devices`, `registers`, `readings`
- `alarm_rules`, `alarm_events`
- `system_alerts`, `whatsapp_deliveries`
- `users`, `sessions`

**PostgreSQL (remote)**: Optional, one raw + downsample table per device

### 4. Modbus Register Grouping
The collector intelligently groups registers for efficient polling:
- Groups by function code (FC1, FC2, FC3, FC4)
- Respects protocol limits (2000 coils, 125 registers per read)
- Uses learned block splits from previous polls

---

## Common Tasks

### Add a New API Endpoint
1. Define Zod schema in `server/src/http/schemas.ts`
2. Add route handler in `server/src/http/routes.ts` or `server/src/http/system-routes.ts`
3. Implement database queries in `server/src/db/database.ts`
4. Test with `npm run test:collector`

### Modify a Device Feature
1. Update register definitions in the UI (creates entry in `registers` table)
2. Collector polls using `PollingService`
3. Changes trigger re-polling with new configuration

### Update the Dashboard
1. Vinext/React components in `app/`
2. API client utilities in `app/lib/api.ts`
3. Build with `npm run build`

---

## Potential Pitfalls

1. **PostgreSQL Column Sync**: Adding tags doesn't automatically alter remote tables—run "Sync table columns" via UI
2. **Environment Variables**: Missing production requirements cause startup failures (check `env.ts`)
3. **Serial Ports**: Modbus RTU requires OS driver for serial adapter
4. **Token Invalidation**: Password changes invalidate all existing tokens and restart OPC UA

---

## Testing Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start development servers |
| `npm run build:all` | Build both components |
| `npm test` | Run all tests |
| `npm run typecheck` | TypeScript check |

**Test structure**:
- Dashboard: `tests/rendered-html.test.mjs`
- Collector: `server/test/*.test.ts`

---

## Related Documentation

- [API.md](docs/API.md) - REST API reference
- [DATA_SERVERS.md](docs/DATA_SERVERS.md) - Modbus TCP/OPC UA data servers
- [POSTGRESQL.md](docs/POSTGRESQL.md) - Remote database synchronization
- [WHATSAPP_ALERTS.md](docs/WHATSAPP_ALERTS.md) - System alert notifications
- [SECURITY.md](docs/SECURITY.md) - Security considerations

---

**Last updated**: 2026-08-02 (V1.3.0)
