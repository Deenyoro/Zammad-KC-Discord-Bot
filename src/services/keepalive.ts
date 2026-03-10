/**
 * Keepalive & status refresh for ticket threads.
 *
 * Two mechanisms:
 *
 * 1. **Daily keepalive** (KEEPALIVE_HOUR) — Ensures every open ticket thread
 *    gets activity to prevent Discord from auto-archiving.
 *
 * 2. **Status refresh** (STATUS_REFRESH_MINUTES, default 60) — Keeps the
 *    status embed current with fresh "Last Activity" and contact info.
 *
 * Both share the same core logic: find and delete ALL previous status embeds
 * in the thread, then either edit-in-place (if already at bottom) or
 * delete+re-send silently (if something was posted below it).
 *
 * There is always exactly ONE status embed per thread, always at the bottom.
 */

import {
  Client,
  EmbedBuilder,
  Message,
  ThreadChannel,
} from "discord.js";
import { logger } from "../util/logger.js";
import { getAllTicketThreads, getSetting, getSettingOrEnv, setSetting } from "../db/index.js";
import { getCurrentHourInTz } from "../util/timezone.js";
import { getTicket, getArticles, getUser } from "./zammad.js";
import { ticketUrl } from "./threads.js";
import { discordQueue } from "../queue/index.js";
import { isClosedState, isHiddenState } from "../util/states.js";

const STATUS_EMBED_FOOTER = "Daily status update — no action needed";

let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let lastPostedHour = -1;

function getKeepaliveHour(): number | undefined {
  const val = getSettingOrEnv("KEEPALIVE_HOUR");
  if (val === undefined) return undefined;
  const n = parseInt(val, 10);
  return isNaN(n) || n < 0 || n > 23 ? undefined : n;
}

function getRefreshMinutes(): number {
  const val = getSettingOrEnv("STATUS_REFRESH_MINUTES");
  if (val === undefined) return 60;
  const n = parseInt(val, 10);
  return isNaN(n) || n < 1 ? 60 : n;
}

/**
 * Core logic shared by both keepalive and refresh:
 * Ensure exactly one status embed at the bottom of the thread.
 */
async function ensureStatusAtBottom(
  client: Client,
  thread: ThreadChannel,
  embed: EmbedBuilder,
  threadId: string,
): Promise<void> {
  const botId = client.user?.id;
  if (!botId) return;

  // Fetch recent messages to find our status embed(s)
  const recent = await thread.messages.fetch({ limit: 15, cache: false });
  const statusMessages: Message[] = [];

  for (const [, msg] of recent) {
    if (
      msg.author.id === botId &&
      msg.embeds.length > 0 &&
      msg.embeds[0].footer?.text === STATUS_EMBED_FOOTER
    ) {
      statusMessages.push(msg);
    }
  }

  const lastMsg = recent.first(); // most recent message in thread
  const isAtBottom =
    statusMessages.length === 1 &&
    lastMsg?.id === statusMessages[0].id;

  if (isAtBottom) {
    // Already the last message and only one — edit in place
    await discordQueue.add(async () => {
      await statusMessages[0].edit({ embeds: [embed] });
    });
    setSetting(`keepalive:msg:${threadId}`, statusMessages[0].id);
    return;
  }

  // Delete ALL old status embeds
  for (const msg of statusMessages) {
    try {
      await discordQueue.add(async () => { await msg.delete(); });
    } catch {
      // already deleted
    }
  }

  // Post new one at the bottom, silently
  const newMsg = (await discordQueue.add(async () =>
    thread.send({
      embeds: [embed],
      flags: 4096, // SUPPRESS_NOTIFICATIONS
      allowedMentions: { parse: [] },
    } as any)
  )) as Message | undefined;

  if (newMsg) {
    setSetting(`keepalive:msg:${threadId}`, newMsg.id);
  }
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

  let updated = 0;
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

      const embed = await buildStatusEmbed(mapping.ticket_id, mapping.ticket_number, mapping.title);
      await ensureStatusAtBottom(client, thread, embed, mapping.thread_id);
      updated++;
    } catch (err) {
      failed++;
      logger.warn({ ticketId: mapping.ticket_id, err }, "Keepalive: failed to post status");
    }
  }

  logger.info({ updated, failed }, "Keepalive sweep complete");
}

/**
 * Refresh sweep — same logic as keepalive, keeps status embed current.
 */
