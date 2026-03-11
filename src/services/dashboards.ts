/**
 * Persistent state dashboard threads.
 *
 * Maintains one thread per dashboard state (waiting for reply, on-site, project)
 * in the tickets channel. Each thread lists every ticket currently in that state.
 * Threads stay open/visible as long as there is at least one ticket in that state,
 * giving agents a quick overview without cluttering the main channel.
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
import { ticketUrl, addRoleMembersToThread } from "./threads.js";
import { discordQueue } from "../queue/index.js";
import { DASHBOARD_STATES } from "../util/states.js";

// ---------------------------------------------------------------
// Dashboard configuration per state
// ---------------------------------------------------------------

interface DashboardConfig {
  state: string;
  label: string;
  headerText: string;
  color: number;
  emptyText: string;
  durationVerb: string;
  threadIdKey: string;
  msgIdKey: string;
}

const CONFIGS: DashboardConfig[] = [
  {
    state: "waiting for reply",
    label: "Waiting for Reply",
    headerText: "this thread tracks all tickets awaiting customer response.",
    color: 0xe67e22, // orange
    emptyText: "No tickets are currently waiting for a reply.",
    durationVerb: "waiting",
    threadIdKey: "dashboard:waiting_for_reply:thread_id",
    msgIdKey: "dashboard:waiting_for_reply:message_id",
  },
  {
    state: "on-site",
    label: "On-Site",
    headerText: "this thread tracks all tickets requiring on-site work.",
    color: 0x9b59b6, // purple
    emptyText: "No tickets currently require on-site work.",
    durationVerb: "on-site",
    threadIdKey: "dashboard:on_site:thread_id",
    msgIdKey: "dashboard:on_site:message_id",
  },
  {
    state: "project",
    label: "Project",
    headerText: "this thread tracks all project tickets.",
    color: 0x3498db, // blue
    emptyText: "No project tickets currently active.",
    durationVerb: "in project",
    threadIdKey: "dashboard:project:thread_id",
    msgIdKey: "dashboard:project:message_id",
  },
];

// ---------------------------------------------------------------
// Shared ticket type
// ---------------------------------------------------------------

interface DashboardTicket {
  ticket_id: number;
  ticket_number: string;
  title: string | null;
  thread_id: string;
  updated_at: string;
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Update all dashboard threads. Call after every sync cycle or webhook.
 * Backwards-compatible — replaces the old updateWaitingDashboard().
 */
export async function updateDashboards(client: Client): Promise<void> {
  const allThreads = getAllTicketThreads();

  for (const config of CONFIGS) {
    try {
      await updateSingleDashboard(client, config, allThreads);
    } catch (err) {
      logger.warn({ err, state: config.state }, `Failed to update ${config.label} dashboard`);
    }
  }
}

/** Backwards-compatible alias. */
export const updateWaitingDashboard = updateDashboards;

// ---------------------------------------------------------------
// Single dashboard update
// ---------------------------------------------------------------

async function updateSingleDashboard(
  client: Client,
  config: DashboardConfig,
  allThreads: ReturnType<typeof getAllTicketThreads>
): Promise<void> {
  const tickets: DashboardTicket[] = allThreads
    .filter((t) => t.state === config.state)
    .map((t) => ({
      ticket_id: t.ticket_id,
      ticket_number: t.ticket_number,
      title: t.title,
      thread_id: t.thread_id,
      updated_at: t.updated_at,
    }));

  // Sort oldest first
  tickets.sort(
    (a, b) =>
      new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
  );

  const existingThreadId = getSetting(config.threadIdKey);
  const existingMsgId = getSetting(config.msgIdKey);

  // No tickets → archive the dashboard thread if it exists
  if (tickets.length === 0) {
    if (existingThreadId) {
      await archiveDashboard(client, config, existingThreadId);
    }
    return;
  }

  const embed = buildDashboardEmbed(config, tickets);

  // Try to update the existing dashboard
  if (existingThreadId && existingMsgId) {
    const updated = await tryUpdateExisting(
      client,
      config,
      existingThreadId,
      existingMsgId,
      embed
    );
    if (updated) return;
  }

  // Create a new dashboard thread
  await createDashboardThread(client, config, embed);
}

// ---------------------------------------------------------------
// Embed builder
// ---------------------------------------------------------------

