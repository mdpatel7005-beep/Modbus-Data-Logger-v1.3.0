import "dotenv/config";
import { buildApplication } from "./app.js";
import { env } from "./config/env.js";
const app = await buildApplication();
async function shutdown(signal) {
    app.log.info({ signal }, "shutdown requested");
    await app.close();
    process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
try {
    await app.listen({ host: env.host, port: env.port });
    app.log.info({
        host: env.host,
        port: env.port,
        environment: env.nodeEnv,
        authDisabled: env.authDisabled,
    }, "Modbus Data Logger V1.3.0 collector ready");
}
catch (error) {
    app.log.fatal({ error }, "collector failed to start");
    process.exit(1);
}
//# sourceMappingURL=index.js.map