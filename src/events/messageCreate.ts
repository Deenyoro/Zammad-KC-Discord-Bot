import { Client, Events, Message } from "discord.js";
import { logger } from "../util/logger.js";
import { getThreadByThreadId, getUserMap, markArticleSynced, type UserMapEntry } from "../db/index.js";
import { createArticle, expandTextModules, type ArticleAttachment } from "../services/zammad.js";
import { enqueueForTicket } from "../queue/index.js";
import { getAttachmentLimits } from "../util/attachmentLimits.js";

export function onMessageCreate(client: Client): void {
  client.on(Events.MessageCreate, async (message: Message) => {
    // Ignore bots (including ourselves)
    if (message.author.bot) return;

    // Only care about messages in threads
    if (!message.channel.isThread()) return;

    const mapping = getThreadByThreadId(message.channelId);
    if (!mapping) return; // Not a tracked ticket thread

    // Only mapped agents may post into ticket threads
    const userEntry = getUserMap(message.author.id);
    if (!userEntry) return;

    await enqueueForTicket(mapping.ticket_id, async () => {
      try {
        await forwardToZammad(message, mapping.ticket_id, mapping.thread_id, userEntry);
      } catch (err) {
        logger.error(
          { ticketId: mapping.ticket_id, messageId: message.id, err },
          "Failed to forward Discord message to Zammad"
        );
      }
    });
  });
}

async function forwardToZammad(
  message: Message,
  ticketId: number,
  threadId: string,
  userEntry: UserMapEntry
): Promise<void> {
  // Expand ::shortcut text modules before sending
  const rawBody = message.content || "";
  const { expanded: body, contentType } = await expandTextModules(rawBody);

  // Download Discord attachments and base64-encode for Zammad.
  // Limits configurable via /setup attachments — prevents OOM from
  // bulk uploads (10 × 25 MB base64 ≈ 580 MB peak without limits).
  const limits = getAttachmentLimits();
  const MAX_ATTACHMENT_BYTES = limits.perFileBytes;
  const MAX_TOTAL_BYTES = limits.totalBytes;
  const MAX_ATTACHMENT_COUNT = limits.maxCount;
  let totalBytes = 0;
  const attachments: ArticleAttachment[] = [];
  for (const [, att] of message.attachments) {
    if (attachments.length >= MAX_ATTACHMENT_COUNT) break;
    if (att.size > MAX_ATTACHMENT_BYTES) {
      logger.warn({ filename: att.name, size: att.size }, "Skipping oversized Discord attachment");
      continue;
    }
    if (totalBytes + att.size > MAX_TOTAL_BYTES) {
      logger.warn({ filename: att.name, size: att.size, totalBytes }, "Skipping attachment — total budget exceeded");
      continue;
    }
    try {
      const res = await fetch(att.url, { signal: AbortSignal.timeout(60_000) });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > MAX_ATTACHMENT_BYTES) {
        logger.warn({ filename: att.name, actual: buf.byteLength }, "Attachment larger than declared — skipping");
        continue;
      }
      totalBytes += buf.byteLength;
      attachments.push({
        filename: att.name ?? "attachment",
        data: buf.toString("base64"),
        "mime-type": att.contentType || "application/octet-stream",
      });
    } catch (err) {
      logger.warn({ filename: att.name, err }, "Failed to download Discord attachment");
    }
  }

  if (!body.trim() && attachments.length === 0) return; // nothing to forward

  // Thread messages are always internal notes — use /reply to send externally.
  // This prevents accidental outbound messages to customers via Teams/SMS/email.
  const article = await createArticle({
    ticket_id: ticketId,
    body,
    type: "note",
    sender: "Agent",
    internal: true,
    content_type: contentType,
    origin_by_id: userEntry.zammad_id ?? undefined,
    on_behalf_of: userEntry.zammad_id,
    attachments: attachments.length > 0 ? attachments : undefined,
  });

  // Mark as synced so the webhook echo is suppressed
  markArticleSynced(article.id, ticketId, threadId, message.id, "discord_to_zammad");

  logger.info(
    { ticketId, articleId: article.id, discordMsgId: message.id, attachmentCount: attachments.length },
    "Forwarded Discord message as internal note to Zammad"
  );
}
