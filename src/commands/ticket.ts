import { ChatInputCommandInteraction, ThreadChannel } from "discord.js";
import { logger } from "../util/logger.js";
import {
  getThreadByThreadId,
  getUserMap,
  updateThreadState,
  getTemplate,
  getAllTemplates,
  upsertTemplate,
  deleteTemplate,
  type TicketThread,
} from "../db/index.js";
import {
  updateTicket,
  getStateByName,
  addTimeAccounting,
  createArticle,
  getArticles,
  getTicket,
  getUser,
  searchTickets,
  getTicketByNumber,
  createTicket,
  getTicketTags,
  addTicketTag,
  removeTicketTag,
  mergeTickets,
  getTicketHistory,
  createScheduledArticle,
  getScheduledArticles,
  cancelScheduledArticle,
  createSmsConversation,
  type ArticleAttachment,
} from "../services/zammad.js";
import { ticketUrl, closeTicketThread, removeRoleMembersFromThread } from "../services/threads.js";
import { discordQueue } from "../queue/index.js";
import { parseTime } from "../util/parseTime.js";
import { truncate } from "../util/truncate.js";
import { env } from "../util/env.js";

// ---------------------------------------------------------------
// Handler utilities
// ---------------------------------------------------------------

async function requireMapping(
  interaction: ChatInputCommandInteraction
): Promise<TicketThread | null> {
  const mapping = getThreadByThreadId(interaction.channelId);
  if (!mapping) {
    await interaction.reply({
      content: "This command must be used inside a ticket thread.",
      ephemeral: true,
    });
    return null;
  }

  const caller = getUserMap(interaction.user.id);
  if (!caller) {
    await interaction.reply({
      content:
        "You must be mapped to a Zammad agent before using ticket commands. Ask an admin to run `/setup usermap`.",
      ephemeral: true,
    });
    return null;
  }

  return mapping;
}

// ---------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------

export async function handleClose(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply();

  const closedState = await getStateByName("closed");
  if (!closedState) throw new Error("Could not find 'closed' state in Zammad");

  await updateTicket(mapping.ticket_id, { state_id: closedState.id });

  // Update local DB state IMMEDIATELY so the grace period starts now,
  // preventing the backfill from reopening the thread due to stale Zammad API data
  updateThreadState(mapping.ticket_id, "closed");

  // Immediately close the Discord thread (archive, lock, remove members)
  if (interaction.client && mapping.thread_id) {
    await closeTicketThread(interaction.client, mapping.thread_id);
  }

  await interaction.editReply(`${interaction.user} closed ticket #${mapping.ticket_number}.`);
}

export async function handleAssign(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: true });

  const discordUser = interaction.options.getUser("user", true);
  const userEntry = getUserMap(discordUser.id);
  if (!userEntry?.zammad_id) {
    await interaction.editReply(
      `No Zammad mapping for ${discordUser.username}. Use \`/setup usermap\` first.`
    );
    return;
  }

  await updateTicket(mapping.ticket_id, { owner_id: userEntry.zammad_id });
  await interaction.editReply(
    `Ticket #${mapping.ticket_number} assigned to ${discordUser.username}.`
  );
}

export async function handleTime(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: true });

  const minutes = interaction.options.getNumber("minutes", true);
  await addTimeAccounting({ ticket_id: mapping.ticket_id, time_unit: minutes });
  await interaction.editReply(
    `Logged ${minutes} minutes on ticket #${mapping.ticket_number}.`
  );
}

export async function handlePriority(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: true });

  const priorityId = parseInt(interaction.options.getString("level", true), 10);
  await updateTicket(mapping.ticket_id, { priority_id: priorityId });
  await interaction.editReply(
    `Ticket #${mapping.ticket_number} priority updated.`
  );
}

