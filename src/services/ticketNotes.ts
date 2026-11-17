/**
 * Internal Zammad notes the bot writes about its own actions on a ticket
 * (reminders, scheduled replies), so the ticket history shows everything
 * that was set up or done from Discord.
 *
 * Best effort: a failed note is logged and never blocks the action itself.
 */

import { createArticle } from "./zammad.js";
import { markArticleSynced } from "../db/index.js";
import { logger } from "../util/logger.js";

export async function addTicketNote(
  ticketId: number,
  text: string,
  opts: {
    /** Zammad user to author the note as (the Discord user's mapped agent). */
    zammadId?: number | null;
    /** Ticket thread; with `echo: false` the note is marked as already shown there. */
    threadId?: string | null;
    /** The Discord message that already shows this (for the sync record). */
    discordMsgId?: string | null;
    /** false: do not mirror the note back into the thread (it is already visible there). Default true. */
    echo?: boolean;
  } = {},
): Promise<number | null> {
  try {
    const article = await createArticle({
      ticket_id: ticketId,
      body: text,
      type: "note",
      sender: "Agent",
      internal: true,
      content_type: "text/plain",
      origin_by_id: opts.zammadId ?? undefined,
      on_behalf_of: opts.zammadId ?? null,
    });
    if (opts.echo === false && opts.threadId) {
      markArticleSynced(article.id, ticketId, opts.threadId, opts.discordMsgId ?? null, "discord_to_zammad");
    }
    return article.id;
  } catch (err) {
    logger.warn({ err, ticketId }, "Failed to add ticket note");
    return null;
  }
}
