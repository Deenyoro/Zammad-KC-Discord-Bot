import { Client, ThreadChannel } from "discord.js";
import { logger } from "../util/logger.js";
import {
  getThreadByTicketId,
  isArticleSynced,
  markArticleSynced,
  isDeliveryProcessed,
  markDeliveryProcessed,
  unmarkDeliveryProcessed,
  updateThreadState,
  updateThreadTitle,
} from "../db/index.js";
import {
  downloadAttachment,
  getArticles,
  getTicket,
  getUser,
} from "./zammad.js";
import {
  createTicketThread,
  updateHeaderEmbed,
  closeTicketThread,
  reopenTicketThread,
  renameTicketThread,
  sendToThread,
  ticketUrl,
  removeRoleMembersFromThread,
  addRoleMembersToThread,
  type TicketInfo,
} from "./threads.js";

/** Extract a display name from an article "from" field like "John Doe <john@example.com>" */
function extractDisplayName(from: string | undefined): string | undefined {
  if (!from) return undefined;
  // "John Doe <john@example.com>" → "John Doe"
  const match = from.match(/^(.+?)\s*<[^>]+>$/);
  if (match) return match[1].trim();
  // If it looks like a bare email, skip it
  if (from.includes("@") && !from.includes(" ")) return undefined;
  return from.trim() || undefined;
}

// ---------------------------------------------------------------
// Webhook payload types (from Zammad trigger → webhook)
// ---------------------------------------------------------------

export interface WebhookPayload {
  ticket: {
    id: number;
    number: string;
    title: string;
    state_id: number;
    state: string;          // resolved association name
    priority_id: number;
    priority: string;       // resolved association name
    group_id: number;
    group: string;          // resolved association name
    owner_id: number;
    owner?: string;         // resolved: owner login
    customer_id: number;
    customer?: string;      // resolved: customer login
    created_at: string;
    updated_at: string;
  };
  article?: {
    id: number;
    ticket_id: number;
    body: string;
    sender_id: number;
    sender: string;         // resolved association name: "Customer", "Agent", "System"
    type_id: number;
    type: string;           // resolved: "note", "email", etc.
    from?: string;
    subject?: string;
    internal: boolean;
    content_type?: string;
    created_at: string;
    attachments?: {
      id: number;
      filename: string;
      size: number;
      url: string;          // full URL to download via Zammad API
      preferences: Record<string, string>;
    }[];
  };
}

// ---------------------------------------------------------------
// Main webhook handler
// ---------------------------------------------------------------

export async function handleWebhook(
  client: Client,
  payload: WebhookPayload,
  deliveryId?: string
): Promise<void> {
  // Dedup by delivery ID (Zammad retries up to 4 times).
  // Mark BEFORE processing, but unmark on failure so retries work.
  if (deliveryId) {
    if (isDeliveryProcessed(deliveryId)) {
      logger.debug({ deliveryId }, "Duplicate delivery, skipping");
      return;
    }
    markDeliveryProcessed(deliveryId);
  }

  try {
    await processWebhook(client, payload);
  } catch (err) {
    // Unmark so Zammad retries can succeed
    if (deliveryId) {
      unmarkDeliveryProcessed(deliveryId);
    }
    throw err;
  }
}

async function processWebhook(
  client: Client,
  payload: WebhookPayload
): Promise<void> {
  const { ticket: webhookTicket, article: webhookArticle } = payload;
  const ticketId = webhookTicket.id;

  logger.info(
    { ticketId, articleId: webhookArticle?.id },
    "Processing webhook"
  );

  // Fetch the full ticket with expand=true so relationship names
  // (state, priority, group, customer, owner) are resolved.
  // The webhook payload does NOT include expanded data.
  const fullTicket = await getTicket(ticketId);

  // Resolve owner/customer to "Firstname Lastname" via the users API
  let ownerName: string | undefined;
  if (fullTicket.owner_id && fullTicket.owner_id > 1) {
    try {
      const owner = await getUser(fullTicket.owner_id);
      ownerName = `${owner.firstname} ${owner.lastname}`.trim() || undefined;
    } catch {
      ownerName = undefined;
    }
  }

  let customerName: string | undefined;
  if (fullTicket.customer_id) {
    try {
      const customer = await getUser(fullTicket.customer_id);
      customerName = `${customer.firstname} ${customer.lastname}`.trim() || undefined;
    } catch {
      customerName = fullTicket.customer || undefined;
    }
  }

  const normalizedState = fullTicket.state.toLowerCase();

  const ticketInfo: TicketInfo = {
    id: ticketId,
    number: fullTicket.number,
    title: fullTicket.title,
    state: normalizedState,
    priority: fullTicket.priority,
    customer: customerName,
    owner: ownerName,
    owner_id: fullTicket.owner_id,
    group: fullTicket.group,
    created_at: fullTicket.created_at,
    url: ticketUrl(ticketId),
  };

  let mapping = getThreadByTicketId(ticketId);
  let threadJustCreated = false;

  // Create thread if it doesn't exist
  if (!mapping) {
    await createTicketThread(client, ticketInfo);
    mapping = getThreadByTicketId(ticketId);
    if (!mapping) throw new Error(`Failed to create mapping for ticket ${ticketId}`);
    threadJustCreated = true;

    // If we just created a thread for a closed ticket, close it immediately
    if (normalizedState === "closed") {
      await closeTicketThread(client, mapping.thread_id);
      logger.info({ ticketId }, "Closed newly created thread for closed ticket");
    } else if (normalizedState === "pending close") {
      // Don't add members to newly created "pending close" threads
      await removeRoleMembersFromThread(client, mapping.thread_id);
      logger.info({ ticketId }, "Removed members from newly created pending close thread");
    }
  }

  // Update header embed (state, title, assignee may have changed)
  try {
    await updateHeaderEmbed(client, mapping.channel_id, mapping.header_message_id, ticketInfo);
  } catch (err) {
    logger.warn({ ticketId, err }, "Failed to update header embed");
  }

  // Handle state changes (both sides are lowercase now)
  const oldState = mapping.state;

  if (normalizedState !== oldState) {
    updateThreadState(ticketId, normalizedState);

    if (normalizedState === "closed") {
      await closeTicketThread(client, mapping.thread_id);
    } else if (oldState === "closed") {
      await reopenTicketThread(client, mapping.thread_id);
    }

    // "pending close" → remove role members (thread stays open/unlocked)
    if (normalizedState === "pending close") {
      await removeRoleMembersFromThread(client, mapping.thread_id);
    }

    // Transition OUT of "pending close" → re-add members
    if (oldState === "pending close" && normalizedState !== "pending close") {
      const thread = (await client.channels.fetch(mapping.thread_id)) as ThreadChannel | null;
      if (thread?.isThread() && !thread.archived) {
        await addRoleMembersToThread(thread);
      }
    }
  }

  // If ticket is still "pending close" and a webhook fired (activity while pending),
  // re-add members so the team sees the update
  if (normalizedState === oldState && normalizedState === "pending close" && webhookArticle) {
    const thread = (await client.channels.fetch(mapping.thread_id)) as ThreadChannel | null;
    if (thread?.isThread() && !thread.archived) {
      await addRoleMembersToThread(thread);
    }
  }

  // Handle title changes (use fullTicket.title not webhookTicket.title - webhook payload can be stale)
  if (fullTicket.title !== mapping.title) {
    updateThreadTitle(ticketId, fullTicket.title);
    await renameTicketThread(client, mapping.thread_id, mapping.ticket_number, fullTicket.title);
    logger.info({ ticketId, oldTitle: mapping.title, newTitle: fullTicket.title }, "Renamed thread via webhook for title change");
  }

  // Sync ALL unsynced articles in order (by article ID).
  // This guarantees correct chronological ordering even when webhooks
  // arrive out of order due to concurrent Zammad processing.
  if (webhookArticle) {
    await syncAllUnsyncedArticles(client, mapping.thread_id, ticketId);
  }
}

