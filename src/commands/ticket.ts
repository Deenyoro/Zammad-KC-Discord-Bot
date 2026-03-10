import { ChatInputCommandInteraction, ThreadChannel } from "discord.js";
import { logger } from "../util/logger.js";
import {
  getThreadByThreadId,
  getAllTicketThreads,
  getUserMap,
  updateThreadState,
  getSettingOrEnv,
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

  // Validate to override if provided
  if (toOverride) {
    const trimmed = toOverride.trim();
    if (!isValidEmail(trimmed)) {
      await interaction.editReply(`Invalid email address: \`${trimmed}\`\nUse \`/participants\` to see valid addresses.`);
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

  // Apply to override — forces email type since we have an explicit email address
  if (toOverride) {
    channel.to = toOverride.trim();
    channel.type = "email";
    channel.label = `email to ${toOverride.trim()}`;
  }

  // Get user mapping for attribution
  const userEntry = getUserMap(interaction.user.id);

  // Parse and validate CC emails (only applies to email tickets)
  let cc: string | undefined;
  let ccIgnored = false;
  if (ccInput) {
    if (channel.type === "email") {
      const ccEmails = ccInput.split(',').map(e => e.trim()).filter(e => e.length > 0);
      const invalid = ccEmails.filter(e => !isValidEmail(e));
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

  const fileSuffix = fileOption ? ` with attachment "${fileOption.name}"${convertedLabel}` : "";
  const ccSuffix = cc ? ` (CC: ${cc})` : "";
  const ccWarning = ccIgnored ? "\n⚠️ CC was ignored — only supported for email tickets." : "";
  const tmSuffix = expandedModules.length > 0 ? `\n📝 Expanded: ${expandedModules.join(", ")}` : "";
  await interaction.editReply(
    `Reply sent (${channel.label})${fileSuffix}${ccSuffix} on ticket #${mapping.ticket_number}.${ccWarning}${tmSuffix}`
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
      `**ID ${a.id}** — ${new Date(a.scheduled_at).toLocaleString()} [${a.article_data?.type || "note"}]: ${truncate(a.article_data?.body?.replace(/<[^>]+>/g, "") || "(empty)", 80)}`
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
        ticket = await createSmsConversation({ phone_number: to, body });
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

function getLanguageInstruction(interaction: ChatInputCommandInteraction): string {
  const langCode = interaction.options.getString("language")
    ?? getSettingOrEnv("AI_DEFAULT_LANGUAGE")
    ?? "en";
  if (langCode === "en") return "";
  const language = LANG_MAP[langCode] ?? "English";
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
        styleInstruction +
        langInstruction + "\n\n" +
        ticketContext +
        (extraContext ? `\n\n=== AGENT'S ADDITIONAL CONTEXT ===\n${extraContext}` : ""),
      "Provide a brief summary with this structure:\n\n" +
        "**Issue:** (1-2 sentences - what's the problem?)\n\n" +
        "**Status:** (current state, who's ball is it in?)\n\n" +
        "**Key Info:** (bullet points of critical details - customer sentiment, any deadlines, blockers)\n\n" +
        "**Recommended Action:** (either a 1-2 sentence suggested reply OR 2-3 bullet points of next steps)" +
        langInstruction
    );

    // Clear AI labeling - this does NOT go to Zammad, stays in Discord only
    const fullMessage = "🤖 **AI Generated - For Agent Reference Only**\n\n" + response;

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
