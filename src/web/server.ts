import Fastify, { type FastifyInstance } from "fastify";
import rawBody from "fastify-raw-body";
import type { Client } from "discord.js";
import { env } from "../util/env.js";
import { logger } from "../util/logger.js";
import { registerZammadRoutes } from "./routes/zammad.js";

export async function startWebServer(client: Client): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(rawBody, {
    field: "rawBody",
    global: true,
    encoding: "utf8",
    runFirst: true,
  });

  // Liveness probe — always returns 200 if the process is up
  app.get("/healthz", async () => ({ ok: true }));

  // Readiness probe — checks Zammad connectivity
  app.get("/readyz", async (_req, reply) => {
    try {
      const url = `${env().ZAMMAD_BASE_URL}/api/v1/monitoring/health_check`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${env().ZAMMAD_API_TOKEN}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) return { ok: true };
      return reply.code(503).send({ ok: false, error: "Zammad unhealthy" });
    } catch {
      return reply.code(503).send({ ok: false, error: "Zammad unreachable" });
    }
  });

  // Zammad webhook routes
  registerZammadRoutes(app, client);

  const port = env().PORT;
  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ port }, "Webhook server listening");

  return app;
}
