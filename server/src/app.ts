import path from "node:path";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { ZodError } from "zod";
import { env } from "./config/env.js";
import {
  DeviceRegisterLimitError,
  HistorianColumnNameConflictError,
  LoggerDatabase,
  RegisterNameConflictError,
  UserAdministrationError,
} from "./db/database.js";
import { registerRoutes } from "./http/routes.js";
import { registerSystemRoutes } from "./http/system-routes.js";
import { AuthService } from "./services/auth.js";
import { DataServerManager } from "./services/data-servers.js";
import { PollingService } from "./services/poller.js";
import {
  HistorianAdministrationPausedError,
  PostgresHistorian,
} from "./services/postgres-historian.js";
import { SystemAdministrationService } from "./services/system-admin.js";
import {
  SystemAlertService,
  WhatsAppAlertConfigurationError,
} from "./services/system-alerts.js";

export async function buildApplication() {
  const app = Fastify({
    logger:
      env.nodeEnv === "development"
        ? {
            level: env.logLevel,
            transport: {
              target: "pino-pretty",
              options: { colorize: true, translateTime: "SYS:standard" },
            },
          }
        : { level: env.logLevel },
    bodyLimit: 1024 * 1024,
    trustProxy: env.trustProxy,
    requestIdHeader: "x-request-id",
  });

  const database = new LoggerDatabase(env.databasePath);
  const auth = new AuthService(database);
  await auth.ensureInitialAdministrator();
  const systemAlerts = new SystemAlertService(database, app.log);
  const postgresHistorian = new PostgresHistorian(
    database,
    app.log,
    undefined,
    systemAlerts,
  );
  const poller = new PollingService(database, app.log, postgresHistorian);
  poller.setSystemAlertService(systemAlerts);
  const dataServers = new DataServerManager(
    database,
    app.log,
    path.join(env.systemAdminDataDir, "opcua-pki"),
    {
      validateCredentials: (username, password) =>
        auth.validateReadOnlyCredentials(username, password),
    },
  );
  const systemAdministration = new SystemAdministrationService(database);
  let retentionTimer: NodeJS.Timeout | null = null;
  let postgresMonitorTimer: NodeJS.Timeout | null = null;

  app.decorateRequest("principal", null);

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });
  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || env.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed"), false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.ip,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "validation_error",
        message: "Request validation failed",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    if (error instanceof HistorianColumnNameConflictError) {
      return reply.code(409).send({
        error: "historian_column_conflict",
        message: error.message,
      });
    }

    if (error instanceof DeviceRegisterLimitError) {
      return reply.code(409).send({
        error: "device_tag_limit",
        message: error.message,
      });
    }

    if (error instanceof RegisterNameConflictError) {
      return reply.code(409).send({
        error: "tag_name_conflict",
        message: error.message,
      });
    }

    if (error instanceof UserAdministrationError) {
      return reply.code(409).send({
        error: error.code,
        message: error.message,
      });
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code.startsWith("SQLITE_CONSTRAINT")
    ) {
      return reply.code(409).send({
        error: "conflict",
        message: "The record conflicts with existing configuration",
      });
    }

    if (error instanceof HistorianAdministrationPausedError) {
      return reply.code(503).send({
        error: "historian_administration_paused",
        message: error.message,
      });
    }

    if (error instanceof WhatsAppAlertConfigurationError) {
      return reply.code(400).send({
        error: "whatsapp_configuration_invalid",
        message: error.message,
      });
    }

    request.log.error({ error, stack: (error as Error)?.stack }, "request failed");
    return reply.code(500).send({
      error: "internal_error",
      message: (error as Error)?.message ?? "The collector could not complete the request",
      requestId: request.id,
    });
  });

  await app.register(
    async (api) => {
      await registerRoutes(api, {
        database,
        auth,
        poller,
        postgresHistorian,
        systemAlerts,
        dataServers,
      });
      await api.register(async (systemApi) => {
        await registerSystemRoutes(systemApi, {
          database,
          auth,
          poller,
          postgresHistorian,
          systemAdministration,
          systemAlerts,
          dataServers,
        });
      });
    },
    { prefix: "/api/v1" },
  );

  app.addHook("onReady", async () => {
    database.appendActivity({
      level: "info",
      category: "system",
      event: "collector.started",
      message: "Collector service started",
      entityType: "service",
      entityId: "collector",
      details: {
        version: env.appVersion,
        pollingEnabled: env.pollingEnabled,
      },
    });
    systemAlerts.start();
    systemAlerts.reconcileIntentionalState();
    if (env.pollingEnabled) await poller.start();
    await dataServers.start();
    const runRetention = async () => {
      const deleted = database.deleteExpiredReadings(env.retentionDays);
      if (deleted > 0) {
        app.log.info(
          { deleted, retentionDays: env.retentionDays },
          "expired readings removed",
        );
      }
      try {
        await postgresHistorian.runMaintenance();
      } catch (error) {
        app.log.error(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          "PostgreSQL retention maintenance failed",
        );
      }
    };
    void runRetention();
    retentionTimer = setInterval(() => void runRetention(), 60 * 60 * 1000);
    retentionTimer.unref();
    const monitorPostgres = async () => {
      try {
        await postgresHistorian.checkAvailability();
      } catch (error) {
        app.log.error(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          "PostgreSQL availability monitor failed unexpectedly",
        );
      }
    };
    void monitorPostgres();
    postgresMonitorTimer = setInterval(() => void monitorPostgres(), 30_000);
    postgresMonitorTimer.unref();
  });

  app.addHook("onClose", async () => {
    if (retentionTimer) clearInterval(retentionTimer);
    if (postgresMonitorTimer) clearInterval(postgresMonitorTimer);
    await dataServers.stop();
    await poller.stopAndDrain();
    await postgresHistorian.close();
    await systemAlerts.close();
    database.appendActivity({
      level: "info",
      category: "system",
      event: "collector.stopped",
      message: "Collector service stopped",
      entityType: "service",
      entityId: "collector",
    });
    database.close();
  });

  return app;
}