export async function handleState(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply();

  const stateName = interaction.options.getString("name", true);
  const state = await getStateByName(stateName);
  if (!state) throw new Error(`Unknown state: ${stateName}`);

  await updateTicket(mapping.ticket_id, { state_id: state.id });

  // Immediately update the Discord thread to match the new state
  const normalizedState = stateName.toLowerCase();
  if (normalizedState === "closed" || normalizedState === "closed (locked)") {
    updateThreadState(mapping.ticket_id, normalizedState);
    if (interaction.client && mapping.thread_id) {
      await closeTicketThread(interaction.client, mapping.thread_id);
    }
  } else if (normalizedState === "waiting for reply") {
    updateThreadState(mapping.ticket_id, normalizedState);
    if (interaction.client && mapping.thread_id) {
      await removeRoleMembersFromThread(interaction.client, mapping.thread_id);
      const thread = (await interaction.client.channels.fetch(mapping.thread_id)) as ThreadChannel | null;
      if (thread?.isThread() && !thread.archived) {
        await discordQueue.add(async () => {
          await thread.edit({ archived: true, reason: "Ticket set to waiting for reply" });
        });
      }
    }
  } else if (normalizedState === "pending close") {
    updateThreadState(mapping.ticket_id, normalizedState);
    if (interaction.client && mapping.thread_id) {
      await removeRoleMembersFromThread(interaction.client, mapping.thread_id);
    }
  }

  await interaction.editReply(
    `${interaction.user} changed ticket #${mapping.ticket_number} state to **${stateName}**.`
  );
}

function computeLockExpiry(code: string): string {
  const now = new Date();
  switch (code) {
    case "30m": now.setMinutes(now.getMinutes() + 30); break;
    case "2h": now.setHours(now.getHours() + 2); break;
    case "4h": now.setHours(now.getHours() + 4); break;
    case "8h": now.setHours(now.getHours() + 8); break;
    case "16h": now.setHours(now.getHours() + 16); break;
    case "1d": now.setDate(now.getDate() + 1); break;
    case "2d": now.setDate(now.getDate() + 2); break;
    case "1w": now.setDate(now.getDate() + 7); break;
    case "1M": now.setMonth(now.getMonth() + 1); break;
    default: now.setDate(now.getDate() + 1); break;
  }
  return now.toISOString();
}

export async function handleLock(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply();

  const duration = interaction.options.getString("duration");

  if (duration) {
    // Timed lock: use "closed (locked until)" state with pending_time
    const timedState = await getStateByName("closed (locked until)");
    if (!timedState) throw new Error("Could not find 'closed (locked until)' state in Zammad. This feature requires Zammad-KC.");

    const pendingTime = computeLockExpiry(duration);
    await updateTicket(mapping.ticket_id, { state_id: timedState.id, pending_time: pendingTime });
    updateThreadState(mapping.ticket_id, "closed (locked until)");

    if (interaction.client && mapping.thread_id) {
      await closeTicketThread(interaction.client, mapping.thread_id);
    }

    const expiryDate = new Date(pendingTime);
    const expiryStr = expiryDate.toLocaleString();
    await interaction.editReply(
      `${interaction.user} locked ticket #${mapping.ticket_number} until ${expiryStr}. It will auto-unlock after that.`
    );
  } else {
    // Permanent lock
    const lockedState = await getStateByName("closed (locked)");
    if (!lockedState) throw new Error("Could not find 'closed (locked)' state in Zammad");

    await updateTicket(mapping.ticket_id, { state_id: lockedState.id });
    updateThreadState(mapping.ticket_id, "closed (locked)");

    if (interaction.client && mapping.thread_id) {
      await closeTicketThread(interaction.client, mapping.thread_id);
    }

    await interaction.editReply(
      `${interaction.user} permanently locked ticket #${mapping.ticket_number}. Customers cannot reopen this ticket.`
    );
  }
}

export async function handleInfo(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: true });

  const ticket = await getTicket(mapping.ticket_id);
  let ownerName = "Unassigned";
  if (ticket.owner_id && ticket.owner_id > 1) {
    try {
      const owner = await getUser(ticket.owner_id);
      ownerName = `${owner.firstname} ${owner.lastname}`.trim();
    } catch {
      /* ignore */
    }
  }

  const lines = [
    `**#${ticket.number}** — ${ticket.title}`,
    `State: ${ticket.state}`,
    `Priority: ${ticket.priority}`,
    `Group: ${ticket.group}`,
    `Assigned: ${ownerName}`,
    `Customer: ${ticket.customer}`,
    `Created: ${ticket.created_at}`,
  ];

  // SLA indicator
  if (ticket.escalation_at) {
    const escalation = new Date(ticket.escalation_at);
    if (escalation <= new Date()) {
      lines.push(`SLA: **BREACHED**`);
    } else {
      const diffMs = escalation.getTime() - Date.now();
      const diffMins = Math.round(diffMs / 60_000);
      const timeLeft = diffMins >= 60
        ? `${Math.floor(diffMins / 60)}h ${diffMins % 60}m`
        : `${diffMins}m`;
      lines.push(`SLA: ${timeLeft} remaining`);
    }
  }

  // Tags
  try {
    const tags = await getTicketTags(mapping.ticket_id);
    if (tags.length > 0) {
      lines.push(`Tags: ${tags.join(", ")}`);
    }
  } catch {
    /* non-critical */
  }

  lines.push(`[Open in Zammad](${ticketUrl(ticket.id)})`);
  await interaction.editReply(lines.join("\n"));
}

