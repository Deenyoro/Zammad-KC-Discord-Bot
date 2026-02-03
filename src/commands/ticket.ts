import { ChatInputCommandInteraction } from "discord.js";
import { logger } from "../util/logger.js";
import { getThreadByThreadId, getUserMap, type TicketThread } from "../db/index.js";
import {
  updateTicket,
  getStateByName,
  addTimeAccounting,
  createArticle,
  getArticles,
  getTicket,
  getUser,
  type ArticleAttachment,
} from "../services/zammad.js";
import { ticketUrl, closeTicketThread } from "../services/threads.js";

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
  await interaction.editReply(
    `${interaction.user} changed ticket #${mapping.ticket_number} state to **${stateName}**.`
  );
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
    `[Open in Zammad](${ticketUrl(ticket.id)})`,
  ];
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
async function detectReplyChannel(
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

  // Parse CC emails (only used for email tickets)
  let cc: string | undefined;
  if (ccInput && channel.type === "email") {
    // Split by comma, trim whitespace, filter out empty strings
    const ccEmails = ccInput.split(',').map(e => e.trim()).filter(e => e.length > 0);
    if (ccEmails.length > 0) {
      cc = ccEmails.join(', ');
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
    origin_by_id: userEntry?.zammad_id ?? undefined,
    attachments,
  });

  const fileSuffix = fileOption ? ` with attachment "${fileOption.name}"` : "";
  const ccSuffix = cc ? ` (CC: ${cc})` : "";
  await interaction.editReply(
    `Reply sent (${channel.label})${fileSuffix}${ccSuffix} on ticket #${mapping.ticket_number}.`
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
