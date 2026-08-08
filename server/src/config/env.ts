import path from "node:path";
import { z } from "zod";

const booleanFromString = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true");

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const semverSchema = z
  .string()
  .max(120)
  .regex(semverPattern)
  .refine((value) => {
    const prerelease = semverPattern.exec(value)?.[4];
    return !prerelease
      ?.split(".")
      .some(
        (identifier) =>
          /^\d+$/.test(identifier) && !/^(0|[1-9]\d*)$/.test(identifier),
      );
  }, "Numeric prerelease identifiers cannot contain leading zeroes");

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4100),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_PATH: z.string().default("../data/logger.db"),
    CORS_ORIGIN: z.string().default("http://localhost:3000,http://localhost:3001"),
    TRUST_PROXY: booleanFromString.default(false),
    AUTH_DISABLED: booleanFromString.default(false),
    JWT_SECRET: z
      .string()
      .min(32)
      .default("development-secret-change-before-prod-32"),
    JWT_ISSUER: z.string().default("modbus-data-logger"),
    ACCESS_TOKEN_TTL: z.string().default("8h"),
    INITIAL_ADMIN_USERNAME: z.string().min(3).default("admin"),
    INITIAL_ADMIN_PASSWORD: z
      .string()
      .min(1)
      .default("change-me-before-production"),
    SETTINGS_ENCRYPTION_KEY: z.string().min(32).optional(),
    APP_VERSION: semverSchema.default("1.3.0"),
    LICENSE_ACTIVATION_DAYS: z.coerce
      .number()
      .int()
      .min(0)
      .max(3_650)
      .default(30),
    SYSTEM_ADMIN_DATA_DIR: z.string().min(1).optional(),
    SYSTEM_UPDATE_HELPER: z.string().min(1).optional(),
    OPENVPN_HELPER: z.string().min(1).optional(),
    RETENTION_DAYS: z.coerce.number().int().min(0).default(365),
    POLLING_ENABLED: booleanFromString.default(true),
    POSTGRES_URL: z.string().url().optional(),
    POSTGRES_SSL: booleanFromString.default(false),
    WAL_CHECKPOINT_PAGES: z.coerce
      .number()
      .int()
      .min(100)
      .max(1_000_000)
      .default(10_000),
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV === "production" && env.AUTH_DISABLED) {
      context.addIssue({
        code: "custom",
        message: "AUTH_DISABLED cannot be true in production",
        path: ["AUTH_DISABLED"],
      });
    }

    if (
      env.NODE_ENV === "production" &&
      env.JWT_SECRET === "development-secret-change-before-prod-32"
    ) {
      context.addIssue({
        code: "custom",
        message: "JWT_SECRET must be changed in production",
        path: ["JWT_SECRET"],
      });
    }

    if (
      env.NODE_ENV === "production" &&
      env.INITIAL_ADMIN_PASSWORD === "change-me-before-production"
    ) {
      context.addIssue({
        code: "custom",
        message: "INITIAL_ADMIN_PASSWORD must be changed in production",
        path: ["INITIAL_ADMIN_PASSWORD"],
      });
    }

    if (env.NODE_ENV === "production" && !env.SETTINGS_ENCRYPTION_KEY) {
      context.addIssue({
        code: "custom",
        message:
          "SETTINGS_ENCRYPTION_KEY is required to protect saved connection passwords",
        path: ["SETTINGS_ENCRYPTION_KEY"],
      });
    }

    for (const [name, value] of [
      ["SYSTEM_UPDATE_HELPER", env.SYSTEM_UPDATE_HELPER],
      ["OPENVPN_HELPER", env.OPENVPN_HELPER],
    ] as const) {
      if (value && !path.isAbsolute(value)) {
        context.addIssue({
          code: "custom",
          message: `${name} must be an absolute executable path`,
          path: [name],
        });
      }
    }

    if (env.SYSTEM_ADMIN_DATA_DIR) {
      const resolved = path.resolve(process.cwd(), env.SYSTEM_ADMIN_DATA_DIR);
      if (resolved.split(path.sep).includes("public")) {
        context.addIssue({
          code: "custom",
          message: "SYSTEM_ADMIN_DATA_DIR must be outside a public directory",
          path: ["SYSTEM_ADMIN_DATA_DIR"],
        });
      }
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid collector configuration: ${details}`);
}

const databasePath = path.resolve(process.cwd(), parsed.data.DATABASE_PATH);

export const env = {
  nodeEnv: parsed.data.NODE_ENV,
  host: parsed.data.HOST,
  port: parsed.data.PORT,
  logLevel: parsed.data.LOG_LEVEL,
  databasePath,
  corsOrigins: parsed.data.CORS_ORIGIN.split(",").map((origin) =>
    origin.trim(),
  ),
  trustProxy: parsed.data.TRUST_PROXY,
  authDisabled: parsed.data.AUTH_DISABLED,
  jwtSecret: parsed.data.JWT_SECRET,
  jwtIssuer: parsed.data.JWT_ISSUER,
  accessTokenTtl: parsed.data.ACCESS_TOKEN_TTL,
  initialAdminUsername: parsed.data.INITIAL_ADMIN_USERNAME,
  initialAdminPassword: parsed.data.INITIAL_ADMIN_PASSWORD,
  settingsEncryptionKey:
    parsed.data.SETTINGS_ENCRYPTION_KEY ?? parsed.data.JWT_SECRET,
  appVersion: parsed.data.APP_VERSION,
  licenseActivationDays: parsed.data.LICENSE_ACTIVATION_DAYS,
  systemAdminDataDir: parsed.data.SYSTEM_ADMIN_DATA_DIR
    ? path.resolve(process.cwd(), parsed.data.SYSTEM_ADMIN_DATA_DIR)
    : path.join(path.dirname(databasePath), "system-admin"),
  systemUpdateHelper: parsed.data.SYSTEM_UPDATE_HELPER,
  openVpnHelper: parsed.data.OPENVPN_HELPER,
  retentionDays: parsed.data.RETENTION_DAYS,
  pollingEnabled: parsed.data.POLLING_ENABLED,
  postgresUrl: parsed.data.POSTGRES_URL,
  postgresSsl: parsed.data.POSTGRES_SSL,
  walCheckpointPages: parsed.data.WAL_CHECKPOINT_PAGES,
} as const;