export async function handleLink(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.reply({
    content: ticketUrl(mapping.ticket_id),
    ephemeral: true,
  });
}

export async function handleNote(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: true });

  const text = interaction.options.getString("text", true);
  const fileOption = interaction.options.getAttachment("file");

  // Get user mapping for attribution
  const userEntry = getUserMap(interaction.user.id);

  let attachments: ArticleAttachment[] | undefined;
  if (fileOption) {
    try {
      const res = await fetch(fileOption.url);
      const buf = Buffer.from(await res.arrayBuffer());
      attachments = [{
        filename: fileOption.name,
        data: buf.toString("base64"),
        "mime-type": fileOption.contentType || "application/octet-stream",
      }];
    } catch (err) {
      logger.warn({ err, filename: fileOption.name }, "Failed to download Discord attachment");
    }
  }

  await createArticle({
    ticket_id: mapping.ticket_id,
    body: text,
    internal: true,
    type: "note",
    sender: "Agent",
    origin_by_id: userEntry?.zammad_id ?? undefined,
    attachments,
  });
  await interaction.editReply(
    `Internal note added to ticket #${mapping.ticket_number}.`
  );
}

/**
 * Detect the ticket's channel type from its articles.
 * Returns the article type name and the "to" address for replies.
 */
export async function detectReplyChannel(
  ticketId: number
): Promise<{ type: string; to: string; label: string } | null> {
  const articles = await getArticles(ticketId);

  // Look for the most recent non-note, non-system article to determine channel type
  // Prefer customer articles, fall back to agent articles
  const channelArticle =
    [...articles].reverse().find((a) => a.type !== "note" && a.sender === "Customer") ??
    [...articles].reverse().find((a) => a.type !== "note" && a.sender !== "System");

  if (!channelArticle) return null;

  const articleType = channelArticle.type;

  switch (articleType) {
    case "email": {
      // For email: get customer email address
      const ticket = await getTicket(ticketId);
      let to: string | undefined;
      if (ticket.customer_id) {
        try {
          const customer = await getUser(ticket.customer_id);
          to = customer.email;
        } catch {
          to = ticket.customer;
        }
      }
      if (!to) return null;
      return { type: "email", to, label: `email to ${to}` };
    }

    case "ringcentral_sms_message": {
      // For SMS: use the customer's phone number from article "from" or customer record
      const ticket = await getTicket(ticketId);
      let to: string | undefined;
      // First try to get from the customer article's "from" field (phone number)
      const customerArticle = [...articles].reverse().find(
        (a) => a.type === "ringcentral_sms_message" && a.sender === "Customer"
      );
      if (customerArticle?.from) {
        to = customerArticle.from;
      }
      if (!to && ticket.customer_id) {
        try {
          const customer = await getUser(ticket.customer_id);
          to = customer.phone || customer.mobile;
        } catch {
          /* ignore */
        }
      }
      if (!to) return null;
      return { type: "ringcentral_sms_message", to, label: `SMS to ${to}` };
    }

    case "teams_chat_message": {
      // For Teams: use the customer name from article "from" field
      const customerArticle = [...articles].reverse().find(
        (a) => a.type === "teams_chat_message" && a.sender === "Customer"
      );
      const to = customerArticle?.from || channelArticle.to || channelArticle.from || "";
      return { type: "teams_chat_message", to, label: `Teams message to ${to}` };
    }

    default:
      // Unknown channel type (phone, web, etc.) — default to email
      const ticket = await getTicket(ticketId);
      let to: string | undefined;
      if (ticket.customer_id) {
        try {
          const customer = await getUser(ticket.customer_id);
          to = customer.email;
        } catch {
          to = ticket.customer;
        }
      }
      if (!to) return null;
      return { type: "email", to, label: `email to ${to}` };
  }
}

