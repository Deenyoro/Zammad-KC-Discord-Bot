/**
 * Keepalive & status refresh for ticket threads.
 *
 * Two mechanisms:
 *
 * 1. **Daily keepalive** (KEEPALIVE_HOUR) — Posts a new status embed in every
 *    open ticket thread once per day to prevent Discord from auto-archiving.
 *
 * 2. **Status refresh** (STATUS_REFRESH_MINUTES, default 60) — Edits the
 *    existing status embed in place to keep "Last Activity" and contact info
 *    current. Runs independently of the daily keepalive.
 *
 * Both use SUPPRESS_NOTIFICATIONS so agents are not pinged.
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
  if (val === undefined) return 60; // default: every hour
  const n = parseInt(val, 10);
  return isNaN(n) || n < 1 ? 60 : n;
}

/**
 * Run the keepalive sweep — posts new status embeds (replacing old ones).
 * This is the daily mechanism to prevent thread archiving.
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
      const newMsg = (await discordQueue.add(async () =>
        thread.send({
          embeds: [embed],
          flags: 4096, // SUPPRESS_NOTIFICATIONS
          allowedMentions: { parse: [] },
        } as any)
      )) as Message | undefined;

      // Track the message ID so the refresh timer can edit it in place
      if (newMsg) {
        setSetting(`keepalive:msg:${mapping.thread_id}`, newMsg.id);
      }

      posted++;
    } catch (err) {
      failed++;
      logger.warn({ ticketId: mapping.ticket_id, err }, "Keepalive: failed to post status");
    }
  }

  logger.info({ posted, replaced, failed }, "Keepalive sweep complete");
}

/**
 * Refresh sweep — edits existing status embeds in place with fresh data.
 * Does NOT post new messages or prevent archiving — that's the daily keepalive's job.
 */
async function runRefreshSweep(client: Client): Promise<void> {
  const allThreads = getAllTicketThreads();
  const targets = allThreads.filter(
    (t) => !isClosedState(t.state) && !isHiddenState(t.state)
  );

  let refreshed = 0;
  let failed = 0;

  for (const mapping of targets) {
    const storedMsgId = getSetting(`keepalive:msg:${mapping.thread_id}`);
    if (!storedMsgId) continue; // no status embed to refresh

    try {
      const thread = (await client.channels.fetch(mapping.thread_id, {
        force: true,
      })) as ThreadChannel | null;

      if (!thread?.isThread()) continue;

      // Only refresh if the status embed is still the last message
      const lastMessages = await thread.messages.fetch({ limit: 1, cache: false });
      const lastMsg = lastMessages.first();
      if (!lastMsg || lastMsg.id !== storedMsgId) continue;

      // Verify it's actually our status embed
      if (lastMsg.author.id !== client.user?.id) continue;
      if (!lastMsg.embeds[0] || lastMsg.embeds[0].footer?.text !== STATUS_EMBED_FOOTER) continue;

      const embed = await buildStatusEmbed(mapping.ticket_id, mapping.ticket_number, mapping.title);

      await discordQueue.add(async () => {
        await lastMsg.edit({ embeds: [embed] });
      });

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
  const contacts: string[] = [];

  try {
    const ticket = await getTicket(ticketId);
    state = ticket.state;
    createdAt = formatDate(ticket.created_at);

    // Collect contact info from customer and owner
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
        // Collect customer contact info
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

    // Get articles for activity info and additional contacts
    try {
      const articles = await getArticles(ticketId);
      if (articles.length > 0) {
        const last = articles[articles.length - 1];
        const sender = last.from?.replace(/<[^>]+>/g, "").trim() || last.sender || "Unknown";
        const timeAgo = formatTimeAgo(last.created_at);
        const typeLabel = last.type === "note" ? "internal note" : last.type;
        lastActivityDesc = `${typeLabel} by ${sender} — ${timeAgo}`;

        // Collect email/phone contacts from article to/from/cc fields
        for (const a of articles) {
          if (a.sender === "System") continue;
          for (const field of [a.from, a.to, a.cc]) {
            if (!field) continue;
            for (const part of field.split(",")) {
              const trimmed = part.trim();
              // Extract email addresses
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

          // Detect Teams channel from article preferences
          const prefs = a.preferences as Record<string, any> | undefined;
          if (prefs?.teams_chat?.conversation_id) {
            const teamsKey = `teams:${prefs.teams_chat.conversation_id}`;
            if (!seenContacts.has(teamsKey)) {
              seenContacts.add(teamsKey);
              const teamsName = prefs.teams_chat.display_name || "Teams Chat";
              contacts.push(`\uD83D\uDCAC ${teamsName}`);
            }
          }

          // Detect SMS/phone from article type
          if ((a.type === "sms" || a.type === "ringcentral sms") && a.to) {
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

  // Build contact section (cap at 8 to avoid embed bloat)
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
      `**State:** ${state}\n` +
      `**Assignee:** ${owner}\n` +
      `**Customer:** ${customer}\n` +
      `**Created:** ${createdAt}\n` +
      `**Last Activity:** ${lastActivityDesc}` +
      contactSection
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
  // 1. Daily keepalive — posts new status embeds once per day
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

  // 2. Status refresh — edits existing embeds in place on a configurable interval
  const refreshMs = getRefreshMinutes() * 60_000;
  logger.info({ refreshMinutes: getRefreshMinutes() }, "Status refresh timer started");
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
