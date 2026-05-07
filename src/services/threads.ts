import {
  Client,
  EmbedBuilder,
  TextChannel,
  ThreadAutoArchiveDuration,
  ThreadChannel,
  AttachmentBuilder,
  Message,
} from "discord.js";
import { env } from "../util/env.js";
import { formatInBotTz } from "../util/timezone.js";
import { truncate, splitMessage } from "../util/truncate.js";
import { logger } from "../util/logger.js";
import {
  upsertTicketThread,
} from "../db/index.js";
import { discordQueue } from "../queue/index.js";

// ---------------------------------------------------------------
// Embed builder
// ---------------------------------------------------------------

export interface TicketInfo {
  id: number;
  number: string;
  title: string;
  state: string;
  priority?: string;
  customer?: string;
  owner?: string;
  owner_id?: number;
  group?: string;
  created_at?: string;
  escalation_at?: string | null;
  url: string;
}

/**
 * Format owner name as "FirstnameL." for thread titles.
 * Returns undefined if no valid name.
 */
export function formatOwnerLabel(firstname?: string, lastname?: string): string | undefined {
  const first = firstname?.trim();
  const last = lastname?.trim();
  if (!first) return undefined;
  if (last) return `${first}${last[0].toUpperCase()}.`;
  return first;
}

/**
 * Format a full "Firstname Lastname" string into "FirstnameL." label.
 */
export function formatOwnerLabelFromFull(fullName: string): string | undefined {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return undefined;
  return formatOwnerLabel(parts[0], parts.length > 1 ? parts[parts.length - 1] : undefined);
}

/**
 * Build a thread name with optional owner prefix.
 */
function buildThreadName(ticketNumber: string, title: string, ownerLabel?: string): string {
  if (ownerLabel) {
    return truncate(`#${ticketNumber} 👤${ownerLabel} ${title}`, 100);
  }
  return truncate(`#${ticketNumber} ${title}`, 100);
}

function stateColor(state: string): number {
  switch (state.toLowerCase()) {
    case "new":
      return 0x3498db; // blue
    case "open":
      return 0x2ecc71; // green
    case "waiting for reply":
      return 0xe67e22; // orange - awaiting customer response
    case "on-site":
      return 0x9b59b6; // purple - on-site work required
    case "project":
      return 0x3498db; // blue - project ticket
    case "pending reminder":
    case "pending close":
      return 0xf39c12; // amber
    case "closed":
      return 0x95a5a6; // grey
    case "closed (locked)":
      return 0x7f8c8d; // dark grey - permanently closed
    case "closed (locked until)":
      return 0x8e44ad; // purple - timed lock
    default:
      return 0x7289da; // discord blurple
  }
}

export function buildTicketEmbed(ticket: TicketInfo): EmbedBuilder {
  // SLA breach overrides color to red
  const slaBreached = ticket.escalation_at && new Date(ticket.escalation_at) <= new Date();
  const color = slaBreached ? 0xe74c3c : stateColor(ticket.state);

  const embed = new EmbedBuilder()
    .setTitle(truncate(`#${ticket.number} — ${ticket.title}`, 256))
    .setURL(ticket.url)
    .setColor(color)
    .setTimestamp(ticket.created_at ? new Date(ticket.created_at) : new Date());

  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: "State", value: ticket.state, inline: true },
  ];
  if (ticket.priority) fields.push({ name: "Priority", value: ticket.priority, inline: true });
  if (ticket.customer) fields.push({ name: "Customer", value: ticket.customer, inline: true });
  if (ticket.owner) fields.push({ name: "Assigned", value: ticket.owner, inline: true });
  if (ticket.group) fields.push({ name: "Group", value: ticket.group, inline: true });

  // SLA indicator
  if (ticket.escalation_at) {
    const escalationDate = new Date(ticket.escalation_at);
    const now = new Date();
    if (escalationDate <= now) {
      fields.push({ name: "SLA", value: `BREACHED (was ${formatInBotTz(escalationDate)})`, inline: true });
    } else {
      const diffMs = escalationDate.getTime() - now.getTime();
      const diffMins = Math.round(diffMs / 60_000);
      const timeLeft = diffMins >= 60
        ? `${Math.floor(diffMins / 60)}h ${diffMins % 60}m`
        : `${diffMins}m`;
      fields.push({ name: "SLA", value: `${timeLeft} remaining`, inline: true });
    }
  }

  embed.addFields(fields);
  embed.addFields({ name: "Zammad", value: `[Open ticket](${ticket.url})`, inline: false });

  return embed;
}