async function runRefreshSweep(client: Client): Promise<void> {
  const allThreads = getAllTicketThreads();
  const targets = allThreads.filter(
    (t) => !isClosedState(t.state) && !isHiddenState(t.state)
  );

  let refreshed = 0;
  let failed = 0;

  for (const mapping of targets) {
    try {
      const thread = (await client.channels.fetch(mapping.thread_id, {
        force: true,
      })) as ThreadChannel | null;

      if (!thread?.isThread()) continue;

      const embed = await buildStatusEmbed(mapping.ticket_id, mapping.ticket_number, mapping.title);
      await ensureStatusAtBottom(client, thread, embed, mapping.thread_id);
      refreshed++;
    } catch (err) {
      failed++;
      logger.debug({ ticketId: mapping.ticket_id, err }, "Refresh: failed to update status embed");
    }
  }

  if (refreshed > 0 || failed > 0) {
    logger.info({ refreshed, failed }, "Status refresh sweep complete");
  }
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
  let channelType = "Unknown";
  const contacts: string[] = [];

  try {
    const ticket = await getTicket(ticketId);
    state = ticket.state;
    createdAt = formatDate(ticket.created_at);

    const seenContacts = new Set<string>();

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
        if (customerUser.email) {
          const key = customerUser.email.toLowerCase();
          if (!seenContacts.has(key)) {
            seenContacts.add(key);
            contacts.push(`\u2709 ${customerUser.email}`);
          }
        }
        if (customerUser.phone) {
          const key = customerUser.phone.replace(/\s/g, "");
          if (!seenContacts.has(key)) {
            seenContacts.add(key);
            contacts.push(`\u260E ${customerUser.phone}`);
          }
        }
        if (customerUser.mobile && customerUser.mobile !== customerUser.phone) {
          const key = customerUser.mobile.replace(/\s/g, "");
          if (!seenContacts.has(key)) {
            seenContacts.add(key);
            contacts.push(`\uD83D\uDCF1 ${customerUser.mobile}`);
          }
        }
      } catch {
        customer = ticket.customer || "Unknown";
      }
    }

    try {
      const articles = await getArticles(ticketId);
      if (articles.length > 0) {
        const last = articles[articles.length - 1];
        const sender = last.from?.replace(/<[^>]+>/g, "").trim() || last.sender || "Unknown";
        const timeAgo = formatTimeAgo(last.created_at);
        const typeLabel = last.type === "note" ? "internal note" : last.type;
        lastActivityDesc = `${typeLabel} by ${sender} — ${timeAgo}`;

        // Detect primary channel type from non-note, non-system articles
        const channelArticle =
          [...articles].reverse().find((a) => a.type !== "note" && a.sender === "Customer") ??
          [...articles].reverse().find((a) => a.type !== "note" && a.sender !== "System");
        if (channelArticle) {
          switch (channelArticle.type) {
            case "email": channelType = "\u2709\uFE0F Email"; break;
            case "ringcentral_sms_message": channelType = "\uD83D\uDCF1 SMS (RingCentral)"; break;
            case "teams_chat_message": channelType = "\uD83D\uDCAC Teams"; break;
            default: channelType = channelArticle.type; break;
          }
        }

        for (const a of articles) {
          if (a.sender === "System") continue;
          for (const field of [a.from, a.to, a.cc]) {
            if (!field) continue;
            for (const part of field.split(",")) {
              const trimmed = part.trim();
              const emailMatch = trimmed.match(/<([^>]+@[^>]+)>/) || trimmed.match(/^([^\s<]+@[^\s>]+)$/);
              if (emailMatch) {
                const key = emailMatch[1].toLowerCase();
                if (!seenContacts.has(key)) {
                  seenContacts.add(key);
                  contacts.push(`\u2709 ${emailMatch[1]}`);
                }
              }
            }
          }

          const prefs = a.preferences as Record<string, any> | undefined;
          if (prefs?.teams_chat?.conversation_id) {
            const teamsKey = `teams:${prefs.teams_chat.conversation_id}`;
            if (!seenContacts.has(teamsKey)) {
              seenContacts.add(teamsKey);
              const teamsName = prefs.teams_chat.display_name || "Teams Chat";
              contacts.push(`\uD83D\uDCAC ${teamsName}`);
            }
          }

          if ((a.type === "sms" || a.type === "ringcentral_sms_message") && a.to) {
            for (const part of a.to.split(",")) {
              const phone = part.trim().replace(/[^\d+]/g, "");
              if (phone.length >= 7 && !seenContacts.has(phone)) {
                seenContacts.add(phone);
                contacts.push(`\uD83D\uDCF1 ${part.trim()}`);
              }
            }
          }
        }
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

  let contactSection = "";
  if (contacts.length > 0) {
    const displayContacts = contacts.slice(0, 8);
    contactSection = `\n**Contacts:** ${displayContacts.join(" | ")}`;
    if (contacts.length > 8) {
      contactSection += ` *(+${contacts.length - 8} more)*`;
    }
  }

  return new EmbedBuilder()
    .setTitle("Ticket Status Update")
    .setDescription(
      `**#${ticketNumber}** — [${displayTitle}](${url})\n\n` +
      `**Channel:** ${channelType}\n` +
      `**State:** ${state}\n` +
      `**Assignee:** ${owner}\n` +
      `**Customer:** ${customer}\n` +
      `**Created:** ${createdAt}\n` +
      `**Last Activity:** ${lastActivityDesc}` +
      contactSection
    )
    .setColor(0x3498db)
    .setFooter({ text: STATUS_EMBED_FOOTER })
    .setTimestamp(new Date());
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
  // 1. Daily keepalive — ensures threads stay alive
  keepaliveTimer = setInterval(() => {
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

  // 2. Status refresh — keeps embeds current
  const refreshMs = getRefreshMinutes() * 60_000;
  logger.info({ refreshMinutes: getRefreshMinutes() }, "Status refresh timer started");

  // Run immediately on startup (after a short delay for sync to finish)
  setTimeout(() => {
    runRefreshSweep(client).catch((err) =>
      logger.error({ err }, "Initial status refresh sweep failed")
    );
  }, 15_000);

  refreshTimer = setInterval(() => {
    runRefreshSweep(client).catch((err) =>
      logger.error({ err }, "Status refresh sweep failed")
    );
  }, refreshMs);
}

export function stopKeepalive(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
