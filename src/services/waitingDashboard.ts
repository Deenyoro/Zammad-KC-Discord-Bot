/**
 * Persistent "Waiting for Reply" dashboard thread.
 *
 * Maintains a single thread in the tickets channel that lists every ticket
 * currently in the "waiting for reply" state.  The thread stays open/visible
 * as long as there is at least one such ticket, giving agents a quick overview
 * without cluttering the main channel.
 *
 * Updated after every sync cycle and webhook processing.
 */

import {
  Client,
  EmbedBuilder,
  TextChannel,
  ThreadAutoArchiveDuration,
  ThreadChannel,
  Message,
} from "discord.js";
import { env } from "../util/env.js";
import { logger } from "../util/logger.js";
import { getAllTicketThreads, getSetting, setSetting } from "../db/index.js";
import { ticketUrl } from "./threads.js";
import { discordQueue } from "../queue/index.js";

const DASHBOARD_THREAD_ID_KEY = "dashboard:waiting_for_reply:thread_id";
const DASHBOARD_MSG_ID_KEY = "dashboard:waiting_for_reply:message_id";

interface WaitingTicket {
  ticket_id: number;
  ticket_number: string;
  title: string | null;
  thread_id: string;
  updated_at: string;
}

/**
 * Update (or create) the waiting-for-reply dashboard thread.
 * Call this after every sync cycle or webhook processing.
 */
export async function updateWaitingDashboard(client: Client): Promise<void> {
  try {
    const allThreads = getAllTicketThreads();
    const waiting: WaitingTicket[] = allThreads
      .filter((t) => t.state === "waiting for reply")
      .map((t) => ({
        ticket_id: t.ticket_id,
        ticket_number: t.ticket_number,
        title: t.title,
        thread_id: t.thread_id,
        updated_at: t.updated_at,
      }));

    // Sort by how long they've been waiting (oldest first)
    waiting.sort(
      (a, b) =>
        new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
    );

    const existingThreadId = getSetting(DASHBOARD_THREAD_ID_KEY);
    const existingMsgId = getSetting(DASHBOARD_MSG_ID_KEY);

    // No waiting tickets → archive the dashboard thread if it exists
    if (waiting.length === 0) {
      if (existingThreadId) {
        await archiveDashboard(client, existingThreadId);
      }
      return;
    }

    // Build the embed
    const embed = buildDashboardEmbed(waiting);

    // Try to update the existing dashboard
    if (existingThreadId && existingMsgId) {
      const updated = await tryUpdateExisting(
        client,
        existingThreadId,
        existingMsgId,
        embed
      );
      if (updated) return;
      // If update failed (thread deleted, etc.), fall through to create a new one
    }

    // Create a new dashboard thread
    await createDashboardThread(client, embed);
  } catch (err) {
    logger.warn({ err }, "Failed to update waiting-for-reply dashboard");
  }
}

function buildDashboardEmbed(waiting: WaitingTicket[]): EmbedBuilder {
  const now = Date.now();
  const lines: string[] = [];

  for (const t of waiting) {
    const url = ticketUrl(t.ticket_id);
    const waitingSince = new Date(t.updated_at).getTime();
    const diffMs = now - waitingSince;
    const diffMins = Math.floor(diffMs / 60_000);
    const waitLabel = formatDuration(diffMins);
    const title = t.title
      ? t.title.length > 60
        ? t.title.slice(0, 57) + "..."
        : t.title
      : "Untitled";

    lines.push(
      `**#${t.ticket_number}** — [${title}](${url}) · <t:${Math.floor(waitingSince / 1000)}:R>\n` +
        `  └ <#${t.thread_id}> · waiting ${waitLabel}`
    );
  }

  // Discord embed description limit is 4096 chars — truncate if needed
  let description = lines.join("\n\n");
  if (description.length > 4000) {
    description =
      description.slice(0, 3950) + `\n\n*… and more (${waiting.length} total)*`;
  }

  return new EmbedBuilder()
    .setTitle(`Waiting for Reply (${waiting.length})`)
    .setDescription(description)
    .setColor(0xe67e22) // orange — matches the "waiting for reply" state color
    .setFooter({ text: "Updates every sync cycle (~30s)" })
    .setTimestamp(new Date());
}

