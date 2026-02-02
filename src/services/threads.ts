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
import { truncate } from "../util/truncate.js";
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
  url: string;
}

function stateColor(state: string): number {
  switch (state.toLowerCase()) {
    case "new":
      return 0x3498db; // blue
    case "open":
      return 0x2ecc71; // green
    case "pending reminder":
    case "pending close":
      return 0xf39c12; // amber
    case "closed":
      return 0x95a5a6; // grey
    default:
      return 0x7289da; // discord blurple
  }
}

export function buildTicketEmbed(ticket: TicketInfo): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(truncate(`#${ticket.number} — ${ticket.title}`, 256))
    .setURL(ticket.url)
    .setColor(stateColor(ticket.state))
    .setTimestamp(ticket.created_at ? new Date(ticket.created_at) : new Date());

  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: "State", value: ticket.state, inline: true },
  ];
  if (ticket.priority) fields.push({ name: "Priority", value: ticket.priority, inline: true });
  if (ticket.customer) fields.push({ name: "Customer", value: ticket.customer, inline: true });
  if (ticket.owner) fields.push({ name: "Assigned", value: ticket.owner, inline: true });
  if (ticket.group) fields.push({ name: "Group", value: ticket.group, inline: true });

  embed.addFields(fields);
  embed.addFields({ name: "Zammad", value: `[Open ticket](${ticket.url})`, inline: false });

  return embed;
}

export function ticketUrl(ticketId: number): string {
  const base = env().ZAMMAD_PUBLIC_URL ?? env().ZAMMAD_BASE_URL;
  // Use path-based URL (no fragment) — Discord embeds reject URLs with # fragments
  return `${base}/ticket/zoom/${ticketId}`;
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

  const thread = await discordQueue.add(async () =>
    headerMessage.startThread({
      name: truncate(`#${ticket.number} ${ticket.title}`, 100),
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

export async function updateHeaderEmbed(
  client: Client,
  channelId: string,
  headerMessageId: string,
  ticket: TicketInfo
): Promise<void> {
  const channel = (await client.channels.fetch(channelId)) as TextChannel;
  const msg = await channel.messages.fetch(headerMessageId);
  const embed = buildTicketEmbed(ticket);
  await discordQueue.add(async () => { await msg.edit({ embeds: [embed] }); });
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
  newTitle: string
): Promise<void> {
  const thread = (await client.channels.fetch(threadId)) as ThreadChannel | null;
  if (!thread?.isThread()) {
    logger.warn({ threadId }, "Thread not found or not a thread for rename");
    return;
  }
  const name = truncate(`#${ticketNumber} ${newTitle}`, 100);
  const oldName = thread.name;
  logger.info({ threadId, oldName, newName: name }, "About to rename thread");
  await discordQueue.add(async () => {
    await thread.setName(name, "Ticket title updated in Zammad");
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

  const files = attachments?.map(
    (a) => new AttachmentBuilder(a.data, { name: a.filename })
  );

  const msg = await discordQueue.add(async () =>
    thread.send({
      content: truncate(content, 2000),
      files,
      allowedMentions: { parse: [] },
    })
  ) as Message | undefined;
  return msg?.id ?? null;
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

/** Fetch all guild members with the ticket role and add them to the thread. */
export async function addRoleMembersToThread(thread: ThreadChannel): Promise<void> {
  try {
    const memberIds = await getRoleMemberIds(thread.guild);
    await Promise.allSettled(
      memberIds.map((memberId) =>
        discordQueue.add(async () => { await thread.members.add(memberId); }).catch((err) => {
          logger.debug({ memberId, threadId: thread.id, err }, "Failed to add role member to thread");
        })
      )
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
