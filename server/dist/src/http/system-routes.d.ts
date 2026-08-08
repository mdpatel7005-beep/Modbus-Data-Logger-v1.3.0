import type { FastifyInstance } from "fastify";
import type { LoggerDatabase } from "../db/database.js";
import type { AuthService } from "../services/auth.js";
import type { DataServerManager } from "../services/data-servers.js";
import type { PollingService } from "../services/poller.js";
import type { PostgresHistorian } from "../services/postgres-historian.js";
import { type SystemAdministrationService } from "../services/system-admin.js";
import type { SystemAlertService } from "../services/system-alerts.js";
export declare function registerSystemRoutes(app: FastifyInstance, dependencies: {
    database: LoggerDatabase;
    auth: AuthService;
    poller: PollingService;
    postgresHistorian: PostgresHistorian;
    systemAdministration: SystemAdministrationService;
    systemAlerts: SystemAlertService;
    dataServers: DataServerManager;
}): Promise<void>;
