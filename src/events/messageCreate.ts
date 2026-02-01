import { Client, Events, Message } from "discord.js";
import { logger } from "../util/logger.js";
import { getThreadByThreadId, getUserMap, markArticleSynced } from "../db/index.js";
import { createArticle, type ArticleAttachment } from "../services/zammad.js";
import { enqueueForTicket } from "../queue/index.js";

export function onMessageCreate(client: Client): void {
  client.on(Events.MessageCreate, async (message: Message) => {
    // Ignore bots (including ourselves)
    if (message.author.bot) return;

    // Only care about messages in threads
    if (!message.channel.isThread()) return;

    const mapping = getThreadByThreadId(message.channelId);
    if (!mapping) return; // Not a tracked ticket thread

    await enqueueForTicket(mapping.ticket_id, async () => {
      try {
        await forwardToZammad(message, mapping.ticket_id, mapping.thread_id);
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
  threadId: string
): Promise<void> {
  const userEntry = getUserMap(message.author.id);

  const body = message.content || "";

  // Download Discord attachments and base64-encode for Zammad
  const attachments: ArticleAttachment[] = [];
  for (const [, att] of message.attachments) {
    try {
      const res = await fetch(att.url);
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

  const senderInfo = userEntry
    ? `${message.author.username}`
    : `${message.author.username} (unmapped)`;

  const article = await createArticle({
    ticket_id: ticketId,
    body: `[Discord — ${senderInfo}] ${body}`,
    type: "note",
    sender: "Agent",
    internal: true,
    content_type: "text/plain",
    attachments: attachments.length > 0 ? attachments : undefined,
  });

  // Mark as synced so the webhook echo is suppressed
  markArticleSynced(article.id, ticketId, threadId, message.id, "discord_to_zammad");

  logger.info(
    { ticketId, articleId: article.id, discordMsgId: message.id, attachmentCount: attachments.length },
    "Forwarded Discord message to Zammad"
  );
}
