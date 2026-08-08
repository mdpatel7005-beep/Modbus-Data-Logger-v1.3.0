import type { FastifyInstance } from "fastify";
import type { LoggerDatabase } from "../db/database.js";
import type { AuthService } from "../services/auth.js";
import type { DataServerManager } from "../services/data-servers.js";
import type { PollingService } from "../services/poller.js";
import type { SystemAlertService } from "../services/system-alerts.js";
import { type PostgresHistorian } from "../services/postgres-historian.js";
export declare function registerRoutes(app: FastifyInstance, dependencies: {
    database: LoggerDatabase;
    auth: AuthService;
    poller: PollingService;
    postgresHistorian: PostgresHistorian;
    systemAlerts: SystemAlertService;
    dataServers: DataServerManager;
}): Promise<void>;
