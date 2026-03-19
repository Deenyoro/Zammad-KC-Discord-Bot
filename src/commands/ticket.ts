import { ChatInputCommandInteraction, ThreadChannel } from "discord.js";
import { logger } from "../util/logger.js";
import {
  getThreadByThreadId,
  getAllTicketThreads,
  getUserMap,
  updateThreadState,
  upsertTicketThread,
  getSettingOrEnv,
  getSetting,
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
  getTextModules,
  findTextModule,
  expandTextModules,
  clearTextModulesCache,
  type ArticleAttachment,
} from "../services/zammad.js";
import { ticketUrl, closeTicketThread, removeRoleMembersFromThread, renameTicketThread, formatOwnerLabel } from "../services/threads.js";
import { discordQueue } from "../queue/index.js";
import { parseTime } from "../util/parseTime.js";
import { formatInBotTz, getBotTimezone } from "../util/timezone.js";
import { truncate, splitMessage } from "../util/truncate.js";
import { env } from "../util/env.js";
import { getAttachmentLimits } from "../util/attachmentLimits.js";
import { isValidEmail, parseEmailAddress, parseDisplayName } from "../util/email.js";
import { canConvert, convertFile, type ConvertTarget } from "../util/fileConvert.js";

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

  // Add an internal note before closing if provided
  const noteText = interaction.options.getString("note");
  if (noteText) {
    const userEntry = getUserMap(interaction.user.id);
    const { expanded: body, contentType } = await expandTextModules(noteText);
    await createArticle({
      ticket_id: mapping.ticket_id,
      body,
      internal: true,
      type: "note",
      sender: "Agent",
      content_type: contentType,
      origin_by_id: userEntry?.zammad_id ?? undefined,
    });
  }

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

  const noteSuffix = noteText ? " (internal note added)" : "";
  await interaction.editReply(`${interaction.user} closed ticket #${mapping.ticket_number}.${noteSuffix}`);
}

export async function handleAssign(interaction: ChatInputCommandInteraction) {
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

  // Rename thread to reflect new owner
  try {
    const owner = await getUser(userEntry.zammad_id);
    const ownerLabel = formatOwnerLabel(owner.firstname, owner.lastname);
    await renameTicketThread(
      interaction.client,
      mapping.thread_id,
      mapping.ticket_number,
      mapping.title || "",
      ownerLabel
    );
  } catch (err) {
    logger.warn({ err, ticketId: mapping.ticket_id }, "Failed to rename thread after assign");
  }

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

export async function handleRename(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply();

  const newTitle = interaction.options.getString("title", true).trim();
  if (!newTitle) {
    await interaction.editReply("Title cannot be empty.");
    return;
  }

  await updateTicket(mapping.ticket_id, { title: newTitle });

  // Update the Discord thread name and local DB
  if (mapping.thread_id) {
    let ownerLabel: string | undefined;
    try {
      const ticket = await getTicket(mapping.ticket_id);
      if (ticket.owner_id && ticket.owner_id !== 1) {
        const owner = await getUser(ticket.owner_id);
        ownerLabel = formatOwnerLabel(owner.firstname, owner.lastname);
      }
    } catch {
      // Non-critical — thread rename will just omit owner label
    }
    await renameTicketThread(interaction.client, mapping.thread_id, mapping.ticket_number, newTitle, ownerLabel);
  }
  upsertTicketThread({ ...mapping, title: newTitle });

  await interaction.editReply(
    `${interaction.user} renamed ticket #${mapping.ticket_number} to **${newTitle}**.`
  );
}

function computeLockExpiry(code: string): string {
  const now = new Date();
  switch (code) {
    case "15m": now.setMinutes(now.getMinutes() + 15); break;
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

    const expiryStr = formatInBotTz(pendingTime);
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

// ---------------------------------------------------------------
// /participants command handler
// ---------------------------------------------------------------

export async function handleParticipants(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: true });

  const [articles, ticket] = await Promise.all([
    getArticles(mapping.ticket_id),
    getTicket(mapping.ticket_id),
  ]);

  // Collect all addresses from all articles (from, to, cc)
  const participants = new Map<string, { name: string | null; roles: Set<string> }>();

  function addParticipant(raw: string | undefined, role: string): void {
    if (!raw) return;
    // Fields can contain multiple comma-separated addresses
    for (const part of raw.split(",")) {
      const email = parseEmailAddress(part.trim());
      if (!email) continue;
      const lower = email.toLowerCase();
      const existing = participants.get(lower);
      if (existing) {
        existing.roles.add(role);
        // Keep the first non-null name we found
        if (!existing.name) existing.name = parseDisplayName(part.trim());
      } else {
        participants.set(lower, {
          name: parseDisplayName(part.trim()),
          roles: new Set([role]),
        });
      }
    }
  }

  for (const a of articles) {
    if (a.sender === "System") continue;

    if (a.sender === "Customer") {
      addParticipant(a.from, "Customer");
      addParticipant(a.to, "Recipient");
    } else {
      // Agent article
      addParticipant(a.from, "Agent");
      addParticipant(a.to, "Recipient");
    }
    addParticipant(a.cc, "CC");
  }

  // Ensure the ticket customer is always listed
  if (ticket.customer_id) {
    try {
      const customer = await getUser(ticket.customer_id);
      if (customer.email) {
        const lower = customer.email.toLowerCase();
        const existing = participants.get(lower);
        if (existing) {
          existing.roles.add("Customer");
          if (!existing.name) existing.name = `${customer.firstname} ${customer.lastname}`.trim();
        } else {
          participants.set(lower, {
            name: `${customer.firstname} ${customer.lastname}`.trim() || null,
            roles: new Set(["Customer"]),
          });
        }
      }
    } catch { /* customer lookup failed — non-fatal */ }
  }

  if (participants.size === 0) {
    await interaction.editReply("No email participants found on this ticket.");
    return;
  }

  // Sort: customers first, then recipients, then CC, then agents
  const roleOrder = (roles: Set<string>): number => {
    if (roles.has("Customer")) return 0;
    if (roles.has("Recipient")) return 1;
    if (roles.has("CC")) return 2;
    return 3;
  };

  const sorted = [...participants.entries()].sort(
    (a, b) => roleOrder(a[1].roles) - roleOrder(b[1].roles)
  );

  const lines = sorted.map(([email, data]) => {
    const nameLabel = data.name ? ` (${data.name})` : "";
    const roleLabel = [...data.roles].join(", ");
    return `\`${email}\`${nameLabel} — ${roleLabel}`;
  });

  await interaction.editReply(
    truncate(
      `**Participants on ticket #${mapping.ticket_number}:**\n${lines.join("\n")}\n\n_Use \`/reply to:<email>\` to reply to a specific address._`,
      2000
    )
  );
}

export async function handleNote(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: true });

  const rawText = interaction.options.getString("text", true);
  const fileOption = interaction.options.getAttachment("file");

  // Expand ::shortcut text modules before sending
  const { expanded: text, contentType } = await expandTextModules(rawText);

  // Get user mapping for attribution
  const userEntry = getUserMap(interaction.user.id);

  const fileSizeLimit = getAttachmentLimits().perFileBytes;
  let attachments: ArticleAttachment[] | undefined;
  if (fileOption) {
    if (fileOption.size > fileSizeLimit) {
      logger.warn({ filename: fileOption.name, size: fileOption.size, limit: fileSizeLimit }, "Skipping oversized slash command attachment");
    } else {
      try {
        const res = await fetch(fileOption.url, { signal: AbortSignal.timeout(60_000) });
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > fileSizeLimit) {
          logger.warn({ filename: fileOption.name, actual: buf.byteLength }, "Attachment larger than declared");
        } else {
          attachments = [{
            filename: fileOption.name,
            data: buf.toString("base64"),
            "mime-type": fileOption.contentType || "application/octet-stream",
          }];
        }
      } catch (err) {
        logger.warn({ err, filename: fileOption.name }, "Failed to download Discord attachment");
      }
    }
  }

  await createArticle({
    ticket_id: mapping.ticket_id,
    body: text,
    internal: true,
    type: "note",
    sender: "Agent",
    content_type: contentType,
    origin_by_id: userEntry?.zammad_id ?? undefined,
    attachments,
  });

  const shouldClose = !!interaction.options.getString("close");
  let closeSuffix = "";
  if (shouldClose) {
    const closedState = await getStateByName("closed");
    if (!closedState) throw new Error("Could not find 'closed' state in Zammad");
    await updateTicket(mapping.ticket_id, { state_id: closedState.id });
    updateThreadState(mapping.ticket_id, "closed");
    if (interaction.client && mapping.thread_id) {
      await closeTicketThread(interaction.client, mapping.thread_id);
    }
    closeSuffix = " — ticket closed.";
  }

  await interaction.editReply(
    `Internal note added to ticket #${mapping.ticket_number}.${closeSuffix}`
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

// ---------------------------------------------------------------
// /reply autocomplete — suggests ticket participants for to/cc
// ---------------------------------------------------------------

export async function handleReplyAutocomplete(
  interaction: import("discord.js").AutocompleteInteraction
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "to" && focused.name !== "cc") return;

  const mapping = getThreadByThreadId(interaction.channelId);
  if (!mapping) {
    await interaction.respond([]);
    return;
  }

  try {
    const articles = await getArticles(mapping.ticket_id);

    // Collect unique emails from all articles
    const seen = new Map<string, string>(); // lowercase email → display label
    for (const a of articles) {
      if (a.sender === "System") continue;
      for (const field of [a.from, a.to, a.cc]) {
        if (!field) continue;
        for (const part of field.split(",")) {
          const email = parseEmailAddress(part.trim());
          if (!email) continue;
          const lower = email.toLowerCase();
          if (!seen.has(lower)) {
            const name = parseDisplayName(part.trim());
            seen.set(lower, name ? `${name} <${email}>` : email);
          }
        }
      }
    }

    // Also ensure ticket customer is listed
    try {
      const ticket = await getTicket(mapping.ticket_id);
      if (ticket.customer_id) {
        const customer = await getUser(ticket.customer_id);
        if (customer.email) {
          const lower = customer.email.toLowerCase();
          if (!seen.has(lower)) {
            const name = `${customer.firstname} ${customer.lastname}`.trim();
            seen.set(lower, name ? `${name} <${customer.email}>` : customer.email);
          }
        }
      }
    } catch { /* non-fatal */ }

    // Filter by what the user has typed so far
    const query = focused.value.toLowerCase();
    const choices = [...seen.entries()]
      .filter(([email, label]) => email.includes(query) || label.toLowerCase().includes(query))
      .slice(0, 25) // Discord max autocomplete choices
      .map(([email, label]) => ({
        name: label.length > 100 ? label.slice(0, 97) + "..." : label,
        value: email,
      }));

    await interaction.respond(choices);
  } catch (err) {
    logger.debug({ err }, "Autocomplete failed — returning empty");
    await interaction.respond([]);
  }
}