export function ticketUrl(ticketId: number): string {
  const base = env().ZAMMAD_PUBLIC_URL ?? env().ZAMMAD_BASE_URL;
  return `${base}/#ticket/zoom/${ticketId}`;
}

// ---------------------------------------------------------------
// Thread lifecycle
// ---------------------------------------------------------------

export async function createTicketThread(
  client: Client,
  ticket: TicketInfo
): Promise<{ threadId: string; headerMessageId: string }> {
  const channel = (await client.channels.fetch(env().DISCORD_TICKETS_CHANNEL_ID)) as TextChannel;
  if (!channel?.isTextBased()) throw new Error("Tickets channel is not a text channel");

  const embed = buildTicketEmbed(ticket);

  const headerMessage = await discordQueue.add(async () =>
    channel.send({ embeds: [embed] })
  ) as Message | undefined;
  if (!headerMessage) throw new Error("Failed to send header message");

  const ownerLabel = ticket.owner ? formatOwnerLabelFromFull(ticket.owner) : undefined;
  const thread = await discordQueue.add(async () =>
    headerMessage.startThread({
      name: buildThreadName(ticket.number, ticket.title, ownerLabel),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: `Zammad ticket ${ticket.id}`,
    })
  ) as ThreadChannel | undefined;
  if (!thread) throw new Error("Failed to create thread");

  upsertTicketThread({
    ticket_id: ticket.id,
    ticket_number: ticket.number,
    thread_id: thread.id,
    header_message_id: headerMessage.id,
    channel_id: channel.id,
    title: ticket.title,
    state: ticket.state,
  });

  // Force-add all role members to the thread (fire-and-forget, don't block creation)
  addRoleMembersToThread(thread).catch((err) =>
    logger.warn({ ticketId: ticket.id, err }, "Failed to add role members")
  );

  logger.info(
    { ticketId: ticket.id, threadId: thread.id },
    "Created ticket thread"
  );

  return { threadId: thread.id, headerMessageId: headerMessage.id };
}

/**
 * Cache of the most recent embed JSON we wrote per header message, so we can
 * skip the channel.fetch + message.fetch + msg.edit roundtrip when the
 * computed embed hasn't changed. Keyed by headerMessageId; values are the
 * stringified result of `EmbedBuilder.toJSON()`.
 *
 * In-memory only; a bot restart clears it, which means the first sync after
 * restart will write 1 edit per ticket (same as old behavior). Subsequent
 * syncs only edit when an input field actually changes. Tickets with an
 * active SLA countdown still update each cycle because the rendered
 * "Xm remaining" string changes — same as before.
 */
const _headerEmbedCache = new Map<string, string>();

export async function updateHeaderEmbed(
  client: Client,
  channelId: string,
  headerMessageId: string,
  ticket: TicketInfo
): Promise<void> {
  const embed = buildTicketEmbed(ticket);
  const sig = JSON.stringify(embed.toJSON());

  // If the embed we'd write is byte-identical to the last one we wrote for
  // this header message, skip the entire fetch+edit round-trip. Discord's
  // copy of the embed will already match, since either we wrote the cached
  // value last cycle or no other writer is updating this header message.
  if (_headerEmbedCache.get(headerMessageId) === sig) {
    return;
  }

  const channel = (await client.channels.fetch(channelId)) as TextChannel;
  const msg = await channel.messages.fetch(headerMessageId);
  await discordQueue.add(async () => { await msg.edit({ embeds: [embed] }); });
  _headerEmbedCache.set(headerMessageId, sig);
}

