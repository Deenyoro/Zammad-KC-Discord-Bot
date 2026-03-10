/**
 * Daily keepalive sweep — posts a silent status embed in every open ticket thread.
 *
 * Prevents Discord from hiding threads due to inactivity. Uses the
 * SUPPRESS_NOTIFICATIONS flag (4096) so agents are not pinged.
 *
 * If the previous message in the thread was also a status update from this bot,
 * it is deleted before posting the new one (avoids clutter). If there was any
 * other correspondence in between, the old status update is left in place.
 */

import {
  Client,
  EmbedBuilder,
  Message,
  ThreadChannel,
} from "discord.js";
import { logger } from "../util/logger.js";
import { getAllTicketThreads, getSetting, getSettingOrEnv } from "../db/index.js";
import { getCurrentHourInTz } from "../util/timezone.js";
import { getTicket, getArticles, getUser } from "./zammad.js";
import { ticketUrl } from "./threads.js";
import { discordQueue } from "../queue/index.js";
import { isClosedState, isHiddenState } from "../util/states.js";

const STATUS_EMBED_FOOTER = "Daily status update — no action needed";

let timer: ReturnType<typeof setInterval> | null = null;
let lastPostedHour = -1;

function getKeepaliveHour(): number | undefined {
  const val = getSettingOrEnv("KEEPALIVE_HOUR");
  if (val === undefined) return undefined;
  const n = parseInt(val, 10);
  return isNaN(n) || n < 0 || n > 23 ? undefined : n;
}

/**
 * Run the keepalive sweep for all non-closed, non-hidden ticket threads.
 */
export async function runKeepaliveSweep(client: Client): Promise<void> {
  const allThreads = getAllTicketThreads();
  const targets = allThreads.filter(
    (t) => !isClosedState(t.state) && !isHiddenState(t.state)
  );

  logger.info({ count: targets.length }, "Starting keepalive sweep");

  let posted = 0;
  let replaced = 0;
  let failed = 0;

  for (const mapping of targets) {
    try {
      const thread = (await client.channels.fetch(mapping.thread_id, {
        force: true,
      })) as ThreadChannel | null;

      if (!thread?.isThread()) {
        logger.debug({ threadId: mapping.thread_id }, "Keepalive: thread not found");
        continue;
      }

      // Build the status embed from live Zammad data
      const embed = await buildStatusEmbed(mapping.ticket_id, mapping.ticket_number, mapping.title);

      // Check if the last message in the thread is a previous status update from us
      const deletedPrevious = await maybeDeletePreviousStatus(thread, client);
      if (deletedPrevious) replaced++;

      // Send the new status update with SUPPRESS_NOTIFICATIONS flag
      await discordQueue.add(async () => {
        await thread.send({
          embeds: [embed],
          flags: 4096, // SUPPRESS_NOTIFICATIONS
          allowedMentions: { parse: [] },
        } as any);
      });

      posted++;
    } catch (err) {
      failed++;
      logger.warn({ ticketId: mapping.ticket_id, err }, "Keepalive: failed to post status");
    }
  }

  logger.info({ posted, replaced, failed }, "Keepalive sweep complete");
}

async function buildStatusEmbed(
  ticketId: number,
  ticketNumber: string,
  title: string | null,
): Promise<EmbedBuilder> {
  const url = ticketUrl(ticketId);
  let state = "Unknown";
  let owner = "Unassigned";
  let customer = "Unknown";
  let createdAt = "Unknown";
  let lastActivityDesc = "No articles";

  try {
    const ticket = await getTicket(ticketId);
    state = ticket.state;
    createdAt = formatDate(ticket.created_at);

    if (ticket.owner_id && ticket.owner_id > 1) {
      try {
        const ownerUser = await getUser(ticket.owner_id);
        owner = `${ownerUser.firstname} ${ownerUser.lastname}`.trim() || "Unassigned";
      } catch {
        // non-critical
      }
    }

    if (ticket.customer_id) {
      try {
        const customerUser = await getUser(ticket.customer_id);
        customer = `${customerUser.firstname} ${customerUser.lastname}`.trim() || ticket.customer || "Unknown";
      } catch {
        customer = ticket.customer || "Unknown";
      }
    }

    // Get last article for activity info
    try {
      const articles = await getArticles(ticketId);
      if (articles.length > 0) {
        const last = articles[articles.length - 1];
        const sender = last.from?.replace(/<[^>]+>/g, "").trim() || last.sender || "Unknown";
        const timeAgo = formatTimeAgo(last.created_at);
        const typeLabel = last.type === "note" ? "internal note" : last.type;
        lastActivityDesc = `${typeLabel} by ${sender} — ${timeAgo}`;
      }
    } catch {
      // non-critical
    }
  } catch (err) {
    logger.debug({ ticketId, err }, "Keepalive: failed to fetch ticket details");
  }

  const displayTitle = title
    ? title.length > 60 ? title.slice(0, 57) + "..." : title
    : "Untitled";

  return new EmbedBuilder()
    .setTitle("Ticket Status Update")
    .setDescription(
      `**#${ticketNumber}** — [${displayTitle}](${url})\n\n` +
      `**State:** ${state}\n` +
      `**Assignee:** ${owner}\n` +
      `**Customer:** ${customer}\n` +
      `**Created:** ${createdAt}\n` +
      `**Last Activity:** ${lastActivityDesc}`
    )
    .setColor(0x3498db) // blue
    .setFooter({ text: STATUS_EMBED_FOOTER })
    .setTimestamp(new Date());
}

/**
 * If the most recent message in the thread is a status update from the bot,
 * delete it (to avoid stacking daily updates with no real conversation between them).
 * Returns true if a message was deleted.
 */
async function maybeDeletePreviousStatus(
  thread: ThreadChannel,
  client: Client,
): Promise<boolean> {
  try {
    const messages = await thread.messages.fetch({ limit: 1 });
    const lastMsg = messages.first();
    if (!lastMsg) return false;

    // Check if it's from our bot and has our status embed footer
    if (lastMsg.author.id !== client.user?.id) return false;
    if (lastMsg.embeds.length === 0) return false;

    const embed = lastMsg.embeds[0];
    if (embed.footer?.text !== STATUS_EMBED_FOOTER) return false;

    // It's our previous status update with no conversation in between — delete it
    await discordQueue.add(async () => {
      await lastMsg.delete();
    });

    return true;
  } catch (err) {
    logger.debug({ threadId: thread.id, err }, "Keepalive: failed to check/delete previous status");
    return false;
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function formatTimeAgo(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    const weeks = Math.floor(days / 7);
    return `${weeks}w ago`;
  } catch {
    return iso;
  }
}

export function startKeepalive(client: Client): void {
  timer = setInterval(() => {
    const hour = getKeepaliveHour();
    if (hour === undefined) return;

    const currentHour = getCurrentHourInTz();
    if (currentHour === hour && lastPostedHour !== currentHour) {
      lastPostedHour = currentHour;
      runKeepaliveSweep(client).catch((err) =>
        logger.error({ err }, "Keepalive sweep failed")
      );
    }
  }, 60_000);
}

export function stopKeepalive(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
