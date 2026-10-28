/**
 * Debug endpoints — inspect the actual state of Discord threads.
 *
 * They expose ticket titles and thread members and can change settings, and
 * any pod in the cluster can reach the service, so they are only registered
 * when DEBUG_TOKEN is set, and then require it as "Authorization: Bearer <token>".
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Client } from "discord.js";
import { EmbedBuilder, ThreadChannel } from "discord.js";
import { getAllTicketThreads, getSetting, setSetting } from "../../db/index.js";
import { isClosedState, isHiddenState } from "../../util/states.js";
import { runKeepaliveSweep } from "../../services/keepalive.js";

/** Constant-time check of "Authorization: Bearer <token>". */
function hasDebugToken(req: FastifyRequest, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(token).digest();
  return given.length > 0 && timingSafeEqual(a, b);
}

export function registerDebugRoutes(app: FastifyInstance, client: Client, debugToken: string | undefined): void {
  const token = debugToken?.trim();
  if (!token) return;
  app.register(async (debug) => {
    debug.addHook("onRequest", async (req, reply) => {
      if (!hasDebugToken(req, token)) {
        return reply.code(401).send({ ok: false, error: "unauthorized" });
      }
    });
    registerDebugRouteHandlers(debug, client);
  });
}

function registerDebugRouteHandlers(app: FastifyInstance, client: Client): void {
  // Full thread state report
  app.get("/debug/threads", async () => {
    const allThreads = getAllTicketThreads();
    const nonClosed = allThreads.filter((t) => !isClosedState(t.state));

    const results = [];

    for (const mapping of nonClosed) {
      const entry: Record<string, unknown> = {
        ticket_id: mapping.ticket_id,
        ticket_number: mapping.ticket_number,
        title: mapping.title,
        db_state: mapping.state,
        thread_id: mapping.thread_id,
        is_hidden: isHiddenState(mapping.state),
      };

      try {
        const thread = (await client.channels.fetch(mapping.thread_id, {
          force: true,
        })) as ThreadChannel | null;

        if (!thread?.isThread()) {
          entry.discord_error = "Thread not found or not a thread";
        } else {
          entry.discord_archived = thread.archived;
          entry.discord_locked = thread.locked;
          entry.discord_name = thread.name;
          entry.discord_member_count = thread.memberCount;
          entry.discord_message_count = thread.messageCount;
          entry.discord_owner_id = thread.ownerId;

          // Fetch actual thread members
          try {
            const members = await thread.members.fetch();
            entry.discord_members = members.map((m) => ({
              id: m.id,
              user_id: m.user?.id ?? m.id,
              username: m.user?.username ?? "unknown",
            }));
            entry.discord_member_count_actual = members.size;
          } catch (err: any) {
            entry.discord_members_error = err?.message ?? String(err);
          }
        }
      } catch (err: any) {
        entry.discord_error = err?.message ?? String(err);
      }

      results.push(entry);
    }

    // Check dashboard thread
    const dashboardThreadId = getSetting("dashboard:other_tickets:thread_id");
    const dashboardMsgId = getSetting("dashboard:other_tickets:message_id");
    let dashboard: Record<string, unknown> = {
      thread_id: dashboardThreadId ?? null,
      message_id: dashboardMsgId ?? null,
    };

    if (dashboardThreadId) {
      try {
        const thread = (await client.channels.fetch(dashboardThreadId, {
          force: true,
        })) as ThreadChannel | null;
        if (thread?.isThread()) {
          dashboard.discord_archived = thread.archived;
          dashboard.discord_locked = thread.locked;
          dashboard.discord_name = thread.name;
          dashboard.discord_member_count = thread.memberCount;
          try {
            const members = await thread.members.fetch();
            dashboard.discord_members = members.map((m) => ({
              id: m.id,
              user_id: m.user?.id ?? m.id,
              username: m.user?.username ?? "unknown",
            }));
            dashboard.discord_member_count_actual = members.size;
          } catch (err: any) {
            dashboard.discord_members_error = err?.message ?? String(err);
          }
        } else {
          dashboard.discord_error = "Thread not found";
        }
      } catch (err: any) {
        dashboard.discord_error = err?.message ?? String(err);
      }
    }

    return {
      ticket_threads: results,
      dashboard,
      summary: {
        total_non_closed: nonClosed.length,
        visible: nonClosed.filter((t) => !isHiddenState(t.state)).length,
        hidden: nonClosed.filter((t) => isHiddenState(t.state)).length,
      },
    };
  });

  // Quick summary
  app.get("/debug/summary", async () => {
    const allThreads = getAllTicketThreads();
    const states: Record<string, number> = {};
    for (const t of allThreads) {
      states[t.state] = (states[t.state] || 0) + 1;
    }
    return { total: allThreads.length, by_state: states };
  });

  // Trigger keepalive sweep manually
  app.post("/debug/keepalive", async () => {
    runKeepaliveSweep(client).catch(() => {});
    return { ok: true, message: "Keepalive sweep started" };
  });

  // Get/set keepalive hour
  app.get("/debug/settings/keepalive", async () => {
    const hour = getSetting("KEEPALIVE_HOUR");
    return { KEEPALIVE_HOUR: hour ?? null };
  });

  app.post<{ Body: { hour: number } }>("/debug/settings/keepalive", async (req) => {
    const hour = (req.body as any)?.hour;
    if (typeof hour !== "number" || hour < 0 || hour > 23) {
      return { ok: false, error: "hour must be 0-23" };
    }
    setSetting("KEEPALIVE_HOUR", String(hour));
    return { ok: true, KEEPALIVE_HOUR: hour };
  });
}
