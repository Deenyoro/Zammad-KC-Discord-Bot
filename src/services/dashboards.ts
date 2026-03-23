/**
 * Persistent "Other Tickets" dashboard thread.
 *
 * Maintains a single thread in the tickets channel that lists every ticket
 * currently in a dashboard state (waiting for reply, on-site, project).
 * Tickets are grouped by state with distinct colors per section.
 * The thread stays open/visible as long as there is at least one such ticket.
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

const DASHBOARD_THREAD_ID_KEY = "dashboard:other_tickets:thread_id";
const DASHBOARD_MSG_ID_KEY = "dashboard:other_tickets:message_id";

/** Minimum interval between dashboard re-posts (bumps) in ms. */
const DASHBOARD_BUMP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let lastDashboardBumpTime = 0;
let lastDashboardContentHash = "";

// Migrate from old WFR-only keys if they exist
function migrateOldKeys(): void {
  const oldThreadId = getSetting("dashboard:waiting_for_reply:thread_id");
  const oldMsgId = getSetting("dashboard:waiting_for_reply:message_id");
  if (oldThreadId && !getSetting(DASHBOARD_THREAD_ID_KEY)) {
    setSetting(DASHBOARD_THREAD_ID_KEY, oldThreadId);
    if (oldMsgId) setSetting(DASHBOARD_MSG_ID_KEY, oldMsgId);
    // Clear old keys
    setSetting("dashboard:waiting_for_reply:thread_id", "");
    setSetting("dashboard:waiting_for_reply:message_id", "");
    logger.info("Migrated WFR dashboard settings to other_tickets");
  }
}

interface DashboardTicket {
  ticket_id: number;
  ticket_number: string;
  title: string | null;
  thread_id: string;
  updated_at: string;
  state: string;
}

const STATE_CONFIG: Record<string, { emoji: string; label: string; verb: string; color: number }> = {
  "waiting for reply": { emoji: "🟠", label: "Waiting for Reply", verb: "waiting", color: 0xe67e22 },
  "on-site":          { emoji: "🟣", label: "On-Site",           verb: "on-site", color: 0x9b59b6 },
  "project":          { emoji: "🔵", label: "Project",           verb: "in project", color: 0x3498db },
};

/**
 * Update (or create) the combined dashboard thread.
 * Call this after every sync cycle or webhook processing.
 */
export async function updateDashboards(client: Client): Promise<void> {
  try {
    migrateOldKeys();

    const allThreads = getAllTicketThreads();
    const dashboardStates = new Set<string>(DASHBOARD_STATES);
    const tickets: DashboardTicket[] = allThreads
      .filter((t) => dashboardStates.has(t.state))
      .map((t) => ({
        ticket_id: t.ticket_id,
        ticket_number: t.ticket_number,
        title: t.title,
        thread_id: t.thread_id,
        updated_at: t.updated_at,
        state: t.state,
      }));

    const existingThreadId = getSetting(DASHBOARD_THREAD_ID_KEY);
    const existingMsgId = getSetting(DASHBOARD_MSG_ID_KEY);

    // No tickets in any dashboard state → archive
    if (tickets.length === 0) {
      if (existingThreadId) {
        await archiveDashboard(client, existingThreadId);
      }
      return;
    }

    const embed = buildDashboardEmbed(tickets);

    // Try to update existing
    if (existingThreadId && existingMsgId) {
      const updated = await tryUpdateExisting(client, existingThreadId, existingMsgId, embed);
      if (updated) return;
    }

    // Create new
    await createDashboardThread(client, embed);
  } catch (err) {
    logger.warn({ err }, "Failed to update other-tickets dashboard");
  }
}

