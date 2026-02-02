import { Client, Events, Message } from "discord.js";
import { logger } from "../util/logger.js";
import { getThreadByThreadId, getUserMap, markArticleSynced, type UserMapEntry } from "../db/index.js";
import { createArticle, type ArticleAttachment } from "../services/zammad.js";
import { enqueueForTicket } from "../queue/index.js";

export function onMessageCreate(client: Client): void {
  client.on(Events.MessageCreate, async (message: Message) => {
    // Ignore bots (including ourselves)
    if (message.author.bot) return;

    // Only care about messages in threads
    if (!message.channel.isThread()) return;

    const mapping = getThreadByThreadId(message.channelId);
    if (!mapping) {
      logger.debug({ channelId: message.channelId }, "Message in untracked thread");
      return; // Not a tracked ticket thread
    }

    // Only mapped agents may post into ticket threads
    const userEntry = getUserMap(message.author.id);
    if (!userEntry) {
      logger.warn({
        discordId: message.author.id,
        username: message.author.username,
        ticketId: mapping.ticket_id
      }, "User not in usermap, ignoring message");
      return;
    }

    logger.info({
      ticketId: mapping.ticket_id,
      discordUser: message.author.username,
      zammadEmail: userEntry.zammad_email,
      zammadId: userEntry.zammad_id
    }, "Forwarding Discord message to Zammad");

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
  const body = message.content || "";

  // Download Discord attachments and base64-encode for Zammad
  const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB
  const attachments: ArticleAttachment[] = [];
  for (const [, att] of message.attachments) {
    if (att.size > MAX_ATTACHMENT_BYTES) {
      logger.warn({ filename: att.name, size: att.size }, "Skipping oversized Discord attachment");
      continue;
    }
    try {
      const res = await fetch(att.url, { signal: AbortSignal.timeout(60_000) });
      const buf = Buffer.from(await res.arrayBuffer());
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

  const articleData = {
    ticket_id: ticketId,
    body,
    type: "note",
    sender: "Agent",
    internal: true,
    content_type: "text/plain",
    from: userEntry.zammad_email,
    created_by_id: userEntry.zammad_id ?? undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
  };

  logger.debug({ ticketId, articleData }, "Creating Zammad article with user attribution");

  const article = await createArticle(articleData);

  // Mark as synced so the webhook echo is suppressed
  markArticleSynced(article.id, ticketId, threadId, message.id, "discord_to_zammad");

  logger.info(
    {
      ticketId,
      articleId: article.id,
      discordMsgId: message.id,
      attachmentCount: attachments.length,
      requestedCreatedById: userEntry.zammad_id,
      requestedFrom: userEntry.zammad_email
    },
    "Forwarded Discord message to Zammad"
  );
}
