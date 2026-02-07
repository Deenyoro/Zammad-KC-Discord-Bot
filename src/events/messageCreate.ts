import { Client, Events, Message } from "discord.js";
import { logger } from "../util/logger.js";
import { getThreadByThreadId, getUserMap, markArticleSynced, type UserMapEntry } from "../db/index.js";
import { createArticle, getTicket, expandTextModules, type ArticleAttachment } from "../services/zammad.js";
import { enqueueForTicket } from "../queue/index.js";

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
  const { expanded: body } = await expandTextModules(rawBody);

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

  // Fetch ticket to determine if it's Teams/RingCentral and route accordingly
  const ticket = await getTicket(ticketId);
  const teamsChat = ticket.preferences?.teams_chat;
  const ringcentralSms = ticket.preferences?.ringcentral_sms;

  // Determine article type and preferences based on ticket type
  let articleType = "note";
  let articlePreferences: Record<string, any> = {};

  if (teamsChat?.chat_id) {
    articleType = "teams_chat_message";
    articlePreferences.teams_chat = {
      chat_id: teamsChat.chat_id,
      channel_id: teamsChat.channel_id,
    };
    logger.debug({ ticketId, chatId: teamsChat.chat_id }, "Routing Discord message to Teams");
  } else if (ringcentralSms?.from_phone) {
    articleType = "ringcentral_sms_message";
    articlePreferences.ringcentral_sms = {
      to_phone: ringcentralSms.from_phone,
      channel_id: ringcentralSms.channel_id,
    };
    logger.debug({ ticketId, toPhone: ringcentralSms.from_phone }, "Routing Discord message to RingCentral");
  }

  const article = await createArticle({
    ticket_id: ticketId,
    body,
    type: articleType,
    sender: "Agent",
    internal: articleType === "note",
    content_type: "text/plain",
    origin_by_id: userEntry.zammad_id ?? undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
    preferences: Object.keys(articlePreferences).length > 0 ? articlePreferences : undefined,
  });

  // Mark as synced so the webhook echo is suppressed
  markArticleSynced(article.id, ticketId, threadId, message.id, "discord_to_zammad");

  logger.info(
    { ticketId, articleId: article.id, articleType, discordMsgId: message.id, attachmentCount: attachments.length },
    "Forwarded Discord message to Zammad"
  );
}