export async function handleReply(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: true });

  const rawText = interaction.options.getString("text", true);
  const toOverride = interaction.options.getString("to");
  const ccInput = interaction.options.getString("cc");
  const fileOption = interaction.options.getAttachment("file");
  const convertOption = interaction.options.getString("convert") as ConvertTarget | null;

  // Validate and normalize "to" override — accepts bare email, "Name <email>", mailto:, etc.
  let parsedTo: string | null = null;
  if (toOverride) {
    parsedTo = parseEmailAddress(toOverride);
    if (!parsedTo) {
      await interaction.editReply(`Invalid email address: \`${toOverride.trim()}\`\nUse \`/participants\` to see valid addresses.`);
      return;
    }
  }

  // Expand ::shortcut text modules before sending
  const { expanded: text, contentType, used: expandedModules } = await expandTextModules(rawText);

  const channel = await detectReplyChannel(mapping.ticket_id);
  if (!channel) {
    await interaction.editReply(
      "Could not determine reply channel for this ticket. No customer articles found."
    );
    return;
  }

  // Apply to override — only for email tickets; silently ignored for SMS/Teams
  let toIgnored = false;
  if (parsedTo) {
    if (channel.type === "email") {
      channel.to = parsedTo;
      channel.label = `email to ${parsedTo}`;
    } else {
      toIgnored = true;
    }
  }

  // Get user mapping for attribution
  const userEntry = getUserMap(interaction.user.id);

  // Parse and validate CC emails (only applies to email tickets)
  let cc: string | undefined;
  let ccIgnored = false;
  if (ccInput) {
    if (channel.type === "email") {
      const ccRaw = ccInput.split(',').map(e => e.trim()).filter(e => e.length > 0);
      const ccEmails: string[] = [];
      const invalid: string[] = [];
      for (const raw of ccRaw) {
        const parsed = parseEmailAddress(raw);
        if (parsed) ccEmails.push(parsed);
        else invalid.push(raw);
      }
      if (invalid.length > 0) {
        await interaction.editReply(`Invalid CC email(s): ${invalid.map(e => `\`${e}\``).join(", ")}`);
        return;
      }
      if (ccEmails.length > 0) {
        cc = ccEmails.join(', ');
      }
    } else {
      ccIgnored = true;
    }
  }

  // Download attachment from Discord, optionally convert, and base64-encode for Zammad
  const replyFileLimit = getAttachmentLimits().perFileBytes;
  let attachments: ArticleAttachment[] | undefined;
  let convertedLabel = "";
  if (fileOption) {
    if (fileOption.size > replyFileLimit) {
      logger.warn({ filename: fileOption.name, size: fileOption.size, limit: replyFileLimit }, "Skipping oversized reply attachment");
    } else {
      try {
        const res = await fetch(fileOption.url, { signal: AbortSignal.timeout(60_000) });
        let buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > replyFileLimit) {
          logger.warn({ filename: fileOption.name, actual: buf.byteLength }, "Reply attachment larger than declared");
        } else {
          let finalName = fileOption.name;
          let finalMime = fileOption.contentType || "application/octet-stream";

          // Convert if requested and the file type is applicable
          if (convertOption && canConvert(fileOption.name, convertOption)) {
            const converted = await convertFile(buf, fileOption.name, convertOption);
            if (converted) {
              buf = Buffer.from(converted.data) as typeof buf;
              finalName = converted.filename;
              finalMime = converted.mimeType;
              convertedLabel = ` (converted to ${convertOption.toUpperCase()})`;
              logger.info({ from: fileOption.name, to: finalName }, "Converted attachment");
            } else {
              // Conversion failed — use original, don't block the reply
              logger.warn({ filename: fileOption.name, target: convertOption }, "Conversion unavailable, using original");
            }
          }

          // Re-check size after conversion (PNG/PDF may be larger)
          if (buf.byteLength > replyFileLimit) {
            logger.warn({ filename: finalName, size: buf.byteLength }, "Converted file exceeds size limit, using original");
            // Fall back to original download
            const origRes = await fetch(fileOption.url, { signal: AbortSignal.timeout(60_000) });
            buf = Buffer.from(await origRes.arrayBuffer());
            finalName = fileOption.name;
            finalMime = fileOption.contentType || "application/octet-stream";
            convertedLabel = "";
          }

          attachments = [{
            filename: finalName,
            data: buf.toString("base64"),
            "mime-type": finalMime,
          }];
        }
      } catch (err) {
        logger.warn({ err, filename: fileOption.name }, "Failed to download Discord attachment");
      }
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
    content_type: contentType,
    to: channel.to,
    cc,
    origin_by_id: channel.type === "email" ? (userEntry?.zammad_id ?? undefined) : undefined,
    attachments,
  });

  const shouldClose = !!interaction.options.getString("close");
  let closeSuffix = "";
  if (shouldClose) {
    const closedState = await getStateByName("closed");
    if (!closedState) throw new Error("Could not find 'closed' state in Zammad");
    await updateTicket(mapping.ticket_id, { state_id: closedState.id });
    updateThreadState(mapping.ticket_id, "closed");
    if (interaction.client && mapping.thread_id) {
      await closeTicketThread(interaction.client, mapping.thread_id);
    }
    closeSuffix = " — ticket closed.";
  }

  const fileSuffix = fileOption ? ` with attachment "${fileOption.name}"${convertedLabel}` : "";
  const ccSuffix = cc ? ` (CC: ${cc})` : "";
  const toWarning = toIgnored ? "\n⚠️ `to:` was ignored — only supported for email tickets." : "";
  const ccWarning = ccIgnored ? "\n⚠️ `cc:` was ignored — only supported for email tickets." : "";
  const tmSuffix = expandedModules.length > 0 ? `\n📝 Expanded: ${expandedModules.join(", ")}` : "";
  await interaction.editReply(
    `Reply sent (${channel.label})${fileSuffix}${ccSuffix} on ticket #${mapping.ticket_number}.${closeSuffix}${toWarning}${ccWarning}${tmSuffix}`
  );
}