export async function closeTicketThread(client: Client, threadId: string): Promise<void> {
  const thread = (await client.channels.fetch(threadId)) as ThreadChannel | null;
  if (!thread?.isThread()) return;

  // Archive first for instant visual feedback, then remove members in the background
  await discordQueue.add(async () => {
    await thread.edit({ locked: true, archived: true, reason: "Ticket closed in Zammad" });
  });

  removeRoleMembersFromThread(client, threadId).catch((err) =>
    logger.warn({ threadId, err }, "Failed to remove role members after close")
  );
}

export async function reopenTicketThread(client: Client, threadId: string): Promise<void> {
  const thread = (await client.channels.fetch(threadId)) as ThreadChannel | null;
  if (!thread?.isThread()) return;
  await discordQueue.add(async () => {
    await thread.edit({ locked: false, archived: false, reason: "Ticket reopened in Zammad" });
  });

  // Re-add role members after unarchiving (fire-and-forget)
  addRoleMembersToThread(thread).catch((err) =>
    logger.warn({ threadId, err }, "Failed to re-add role members")
  );
}

export async function renameTicketThread(
  client: Client,
  threadId: string,
  ticketNumber: string,
  newTitle: string,
  ownerLabel?: string
): Promise<void> {
  const thread = (await client.channels.fetch(threadId)) as ThreadChannel | null;
  if (!thread?.isThread()) {
    logger.warn({ threadId }, "Thread not found or not a thread for rename");
    return;
  }
  // Skip rename for archived threads — Discord rejects setName on archived threads
  // and the backfill would retry every cycle, creating a noisy error loop.
  if (thread.archived) return;

  const name = buildThreadName(ticketNumber, newTitle, ownerLabel);
  const oldName = thread.name;
  if (name === oldName) return; // no change needed
  logger.info({ threadId, oldName, newName: name }, "About to rename thread");
  await discordQueue.add(async () => {
    await thread.setName(name, "Ticket updated in Zammad");
    logger.info({ threadId, oldName, newName: name }, "Discord API rename completed");
  });
}

export async function sendToThread(
  client: Client,
  threadId: string,
  content: string,
  attachments?: { data: Buffer; filename: string }[]
): Promise<string | null> {
  const thread = (await client.channels.fetch(threadId)) as ThreadChannel | null;
  if (!thread?.isThread()) return null;

  // If the thread is archived (or locked+archived), temporarily unarchive so
  // we can send. Re-archive afterwards to preserve the visual "closed" state.
  const wasArchived = thread.archived;
  const wasLocked = thread.locked;
  if (wasArchived) {
    logger.debug({ threadId, wasArchived, wasLocked }, "sendToThread: thread is archived, temporarily unarchiving");
  }
  if (wasArchived) {
    await discordQueue.add(async () => {
      await thread.edit({
        archived: false,
        ...(wasLocked ? { locked: false } : {}),
        reason: "Temporarily unarchiving to sync article",
      });
    });
  }

  const files = attachments?.map(
    (a) => new AttachmentBuilder(a.data, { name: a.filename })
  );

  // Split long messages into chunks to avoid Discord's 2000 char limit
  const chunks = splitMessage(content);
  let firstMsgId: string | null = null;

  for (let i = 0; i < chunks.length; i++) {
    const msg = await discordQueue.add(async () =>
      thread.send({
        content: chunks[i],
        // Only attach files to the first message
        files: i === 0 ? files : undefined,
        allowedMentions: { parse: [] },
      })
    ) as Message | undefined;

    if (i === 0) {
      firstMsgId = msg?.id ?? null;
    }
  }

  // Restore archived/locked state so the thread stays visually "closed"
  if (wasArchived) {
    await discordQueue.add(async () => {
      await thread.edit({
        ...(wasLocked ? { locked: true } : {}),
        archived: true,
        reason: "Re-archiving after article sync",
      });
    });
  }

  return firstMsgId;
}

// ---------------------------------------------------------------
// Thread membership — role-based
// ---------------------------------------------------------------