function buildDashboardEmbed(
  config: DashboardConfig,
  tickets: DashboardTicket[]
): EmbedBuilder {
  const now = Date.now();
  const lines: string[] = [];

  for (const t of tickets) {
    const url = ticketUrl(t.ticket_id);
    const since = new Date(t.updated_at).getTime();
    const diffMins = Math.floor((now - since) / 60_000);
    const waitLabel = formatDuration(diffMins);
    const title = t.title
      ? t.title.length > 60
        ? t.title.slice(0, 57) + "..."
        : t.title
      : "Untitled";

    lines.push(
      `**#${t.ticket_number}** — [${title}](${url}) · <t:${Math.floor(since / 1000)}:R>\n` +
        `  └ <#${t.thread_id}> · ${config.durationVerb} ${waitLabel}`
    );
  }

  let description = lines.join("\n\n");
  if (description.length > 4000) {
    description =
      description.slice(0, 3950) + `\n\n*… and more (${tickets.length} total)*`;
  }

  return new EmbedBuilder()
    .setTitle(`${config.label} (${tickets.length})`)
    .setDescription(description)
    .setColor(config.color)
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

// ---------------------------------------------------------------
// Thread update / create / archive
// ---------------------------------------------------------------

async function tryUpdateExisting(
  client: Client,
  config: DashboardConfig,
  threadId: string,
  msgId: string,
  embed: EmbedBuilder
): Promise<boolean> {
  try {
    const thread = (await client.channels.fetch(threadId, { force: true })) as ThreadChannel | null;
    if (!thread?.isThread()) {
      logger.warn({ threadId, state: config.state }, "Dashboard thread not found or not a thread");
      return false;
    }

    if (thread.archived || thread.locked) {
      logger.info({ threadId, state: config.state, archived: thread.archived, locked: thread.locked }, "Unarchiving dashboard thread");
      await discordQueue.add(async () => {
        await thread.edit({
          archived: false,
          locked: false,
          reason: `${config.label} dashboard has tickets`,
        });
      });
    }

    await addRoleMembersToThread(thread).catch((err) =>
      logger.warn({ threadId, err }, "Failed to add role members to dashboard thread")
    );

    try {
      const lastMessages = await thread.messages.fetch({ limit: 1 });
      const lastMsg = lastMessages.first();
      const isAtBottom = lastMsg?.id === msgId;

      if (isAtBottom) {
        const msg = await thread.messages.fetch(msgId);
        await discordQueue.add(async () => {
          await msg.edit({ embeds: [embed] });
        });
      } else {
        try {
          const oldMsg = await thread.messages.fetch(msgId);
          await discordQueue.add(async () => { await oldMsg.delete(); });
        } catch {
          // Already deleted
        }
        const newMsg = (await discordQueue.add(async () =>
          thread.send({
            embeds: [embed],
            flags: 4096, // SUPPRESS_NOTIFICATIONS
          } as any)
        )) as Message | undefined;
        if (newMsg) {
          setSetting(config.msgIdKey, newMsg.id);
        }
      }
    } catch {
      logger.info({ threadId, state: config.state }, "Dashboard embed message missing, posting new one");
      const newMsg = (await discordQueue.add(async () =>
        thread.send({
          embeds: [embed],
          flags: 4096, // SUPPRESS_NOTIFICATIONS
        } as any)
      )) as Message | undefined;
      if (newMsg) {
        setSetting(config.msgIdKey, newMsg.id);
      }
    }

    return true;
  } catch (err) {
    logger.warn({ err, threadId, state: config.state }, "Dashboard thread no longer accessible");
    return false;
  }
}

async function createDashboardThread(
  client: Client,
  config: DashboardConfig,
  embed: EmbedBuilder
): Promise<void> {
  const channel = (await client.channels.fetch(
    env().DISCORD_TICKETS_CHANNEL_ID
  )) as TextChannel | null;
  if (!channel?.isTextBased()) {
    logger.warn({ state: config.state }, "Cannot create dashboard: tickets channel not found");
    return;
  }

  const headerMsg = (await discordQueue.add(async () =>
    channel.send({
      content: `**${config.label} Dashboard** — ${config.headerText}`,
    })
  )) as Message | undefined;
  if (!headerMsg) return;

  const thread = (await discordQueue.add(async () =>
    headerMsg.startThread({
      name: config.label,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: `Persistent dashboard for ${config.state} tickets`,
    })
  )) as ThreadChannel | undefined;

  try {
    await discordQueue.add(async () => { await headerMsg.pin(); });
  } catch {
    // Non-critical — pin limit may be reached
  }
  if (!thread) return;

  await addRoleMembersToThread(thread).catch((err) =>
    logger.warn({ threadId: thread.id, err }, "Failed to add role members to new dashboard thread")
  );

  const embedMsg = (await discordQueue.add(async () =>
    thread.send({ embeds: [embed] })
  )) as Message | undefined;

  setSetting(config.threadIdKey, thread.id);
  if (embedMsg) {
    setSetting(config.msgIdKey, embedMsg.id);
  }

  logger.info(
    { threadId: thread.id, state: config.state },
    `Created ${config.label} dashboard thread`
  );
}

async function archiveDashboard(
  client: Client,
  config: DashboardConfig,
  threadId: string
): Promise<void> {
  try {
    const thread = (await client.channels.fetch(threadId)) as ThreadChannel | null;
    if (!thread?.isThread()) return;

    if (!thread.archived) {
      const existingMsgId = getSetting(config.msgIdKey);
      if (existingMsgId) {
        try {
          const msg = await thread.messages.fetch(existingMsgId);
          const emptyEmbed = new EmbedBuilder()
            .setTitle(`${config.label} (0)`)
            .setDescription(config.emptyText)
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
          reason: `No ${config.state} tickets`,
        });
      });
      logger.info({ threadId, state: config.state }, `Archived empty ${config.label} dashboard`);
    }
  } catch (err) {
    logger.debug({ err, threadId, state: config.state }, "Failed to archive dashboard thread");
  }
}