function buildDashboardEmbed(tickets: DashboardTicket[]): EmbedBuilder {
  const now = Date.now();
  const sections: string[] = [];

  // Group by state in defined order
  for (const state of DASHBOARD_STATES) {
    const stateTickets = tickets
      .filter((t) => t.state === state)
      .sort((a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime());

    if (stateTickets.length === 0) continue;

    const cfg = STATE_CONFIG[state];
    const lines: string[] = [];
    lines.push(`${cfg.emoji} **${cfg.label}** (${stateTickets.length})`);

    for (const t of stateTickets) {
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
          `  └ <#${t.thread_id}> · ${cfg.verb} ${waitLabel}`
      );
    }

    sections.push(lines.join("\n"));
  }

  let description = sections.join("\n\n");
  if (description.length > 4000) {
    description =
      description.slice(0, 3950) + `\n\n*… and more (${tickets.length} total)*`;
  }

  return new EmbedBuilder()
    .setTitle(`Other Tickets (${tickets.length})`)
    .setDescription(description)
    .setColor(0xe67e22)
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
    const thread = (await client.channels.fetch(threadId, { force: true })) as ThreadChannel | null;
    if (!thread?.isThread()) {
      logger.warn({ threadId }, "Dashboard thread not found or not a thread");
      return false;
    }

    // Unarchive FIRST so subsequent operations (rename, message edit) succeed.
    // Discord rejects edits on archived threads.
    if (thread.archived || thread.locked) {
      await discordQueue.add(async () => {
        await thread.edit({
          archived: false,
          locked: false,
          reason: "Other Tickets dashboard has tickets",
        });
      });
    }

    // Rename thread if it still has the old name (must happen after unarchive)
    if (thread.name !== "Other Tickets") {
      await discordQueue.add(async () => {
        await thread.setName("Other Tickets", "Renamed from Waiting for Reply to Other Tickets");
      });
      logger.info({ threadId }, "Renamed dashboard thread to Other Tickets");
    }

    await addRoleMembersToThread(thread).catch((err) =>
      logger.warn({ threadId, err }, "Failed to add role members to dashboard thread")
    );

    // Decide whether to bump (delete + re-post) or just edit in place.
    // Bumping keeps the thread at the top of the thread list, but we throttle
    // to avoid excessive churn. Bump immediately if content changed, otherwise
    // bump every DASHBOARD_BUMP_INTERVAL_MS to keep the thread visible.
    const contentHash = embed.data.description ?? "";
    const contentChanged = contentHash !== lastDashboardContentHash;
    const timeSinceBump = Date.now() - lastDashboardBumpTime;
    const shouldBump = contentChanged || timeSinceBump >= DASHBOARD_BUMP_INTERVAL_MS;

    if (shouldBump) {
      // Delete old embed and send a fresh one (SUPPRESS_NOTIFICATIONS = silent)
      try {
        const oldMsg = await thread.messages.fetch(msgId);
        await discordQueue.add(async () => { await oldMsg.delete(); });
      } catch {
        // Already deleted — that's fine
      }
      const newMsg = (await discordQueue.add(async () =>
        thread.send({
          embeds: [embed],
          flags: 4096, // SUPPRESS_NOTIFICATIONS
        } as any)
      )) as Message | undefined;
      if (newMsg) {
        setSetting(DASHBOARD_MSG_ID_KEY, newMsg.id);
      }
      lastDashboardBumpTime = Date.now();
      lastDashboardContentHash = contentHash;
    } else {
      // Just edit the existing embed in place (no bump, saves API calls)
      try {
        const msg = await thread.messages.fetch(msgId);
        await discordQueue.add(async () => {
          await msg.edit({ embeds: [embed] });
        });
      } catch {
        // Message gone — force a bump next cycle
        lastDashboardContentHash = "";
      }
    }

    return true;
  } catch (err: any) {
    // Only treat 404 (deleted) and 403 (no access) as "thread gone" — create a new one.
    // For transient errors (503, 500, rate limits, network), return true to prevent
    // creating duplicate dashboard threads. We'll retry on the next sync cycle.
    const status = err?.status ?? err?.httpStatus ?? 0;
    if (status === 404 || status === 403) {
      logger.warn({ err, threadId, status }, "Dashboard thread no longer accessible — will recreate");
      return false;
    }
    logger.warn({ err, threadId, status }, "Dashboard update failed (transient) — skipping to avoid duplicates");
    return true;
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

  const headerMsg = (await discordQueue.add(async () =>
    channel.send({
      content:
        "**Other Tickets Dashboard** — this thread tracks tickets that are waiting for reply, on-site, or in a project.",
    })
  )) as Message | undefined;
  if (!headerMsg) return;

  const thread = (await discordQueue.add(async () =>
    headerMsg.startThread({
      name: "Other Tickets",
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: "Persistent dashboard for other ticket states",
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

  setSetting(DASHBOARD_THREAD_ID_KEY, thread.id);
  if (embedMsg) {
    setSetting(DASHBOARD_MSG_ID_KEY, embedMsg.id);
  }

  logger.info({ threadId: thread.id }, "Created Other Tickets dashboard thread");
}

async function archiveDashboard(
  client: Client,
  threadId: string
): Promise<void> {
  try {
    const thread = (await client.channels.fetch(threadId)) as ThreadChannel | null;
    if (!thread?.isThread()) return;

    if (!thread.archived) {
      const existingMsgId = getSetting(DASHBOARD_MSG_ID_KEY);
      if (existingMsgId) {
        try {
          const msg = await thread.messages.fetch(existingMsgId);
          const emptyEmbed = new EmbedBuilder()
            .setTitle("Other Tickets (0)")
            .setDescription("No tickets are currently waiting for reply, on-site, or in a project.")
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
          reason: "No other tickets",
        });
      });
      logger.info({ threadId }, "Archived empty Other Tickets dashboard");
    }
  } catch (err) {
    logger.debug({ err, threadId }, "Failed to archive dashboard thread");
  }
}