export async function handleReply(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: true });

  const text = interaction.options.getString("text", true);
  const ccInput = interaction.options.getString("cc");
  const fileOption = interaction.options.getAttachment("file");

  const channel = await detectReplyChannel(mapping.ticket_id);
  if (!channel) {
    await interaction.editReply(
      "Could not determine reply channel for this ticket. No customer articles found."
    );
    return;
  }

  // Get user mapping for attribution
  const userEntry = getUserMap(interaction.user.id);

  // Parse CC emails (only applies to email tickets)
  let cc: string | undefined;
  let ccIgnored = false;
  if (ccInput) {
    if (channel.type === "email") {
      const ccEmails = ccInput.split(',').map(e => e.trim()).filter(e => e.length > 0);
      if (ccEmails.length > 0) {
        cc = ccEmails.join(', ');
      }
    } else {
      ccIgnored = true;
    }
  }

  // Download attachment from Discord and base64-encode for Zammad
  let attachments: ArticleAttachment[] | undefined;
  if (fileOption) {
    try {
      const res = await fetch(fileOption.url);
      const buf = Buffer.from(await res.arrayBuffer());
      attachments = [{
        filename: fileOption.name,
        data: buf.toString("base64"),
        "mime-type": fileOption.contentType || "application/octet-stream",
      }];
    } catch (err) {
      logger.warn({ err, filename: fileOption.name }, "Failed to download Discord attachment");
    }
  }

  // Note: origin_by_id is only sent for email - Zammad has a bug where setting
  // origin_by_id forces sender to "Customer" for non-email types, which breaks
  // Teams/SMS delivery (the communicate job checks for sender="Agent").
  await createArticle({
    ticket_id: mapping.ticket_id,
    body: text,
    subject: channel.type === "email" ? (mapping.title || undefined) : undefined,
    type: channel.type,
    sender: "Agent",
    internal: false,
    content_type: "text/plain",
    to: channel.to,
    cc,
    origin_by_id: channel.type === "email" ? (userEntry?.zammad_id ?? undefined) : undefined,
    attachments,
  });

  const fileSuffix = fileOption ? ` with attachment "${fileOption.name}"` : "";
  const ccSuffix = cc ? ` (CC: ${cc})` : "";
  const ccWarning = ccIgnored ? "\n⚠️ CC was ignored — only supported for email tickets." : "";
  await interaction.editReply(
    `Reply sent (${channel.label})${fileSuffix}${ccSuffix} on ticket #${mapping.ticket_number}.${ccWarning}`
  );
}

// ---------------------------------------------------------------
// /pending command handler
// ---------------------------------------------------------------

function computePendingTime(code: string): string {
  const now = new Date();
  switch (code) {
    case "1d": now.setDate(now.getDate() + 1); break;
    case "3d": now.setDate(now.getDate() + 3); break;
    case "1w": now.setDate(now.getDate() + 7); break;
    case "2w": now.setDate(now.getDate() + 14); break;
    case "1m": now.setMonth(now.getMonth() + 1); break;
    case "3m": now.setMonth(now.getMonth() + 3); break;
    default: now.setDate(now.getDate() + 1); break;
  }
  return now.toISOString();
}

export async function handlePending(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply();

  const type = interaction.options.getString("type", true);
  const duration = interaction.options.getString("duration", true);

  const state = await getStateByName(type);
  if (!state) throw new Error(`Unknown state: ${type}`);

  const pendingTime = computePendingTime(duration);
  await updateTicket(mapping.ticket_id, { state_id: state.id, pending_time: pendingTime });
  await interaction.editReply(
    `${interaction.user} set ticket #${mapping.ticket_number} to **${type}** until ${new Date(pendingTime).toLocaleDateString()}.`
  );
}

