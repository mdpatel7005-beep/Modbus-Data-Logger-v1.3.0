import "fastify";
import type { Principal } from "./domain.js";

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
}
