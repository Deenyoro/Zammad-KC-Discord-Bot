/**
 * Related tickets: merges, parent/child links and plain "related" links.
 *
 * - getRelatedTickets() feeds the "Related tickets" block of the thread status
 *   update and /related: every merged/linked ticket with its Zammad link and,
 *   when the bot tracks it, its Discord thread.
 * - announceMerges() makes a merge visible on both sides, whether it was done
 *   from Discord (/merge) or in Zammad: an internal note on the ticket that was
 *   merged away and on the ticket it went into (with Zammad and Discord links),
 *   plus a message in the receiving ticket's Discord thread. Each merge is
 *   announced once (merge_notes table); merges older than the first start of
 *   this feature are listed but not announced.
 */

import type { Client } from "discord.js";
import { env } from "../util/env.js";
import { logger } from "../util/logger.js";
import {
  claimMergeNote,
  getSetting,
  getThreadByTicketId,
  markArticleSynced,
  releaseMergeNote,
  setSetting,
} from "../db/index.js";
import {
  createArticle,
  getStates,
  getTicket,
  getTicketHistoryWithUsers,
  getTicketLinks,
  type LinkedTicketInfo,
  type ZammadHistoryEntry,
  type ZammadLink,
} from "./zammad.js";
import { sendToThread, ticketUrl } from "./threads.js";
import { isClosedState } from "../util/states.js";

export type Relation = "merged_into" | "merged_from" | "parent" | "child" | "related";

export interface RelatedTicket {
  id: number;
  number: string;
  title: string;
  state: string;
  relation: Relation;
  /** Merges only: when it happened and who did it. */
  mergedAt?: string;
  mergedBy?: string;
}

export interface MergeEvent {
  childId: number;
  parentId: number;
  at: string;
  byId: number;
}

/** Merge events recorded in a ticket's own history (either direction). */
export function mergeEventsFromHistory(ticketId: number, history: ZammadHistoryEntry[]): MergeEvent[] {
  const out: MergeEvent[] = [];
  for (const h of history) {
    if (h.object !== "Ticket" || (h.o_id != null && h.o_id !== ticketId)) continue;
    if (h.type !== "merged_into" && h.type !== "received_merge") continue;
    const childId = Number(h.id_from);
    const parentId = Number(h.id_to);
    if (!childId || !parentId) continue;
    out.push({ childId, parentId, at: h.created_at, byId: h.created_by_id });
  }
  return out;
}

const RELATION_ORDER: Relation[] = ["merged_into", "parent", "merged_from", "child", "related"];

/**
 * Combine links and merge history into one list. A merge also creates a
 * parent/child link; the merge wins so the list says "merged" rather than
 * "child". Pure: no API calls, so it is unit tested.
 */
export function buildRelatedList(
  ticketId: number,
  links: ZammadLink[],
  tickets: Map<number, LinkedTicketInfo>,
  merges: MergeEvent[],
  stateName: (stateId: number) => string,
  userName: (userId: number) => string | undefined = () => undefined,
): RelatedTicket[] {
  const byId = new Map<number, RelatedTicket>();
  const info = (id: number) => tickets.get(id);

  for (const m of merges) {
    const otherId = m.childId === ticketId ? m.parentId : m.childId;
    if (otherId === ticketId) continue;
    const t = info(otherId);
    byId.set(otherId, {
      id: otherId,
      number: t?.number ?? "",
      title: t?.title ?? "",
      state: t ? stateName(t.state_id) : "",
      relation: m.childId === ticketId ? "merged_into" : "merged_from",
      mergedAt: m.at,
      mergedBy: userName(m.byId),
    });
  }

  for (const l of links) {
    if (l.link_object !== "Ticket") continue;
    const id = Number(l.link_object_value);
    if (!id || id === ticketId || byId.has(id)) continue;
    const t = info(id);
    const relation: Relation = l.link_type === "parent" ? "parent" : l.link_type === "child" ? "child" : "related";
    byId.set(id, {
      id,
      number: t?.number ?? "",
      title: t?.title ?? "",
      state: t ? stateName(t.state_id) : "",
      relation,
    });
  }

  return [...byId.values()].sort(
    (a, b) =>
      RELATION_ORDER.indexOf(a.relation) - RELATION_ORDER.indexOf(b.relation) ||
      Number(b.number || 0) - Number(a.number || 0)
  );
}