// ---------------------------------------------------------------
// Article sync: Zammad → Discord
// ---------------------------------------------------------------

/**
 * Fetch all articles for a ticket from the Zammad API and sync any
 * unsynced ones to Discord in article-ID order. This guarantees
 * correct chronological ordering even when webhooks arrive out of
 * order (e.g. two messages sent in quick succession).
 */
async function syncAllUnsyncedArticles(
  client: Client,
  threadId: string,
  ticketId: number,
): Promise<void> {
  let articles;
  try {
    articles = await getArticles(ticketId);
  } catch (err) {
    logger.error({ ticketId, err }, "Failed to fetch articles for sequential sync");
    return;
  }

  // Articles come back sorted by ID (chronological). Process in order.
  for (const article of articles) {
    if (isArticleSynced(article.id)) continue;

    // Skip system-generated articles (state changes etc.)
    if (article.sender === "System") {
      markArticleSynced(article.id, ticketId, threadId, null, "zammad_to_discord");
      continue;
    }

    const prefix = article.internal ? "**[Internal]** " : "";
    const fromName = extractDisplayName(article.from);
    const senderLabel = fromName
      ? `${fromName} (${article.sender})`
      : article.sender;
    const body = stripHtml(article.body);
    const content = `**${senderLabel}:** ${prefix}${body}`;

    // Download attachments (skip tiny placeholders <10B and oversized >25MB)
    const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
    const attachments: { data: Buffer; filename: string }[] = [];
    if (article.attachments?.length) {
      for (const att of article.attachments) {
        if (att.size < 10) continue;
        if (att.size > MAX_ATTACHMENT_BYTES) {
          logger.warn({ articleId: article.id, attachmentId: att.id, size: att.size }, "Skipping oversized Zammad attachment");
          continue;
        }
        try {
          const downloaded = await downloadAttachment(ticketId, article.id, att.id);
          const filename = ensureFileExtension(att.filename, downloaded.contentType);
          attachments.push({ data: downloaded.data, filename });
        } catch (err) {
          logger.warn({ articleId: article.id, attachmentId: att.id, err }, "Failed to download attachment");
        }
      }
    }

    const discordMsgId = await sendToThread(client, threadId, content, attachments);
    markArticleSynced(article.id, ticketId, threadId, discordMsgId, "zammad_to_discord");

    logger.info(
      { ticketId, articleId: article.id, discordMsgId },
      "Synced article to Discord"
    );
  }
}

/** Ensure a filename has a proper extension based on content type. */
function ensureFileExtension(filename: string, contentType: string): string {
  // If the filename already has a recognized extension, keep it
  if (/\.\w{2,5}$/.test(filename)) return filename;

  const extMap: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "video/mp4": ".mp4",
    "video/3gpp": ".3gp",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "application/pdf": ".pdf",
  };

  const ext = extMap[contentType.toLowerCase()];
  if (ext) return `${filename}${ext}`;

  // Try deriving from subtype (sanitize to alphanumeric only)
  const rawSubtype = contentType.split("/")[1] ?? "";
  const subtype = rawSubtype.match(/^[a-z0-9]+$/i)?.[0];
  if (subtype && subtype !== "octet-stream") return `${filename}.${subtype}`;

  return filename;
}

/** Convert HTML to plain text with basic formatting. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