// ---------------------------------------------------------------
// /replyall command handler — replies to all To + CC from last email
// ---------------------------------------------------------------

export async function handleReplyAll(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: true });

  const rawText = interaction.options.getString("text", true);
  const fileOption = interaction.options.getAttachment("file");
  const convertOption = interaction.options.getString("convert") as ConvertTarget | null;

  // Expand ::shortcut text modules before sending
  const { expanded: text, contentType, used: expandedModules } = await expandTextModules(rawText);

  // Find the last email article to extract recipients
  const articles = await getArticles(mapping.ticket_id);
  const lastEmail = [...articles].reverse().find(
    (a) => a.type === "email" && (a.sender === "Customer" || a.sender === "Agent")
  );

  if (!lastEmail) {
    await interaction.editReply("No email articles found on this ticket. Use `/reply` instead.");
    return;
  }

  // Get the ticket's customer email (this is who we always reply TO)
  const ticket = await getTicket(mapping.ticket_id);
  let customerEmail: string | undefined;
  if (ticket.customer_id) {
    try {
      const customer = await getUser(ticket.customer_id);
      customerEmail = customer.email?.toLowerCase();
    } catch { /* ignore */ }
  }

  if (!customerEmail) {
    await interaction.editReply("Could not determine customer email address.");
    return;
  }

  // Collect all unique email addresses from the last email's to/cc/from fields
  // We'll put the customer in TO and everyone else in CC
  const allAddresses = new Set<string>();

  for (const field of [lastEmail.from, lastEmail.to, lastEmail.cc]) {
    if (!field) continue;
    for (const part of field.split(",")) {
      const email = parseEmailAddress(part.trim());
      if (email) allAddresses.add(email.toLowerCase());
    }
  }

  // Remove the customer (goes in TO) and our own support addresses
  // Get agent emails from user_map to exclude them too
  const agentEmail = getUserMap(interaction.user.id)?.zammad_email?.toLowerCase();
  const excludeSet = new Set<string>();
  excludeSet.add(customerEmail);
  if (agentEmail) excludeSet.add(agentEmail);

  // Exclude any Zammad system/channel email addresses (common support@ addresses)
  // by checking if the address matches the "from" of any agent article
  for (const a of articles) {
    if (a.sender === "Agent" && a.from) {
      const agentFrom = parseEmailAddress(a.from);
      if (agentFrom) excludeSet.add(agentFrom.toLowerCase());
    }
  }

  const ccAddresses = [...allAddresses].filter((e) => !excludeSet.has(e));

  const to = customerEmail;
  const cc = ccAddresses.length > 0 ? ccAddresses.join(", ") : undefined;

  // Get user mapping for attribution
  const userEntry = getUserMap(interaction.user.id);

  // Download attachment (same logic as /reply)
  const replyFileLimit = getAttachmentLimits().perFileBytes;
  let attachments: ArticleAttachment[] | undefined;
  let convertedLabel = "";
  if (fileOption) {
    if (fileOption.size > replyFileLimit) {
      logger.warn({ filename: fileOption.name, size: fileOption.size, limit: replyFileLimit }, "Skipping oversized reply attachment");
    } else {
      try {
        const res = await fetch(fileOption.url, { signal: AbortSignal.timeout(60_000) });
        let buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > replyFileLimit) {
          logger.warn({ filename: fileOption.name, actual: buf.byteLength }, "Reply attachment larger than declared");
        } else {
          let finalName = fileOption.name;
          let finalMime = fileOption.contentType || "application/octet-stream";

          if (convertOption && canConvert(fileOption.name, convertOption)) {
            const converted = await convertFile(buf, fileOption.name, convertOption);
            if (converted) {
              buf = Buffer.from(converted.data) as typeof buf;
              finalName = converted.filename;
              finalMime = converted.mimeType;
              convertedLabel = ` (converted to ${convertOption.toUpperCase()})`;
            } else {
              logger.warn({ filename: fileOption.name, target: convertOption }, "Conversion unavailable, using original");
            }
          }

          if (buf.byteLength > replyFileLimit) {
            logger.warn({ filename: finalName, size: buf.byteLength }, "Converted file exceeds size limit, using original");
            const origRes = await fetch(fileOption.url, { signal: AbortSignal.timeout(60_000) });
            buf = Buffer.from(await origRes.arrayBuffer());
            finalName = fileOption.name;
            finalMime = fileOption.contentType || "application/octet-stream";
            convertedLabel = "";
          }

          attachments = [{
            filename: finalName,
            data: buf.toString("base64"),
            "mime-type": finalMime,
          }];
        }
      } catch (err) {
        logger.warn({ err, filename: fileOption.name }, "Failed to download Discord attachment");
      }
    }
  }

  await createArticle({
    ticket_id: mapping.ticket_id,
    body: text,
    subject: mapping.title || undefined,
    type: "email",
    sender: "Agent",
    internal: false,
    content_type: contentType,
    to,
    cc,
    origin_by_id: userEntry?.zammad_id ?? undefined,
    attachments,
  });

  const shouldClose = !!interaction.options.getString("close");
  let closeSuffix = "";
  if (shouldClose) {
    const closedState = await getStateByName("closed");
    if (!closedState) throw new Error("Could not find 'closed' state in Zammad");
    await updateTicket(mapping.ticket_id, { state_id: closedState.id });
    updateThreadState(mapping.ticket_id, "closed");
    if (interaction.client && mapping.thread_id) {
      await closeTicketThread(interaction.client, mapping.thread_id);
    }
    closeSuffix = " — ticket closed.";
  }

  const fileSuffix = fileOption ? ` with attachment "${fileOption.name}"${convertedLabel}` : "";
  const ccSuffix = cc ? `\nCC: ${cc}` : "";
  const tmSuffix = expandedModules.length > 0 ? `\n📝 Expanded: ${expandedModules.join(", ")}` : "";
  await interaction.editReply(
    `Reply-all sent to ${to}${ccSuffix}${fileSuffix} on ticket #${mapping.ticket_number}.${closeSuffix}${tmSuffix}`
  );
}

// ---------------------------------------------------------------
// /pending command handler
// ---------------------------------------------------------------