export function discordThreadUrl(threadId: string): string {
  return `https://discord.com/channels/${env().DISCORD_GUILD_ID}/${threadId}`;
}

async function stateNamer(): Promise<(id: number) => string> {
  try {
    const states = await getStates();
    const map = new Map(states.map((s) => [s.id, s.name]));
    return (id) => map.get(id) ?? "";
  } catch {
    return () => "";
  }
}

/** Fetch everything related to a ticket. Also returns the merge events. */
export async function getRelatedTickets(
  ticketId: number
): Promise<{ related: RelatedTicket[]; merges: MergeEvent[]; users: Map<number, string> }> {
  const [{ links, tickets }, { history, users }, stateName] = await Promise.all([
    getTicketLinks(ticketId),
    getTicketHistoryWithUsers(ticketId),
    stateNamer(),
  ]);
  const merges = mergeEventsFromHistory(ticketId, history);

  // A merged ticket whose link was removed is missing from the link assets.
  for (const m of merges) {
    const otherId = m.childId === ticketId ? m.parentId : m.childId;
    if (tickets.has(otherId)) continue;
    try {
      const t = await getTicket(otherId);
      tickets.set(otherId, { id: t.id, number: String(t.number), title: t.title, state_id: t.state_id });
    } catch {
      /* deleted ticket: listed by id only */
    }
  }

  const related = buildRelatedList(ticketId, links, tickets, merges, stateName, (id) => users.get(id));
  return { related, merges, users };
}

const RELATION_LABEL: Record<Relation, string> = {
  merged_into: "➡️ Merged into",
  merged_from: "🔀 Merged in",
  parent: "⬆️ Parent",
  child: "⬇️ Child",
  related: "🔗 Related",
};