export async function handleOwner(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: true });

  // Default to the caller if no user specified
  const discordUser = interaction.options.getUser("user") ?? interaction.user;
  const userEntry = getUserMap(discordUser.id);
  if (!userEntry?.zammad_id) {
    await interaction.editReply(
      `No Zammad mapping for ${discordUser.username}. Use \`/setup usermap\` first.`
    );
    return;
  }

  await updateTicket(mapping.ticket_id, { owner_id: userEntry.zammad_id });
  await interaction.editReply(
    `Ticket #${mapping.ticket_number} assigned to ${discordUser.username}.`
  );
}

// ---------------------------------------------------------------
// Admin check (reuses env ADMIN_USER_IDS)
// ---------------------------------------------------------------

function isAdmin(userId: string): boolean {
  const ids = env().ADMIN_USER_IDS;
  return ids.length === 0 || ids.includes(userId);
}

// ---------------------------------------------------------------
// /search
// ---------------------------------------------------------------

export async function handleSearch(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const query = interaction.options.getString("query", true);
  const results = await searchTickets(query, 10);

  if (results.length === 0) {
    await interaction.editReply("No tickets found.");
    return;
  }

  const lines = results.map(
    (t) => `**#${t.number}** — ${truncate(t.title, 60)} [${t.state}] — [Open](${ticketUrl(t.id)})`
  );
  await interaction.editReply(truncate(lines.join("\n"), 2000));
}

// ---------------------------------------------------------------
// /tags (list | add | remove)
// ---------------------------------------------------------------

export async function handleTags(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: true });

  switch (sub) {
    case "list": {
      const tags = await getTicketTags(mapping.ticket_id);
      await interaction.editReply(
        tags.length > 0 ? `Tags: ${tags.join(", ")}` : "No tags on this ticket."
      );
      break;
    }
    case "add": {
      const tag = interaction.options.getString("tag", true);
      await addTicketTag(mapping.ticket_id, tag);
      await interaction.editReply(`Tag **${tag}** added to ticket #${mapping.ticket_number}.`);
      break;
    }
    case "remove": {
      const tag = interaction.options.getString("tag", true);
      await removeTicketTag(mapping.ticket_id, tag);
      await interaction.editReply(`Tag **${tag}** removed from ticket #${mapping.ticket_number}.`);
      break;
    }
  }
}

// ---------------------------------------------------------------
// /merge
// ---------------------------------------------------------------

export async function handleMerge(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply();

  const targetNumber = interaction.options.getString("target", true);
  const targetTicket = await getTicketByNumber(targetNumber);

  if (!targetTicket) {
    await interaction.editReply(`Could not find ticket #${targetNumber}.`);
    return;
  }

  if (targetTicket.id === mapping.ticket_id) {
    await interaction.editReply("Cannot merge a ticket into itself.");
    return;
  }

  await mergeTickets(mapping.ticket_id, targetTicket.id);
  updateThreadState(mapping.ticket_id, "merged");
  await closeTicketThread(interaction.client, mapping.thread_id);
  await interaction.editReply(
    `Ticket #${mapping.ticket_number} merged into #${targetNumber}. Thread closed.`
  );
}

// ---------------------------------------------------------------
// /history
// ---------------------------------------------------------------

export async function handleHistory(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: true });

  const history = await getTicketHistory(mapping.ticket_id);

  if (history.length === 0) {
    await interaction.editReply("No history entries found.");
    return;
  }

  // Show last 15 entries
  const recent = history.slice(-15);
  const lines = recent.map((h) => {
    const ts = new Date(h.created_at).toLocaleString();
    if (h.attribute && h.value_from !== undefined) {
      return `\`${ts}\` **${h.attribute}**: ${h.value_from || "(empty)"} → ${h.value_to || "(empty)"}`;
    }
    return `\`${ts}\` ${h.type}: ${h.object}`;
  });

  await interaction.editReply(truncate(lines.join("\n"), 2000));
}

// ---------------------------------------------------------------
// /schedule, /schedules, /unschedule
// ---------------------------------------------------------------