// Cache of role member IDs — refreshed once per sync cycle
let _roleMemberIds: string[] | null = null;
let _roleMembersFetchedAt = 0;
const ROLE_CACHE_TTL = 60_000; // 1 minute

async function getRoleMemberIds(guild: import("discord.js").Guild): Promise<string[]> {
  const TICKET_ROLE_ID = env().DISCORD_TICKET_ROLE_ID;
  if (!TICKET_ROLE_ID) return [];

  const now = Date.now();
  if (_roleMemberIds && now - _roleMembersFetchedAt < ROLE_CACHE_TTL) {
    return _roleMemberIds;
  }

  await guild.members.fetch();
  const role = guild.roles.cache.get(TICKET_ROLE_ID);
  if (!role) {
    logger.warn({ roleId: TICKET_ROLE_ID }, "Ticket role not found");
    _roleMemberIds = [];
    _roleMembersFetchedAt = now;
    return [];
  }

  _roleMemberIds = [...role.members.keys()];
  _roleMembersFetchedAt = now;
  return _roleMemberIds;
}

/**
 * Ensure all guild members with the ticket role are present in the thread.
 *
 * Computes the diff between the role's member list and the thread's current
 * members and only issues `thread.members.add` for the missing ones. Without
 * this check, every periodic backfill cycle re-issues N adds on every open
 * ticket (where N = ticket-role member count); each is idempotent server-side
 * but still costs a Discord REST roundtrip and rate-limit budget. With ~20
 * open tickets and a ~5-member role the bot was burning ~100 REST calls per
 * sync cycle and stretching each cycle to ~2 minutes.
 */
export async function addRoleMembersToThread(thread: ThreadChannel): Promise<void> {
  try {
    const roleMemberIds = await getRoleMemberIds(thread.guild);
    if (roleMemberIds.length === 0) return;

    let missingMemberIds: string[];
    try {
      const currentMembers = await thread.members.fetch();
      const currentMemberIds = new Set(currentMembers.keys());
      missingMemberIds = roleMemberIds.filter((id) => !currentMemberIds.has(id));
    } catch (err) {
      // If we can't fetch current members, fall back to adding all (old behavior).
      logger.debug({ threadId: thread.id, err }, "Could not fetch thread members; falling back to add-all");
      missingMemberIds = roleMemberIds;
    }

    if (missingMemberIds.length === 0) {
      logger.debug(
        { threadId: thread.id, roleMemberCount: roleMemberIds.length },
        "All role members already in thread; skipping adds",
      );
      return;
    }

    logger.info(
      { threadId: thread.id, addCount: missingMemberIds.length, roleMemberCount: roleMemberIds.length },
      "Adding missing role members to thread",
    );
    await Promise.allSettled(
      missingMemberIds.map((memberId) =>
        discordQueue.add(async () => { await thread.members.add(memberId); }).catch((err) => {
          logger.debug({ memberId, threadId: thread.id, err }, "Failed to add role member to thread");
        }),
      ),
    );
    logger.info(
      { threadId: thread.id, addCount: missingMemberIds.length },
      "Role members added to thread",
    );
  } catch (err) {
    logger.warn({ threadId: thread.id, err }, "Failed to add role members to thread");
  }
}

/** Remove all role members from a thread (on ticket close). */
export async function removeRoleMembersFromThread(
  client: Client,
  threadId: string
): Promise<void> {
  const thread = (await client.channels.fetch(threadId)) as ThreadChannel | null;
  if (!thread?.isThread()) return;

  try {
    const memberIds = await getRoleMemberIds(thread.guild);
    // Submit all removals to the queue concurrently instead of awaiting each one
    await Promise.allSettled(
      memberIds.map((memberId) =>
        discordQueue.add(async () => { await thread.members.remove(memberId); }).catch((err) => {
          logger.debug({ memberId, threadId, err }, "Failed to remove member from thread");
        })
      )
    );
  } catch (err) {
    logger.warn({ threadId, err }, "Failed to remove role members from thread");
  }
}