function shorten(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** One Markdown line per related ticket, for Discord. */
export function formatRelatedLines(related: RelatedTicket[], max = 10): string[] {
  const lines = related.slice(0, max).map((r) => {
    const num = r.number ? `#${r.number}` : `id ${r.id}`;
    const title = r.title ? ` ${shorten(r.title.replace(/[[\]]/g, ""), 40)}` : "";
    const state = r.state ? ` (${r.state})` : "";
    const thread = getThreadByTicketId(r.id);
    const threadPart = thread ? ` · [Discord thread](${discordThreadUrl(thread.thread_id)})` : "";
    return `${RELATION_LABEL[r.relation]}: [${num}](${ticketUrl(r.id)})${title}${state}${threadPart}`;
  });
  if (related.length > max) lines.push(`*(+${related.length - max} more — use /related)*`);
  return lines;
}

// ---------------------------------------------------------------
// Merge announcements
// ---------------------------------------------------------------

/** Merges before this moment were made before the feature existed: list only. */
function announceSince(): string {
  let since = getSetting("MERGE_NOTES_SINCE");
  if (!since) {
    since = new Date().toISOString();
    setSetting("MERGE_NOTES_SINCE", since);
  }
  return since;
}

/** Call once at startup so the cut-off is the deploy time, not the first merge. */
export function initMergeAnnouncements(): void {
  announceSince();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function ticketRefHtml(t: { id: number; number: string; title: string }): string {
  return `<a href="${ticketUrl(t.id)}">#${escapeHtml(t.number)}</a> “${escapeHtml(t.title || "Untitled")}”`;
}

function threadRefHtml(ticketId: number): string {
  const m = getThreadByTicketId(ticketId);
  return m ? `<a href="${discordThreadUrl(m.thread_id)}">Discord thread</a>` : "no Discord thread";
}

/**
 * Internal note on a ticket, recorded as already synced so the webhook echo
 * does not post it back into Discord.
 */
async function addMergeNote(ticketId: number, html: string): Promise<void> {
  const article = await createArticle({
    ticket_id: ticketId,
    body: html,
    content_type: "text/html",
    internal: true,
    subject: "Ticket merge",
  });
  const thread = getThreadByTicketId(ticketId);
  if (thread) markArticleSynced(article.id, ticketId, thread.thread_id, null, "discord_to_zammad");
}

/**
 * Announce new merges in which this ticket took part. Returns the ids of the
 * receiving tickets that got an announcement (their status should refresh).
 * `merges` may be passed when the caller already read the history.
 */
export async function announceMerges(
  client: Client,
  ticketId: number,
  merges?: MergeEvent[],
  userNames?: Map<number, string>,
): Promise<number[]> {
  const since = announceSince();
  let users = userNames;
  if (!merges) {
    const h = await getTicketHistoryWithUsers(ticketId);
    merges = mergeEventsFromHistory(ticketId, h.history);
    users = h.users;
  }
  const fresh = merges.filter((m) => m.at >= since);
  const announced: number[] = [];

  for (const m of fresh) {
    if (!claimMergeNote(m.childId, m.parentId)) continue;
    let posted = false;
    try {
      const [child, parent] = await Promise.all([getTicket(m.childId), getTicket(m.parentId)]);
      const who = users?.get(m.byId);
      const when = new Date(m.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
      const byText = who ? ` by ${escapeHtml(who)}` : "";

      await addMergeNote(
        parent.id,
        `<p>🔀 Ticket ${ticketRefHtml(child)} was merged into this ticket${byText} on ${when}. ` +
          `Its messages now appear here.</p>` +
          `<p>Merged ticket: ${ticketRefHtml(child)} · ${threadRefHtml(child.id)}</p>`
      );
      posted = true;
      await addMergeNote(
        child.id,
        `<p>➡️ This ticket was merged into ${ticketRefHtml(parent)}${byText} on ${when}. ` +
          `Follow the conversation there.</p>` +
          `<p>Open: ${ticketRefHtml(parent)} · ${threadRefHtml(parent.id)}</p>`
      );

      // A closed target keeps its archived thread untouched (sendToThread
      // would briefly unarchive it); the Zammad note is enough there.
      const parentThread = getThreadByTicketId(parent.id);
      if (parentThread && !isClosedState(parent.state) && !isClosedState(parentThread.state)) {
        const childThread = getThreadByTicketId(child.id);
        const childLink = childThread ? ` · [Discord thread](${discordThreadUrl(childThread.thread_id)})` : "";
        await sendToThread(
          client,
          parentThread.thread_id,
          `🔀 Ticket [#${child.number}](${ticketUrl(child.id)}) (**${child.title || "Untitled"}**) was merged into this ticket${who ? ` by ${who}` : ""}. Its correspondence now lands here.${childLink}`
        );
      }
      const childThread = getThreadByTicketId(child.id);
      if (childThread) {
        const parentLink = parentThread ? ` · [Discord thread](${discordThreadUrl(parentThread.thread_id)})` : "";
        await sendToThread(
          client,
          childThread.thread_id,
          `➡️ This ticket was merged into [#${parent.number}](${ticketUrl(parent.id)}) (**${parent.title || "Untitled"}**).${parentLink}`
        );
      }

      announced.push(parent.id);
      logger.info({ childId: child.id, parentId: parent.id }, "Merge announced in Zammad and Discord");
    } catch (err) {
      // Retry later only if nothing went out yet; a half-done announcement is
      // better than the same note twice.
      if (!posted) releaseMergeNote(m.childId, m.parentId);
      logger.warn({ ticketId, merge: m, err, willRetry: !posted }, "Failed to announce merge");
    }
  }
  return announced;
}