export async function handleSchedule(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: true });

  const text = interaction.options.getString("text", true);
  const timeInput = interaction.options.getString("time", true);
  const scheduledAt = parseTime(timeInput);

  if (!scheduledAt) {
    await interaction.editReply(
      'Could not parse time. Use formats like: `2h`, `1d`, `tomorrow 9am`, or an ISO date.'
    );
    return;
  }

  // Detect reply channel to set article type
  const channel = await detectReplyChannel(mapping.ticket_id);
  const articleType = channel?.type ?? "email";

  await createScheduledArticle({
    ticket_id: mapping.ticket_id,
    body: text,
    scheduled_at: scheduledAt,
    article_type: articleType,
    to: channel?.to,
  });

  await interaction.editReply(
    `Reply scheduled for ${new Date(scheduledAt).toLocaleString()} on ticket #${mapping.ticket_number}.`
  );
}

export async function handleSchedules(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: true });

  const articles = await getScheduledArticles(mapping.ticket_id);

  if (articles.length === 0) {
    await interaction.editReply("No scheduled replies for this ticket.");
    return;
  }

  const lines = articles.map(
    (a) =>
      `**ID ${a.id}** — ${new Date(a.scheduled_at).toLocaleString()}: ${truncate(a.body, 80)}`
  );
  await interaction.editReply(truncate(lines.join("\n"), 2000));
}

export async function handleUnschedule(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: true });

  const idStr = interaction.options.getString("id", true);
  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    await interaction.editReply("Invalid ID. Please provide a numeric ID.");
    return;
  }

  await cancelScheduledArticle(id);
  await interaction.editReply(`Scheduled reply #${id} cancelled.`);
}

// ---------------------------------------------------------------
// /newticket
// ---------------------------------------------------------------

export async function handleNewTicket(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const type = interaction.options.getString("type", true);
  const to = interaction.options.getString("to", true);
  const subject = interaction.options.getString("subject", true);
  const body = interaction.options.getString("body", true);

  const userEntry = getUserMap(interaction.user.id);
  if (!userEntry) {
    await interaction.editReply(
      "You must be mapped to a Zammad agent. Ask an admin to run `/setup usermap`."
    );
    return;
  }

  try {
    let ticket;

    switch (type) {
      case "email":
        ticket = await createTicket({
          title: subject,
          group: "Users",
          customer: to,
          article: {
            subject,
            body,
            type: "email",
            sender: "Agent",
            internal: false,
            content_type: "text/plain",
            to,
          },
        });
        break;

      case "sms":
        ticket = await createSmsConversation({ to, body });
        break;

      case "phone":
        ticket = await createTicket({
          title: subject,
          group: "Users",
          customer: to,
          article: {
            subject,
            body,
            type: "note",
            sender: "Agent",
            internal: true,
            content_type: "text/plain",
          },
        });
        break;

      default:
        await interaction.editReply("Unknown ticket type.");
        return;
    }

    await interaction.editReply(
      `Ticket #${ticket.number} created (${type}). ${ticketUrl(ticket.id)}`
    );
  } catch (err) {
    logger.error({ err, type, to }, "Failed to create new ticket");
    const msg = err instanceof Error ? err.message : "Unknown error";
    await interaction.editReply(`Failed to create ticket: ${msg}`);
  }
}

// ---------------------------------------------------------------
// /template (use | list | add | remove)
// ---------------------------------------------------------------

