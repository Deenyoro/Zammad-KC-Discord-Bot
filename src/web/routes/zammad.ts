import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { env } from "../../util/env.js";
import { logger } from "../../util/logger.js";
import { enqueueForTicket } from "../../queue/index.js";
import { handleWebhook, type WebhookPayload } from "../../services/sync.js";
import type { Client } from "discord.js";

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function verifySignature(raw: string | undefined, header: string | undefined, secret: string): boolean {
  if (!header || !raw) return false;
  const sig = header.startsWith("sha1=") ? header.slice(5) : header;
  const digest = crypto.createHmac("sha1", secret).update(raw, "utf8").digest("hex");
  return timingSafeEqual(digest, sig);
}

export function registerZammadRoutes(app: FastifyInstance, client: Client): void {
  app.post<{ Body: WebhookPayload }>("/webhooks/zammad", async (req, reply) => {
    const raw = (req as any).rawBody as string | undefined;
    const deliveryId = req.headers["x-zammad-delivery"] as string | undefined;
    const signature = req.headers["x-hub-signature"] as string | undefined;

    if (!raw) {
      logger.warn({ deliveryId }, "Empty request body");
      return reply.code(400).send({ ok: false, error: "Empty body" });
    }

    if (!verifySignature(raw, signature, env().ZAMMAD_WEBHOOK_SECRET)) {
      logger.warn({ deliveryId }, "Invalid webhook signature");
      return reply.code(401).send({ ok: false, error: "Invalid signature" });
    }

    const payload = req.body;
    if (!payload?.ticket?.id) {
      return reply.code(400).send({ ok: false, error: "Missing ticket data" });
    }

    // ACK quickly, process async via per-ticket queue
    enqueueForTicket(payload.ticket.id, () =>
      handleWebhook(client, payload, deliveryId)
    ).catch((err) => {
      logger.error({ ticketId: payload.ticket.id, err }, "Webhook processing failed");
    });

    return reply.code(202).send({ ok: true });
  });
}