function computePendingTime(code: string): string {
  const now = new Date();
  switch (code) {
    case "1d": now.setDate(now.getDate() + 1); break;
    case "2d": now.setDate(now.getDate() + 2); break;
    case "3d": now.setDate(now.getDate() + 3); break;
    case "4d": now.setDate(now.getDate() + 4); break;
    case "5d": now.setDate(now.getDate() + 5); break;
    case "6d": now.setDate(now.getDate() + 6); break;
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
  const duration = interaction.options.getString("duration", false);
  const dateStr = interaction.options.getString("date", false);

  if (!duration && !dateStr) {
    await interaction.editReply("You must provide either a **duration** or a **date**.");
    return;
  }

  const state = await getStateByName(type);
  if (!state) throw new Error(`Unknown state: ${type}`);

  let pendingTime: string;
  if (dateStr) {
    const parsed = new Date(dateStr + "T12:00:00");
    if (isNaN(parsed.getTime())) {
      await interaction.editReply("Invalid date format. Use **YYYY-MM-DD** (e.g. 2026-03-20).");
      return;
    }
    if (parsed.getTime() <= Date.now()) {
      await interaction.editReply("Date must be in the future.");
      return;
    }
    pendingTime = parsed.toISOString();
  } else {
    pendingTime = computePendingTime(duration!);
  }

  await updateTicket(mapping.ticket_id, { state_id: state.id, pending_time: pendingTime });
  await interaction.editReply(
    `${interaction.user} set ticket #${mapping.ticket_number} to **${type}** until ${new Date(pendingTime).toLocaleDateString()}.`
  );
}

// handleOwner removed — merged into handleAssign

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

export async function handleMergeAutocomplete(
  interaction: import("discord.js").AutocompleteInteraction
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "target") return;

  const currentMapping = getThreadByThreadId(interaction.channelId);
  const query = focused.value.toLowerCase();

  try {
    // Local DB is instant — get all tracked threads that aren't closed/merged
    const closedStates = new Set(["closed", "closed (locked)", "closed (locked until)", "merged", "removed"]);
    const threads = getAllTicketThreads().filter(
      (t) => !closedStates.has(t.state.toLowerCase()) && t.ticket_id !== currentMapping?.ticket_id
    );

    // Filter by query (match on ticket number or title)
    let matches = threads.filter(
      (t) =>
        t.ticket_number.includes(query) ||
        (t.title ?? "").toLowerCase().includes(query)
    );

    // If few local matches and user typed something, also search Zammad
    if (matches.length < 10 && query.length >= 2) {
      try {
        const apiResults = await searchTickets(query, 15);
        for (const t of apiResults) {
          if (t.id === currentMapping?.ticket_id) continue;
          if (closedStates.has(t.state.toLowerCase())) continue;
          if (matches.some((m) => m.ticket_id === t.id)) continue;
          matches.push({
            ticket_id: t.id,
            ticket_number: t.number,
            title: t.title,
            state: t.state,
          } as TicketThread);
        }
      } catch { /* API search failed — use local results only */ }
    }

    const choices = matches.slice(0, 25).map((t) => {
      const label = `#${t.ticket_number} — ${t.title ?? "Untitled"}`;
      return {
        name: label.length > 100 ? label.slice(0, 97) + "..." : label,
        value: t.ticket_number,
      };
    });

    await interaction.respond(choices);
  } catch (err) {
    logger.debug({ err }, "Merge autocomplete failed");
    await interaction.respond([]);
  }
}

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

  const closedStates = new Set(["closed", "closed (locked)", "closed (locked until)", "merged", "removed"]);
  if (closedStates.has(targetTicket.state.toLowerCase())) {
    await interaction.editReply(`Cannot merge into ticket #${targetNumber} — it is ${targetTicket.state}.`);
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
    const ts = formatInBotTz(h.created_at);
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

  const rawText = interaction.options.getString("text", true);
  const timeInput = interaction.options.getString("time", true);

  // Expand ::shortcut text modules before scheduling
  const { expanded: text, contentType } = await expandTextModules(rawText);
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
    content_type: contentType,
  });

  const tz = getBotTimezone();
  const tzLabel = tz ? ` (${tz})` : "";
  await interaction.editReply(
    `Reply scheduled for **${formatInBotTz(scheduledAt)}**${tzLabel} on ticket #${mapping.ticket_number}.`
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

  const lines = articles.map((a) => {
    const body = a.article_data?.body?.replace(/<[^>]+>/g, "").trim() || "(empty)";
    return `**ID ${a.id}** — ${formatInBotTz(a.scheduled_at)} [${a.article_data?.type || "note"}]\n${body}`;
  });
  const joined = lines.join("\n\n");
  if (joined.length <= 2000) {
    await interaction.editReply(joined);
  } else {
    // Split into multiple messages if needed
    const parts = splitMessage(joined, 2000);
    await interaction.editReply(parts[0]);
    for (let i = 1; i < parts.length; i++) {
      await interaction.followUp({ content: parts[i], ephemeral: true });
    }
  }
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

  await cancelScheduledArticle(mapping.ticket_id, id);
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
  const rawBody = interaction.options.getString("body", true);
  const sendOption = interaction.options.getBoolean("send");

  // Expand ::shortcut text modules before sending
  const { expanded: body, contentType: newTicketContentType } = await expandTextModules(rawBody);

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
            content_type: newTicketContentType,
            to,
          },
        });
        break;

      case "sms":
        ticket = await createSmsConversation({
          phone_number: to,
          body,
          skip_send: sendOption === false ? true : undefined,
        });
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
            content_type: newTicketContentType,
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
// /textmodule (list | search | use | preview | refresh)
// ---------------------------------------------------------------

export async function handleTextModule(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case "list": {
      await interaction.deferReply({ ephemeral: true });
      const modules = await getTextModules();
      if (modules.length === 0) {
        await interaction.editReply("No text modules found in Zammad.");
        return;
      }
      const lines = modules.map((m) => {
        const keywords = m.keywords ? ` (${m.keywords})` : "";
        return `**${m.name}**${keywords}`;
      });
      await interaction.editReply(truncate(lines.join("\n"), 2000));
      break;
    }

    case "search": {
      await interaction.deferReply({ ephemeral: true });
      const query = interaction.options.getString("query", true).toLowerCase();
      const modules = await getTextModules();
      const matches = modules.filter((m) => {
        const nameMatch = m.name.toLowerCase().includes(query);
        const keywordMatch = m.keywords?.toLowerCase().includes(query) ?? false;
        return nameMatch || keywordMatch;
      });
      if (matches.length === 0) {
        await interaction.editReply(`No text modules matching "${query}".`);
        return;
      }
      const lines = matches.map((m) => {
        const keywords = m.keywords ? ` (${m.keywords})` : "";
        return `**${m.name}**${keywords}`;
      });
      await interaction.editReply(truncate(lines.join("\n"), 2000));
      break;
    }

    case "use": {
      const mapping = await requireMapping(interaction);
      if (!mapping) return;
      await interaction.deferReply({ ephemeral: true });

      const name = interaction.options.getString("name", true);
      const module = await findTextModule(name);
      if (!module) {
        await interaction.editReply(
          `Text module "${name}" not found. Use \`/textmodule list\` to see available modules.`
        );
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
        body: module.content,
        subject: channel.type === "email" ? (mapping.title || undefined) : undefined,
        type: channel.type,
        sender: "Agent",
        internal: false,
        content_type: "text/html",
        to: channel.to,
        origin_by_id: channel.type === "email" ? (userEntry?.zammad_id ?? undefined) : undefined,
      });

      await interaction.editReply(
        `Text module "${module.name}" sent (${channel.label}) on ticket #${mapping.ticket_number}.`
      );
      break;
    }

    case "preview": {
      await interaction.deferReply({ ephemeral: true });
      const name = interaction.options.getString("name", true);
      const module = await findTextModule(name);
      if (!module) {
        await interaction.editReply(
          `Text module "${name}" not found. Use \`/textmodule list\` to see available modules.`
        );
        return;
      }
      const plainContent = module.content.replace(/<[^>]+>/g, "").trim();
      const keywords = module.keywords ? `\nKeywords: ${module.keywords}` : "";
      await interaction.editReply(
        truncate(`**${module.name}**${keywords}\n\n${plainContent}`, 2000)
      );
      break;
    }

    case "refresh": {
      await interaction.deferReply({ ephemeral: true });
      clearTextModulesCache();
      const modules = await getTextModules();
      await interaction.editReply(`Text modules cache refreshed. ${modules.length} active modules loaded.`);
      break;
    }
  }
}

