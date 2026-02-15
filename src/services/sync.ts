import { Client, ThreadChannel } from "discord.js";
import { env } from "../util/env.js";
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
  formatOwnerLabelFromFull,
  type TicketInfo,
} from "./threads.js";
import { discordQueue } from "../queue/index.js";
import { isClosedState, isHiddenState } from "../util/states.js";
import { getAttachmentLimits } from "../util/attachmentLimits.js";

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
    escalation_at: fullTicket.escalation_at,
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

    // If we just created a thread for a closed/locked ticket, close it immediately
    if (isClosedState(normalizedState)) {
      await closeTicketThread(client, mapping.thread_id);
      logger.info({ ticketId }, "Closed newly created thread for closed ticket");
    } else if (isHiddenState(normalizedState)) {
      // Don't add members to newly created hidden-state threads; archive "waiting for reply"
      await removeRoleMembersFromThread(client, mapping.thread_id);
      if (normalizedState === "waiting for reply") {
        const thread = (await client.channels.fetch(mapping.thread_id)) as ThreadChannel | null;
        if (thread?.isThread() && !thread.archived) {
          await discordQueue.add(async () => {
            await thread.edit({ archived: true, reason: "Ticket is waiting for reply" });
          });
        }
      }
      logger.info({ ticketId, state: normalizedState }, "Hidden newly created thread for ticket in hidden state");
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

    // "Waiting for reply" → "open" with a customer article = customer replied
    if (
      oldState === "waiting for reply" &&
      normalizedState === "open" &&
      webhookArticle &&
      webhookArticle.sender === "Customer"
    ) {
      sendToThread(
        client,
        mapping.thread_id,
        "**Customer replied** — ticket moved from _waiting for reply_ to _open_."
      ).catch((err) =>
        logger.warn({ ticketId, err }, "Failed to send waiting-for-reply notification")
      );
    }

    if (isClosedState(normalizedState)) {
      await closeTicketThread(client, mapping.thread_id);
    } else if (isClosedState(oldState)) {
      // Double-check with a fresh API call to avoid stale data causing a false reopen.
      // The Zammad API frequently returns stale state data on webhook-triggered fetches.
      try {
        const freshTicket = await getTicket(ticketId);
        const freshState = freshTicket.state.toLowerCase();
        if (isClosedState(freshState)) {
          logger.info(
            { ticketId, webhookState: normalizedState, freshState },
            "Skipping reopen in webhook - fresh API confirms ticket is closed (stale data)"
          );
          updateThreadState(ticketId, freshState);
        } else {
          await reopenTicketThread(client, mapping.thread_id);
        }
      } catch (err) {
        logger.warn({ ticketId, err }, "Failed to verify ticket state before reopen");
      }
    }

    // "waiting for reply" → archive thread and remove members (hides from ticket list)
    if (isHiddenState(normalizedState) && !isHiddenState(oldState)) {
      await removeRoleMembersFromThread(client, mapping.thread_id);
      // Archive "waiting for reply" threads so they disappear from channel lists
      if (normalizedState === "waiting for reply") {
        const thread = (await client.channels.fetch(mapping.thread_id)) as ThreadChannel | null;
        if (thread?.isThread() && !thread.archived) {
          await discordQueue.add(async () => {
            await thread.edit({ archived: true, reason: "Ticket set to waiting for reply" });
          });
        }
      }
    }

    // Transition OUT of a hidden state → unarchive and re-add members (but NOT if closing)
    if (isHiddenState(oldState) && !isHiddenState(normalizedState) && !isClosedState(normalizedState)) {
      const thread = (await client.channels.fetch(mapping.thread_id)) as ThreadChannel | null;
      if (thread?.isThread()) {
        if (thread.archived) {
          await discordQueue.add(async () => {
            await thread.edit({ archived: false, reason: "Ticket no longer waiting for reply" });
          });
        }
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

  // Handle title or owner changes — rename thread to reflect current state
  const ownerLabel = ownerName ? formatOwnerLabelFromFull(ownerName) : undefined;
  if (fullTicket.title !== mapping.title) {
    updateThreadTitle(ticketId, fullTicket.title);
  }
  // Always pass current owner to rename — it will skip if the name hasn't actually changed
  try {
    await renameTicketThread(client, mapping.thread_id, mapping.ticket_number, fullTicket.title, ownerLabel);
  } catch (err) {
    logger.warn({ ticketId, err }, "Failed to rename thread during webhook sync");
  }

  // Sync ALL unsynced articles in order (by article ID).
  // This guarantees correct chronological ordering even when webhooks
  // arrive out of order due to concurrent Zammad processing.
  // Always sync — Zammad sometimes sends webhooks without the article
  // payload (e.g. for internal notes), so we must not gate on webhookArticle.
  await syncAllUnsyncedArticles(client, mapping.thread_id, ticketId);
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
export async function syncAllUnsyncedArticles(
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

  // Sort explicitly by ID to guarantee chronological order regardless of API behavior.
  articles.sort((a: { id: number }, b: { id: number }) => a.id - b.id);

  // Track whether we've already synced a non-system article for this ticket.
  // The first article gets the full email body; subsequent ones strip the
  // quoted reply chain since it's already visible earlier in the thread.
  let hasFirstArticle = false;

  for (const article of articles) {
    if (isArticleSynced(article.id)) {
      if (article.sender !== "System") hasFirstArticle = true;
      continue;
    }

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

    // First article keeps the full body; replies strip the quoted email chain
    const rawBody = hasFirstArticle
      ? stripQuotedEmail(article.body)
      : article.body;
    const body = stripHtml(rawBody);
    const content = `**${senderLabel}:** ${prefix}${body}`;
    hasFirstArticle = true;

    // Process attachments:
    // - Files with known size ≤ threshold: download and upload to Discord
    // - Files with known size > threshold: link to Zammad (prevents OOM)
    // - Files with unknown size (0): attempt download (downloadAttachment has configurable safety cap)
    // - Configurable max file count and total download budget
    // All limits are configurable via /setup attachments
    const limits = getAttachmentLimits();
    const LARGE_FILE_THRESHOLD = limits.perFileBytes;
    const MAX_TOTAL_DOWNLOAD_BYTES = limits.totalBytes;
    const MAX_DISCORD_ATTACHMENTS = limits.maxCount;
    let totalDownloaded = 0;
    const attachments: { data: Buffer; filename: string }[] = [];
    const largeFileLinks: string[] = [];
    const zammadBase = env().ZAMMAD_PUBLIC_URL ?? env().ZAMMAD_BASE_URL;

    if (article.attachments?.length) {
      for (const att of article.attachments) {
        const attSize = Number.isFinite(att.size) ? att.size : 0;
        if (attSize < 10 && attSize > 0) continue; // skip tiny placeholders

        // Known-large files: link instead of downloading
        if (attSize > LARGE_FILE_THRESHOLD) {
          const sizeMB = (attSize / 1024 / 1024).toFixed(1);
          largeFileLinks.push(`[${att.filename} (${sizeMB} MB)](${zammadBase}/#ticket/zoom/${ticketId}/${article.id})`);
          continue;
        }

        if (attachments.length >= MAX_DISCORD_ATTACHMENTS) {
          logger.info({ articleId: article.id, total: article.attachments.length, limit: MAX_DISCORD_ATTACHMENTS }, "Capping attachments at Discord limit");
          break;
        }
        if (attSize > 0 && totalDownloaded + attSize > MAX_TOTAL_DOWNLOAD_BYTES) {
          // Remaining files go to link list
          const sizeMB = (attSize / 1024 / 1024).toFixed(1);
          largeFileLinks.push(`[${att.filename} (${sizeMB} MB)](${zammadBase}/#ticket/zoom/${ticketId}/${article.id})`);
          continue;
        }
        // Download the attachment (size 0 = unknown size, e.g. inline images — try anyway,
        // downloadAttachment has its own configurable safety cap)
        try {
          const downloaded = await downloadAttachment(ticketId, article.id, att.id);
          const filename = ensureFileExtension(att.filename, downloaded.contentType);
          attachments.push({ data: downloaded.data, filename });
          totalDownloaded += downloaded.data.length;
        } catch (err) {
          // If download fails for unknown-size file, fall back to link
          if (attSize === 0) {
            largeFileLinks.push(`[${att.filename} (? MB)](${zammadBase}/#ticket/zoom/${ticketId}/${article.id})`);
          }
          logger.warn({ articleId: article.id, attachmentId: att.id, err }, "Failed to download attachment");
        }
      }
    }

    // Append links for large/overflow files to the message content
    let finalContent = content;
    if (largeFileLinks.length > 0) {
      finalContent += `\n📎 **Attachments in Zammad:**\n${largeFileLinks.join("\n")}`;
    }

    const discordMsgId = await sendToThread(client, threadId, finalContent, attachments);
    if (!discordMsgId) {
      // sendToThread returned null — thread could not be fetched or message failed.
      // Do NOT mark as synced so the article is retried on the next sync cycle.
      // Break (don't continue) because if the thread is unfetchable, remaining
      // articles for this ticket will also fail.
      logger.warn(
        { ticketId, articleId: article.id },
        "sendToThread returned null — article NOT marked as synced, will retry"
      );
      break;
    }
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

/**
 * Remove quoted email content from HTML before converting to plain text.
 * Strips <blockquote> elements, Gmail/Outlook quote containers, and
 * common text-based reply separators so only the new reply remains.
 */
function stripQuotedEmail(html: string): string {
  let cleaned = html;

  // Remove <blockquote> elements and everything inside (handles nesting)
  // Use a loop because nested blockquotes need multiple passes
  let prev = "";
  while (prev !== cleaned) {
    prev = cleaned;
    cleaned = cleaned.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "");
  }

  // Gmail: <div class="gmail_quote">...</div>  (greedy — captures to the end)
  cleaned = cleaned.replace(/<div\s[^>]*class=["']gmail_quote["'][\s\S]*/gi, "");

  // Outlook / generic: <div id="appendonsend">...</div>
  cleaned = cleaned.replace(/<div\s[^>]*id=["']appendonsend["'][\s\S]*/gi, "");

  // Yahoo: <div class="yahoo_quoted">...</div>
  cleaned = cleaned.replace(/<div\s[^>]*class=["']yahoo_quoted["'][\s\S]*/gi, "");

  // Zammad's own quote marker: <div data-signature="true">
  cleaned = cleaned.replace(/<div\s[^>]*data-signature=["']true["'][\s\S]*/gi, "");

  // Strip "On <date> <person> wrote:" line (plain-text style, sometimes outside blockquotes)
  cleaned = cleaned.replace(/On\s.+wrote:\s*$/gim, "");

  // Strip Outlook-style header block: "From: ... Sent: ... To: ... Subject: ..."
  cleaned = cleaned.replace(/[-_]{2,}[\s\S]*?From:\s.+[\s\S]*?Subject:\s.+/gi, "");

  return cleaned;
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