function formatDuration(totalMinutes: number): string {
  if (totalMinutes < 1) return "just now";
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  if (days < 7) return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  const weeks = Math.floor(days / 7);
  const remDays = days % 7;
  return remDays > 0 ? `${weeks}w ${remDays}d` : `${weeks}w`;
}

async function tryUpdateExisting(
  client: Client,
  threadId: string,
  msgId: string,
  embed: EmbedBuilder
): Promise<boolean> {
  try {
    const thread = (await client.channels.fetch(threadId)) as ThreadChannel | null;
    if (!thread?.isThread()) return false;

    // Ensure thread is unarchived so agents can see it
    if (thread.archived) {
      await discordQueue.add(async () => {
        await thread.edit({
          archived: false,
          locked: false,
          reason: "Waiting-for-reply dashboard has tickets",
        });
      });
    }

    // Update the embed message
    try {
      const msg = await thread.messages.fetch(msgId);
      await discordQueue.add(async () => {
        await msg.edit({ embeds: [embed] });
      });
    } catch {
      // Message was deleted — post a new one and update the stored ID
      const newMsg = (await discordQueue.add(async () =>
        thread.send({ embeds: [embed] })
      )) as Message | undefined;
      if (newMsg) {
        setSetting(DASHBOARD_MSG_ID_KEY, newMsg.id);
      }
    }

    return true;
  } catch (err) {
    logger.debug({ err, threadId }, "Dashboard thread no longer accessible");
    return false;
  }
}

async function createDashboardThread(
  client: Client,
  embed: EmbedBuilder
): Promise<void> {
  const channel = (await client.channels.fetch(
    env().DISCORD_TICKETS_CHANNEL_ID
  )) as TextChannel | null;
  if (!channel?.isTextBased()) {
    logger.warn("Cannot create dashboard: tickets channel not found");
    return;
  }

  // Post a header message in the channel, then start a thread from it
  const headerMsg = (await discordQueue.add(async () =>
    channel.send({
      content:
        "**Waiting for Reply Dashboard** — this thread tracks all tickets awaiting customer response.",
    })
  )) as Message | undefined;
  if (!headerMsg) return;

  const thread = (await discordQueue.add(async () =>
    headerMsg.startThread({
      name: "Waiting for Reply",
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: "Persistent dashboard for waiting-for-reply tickets",
    })
  )) as ThreadChannel | undefined;
  if (!thread) return;

  // Post the embed inside the thread
  const embedMsg = (await discordQueue.add(async () =>
    thread.send({ embeds: [embed] })
  )) as Message | undefined;

  // Persist IDs
  setSetting(DASHBOARD_THREAD_ID_KEY, thread.id);
  if (embedMsg) {
    setSetting(DASHBOARD_MSG_ID_KEY, embedMsg.id);
  }

  logger.info(
    { threadId: thread.id },
    "Created waiting-for-reply dashboard thread"
  );
}

async function archiveDashboard(
  client: Client,
  threadId: string
): Promise<void> {
  try {
    const thread = (await client.channels.fetch(threadId)) as ThreadChannel | null;
    if (!thread?.isThread()) return;

    if (!thread.archived) {
      // Update the embed to show "no tickets waiting"
      const existingMsgId = getSetting(DASHBOARD_MSG_ID_KEY);
      if (existingMsgId) {
        try {
          const msg = await thread.messages.fetch(existingMsgId);
          const emptyEmbed = new EmbedBuilder()
            .setTitle("Waiting for Reply (0)")
            .setDescription("No tickets are currently waiting for a reply.")
            .setColor(0x2ecc71) // green
            .setTimestamp(new Date());
          await discordQueue.add(async () => {
            await msg.edit({ embeds: [emptyEmbed] });
          });
        } catch {
          // Message gone — that's fine
        }
      }

      await discordQueue.add(async () => {
        await thread.edit({
          archived: true,
          reason: "No tickets waiting for reply",
        });
      });
      logger.info({ threadId }, "Archived empty waiting-for-reply dashboard");
    }
  } catch (err) {
    logger.debug({ err, threadId }, "Failed to archive dashboard thread");
  }
}