// ---------------------------------------------------------------
// AI command helpers
// ---------------------------------------------------------------

const LANG_MAP: Record<string, string> = {
  en: "English",
  "pt-br": "Brazilian Portuguese",
  ar: "Arabic",
  zh: "Chinese",
  es: "Spanish",
  fr: "French",
  de: "German",
  ja: "Japanese",
  ko: "Korean",
  ru: "Russian",
  it: "Italian",
  hi: "Hindi",
};

const TONE_MAP: Record<string, string> = {
  formal: "Use a formal, professional tone.",
  friendly: "Use a warm, friendly tone while remaining professional.",
  brief: "Be extremely concise and to the point.",
  empathetic: "Show empathy and understanding for the customer's situation.",
};

const AUDIENCE_MAP: Record<string, string> = {
  technical: "The customer is technically savvy - use technical terms freely.",
  "non-technical": "The customer is not technical - avoid jargon, use simple explanations.",
};

const LENGTH_MAP: Record<string, string> = {
  short: "Keep response very brief (2-3 sentences max).",
  medium: "Keep response moderate length.",
  detailed: "Provide a comprehensive, detailed response.",
};

const FORMAT_MAP: Record<string, string> = {
  steps: "Format as numbered troubleshooting steps.",
  script: "Format as a phone script the agent can read aloud to the customer.",
  checklist: "Format as a checkbox checklist.",
};

function resolveLanguageName(langCode: string): string {
  return LANG_MAP[langCode] ?? langCode;
}

function getLanguageInstruction(interaction: ChatInputCommandInteraction): string {
  const langCode = interaction.options.getString("language")
    ?? getSettingOrEnv("AI_DEFAULT_LANGUAGE")
    ?? "en";
  if (langCode === "en") return "";
  const language = resolveLanguageName(langCode);
  return ` Respond entirely in ${language}.`;
}

function getCallerIdentity(interaction: ChatInputCommandInteraction): string {
  const caller = getUserMap(interaction.user.id);
  return caller?.zammad_email
    ? `${interaction.user.displayName} (${caller.zammad_email})`
    : interaction.user.displayName;
}

function getStyleInstructions(interaction: ChatInputCommandInteraction): string {
  const parts: string[] = [];

  const tone = interaction.options.getString("tone");
  if (tone && TONE_MAP[tone]) parts.push(TONE_MAP[tone]);

  const audience = interaction.options.getString("audience");
  if (audience && AUDIENCE_MAP[audience]) parts.push(AUDIENCE_MAP[audience]);

  const length = interaction.options.getString("length");
  if (length && LENGTH_MAP[length]) parts.push(LENGTH_MAP[length]);

  const format = interaction.options.getString("format");
  if (format && FORMAT_MAP[format]) parts.push(FORMAT_MAP[format]);

  return parts.length > 0 ? "\n\nSTYLE INSTRUCTIONS:\n- " + parts.join("\n- ") : "";
}

function getExcludeInternal(interaction: ChatInputCommandInteraction): boolean {
  return interaction.options.getBoolean("exclude_internal") ?? false;
}

// ---------------------------------------------------------------
// /aireply — AI suggested response
// ---------------------------------------------------------------

export async function handleAiReply(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: false });

  try {
    const { isAIConfigured, buildTicketContext, aiChat } = await import("../services/ai.js");

    if (!isAIConfigured()) {
      await interaction.editReply(
        "AI is not configured. Set AI_API_KEY or use `/setup ai` to enable AI features."
      );
      return;
    }

    const callerName = getCallerIdentity(interaction);
    const langInstruction = getLanguageInstruction(interaction);
    const styleInstruction = getStyleInstructions(interaction);
    const excludeInternal = getExcludeInternal(interaction);
    const extraContext = interaction.options.getString("context") ?? "";

    const ticketContext = await buildTicketContext(mapping.ticket_id, { excludeInternal });
    const response = await aiChat(
      "You are a skilled customer support assistant helping an agent draft a reply.\n\n" +
        `Agent requesting help: ${callerName}\n\n` +
        "INSTRUCTIONS:\n" +
        "- Draft a response FROM the assigned agent TO the customer\n" +
        "- Match the communication channel's tone (formal for email, brief for SMS/chat)\n" +
        "- Address the customer's specific questions/issues from the conversation\n" +
        "- If SLA is breached or urgent, prioritize speed and resolution\n" +
        "- For first responses, acknowledge receipt and set expectations\n" +
        "- Reference any relevant tags for context (billing, technical, etc.)\n" +
        "- Do NOT add signatures, disclaimers, or quote previous messages\n" +
        "- Keep it concise, professional, and actionable" +
        styleInstruction +
        langInstruction + "\n\n" +
        ticketContext +
        (extraContext ? `\n\n=== AGENT'S ADDITIONAL CONTEXT ===\n${extraContext}` : ""),
      "Draft the reply now. Output ONLY the message text, nothing else." + langInstruction
    );

    const fullMessage =
      "🤖 **AI Generated - For Agent Reference Only**\n" +
      "_This suggestion is not sent to the customer. Copy/edit and use `/reply` to send._\n\n" +
      `**Suggested Response:**\n\`\`\`\n${response}\n\`\`\``;

    const chunks = splitMessage(fullMessage);
    await interaction.editReply(chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp(chunks[i]);
    }
  } catch (err) {
    logger.error({ err }, "AI reply command failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    await interaction.editReply(`AI suggestion failed: ${msg}`);
  }
}

// ---------------------------------------------------------------
// /aisummary — AI ticket summary with next steps
// ---------------------------------------------------------------

