import { Client, ThreadChannel } from "discord.js";
import { env } from "../util/env.js";
import { logger } from "../util/logger.js";
import {
  getThreadByTicketId,
  isArticleSyncedForTicket,
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
import { isClosedState, isHiddenState, isDashboardState } from "../util/states.js";
import { getAttachmentLimits } from "../util/attachmentLimits.js";
import { updateDashboards } from "./dashboards.js";
import { splitEmailHtml } from "../util/emailSplit.js";

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

  // Safety: if the webhook article's ticket_id doesn't match the webhook ticket,
  // discard the article to prevent cross-ticket misattribution. This can happen
  // when Zammad fires webhooks during ticket merges or split operations.
  const sanitizedArticle = webhookArticle && webhookArticle.ticket_id !== ticketId
    ? (() => {
        logger.warn(
          { ticketId, articleId: webhookArticle.id, articleTicketId: webhookArticle.ticket_id },
          "Webhook article ticket_id mismatch — discarding article from webhook payload"
        );
        return undefined;
      })()
    : webhookArticle;

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
      // Don't add members to newly created hidden-state threads; archive dashboard-state tickets
      await removeRoleMembersFromThread(client, mapping.thread_id);
      if (isDashboardState(normalizedState)) {
        const thread = (await client.channels.fetch(mapping.thread_id)) as ThreadChannel | null;
        if (thread?.isThread() && !thread.archived) {
          await discordQueue.add(async () => {
            await thread.edit({ archived: true, reason: `Ticket is ${normalizedState}` });
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

    // Track notification intent — actual send happens after unarchiving to avoid
    // a race where sendToThread's archive-restore re-archives the thread.
    const customerReplied =
      isDashboardState(oldState) &&
      normalizedState === "open" &&
      sanitizedArticle &&
      sanitizedArticle.sender === "Customer";

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

    // Dashboard/hidden state → archive thread and remove members (hides from ticket list)
    if (isHiddenState(normalizedState) && !isHiddenState(oldState)) {
      await removeRoleMembersFromThread(client, mapping.thread_id);
      // Archive dashboard-state threads so they disappear from channel lists
      if (isDashboardState(normalizedState)) {
        const thread = (await client.channels.fetch(mapping.thread_id)) as ThreadChannel | null;
        if (thread?.isThread() && !thread.archived) {
          await discordQueue.add(async () => {
            await thread.edit({ archived: true, reason: `Ticket set to ${normalizedState}` });
          });
        }
      }
    }

    // Transition OUT of a hidden state → unarchive, re-add members, then notify
    if (isHiddenState(oldState) && !isHiddenState(normalizedState) && !isClosedState(normalizedState)) {
      const thread = (await client.channels.fetch(mapping.thread_id)) as ThreadChannel | null;
      if (thread?.isThread()) {
        if (thread.archived) {
          await discordQueue.add(async () => {
            await thread.edit({ archived: false, reason: `Ticket no longer ${oldState}` });
          });
        }
        await addRoleMembersToThread(thread);

        // Send "customer replied" notification AFTER unarchiving and adding members
        // so it doesn't race with sendToThread's archive-restore logic.
        if (customerReplied) {
          discordQueue.add(async () => {
            await thread.send({
              content: `**Customer replied** — ticket moved from _${oldState}_ to _${normalizedState}_.`,
              allowedMentions: { parse: [] },
            });
          }).catch((err) =>
            logger.warn({ ticketId, err }, "Failed to send state transition notification")
          );
        }
      }
    }
  }

  // If ticket is still "pending close" and a webhook fired (activity while pending),
  // re-add members so the team sees the update
  if (normalizedState === oldState && normalizedState === "pending close" && sanitizedArticle) {
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

  // FALLBACK: Zammad fires webhooks before the DB transaction commits, so the
  // article may not be in the API response yet when syncAllUnsyncedArticles
  // fetches articles. If the webhook included an article and it's STILL not
  // synced after the API fetch, post it directly from the webhook payload.
  if (sanitizedArticle && !isArticleSyncedForTicket(sanitizedArticle.id, ticketId)) {
    logger.warn(
      { ticketId, articleId: sanitizedArticle.id },
      "Webhook article missing from API response — using webhook payload as fallback"
    );
    await syncWebhookArticleFallback(client, mapping.thread_id, ticketId, sanitizedArticle);
  }

  // Update the Other Tickets dashboard (state may have changed)
  await updateDashboards(client);
}

// ---------------------------------------------------------------
// Article sync: Zammad → Discord
// ---------------------------------------------------------------

/**
 * Fetch all articles for a ticket from the Zammad API and sync any
 * unsynced ones to Discord in chronological (created_at) order. This
 * guarantees correct ordering even when webhooks arrive out of order
 * or when Zammad assigns article IDs out of send-time order (e.g. Teams
 * messages, where outbound agent captures lag behind customer replies).
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

  // Sort by created_at (true message time), falling back to ID as a tiebreaker.
  // Article IDs are assigned in Zammad *ingestion* order, which does NOT match
  // chronological order for Teams messages: Zammad captures outbound agent Teams
  // messages via a lagging poll, so they get a higher ID than later customer
  // messages while their created_at is correctly backdated to the real send time.
  // Sorting by ID therefore scrambles Teams conversations; created_at restores order.
  articles.sort((a: { id: number; created_at: string }, b: { id: number; created_at: string }) => {
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    if (Number.isNaN(ta) || Number.isNaN(tb) || ta === tb) return a.id - b.id;
    return ta - tb;
  });

  // Filter out articles older than 7 days that aren't in synced_articles.
  // The synced_articles table is pruned after 30 days, so very old articles
  // would appear "unsynced" and get re-posted as duplicates. Only sync
  // recent articles that are genuinely new.
  const ARTICLE_AGE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const now = Date.now();

  const articleIds = articles.map((a: { id: number }) => a.id);
  // Use ticket-aware check: an article synced to the WRONG ticket is treated as unsynced
  const alreadySynced = articleIds.filter((id: number) => isArticleSyncedForTicket(id, ticketId));
  const unsynced = articleIds.filter((id: number) => !isArticleSyncedForTicket(id, ticketId));
  logger.info(
    { ticketId, total: articles.length, alreadySynced: alreadySynced.length, unsynced: unsynced.length, unsyncedIds: unsynced },
    "Article sync check"
  );

  // Track whether we've already synced a non-system article for this ticket.
  // The first article gets the full email body; subsequent ones strip the
  // quoted reply chain since it's already visible earlier in the thread.
  let hasFirstArticle = false;

  for (const article of articles) {
    if (isArticleSyncedForTicket(article.id, ticketId)) {
      if (article.sender !== "System") hasFirstArticle = true;
      continue;
    }

    // Skip old articles that were likely already synced but pruned from the DB.
    // Without this guard, the 30-day prune + catch-up cycle would re-post
    // every old article as a duplicate every time the bot restarts.
    if (article.created_at) {
      const articleAge = now - new Date(article.created_at).getTime();
      if (articleAge > ARTICLE_AGE_LIMIT_MS) {
        // Silently mark as synced so we don't re-check every cycle
        markArticleSynced(article.id, ticketId, threadId, null, "zammad_to_discord");
        if (article.sender !== "System") hasFirstArticle = true;
        continue;
      }
    }

    // Guard: if Zammad API returned an article that doesn't belong to this ticket
    // (can happen with stale API data), skip it to prevent cross-ticket misattribution.
    if (article.ticket_id && article.ticket_id !== ticketId) {
      logger.warn(
        { ticketId, articleId: article.id, articleTicketId: article.ticket_id },
        "Article belongs to a different ticket — skipping to prevent misattribution"
      );
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

    // For email articles: split into reply + context (signatures/quoted chain).
    // The reply is shown prominently; the context goes behind a spoiler tag.
    // For non-email articles: show the full body as-is.
    let content: string;
    let replyHtml = "";
    if (article.type === "email") {
      const rendered = renderEmailArticle(article.body, senderLabel, prefix, hasFirstArticle);
      content = rendered.content;
      replyHtml = rendered.replyHtml;
    } else {
      const body = stripHtml(article.body);
      content = `**${senderLabel}:** ${prefix}${body || "_(empty message)_"}`;
    }
    hasFirstArticle = true;

    // Collect real attachments + inline images (see collectArticleMedia).
    const { files: attachments, largeFileLinks } = await collectArticleMedia(
      ticketId,
      article.id,
      article.type,
      replyHtml,
      article.attachments,
    );

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

/**
 * Fallback: sync a webhook article directly from the webhook payload when it
 * wasn't returned by the Zammad articles API (race condition — Zammad fires
 * webhooks before the DB transaction commits).
 */
async function syncWebhookArticleFallback(
  client: Client,
  threadId: string,
  ticketId: number,
  webhookArticle: NonNullable<WebhookPayload["article"]>,
): Promise<void> {
  // Guard: verify the webhook article actually belongs to this ticket
  if (webhookArticle.ticket_id && webhookArticle.ticket_id !== ticketId) {
    logger.warn(
      { ticketId, articleId: webhookArticle.id, articleTicketId: webhookArticle.ticket_id },
      "Webhook fallback: article belongs to a different ticket — skipping"
    );
    return;
  }

  // Skip system articles
  if (webhookArticle.sender === "System") {
    markArticleSynced(webhookArticle.id, ticketId, threadId, null, "zammad_to_discord");
    return;
  }

  const prefix = webhookArticle.internal ? "**[Internal]** " : "";
  const fromName = extractDisplayName(webhookArticle.from);
  const senderLabel = fromName
    ? `${fromName} (${webhookArticle.sender})`
    : webhookArticle.sender;

  let content: string;
  let replyHtml = "";
  if (webhookArticle.type === "email") {
    const rendered = renderEmailArticle(webhookArticle.body, senderLabel, prefix, true);
    content = rendered.content;
    replyHtml = rendered.replyHtml;
  } else {
    const body = stripHtml(webhookArticle.body);
    content = `**${senderLabel}:** ${prefix}${body || "_(empty message)_"}`;
  }

  // Collect real attachments + inline images (see collectArticleMedia).
  const { files: attachments, largeFileLinks } = await collectArticleMedia(
    ticketId,
    webhookArticle.id,
    webhookArticle.type,
    replyHtml,
    webhookArticle.attachments,
  );

  let finalContent = content;
  if (largeFileLinks.length > 0) {
    finalContent += `\n📎 **Attachments in Zammad:**\n${largeFileLinks.join("\n")}`;
  }

  const discordMsgId = await sendToThread(client, threadId, finalContent, attachments);
  if (!discordMsgId) {
    logger.error(
      { ticketId, articleId: webhookArticle.id },
      "Webhook article fallback: sendToThread returned null — will retry on next backfill"
    );
    return;
  }
  markArticleSynced(webhookArticle.id, ticketId, threadId, discordMsgId, "zammad_to_discord");
  logger.info(
    { ticketId, articleId: webhookArticle.id, discordMsgId },
    "Synced article to Discord (webhook fallback)"
  );
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
export function stripQuotedEmail(html: string): string {
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

  // Outlook divider + quoted-header block: an <hr> that is shortly followed by a
  // bold "From:" line — remove the <hr> and everything after it.
  cleaned = cleaned.replace(/<hr[^>]*>(?=[\s\S]{0,800}?<b>\s*From:\s*<\/b>)[\s\S]*/gi, "");

  // Outlook quoted-header block with no <hr>: a <div>/<p> wrapping a bold "From:"
  // line — remove it and everything after.
  cleaned = cleaned.replace(/<(?:div|p)[^>]*>\s*(?:<[^>]+>\s*)*<b>\s*From:\s*<\/b>[\s\S]*/gi, "");

  // Strip Outlook-style header block: "From: ... Sent: ... To: ... Subject: ..."
  cleaned = cleaned.replace(/[-_]{2,}[\s\S]*?From:\s.+[\s\S]*?Subject:\s.+/gi, "");

  return cleaned;
}

/** Convert HTML to plain text with basic formatting. */
function stripHtml(html: string | undefined | null): string {
  if (!html) return "";
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

/**
 * Format an email article for Discord with reply/context separation.
 *
 * The actual reply is shown prominently.  Quoted content (previous emails,
 * signatures, forwarded content) is collapsed behind a Discord spoiler tag
 * so it's still accessible but doesn't clutter the thread.
 *
 * Returns both the rendered Discord `content` and the `replyHtml` (the reply
 * portion, quotes removed) so the caller can extract inline images from ONLY
 * the new reply — never from the quoted chain, which would re-post images
 * that already appeared on earlier messages in the thread.
 */
export function renderEmailArticle(
  bodyHtml: string,
  senderLabel: string,
  prefix: string,
  stripQuotes: boolean,
): { content: string; replyHtml: string } {
  if (!bodyHtml) {
    return { content: `**${senderLabel}:** ${prefix}_(empty message)_`, replyHtml: "" };
  }
  const { reply: splitReplyHtml, context: contextHtml } = splitEmailHtml(bodyHtml);

  // For non-first articles, also strip any remaining quoted content from
  // the reply portion (catches nested quotes the split didn't find)
  const replyHtml = stripQuotes ? stripQuotedEmail(splitReplyHtml) : splitReplyHtml;
  const replyText = stripHtml(replyHtml);

  // If split found no context, just return the reply (same as before)
  if (!contextHtml) {
    return { content: `**${senderLabel}:** ${prefix}${replyText}`, replyHtml };
  }

  // Convert context HTML to plain text
  const contextText = stripHtml(contextHtml);

  // Skip context if it's trivially short (just whitespace or a delimiter)
  if (contextText.length < 10) {
    return { content: `**${senderLabel}:** ${prefix}${replyText}`, replyHtml };
  }

  // Truncate context to a reasonable length for Discord
  const MAX_CONTEXT_LEN = 800;
  let truncatedContext = contextText;
  if (truncatedContext.length > MAX_CONTEXT_LEN) {
    truncatedContext = truncatedContext.slice(0, MAX_CONTEXT_LEN).trimEnd() + "…";
  }

  // Sanitize: escape spoiler delimiters and collapse blank lines
  // (blank lines inside || can break the spoiler in some clients)
  truncatedContext = truncatedContext
    .replace(/\|\|/g, "| |")
    .replace(/\n{3,}/g, "\n\n");

  // Build the message: reply shown normally, context behind a spoiler
  return {
    content:
      `**${senderLabel}:** ${prefix}${replyText}\n` +
      `📧 ||${truncatedContext}||`,
    replyHtml,
  };
}

// ---------------------------------------------------------------
// Attachment + inline-image collection (Zammad → Discord)
// ---------------------------------------------------------------

/** Parse a CSS/attribute pixel value (e.g. `width: 262px` or `width="262"`).
 *  Deliberately does NOT match `max-width` (the char before "width" there is
 *  "-", which the leading class excludes), so a bare `width` wins over a
 *  responsive `max-width`. Returns null when the property is absent. */
export function parseImgPx(tag: string, prop: string): number | null {
  const style = new RegExp(`(?:^|[;\\s"'])${prop}\\s*:\\s*([0-9.]+)\\s*px`, "i").exec(tag);
  if (style) return parseFloat(style[1]);
  const attr = new RegExp(`\\b${prop}\\s*=\\s*["']?([0-9.]+)`, "i").exec(tag);
  if (attr) return parseFloat(attr[1]);
  return null;
}

/** Heuristic: an <img> with a small explicit width (or a very short height) is
 *  decorative — a signature logo, email-client chrome, or a tracking pixel —
 *  not a real screenshot the user meant to share. Screenshots are wide and
 *  typically declare only a large `max-width`, so they pass through. */
export function isDecorativeImage(tag: string): boolean {
  const width = parseImgPx(tag, "width");
  const height = parseImgPx(tag, "height");
  if (width !== null && width <= 300) return true;   // logos/icons are narrow
  if (height !== null && height > 0 && height <= 60) return true; // thin banners/pixels
  return false;
}

/**
 * Extract inline-image attachment IDs referenced in an email HTML body.
 *
 * Zammad embeds inline images as
 *   <img src="/api/v1/ticket_attachment/{ticket}/{article}/{attId}?view=inline">
 * and does NOT list them in `article.attachments`, so they are invisible to a
 * plain attachment loop and never reach Discord. We recover them from the body.
 *
 * Only images belonging to THIS article are returned (a quoted reply re-embeds
 * the previous message's images under new IDs; those live in the context
 * portion and are excluded by passing only the reply HTML here). Small
 * decorative images are filtered out.
 */
export function extractInlineImageIds(html: string, ticketId: number, articleId: number): number[] {
  if (!html) return [];
  const ids: number[] = [];
  const seen = new Set<number>();
  const imgRe = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html)) !== null) {
    const tag = m[0];
    const src = /src\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!src) continue;
    const ref = /\/ticket_attachment\/(\d+)\/(\d+)\/(\d+)/.exec(src[1]);
    if (!ref) continue;
    const t = Number(ref[1]), a = Number(ref[2]), attId = Number(ref[3]);
    if (t !== ticketId || a !== articleId) continue; // only this article's own images
    if (seen.has(attId)) continue;
    if (isDecorativeImage(tag)) continue;
    seen.add(attId);
    ids.push(attId);
  }
  return ids;
}

/** True for Zammad's internal raw-source copies (e.g. `message.html`) that it
 *  keeps as content-alternative / original-format attachments. These are never
 *  user-supplied files and only add clutter if forwarded to Discord. */
export function isRawSourceAttachment(att: { filename?: string; preferences?: unknown }): boolean {
  const p = (att.preferences ?? {}) as Record<string, unknown>;
  if (p["content-alternative"] || p["Content-Alternative"]) return true;
  if (p["original-format"] || p["Original-Format"]) return true;
  return /^message\.(html?|txt|eml)$/i.test(att.filename ?? "");
}

interface RawAttachment {
  id: number;
  filename: string;
  size: number | string;
  preferences?: unknown;
}

/**
 * Collect everything to send to Discord for one article: real file
 * attachments PLUS inline images embedded in the email body. Returns the
 * files to upload and Zammad links for any file too large / over budget.
 *
 * Shared by the API-sync and webhook-fallback paths so both behave identically.
 */
async function collectArticleMedia(
  ticketId: number,
  articleId: number,
  articleType: string,
  replyHtml: string,
  rawAttachments: RawAttachment[] | undefined,
): Promise<{ files: { data: Buffer; filename: string }[]; largeFileLinks: string[] }> {
  const limits = getAttachmentLimits();
  const LARGE_FILE_THRESHOLD = limits.perFileBytes;
  const MAX_TOTAL_DOWNLOAD_BYTES = limits.totalBytes;
  const MAX_DISCORD_ATTACHMENTS = limits.maxCount;
  const zammadBase = env().ZAMMAD_PUBLIC_URL ?? env().ZAMMAD_BASE_URL;

  const files: { data: Buffer; filename: string }[] = [];
  const largeFileLinks: string[] = [];
  const downloadedIds = new Set<number>();
  let totalDownloaded = 0;
  const zammadLink = (name: string, note: string) =>
    `[${name} (${note})](${zammadBase}/#ticket/zoom/${ticketId}/${articleId})`;

  // 1) Real file attachments (skip Zammad's internal raw-source copies).
  for (const att of rawAttachments ?? []) {
    if (isRawSourceAttachment(att)) continue;
    const attSize = Number.isFinite(Number(att.size)) ? Number(att.size) : 0;
    if (attSize < 10 && attSize > 0) continue; // skip tiny placeholders
    if (attSize > LARGE_FILE_THRESHOLD) {
      largeFileLinks.push(zammadLink(att.filename, `${(attSize / 1024 / 1024).toFixed(1)} MB`));
      continue;
    }
    if (files.length >= MAX_DISCORD_ATTACHMENTS) {
      logger.info({ articleId, limit: MAX_DISCORD_ATTACHMENTS }, "Capping attachments at Discord limit");
      break;
    }
    if (attSize > 0 && totalDownloaded + attSize > MAX_TOTAL_DOWNLOAD_BYTES) {
      largeFileLinks.push(zammadLink(att.filename, `${(attSize / 1024 / 1024).toFixed(1)} MB`));
      continue;
    }
    try {
      const dl = await downloadAttachment(ticketId, articleId, att.id);
      files.push({ data: dl.data, filename: ensureFileExtension(att.filename, dl.contentType) });
      totalDownloaded += dl.data.length;
      downloadedIds.add(att.id);
    } catch (err) {
      if (attSize === 0) largeFileLinks.push(zammadLink(att.filename, "? MB"));
      logger.warn({ articleId, attachmentId: att.id, err }, "Failed to download attachment");
    }
  }

  // 2) Inline images embedded in the email body (email only). These are NOT in
  //    the attachments array, so they must be pulled from the reply HTML.
  if (articleType === "email") {
    for (const attId of extractInlineImageIds(replyHtml, ticketId, articleId)) {
      if (downloadedIds.has(attId)) continue;
      if (files.length >= MAX_DISCORD_ATTACHMENTS) break;
      if (totalDownloaded >= MAX_TOTAL_DOWNLOAD_BYTES) break;
      try {
        const dl = await downloadAttachment(ticketId, articleId, attId);
        if (totalDownloaded + dl.data.length > MAX_TOTAL_DOWNLOAD_BYTES) continue;
        files.push({ data: dl.data, filename: ensureFileExtension(`inline-image-${attId}`, dl.contentType) });
        totalDownloaded += dl.data.length;
        downloadedIds.add(attId);
      } catch (err) {
        logger.warn({ ticketId, articleId, attachmentId: attId, err }, "Failed to download inline image");
      }
    }
  }

  return { files, largeFileLinks };
}