export async function handleTemplate(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case "use": {
      const mapping = await requireMapping(interaction);
      if (!mapping) return;
      await interaction.deferReply({ ephemeral: true });

      const name = interaction.options.getString("name", true);
      const template = getTemplate(name);
      if (!template) {
        await interaction.editReply(`Template "${name}" not found. Use \`/template list\` to see available templates.`);
        return;
      }

      const channel = await detectReplyChannel(mapping.ticket_id);
      if (!channel) {
        await interaction.editReply(
          "Could not determine reply channel for this ticket."
        );
        return;
      }

      const userEntry = getUserMap(interaction.user.id);

      await createArticle({
        ticket_id: mapping.ticket_id,
        body: template.body,
        subject: channel.type === "email" ? (mapping.title || undefined) : undefined,
        type: channel.type,
        sender: "Agent",
        internal: false,
        content_type: "text/plain",
        to: channel.to,
        origin_by_id: channel.type === "email" ? (userEntry?.zammad_id ?? undefined) : undefined,
      });

      await interaction.editReply(
        `Template "${name}" sent (${channel.label}) on ticket #${mapping.ticket_number}.`
      );
      break;
    }

    case "list": {
      await interaction.deferReply({ ephemeral: true });
      const templates = getAllTemplates();
      if (templates.length === 0) {
        await interaction.editReply("No templates saved. Use `/template add` to create one.");
        return;
      }
      const lines = templates.map(
        (t) => `**${t.name}** — ${truncate(t.body, 60)}`
      );
      await interaction.editReply(truncate(lines.join("\n"), 2000));
      break;
    }

    case "add": {
      if (!isAdmin(interaction.user.id)) {
        await interaction.reply({ content: "Only admins can add templates.", ephemeral: true });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      const name = interaction.options.getString("name", true);
      const body = interaction.options.getString("body", true);
      upsertTemplate(name, body, interaction.user.id);
      await interaction.editReply(`Template "${name}" saved.`);
      break;
    }

    case "remove": {
      if (!isAdmin(interaction.user.id)) {
        await interaction.reply({ content: "Only admins can remove templates.", ephemeral: true });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      const name = interaction.options.getString("name", true);
      const deleted = deleteTemplate(name);
      await interaction.editReply(
        deleted ? `Template "${name}" removed.` : `Template "${name}" not found.`
      );
      break;
    }
  }
}

// ---------------------------------------------------------------
// /ai — AI suggested response
// ---------------------------------------------------------------

export async function handleAi(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: true });

  try {
    // Dynamic import to avoid errors when AI deps aren't installed
    const { isAIConfigured, buildTicketContext, aiChat } = await import("../services/ai.js");

    if (!isAIConfigured()) {
      await interaction.editReply(
        "AI is not configured. Set AI_API_KEY or use `/setup ai` to enable AI features."
      );
      return;
    }

    const context = await buildTicketContext(mapping.ticket_id);
    const response = await aiChat(
      "You are an assistant helping a support agent draft a reply. " +
        "The ticket context below identifies the assigned agent and the customer(s). " +
        "Draft a response FROM the assigned agent TO the customer. " +
        "Do NOT impersonate or sign as any customer. " +
        "Do NOT include email signatures, disclaimers, or quoted previous messages. " +
        "Keep it concise, professional, and actionable.\n\n" +
        context,
      "Draft a reply that the assigned agent should send to the customer."
    );

    await interaction.editReply(truncate(`**Suggested Response:**\n\`\`\`\n${response}\n\`\`\``, 2000));
  } catch (err) {
    logger.error({ err }, "AI command failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    await interaction.editReply(`AI suggestion failed: ${msg}`);
  }
}

// ---------------------------------------------------------------
// /aihelp — AI troubleshooting with web search
// ---------------------------------------------------------------

export async function handleAiHelp(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: true });

  try {
    const { isAIConfigured, buildTicketContext, aiChat } = await import("../services/ai.js");
    const { isSearchConfigured, webSearch } = await import("../services/search.js");

    if (!isAIConfigured()) {
      await interaction.editReply(
        "AI is not configured. Set AI_API_KEY or use `/setup ai` to enable AI features."
      );
      return;
    }

    const context = await buildTicketContext(mapping.ticket_id);

    // If search is configured, augment with web results
    let searchResults = "";
    if (isSearchConfigured()) {
      try {
        const ticket = await getTicket(mapping.ticket_id);
        const searchQuery = ticket.title;
        const results = await webSearch(searchQuery);
        if (results) {
          searchResults = `\n\nWeb search results for "${searchQuery}":\n${results}`;
        }
      } catch (err) {
        logger.warn({ err }, "Web search failed for aihelp, proceeding without");
      }
    }

    const response = await aiChat(
      "You are an assistant helping a support agent troubleshoot a customer issue. " +
        "The ticket context below identifies the assigned agent and the customer(s). " +
        "Provide troubleshooting steps that the AGENT can use or share with the customer. " +
        "Do NOT impersonate any customer. Be specific and actionable.\n\n" +
        context +
        searchResults,
      "Provide troubleshooting steps for this issue."
    );

    await interaction.editReply(truncate(`**Troubleshooting Help:**\n\`\`\`\n${response}\n\`\`\``, 2000));
  } catch (err) {
    logger.error({ err }, "AI help command failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    await interaction.editReply(`AI help failed: ${msg}`);
  }
}