export async function handleAiSummary(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: false });

  try {
    const { isAIConfigured, buildTicketContext, aiChat } = await import("../services/ai.js");

    if (!isAIConfigured()) {
      await interaction.editReply(
        "AI is not configured. Set AI_API_KEY or use `/setup ai` to enable AI features."
      );
      return;
    }

    const callerName = getCallerIdentity(interaction);
    const langInstruction = getLanguageInstruction(interaction);
    const styleInstruction = getStyleInstructions(interaction);
    const excludeInternal = getExcludeInternal(interaction);
    const extraContext = interaction.options.getString("context") ?? "";

    const ticketContext = await buildTicketContext(mapping.ticket_id, { excludeInternal });

    // Check for translate option — if set, override language for the summary output
    const translateCode = interaction.options.getString("translate");
    const translateLang = translateCode ? resolveLanguageName(translateCode) : null;
    const effectiveLangInstruction = translateLang
      ? ` Respond entirely in ${translateLang}.`
      : langInstruction;

    const response = await aiChat(
      "You are a support ticket analyst helping an agent quickly understand a ticket.\n\n" +
        `Agent requesting summary: ${callerName}\n\n` +
        "INSTRUCTIONS:\n" +
        "- Provide a quick executive summary for an agent taking over or reviewing\n" +
        "- Highlight SLA urgency if breached or close to breach\n" +
        "- Note communication channel and adjust advice accordingly\n" +
        "- Identify the core issue and current status\n" +
        "- Flag any escalation signals or frustrated customer indicators\n" +
        "- Note if awaiting customer response vs agent action needed" +
        (translateLang ? `\n- Translate the ENTIRE summary into ${translateLang}` : "") +
        styleInstruction +
        effectiveLangInstruction + "\n\n" +
        ticketContext +
        (extraContext ? `\n\n=== AGENT'S ADDITIONAL CONTEXT ===\n${extraContext}` : ""),
      "Provide a brief summary with this structure:\n\n" +
        "**Issue:** (1-2 sentences - what's the problem?)\n\n" +
        "**Status:** (current state, who's ball is it in?)\n\n" +
        "**Key Info:** (bullet points of critical details - customer sentiment, any deadlines, blockers)\n\n" +
        "**Recommended Action:** (either a 1-2 sentence suggested reply OR 2-3 bullet points of next steps)" +
        effectiveLangInstruction
    );

    // Clear AI labeling - this does NOT go to Zammad, stays in Discord only
    const translateLabel = translateLang ? ` (Translated to ${translateLang})` : "";
    const fullMessage = `🤖 **AI Generated - For Agent Reference Only**${translateLabel}\n\n` + response;

    const chunks = splitMessage(fullMessage);
    await interaction.editReply(chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp(chunks[i]);
    }
  } catch (err) {
    logger.error({ err }, "AI summary command failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    await interaction.editReply(`AI summary failed: ${msg}`);
  }
}

// ---------------------------------------------------------------
// /aihelp — AI troubleshooting with web search
// ---------------------------------------------------------------

export async function handleAiHelp(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: false });

  try {
    const { isAIConfigured, buildTicketContext, aiChat } = await import("../services/ai.js");
    const { isSearchConfigured, webSearch } = await import("../services/search.js");

    if (!isAIConfigured()) {
      await interaction.editReply(
        "AI is not configured. Set AI_API_KEY or use `/setup ai` to enable AI features."
      );
      return;
    }

    const callerName = getCallerIdentity(interaction);
    const langInstruction = getLanguageInstruction(interaction);
    const styleInstruction = getStyleInstructions(interaction);
    const excludeInternal = getExcludeInternal(interaction);
    const extraContext = interaction.options.getString("context") ?? "";

    const ticketContext = await buildTicketContext(mapping.ticket_id, { excludeInternal });

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
      "You are a technical support specialist helping an agent troubleshoot a customer issue.\n\n" +
        `Agent requesting help: ${callerName}\n\n` +
        "INSTRUCTIONS:\n" +
        "- Analyze the issue based on conversation history and any tags\n" +
        "- Provide step-by-step troubleshooting the agent can follow or share\n" +
        "- Consider the communication channel (SMS needs brief steps, email can be detailed)\n" +
        "- If web search results are included, use them to inform your advice\n" +
        "- Prioritize common solutions first, then edge cases\n" +
        "- Include specific questions to ask if more info is needed\n" +
        "- Flag if this needs escalation to another team/specialist" +
        styleInstruction +
        langInstruction + "\n\n" +
        ticketContext +
        searchResults +
        (extraContext ? `\n\n=== AGENT'S ADDITIONAL CONTEXT ===\n${extraContext}` : ""),
      "Provide troubleshooting guidance with this structure:\n\n" +
        "**Likely Cause:** (brief assessment)\n\n" +
        "**Troubleshooting Steps:**\n1. ...\n2. ...\n\n" +
        "**If That Doesn't Work:** (alternative approaches or escalation path)\n\n" +
        "**Questions to Ask Customer:** (if more info needed)" +
        langInstruction
    );

    const fullMessage =
      "🤖 **AI Generated - For Agent Reference Only**\n" +
      "_This troubleshooting info is for agent reference. Not sent to customer._\n\n" +
      `**Troubleshooting Help:**\n\`\`\`\n${response}\n\`\`\``;

    const chunks = splitMessage(fullMessage);
    await interaction.editReply(chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp(chunks[i]);
    }
  } catch (err) {
    logger.error({ err }, "AI help command failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    await interaction.editReply(`AI help failed: ${msg}`);
  }
}

// ---------------------------------------------------------------
// /aiproofread — Proofread a message
// ---------------------------------------------------------------

export async function handleAiProofread(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: false });

  try {
    const { isAIConfigured, buildTicketContext, aiChat } = await import("../services/ai.js");

    if (!isAIConfigured()) {
      await interaction.editReply(
        "AI is not configured. Set AI_API_KEY or use `/setup ai` to enable AI features."
      );
      return;
    }

    const callerName = getCallerIdentity(interaction);
    const langInstruction = getLanguageInstruction(interaction);
    const tone = interaction.options.getString("tone");
    const toneInstruction = tone && TONE_MAP[tone] ? `\n- ${TONE_MAP[tone]}` : "";
    const messageToProofread = interaction.options.getString("message", true);

    // Get ticket context for customer name and channel info
    const ticketContext = await buildTicketContext(mapping.ticket_id);

    const response = await aiChat(
      "You are a professional proofreader for customer support messages.\n\n" +
        `Agent: ${callerName}\n\n` +
        "TICKET CONTEXT (for reference - customer name, channel type, etc.):\n" +
        ticketContext + "\n\n" +
        "PROOFREADING RULES:\n" +
        "- Fix spelling and grammar errors\n" +
        "- Improve sentence flow and clarity\n" +
        "- Ensure customer name is spelled correctly if mentioned\n" +
        "- Match tone to communication channel (formal for email, brief for SMS)\n" +
        "- Maintain the original meaning - do NOT add or remove content\n" +
        "- Do NOT add greetings, signatures, or disclaimers unless they exist\n" +
        "- Output ONLY the corrected message - no explanations or preamble" +
        toneInstruction +
        langInstruction,
      `Proofread and return the corrected version:\n\n${messageToProofread}`
    );

    const fullMessage =
      "🤖 **AI Proofread - For Agent Reference Only**\n" +
      "_Copy and use with `/reply` to send._\n\n" +
      `**Corrected Message:**\n\`\`\`\n${response}\n\`\`\``;

    const chunks = splitMessage(fullMessage);
    await interaction.editReply(chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp(chunks[i]);
    }
  } catch (err) {
    logger.error({ err }, "AI proofread command failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    await interaction.editReply(`AI proofread failed: ${msg}`);
  }
}

// ---------------------------------------------------------------
// /aitranslate — Translate text or ticket thread into a language
// ---------------------------------------------------------------

export async function handleAiTranslate(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply({ ephemeral: false });

  try {
    const { isAIConfigured, buildTicketContext, aiChat } = await import("../services/ai.js");

    if (!isAIConfigured()) {
      await interaction.editReply(
        "AI is not configured. Set AI_API_KEY or use `/setup ai` to enable AI features."
      );
      return;
    }

    const langCode = interaction.options.getString("language", true);
    const targetLanguage = resolveLanguageName(langCode);
    const content = interaction.options.getString("content");

    let response: string;

    if (content) {
      // Translate user-provided text directly
      response = await aiChat(
        "You are a professional translator. Translate the given text accurately into the target language.\n\n" +
          "RULES:\n" +
          "- Translate accurately while preserving meaning and tone\n" +
          "- Keep technical terms, proper nouns, and brand names untranslated unless there is a standard localized form\n" +
          "- Maintain formatting (bullet points, paragraphs, etc.)\n" +
          "- Output ONLY the translated text — no explanations, notes, or preamble\n" +
          `- Target language: ${targetLanguage}`,
        `Translate the following text into ${targetLanguage}:\n\n${content}`
      );
    } else {
      // Translate the entire ticket thread
      const ticketContext = await buildTicketContext(mapping.ticket_id);
      response = await aiChat(
        "You are a professional translator for customer support tickets.\n\n" +
          "INSTRUCTIONS:\n" +
          "- Translate the entire ticket conversation into the target language\n" +
          "- Preserve the structure: keep sender labels, timestamps, and message boundaries clear\n" +
          "- Translate both customer and agent messages\n" +
          "- Keep technical terms, proper nouns, and brand names untranslated unless there is a standard localized form\n" +
          "- Present a clean, readable translated summary of the full thread\n" +
          `- Target language: ${targetLanguage}\n\n` +
          ticketContext,
        `Translate the full ticket conversation above into ${targetLanguage}. Output the translated thread preserving the conversation structure.`
      );
    }

    const label = content ? "Text Translation" : "Ticket Translation";
    const fullMessage =
      `🌐 **AI ${label} → ${targetLanguage}**\n` +
      "_For agent reference only._\n\n" +
      `\`\`\`\n${response}\n\`\`\``;

    const chunks = splitMessage(fullMessage);
    await interaction.editReply(chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp(chunks[i]);
    }
  } catch (err) {
    logger.error({ err }, "AI translate command failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    await interaction.editReply(`AI translation failed: ${msg}`);
  }
}

// ---------------------------------------------------------------
// /checknote — Snapshot service status board into ticket note
// ---------------------------------------------------------------

export async function handleChecknote(interaction: ChatInputCommandInteraction) {
  const mapping = getThreadByThreadId(interaction.channelId);
  if (!mapping) {
    await interaction.reply({
      content: "Use this command inside a ticket thread.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const botId = getSetting("CHECKNOTE_BOT_ID");
  const channelId = getSetting("CHECKNOTE_CHANNEL_ID");

  if (!botId || !channelId) {
    await interaction.editReply(
      "Checknote not configured. Run `/setup checknote bot_id:<id> channel:<channel>` first."
    );
    return;
  }

  try {
    const channel = await interaction.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      await interaction.editReply("Configured channel is not a valid text channel.");
      return;
    }

    // Fetch recent messages and find the latest from the configured bot
    const textChannel = channel as import("discord.js").TextChannel;
    const messages = await textChannel.messages.fetch({ limit: 20, cache: false });
    const botMessage = messages.find((m) => m.author.id === botId);

    if (!botMessage) {
      await interaction.editReply(
        `No recent message found from bot <@${botId}> in <#${channelId}>.`
      );
      return;
    }

    // Extract embed content as plain text
    const embed = botMessage.embeds[0];
    if (!embed) {
      await interaction.editReply("The bot's latest message has no embed.");
      return;
    }

    const embedTitle = embed.title ?? "Service Status";
    // Strip Discord markdown and timestamp tags for plain text
    const rawDesc = embed.description ?? "";
    const plainDesc = rawDesc
      .replace(/<t:\d+:[TtDdFfR]>/g, (match) => {
        // Extract unix timestamp and format it
        const ts = match.match(/<t:(\d+)/);
        if (ts) return new Date(Number(ts[1]) * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
        return match;
      })
      .replace(/\*\*/g, "")
      .replace(/\*/g, "")
      .replace(/_/g, "");

    const footerText = embed.footer?.text ?? "";
    const snapshotTime = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

    // Build note body (HTML for Zammad)
    const noteHtml =
      `<h3>${escapeHtml(embedTitle)}</h3>` +
      `<pre>${escapeHtml(plainDesc)}</pre>` +
      (footerText ? `<p><em>${escapeHtml(footerText)}</em></p>` : "") +
      `<p><small>Snapshot taken at ${snapshotTime}</small></p>`;

    // Try to render as a PNG image via sharp SVG
    let imageAttachment: ArticleAttachment | undefined;
    try {
      const pngBuffer = await renderStatusBoardPng(embedTitle, rawDesc, embed.color ?? 0x2ecc71);
      imageAttachment = {
        filename: `service-status-${Date.now()}.png`,
        data: pngBuffer.toString("base64"),
        "mime-type": "image/png",
      };
    } catch (err) {
      logger.warn({ err }, "Failed to render status board PNG — attaching text only");
    }

    const userEntry = getUserMap(interaction.user.id);

    await createArticle({
      ticket_id: mapping.ticket_id,
      body: noteHtml,
      type: "note",
      sender: "Agent",
      internal: true,
      content_type: "text/html",
      origin_by_id: userEntry?.zammad_id ?? undefined,
      attachments: imageAttachment ? [imageAttachment] : undefined,
    });

    await interaction.editReply(
      `Service status snapshot added as internal note to ticket #${mapping.ticket_id}.` +
      (imageAttachment ? " (with PNG image)" : " (text only)")
    );
  } catch (err) {
    logger.error({ err }, "Checknote command failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    await interaction.editReply(`Failed to create checknote: ${msg}`);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render the status board embed as a PNG image using sharp's SVG support.
 * Uses SVG <circle> elements for status dots and DejaVu Sans font (installed in container).
 * All emoji/unicode is stripped — only ASCII text + SVG primitives.
 */
async function renderStatusBoardPng(
  title: string,
  description: string,
  embedColor: number
): Promise<Buffer> {
  const sharp = (await import("sharp")).default;

  const lines = description.split("\n").filter((l) => l.trim().length > 0);

  // Emoji → { color, label } mapping for SVG circle rendering
  const emojiColors: [string, string][] = [
    ["\uD83D\uDFE2", "#2ecc71"], // 🟢
    ["\uD83D\uDD34", "#e74c3c"], // 🔴
    ["\uD83D\uDFE1", "#f39c12"], // 🟡
    ["\uD83D\uDD35", "#3498db"], // 🔵
    ["\u26AA", "#95a5a6"],       // ⚪
    ["\u23F8\uFE0F", "#95a5a6"], // ⏸️
    ["\u23F8", "#95a5a6"],       // ⏸ (without variation selector)
  ];

  interface ParsedLine {
    dotColor: string | null;
    text: string;
    bold: boolean;
  }

  const parsed: ParsedLine[] = lines.map((line) => {
    // Clean markdown and Discord timestamps
    let clean = line
      .replace(/<t:\d+:[TtDdFfR]>/g, (m) => {
        const ts = m.match(/<t:(\d+)/);
        if (ts) return new Date(Number(ts[1]) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
        return m;
      });

    // Detect bold (section headers like **GroupName**)
    const isBold = /^\*\*[^*]+\*\*$/.test(clean.trim());

    // Strip markdown
    clean = clean.replace(/\*\*/g, "").replace(/\*/g, "").replace(/_/g, "");

    // Detect and remove emoji, record its color
    let dotColor: string | null = null;
    for (const [emoji, color] of emojiColors) {
      if (clean.includes(emoji)) {
        dotColor = color;
        clean = clean.replace(emoji, "").trim();
        break;
      }
    }

    // Strip any remaining non-ASCII (stray emoji)
    clean = clean.replace(/[^\x20-\x7E]/g, "").trim();

    return { dotColor, text: clean, bold: isBold };
  });

  const lineHeight = 22;
  const padding = 16;
  const titleHeight = 36;
  const dotRadius = 5;
  const dotXCenter = padding + dotRadius;
  const textXWithDot = padding + dotRadius * 2 + 8;
  const textXNoDot = padding;
  const width = 620;
  const height = titleHeight + padding * 2 + parsed.length * lineHeight + 10;
  const colorHex = `#${embedColor.toString(16).padStart(6, "0")}`;

  const elements: string[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const { dotColor, text, bold } = parsed[i];
    const y = titleHeight + padding + i * lineHeight;
    const textY = y + 15; // baseline offset

    if (dotColor) {
      // Draw a colored circle
      elements.push(`<circle cx="${dotXCenter}" cy="${y + 11}" r="${dotRadius}" fill="${dotColor}"/>`);
      elements.push(
        `<text x="${textXWithDot}" y="${textY}" fill="#dcddde" font-family="DejaVu Sans, sans-serif" font-size="13">${escapeXml(text)}</text>`
      );
    } else {
      const fill = bold ? "#ffffff" : "#dcddde";
      const weight = bold ? ' font-weight="bold"' : "";
      const size = bold ? "14" : "13";
      elements.push(
        `<text x="${textXNoDot}" y="${textY}" fill="${fill}" font-family="DejaVu Sans, sans-serif" font-size="${size}"${weight}>${escapeXml(text)}</text>`
      );
    }
  }

  // Strip emoji from title too
  const cleanTitle = title.replace(/[^\x20-\x7E]/g, "").trim();

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="#2f3136" rx="8"/>
  <rect x="0" y="0" width="4" height="${height}" fill="${colorHex}" rx="2"/>
  <text x="${padding + 6}" y="26" fill="#ffffff" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="bold">${escapeXml(cleanTitle)}</text>
  ${elements.join("\n  ")}
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------
// /weekly — Create a Weekly Check ticket
// ---------------------------------------------------------------

/**
 * Parse a date string like "2026-03-7" or "2026-03-07" into a Date (UTC midnight).
 * Returns null if the string is not a valid date.
 */
function parseYMD(s: string): Date | null {
  const m = s.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (isNaN(d.getTime())) return null;
  return d;
}

/** Format a Date as YYYY-MM-DD (zero-padded). */
function fmtDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Parse the start/end dates from a Weekly Check ticket title.
 * Handles formats like:
 *   "Weekly Check 2026-03-7 to 2026-03-13"
 *   "Weekly Check 2026-03-07 to 2026-03-13"
 */
function parseWeeklyTitle(title: string): { start: Date; end: Date } | null {
  const m = title.match(/(\d{4}-\d{1,2}-\d{1,2})\s*to\s*(\d{4}-\d{1,2}-\d{1,2})/i);
  if (!m) return null;
  const start = parseYMD(m[1]);
  const end = parseYMD(m[2]);
  if (!start || !end) return null;
  return { start, end };
}

/** Get next Saturday (or today if it's Saturday). */
function nextSaturday(from: Date): Date {
  const d = new Date(from);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const daysUntilSat = (6 - day + 7) % 7 || 7; // if already Sat, use 0? No — use 7 for next
  d.setUTCDate(d.getUTCDate() + (day === 6 ? 0 : daysUntilSat));
  return d;
}

/** Get the next Friday on or after the given date. */
function nextFriday(from: Date): Date {
  const d = new Date(from);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const daysUntilFri = (5 - day + 7) % 7;
  // If already Friday, jump to next Friday (+7)
  d.setUTCDate(d.getUTCDate() + (daysUntilFri === 0 ? 7 : daysUntilFri));
  return d;
}

export async function handleWeekly(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  // Resolve customer email: command option > /setup weekly-email setting
  const emailOption = interaction.options.getString("email");
  const customerEmail = emailOption?.trim().toLowerCase() || getSetting("WEEKLY_CHECK_EMAIL");

  if (!customerEmail) {
    await interaction.editReply(
      "No customer email configured. Use `/setup weekly-email` to set a default, or pass `email:` to this command."
    );
    return;
  }

  const startInput = interaction.options.getString("start");
  const endInput = interaction.options.getString("end");

  let startDate!: Date;
  let endDate!: Date;

  if (startInput && endInput) {
    // Both dates provided explicitly
    const s = parseYMD(startInput);
    const e = parseYMD(endInput);
    if (!s) {
      await interaction.editReply(`Invalid start date: \`${startInput}\`. Use YYYY-MM-DD format.`);
      return;
    }
    if (!e) {
      await interaction.editReply(`Invalid end date: \`${endInput}\`. Use YYYY-MM-DD format.`);
      return;
    }
    startDate = s;
    endDate = e;
  } else if (startInput && !endInput) {
    // Only start provided — end defaults to Friday of that week
    const s = parseYMD(startInput);
    if (!s) {
      await interaction.editReply(`Invalid start date: \`${startInput}\`. Use YYYY-MM-DD format.`);
      return;
    }
    startDate = s;
    endDate = nextFriday(s);
  } else {
    // Auto-detect from most recent Weekly Check ticket
    let autoDetected = false;
    try {
      const results = await searchTickets("title:Weekly Check", 50);
      // Sort by created_at descending to find the most recent
      const sorted = results
        .filter((t) => /weekly\s*check/i.test(t.title))
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      for (const ticket of sorted) {
        const parsed = parseWeeklyTitle(ticket.title);
        if (parsed) {
          // Next week starts the day after the previous end date (7-day span: Sat–Fri)
          startDate = new Date(parsed.end.getTime() + 86400000); // day after end
          endDate = nextFriday(startDate); // always ends on Friday
          autoDetected = true;
          logger.info(
            { prevTitle: ticket.title, newStart: fmtDate(startDate), newEnd: fmtDate(endDate) },
            "Auto-detected weekly dates from previous ticket"
          );
          break;
        }
      }
    } catch (err) {
      logger.warn({ err }, "Failed to search for previous Weekly Check tickets");
    }

    if (!autoDetected) {
      // Fallback: next Saturday → Friday (7-day span)
      const now = new Date();
      startDate = nextSaturday(now);
      endDate = nextFriday(startDate);
      logger.info(
        { start: fmtDate(startDate), end: fmtDate(endDate) },
        "No previous Weekly Check found, using next Sat-Fri"
      );
    }
  }

  // Ensure end is after start
  if (endDate <= startDate) {
    await interaction.editReply(
      `End date (${fmtDate(endDate)}) must be after start date (${fmtDate(startDate)}).`
    );
    return;
  }

  const title = `Weekly Check ${fmtDate(startDate)} to ${fmtDate(endDate)}`;

  try {
    // Create the ticket
    const ticket = await createTicket({
      title,
      group: "Users",
      customer: customerEmail,
      article: {
        subject: title,
        body: `Weekly Check for ${fmtDate(startDate)} to ${fmtDate(endDate)}`,
        type: "email",
        sender: "Agent",
        internal: false,
        to: customerEmail,
        content_type: "text/plain",
      },
    });

    // Set to "pending reminder" with pending_time = day after end date at 23:59 UTC
    // (gives 1 extra day after the week ends to send out emails)
    const pendingState = await getStateByName("pending reminder");
    if (pendingState) {
      const pendingTime = new Date(endDate);
      pendingTime.setUTCDate(pendingTime.getUTCDate() + 1);
      pendingTime.setUTCHours(23, 59, 0, 0);
      await updateTicket(ticket.id, {
        state_id: pendingState.id,
        pending_time: pendingTime.toISOString(),
      });
    } else {
      logger.warn("Could not find 'pending reminder' state — ticket left in default state");
    }

    await interaction.editReply(
      `Weekly Check ticket created: **#${ticket.number}** — ${title}\n` +
      `Customer: ${customerEmail}\n` +
      `State: pending reminder (until day after end: ${fmtDate(new Date(endDate.getTime() + 86400000))})\n` +
      ticketUrl(ticket.id)
    );
    logger.info({ ticketId: ticket.id, title, customerEmail }, "Weekly Check ticket created");
  } catch (err) {
    logger.error({ err, title, customerEmail }, "Failed to create Weekly Check ticket");
    const msg = err instanceof Error ? err.message : "Unknown error";
    await interaction.editReply(`Failed to create Weekly Check ticket: ${msg}`);
  }
}
