import { Client, ThreadChannel } from "discord.js";
import { logger } from "../util/logger.js";
import {
  getThreadByTicketId,
  getAllTicketThreads,
  updateThreadState,
  updateThreadTitle,
} from "../db/index.js";
import { getAllOpenTickets, getTicket, getUser } from "./zammad.js";
import { syncAllUnsyncedArticles } from "./sync.js";
import {
  addRoleMembersToThread,
  removeRoleMembersFromThread,
  createTicketThread,
  updateHeaderEmbed,
  closeTicketThread,
  reopenTicketThread,
  renameTicketThread,
  ticketUrl,
  formatOwnerLabelFromFull,
  buildThreadName,
  listNeedsVerification,
  ownerUnknown,
  type TicketInfo,
} from "./threads.js";
import { discordQueue, enqueueForTicket } from "../queue/index.js";
import { isClosedState, isHiddenState, isDashboardState } from "../util/states.js";
import { updateDashboards } from "./dashboards.js";

// Article catch-up cycle counter.  Every ARTICLE_CATCHUP_INTERVAL cycles
// (~2 min at 30 s intervals) we re-sync articles for ALL open tickets so
// that any webhook that was lost or returned stale data is eventually caught.
// Start at 1 so the first catch-up is at cycle ARTICLE_CATCHUP_INTERVAL,
// giving the bot time to stabilize after startup before bulk-downloading
// attachments (avoids OOM on boot when there's a large backlog).
let syncCycleCount = 1;
const ARTICLE_CATCHUP_INTERVAL = 4;

// ---------------------------------------------------------------------------
// Fast article catch-up
//
// The full sync below does several Discord calls per ticket and takes 1.5-2 minutes for ~25 tickets, so its
// own "every 4th cycle" article catch-up really ran every 7-8 minutes (2026-11-17: a note and an email created
// without a webhook showed up in Discord 2 and 4 minutes late, the customer's reply arrived first).
// This pass is separate and cheap: one ticket list call, then an article check only for tickets whose
// updated_at moved since the last pass (plus every ticket on each CATCHUP_FULL_EVERY-th pass, because the list
// API can lag).
// ---------------------------------------------------------------------------
const CATCHUP_FULL_EVERY = 10;
const catchupSeen = new Map<number, string>();
let catchupPass = 0;

/** Ticket ids whose articles should be checked on this pass. Pure, for tests. */
export function ticketsNeedingCatchup(
  tickets: Array<{ id: number; updated_at: string }>,
  seen: ReadonlyMap<number, string>,
  full: boolean,
): number[] {
  return tickets.filter((t) => full || seen.get(t.id) !== t.updated_at).map((t) => t.id);
}

/** True when a ticket changed within the last 30 minutes (or its time cannot be read). Pure, for tests. */
export function recentlyUpdated(updatedAt: string, now: number): boolean {
  const at = new Date(updatedAt).getTime();
  return Number.isNaN(at) || now - at < 30 * 60 * 1000;
}

export async function catchUpArticles(client: Client): Promise<void> {
  let tickets;
  try {
    tickets = await getAllOpenTickets();
  } catch (err) {
    logger.warn({ err }, "Article catch-up: could not list open tickets");
    return;
  }
  catchupPass++;
  // First pass after start: tickets that have not moved recently are only remembered (the full sync does their
  // first catch-up once the bot has settled; bulk attachment downloads right after boot ran it out of memory
  // before). Tickets updated in the last 30 minutes are checked now: 1.7.7 remembered those too, so a message
  // created while the bot restarted was treated as already seen and waited for the next full pass.
  if (catchupPass === 1) {
    for (const t of tickets) if (!recentlyUpdated(t.updated_at, Date.now())) catchupSeen.set(t.id, t.updated_at);
  }
  const ids = new Set(ticketsNeedingCatchup(tickets, catchupSeen, catchupPass % CATCHUP_FULL_EVERY === 0));
  let checked = 0;
  for (const t of tickets) {
    if (!ids.has(t.id)) continue;
    const existing = getThreadByTicketId(t.id);
    if (!existing) continue; // the full sync creates the thread and its first messages
    try {
      await enqueueForTicket(t.id, () => syncAllUnsyncedArticles(client, existing.thread_id, t.id));
      catchupSeen.set(t.id, t.updated_at);
      checked++;
    } catch (err) {
      logger.warn({ ticketId: t.id, err }, "Article catch-up failed for ticket");
    }
  }
  const open = new Set(tickets.map((t) => t.id));
  for (const id of catchupSeen.keys()) if (!open.has(id)) catchupSeen.delete(id);
  if (checked > 0) logger.info({ checked, open: tickets.length }, "Article catch-up pass complete");
}

/**
 * Sync all non-closed Zammad tickets to Discord threads.
 * - Creates threads for tickets that don't have one yet
 * - Updates the header embed for tickets that already have a thread
 * - Closes threads for tickets that became closed since last sync
 * - Periodically catches up missed articles for all open tickets
 *
 * Called on startup and periodically via setInterval.
 */
export async function syncAllTickets(client: Client): Promise<void> {
  logger.info("Starting ticket sync from Zammad...");

  let tickets;
  try {
    tickets = await getAllOpenTickets();
  } catch (err) {
    logger.error({ err }, "Failed to fetch open tickets from Zammad");
    return;
  }

  logger.info({ count: tickets.length }, "Found open tickets to sync");

  const openTicketIds = new Set<number>();
  let created = 0;
  let updated = 0;
  let closed = 0;
  let failed = 0;

  for (const ticket of tickets) {
    openTicketIds.add(ticket.id);

    try {
      const ticketInfo = await buildTicketInfo(ticket);
      const existing = getThreadByTicketId(ticket.id);

      if (!existing) {
        await createTicketThread(client, ticketInfo);
        created++;
        logger.info({ ticketId: ticket.id, number: ticket.number }, "Created ticket thread");
      } else {
        // The list API (/tickets?expand=true) can return STALE data, it lags
        // behind individual ticket fetches by seconds to minutes.  When the list
        // state/title disagrees with what our DB says (which is updated in
        // real-time by webhooks and bot commands), verify with a fresh individual
        // ticket fetch before trusting the list data.  This prevents the sync
        // from undoing rename/state changes the user just made.
        const listDisagreesOnState = ticketInfo.state !== existing.state;
        const listDisagreesOnTitle = ticket.title !== existing.title;
        let verifiedTicketInfo = ticketInfo;
        let verifiedTitle = ticket.title;

        // The same goes for the owner: a list that still shows the ticket unassigned (or still shows the
        // previous owner) would rename the thread and undo the assignment, and the next webhook would put it
        // back (2026-11-17: the name flipped every sync). So whenever the list would change the thread's
        // name, re-read the ticket first.
        let currentThreadName: string | undefined;
        try {
          const th = await client.channels.fetch(existing.thread_id) as ThreadChannel | null;
          if (th?.isThread() && !th.archived) currentThreadName = th.name;
        } catch {
          // thread not readable: nothing to rename, nothing to verify for the name
        }
        const listOwnerLabel = ticketInfo.owner ? formatOwnerLabelFromFull(ticketInfo.owner) : undefined;
        // true when the name must not be touched this cycle (data could not be confirmed)
        let keepThreadName = ownerUnknown(ticketInfo);

        if (listNeedsVerification({
          listState: ticketInfo.state, storedState: existing.state, listTitle: ticket.title, storedTitle: existing.title ?? "",
          currentThreadName, nameFromList: buildThreadName(existing.ticket_number, ticket.title, listOwnerLabel),
        }) || listDisagreesOnState || listDisagreesOnTitle) {
          try {
            const freshTicket = await getTicket(ticket.id);
            const freshInfo = await buildTicketInfo(freshTicket);
            verifiedTicketInfo = freshInfo;
            verifiedTitle = freshTicket.title;
            keepThreadName = ownerUnknown(freshInfo);
            if (freshInfo.state !== ticketInfo.state || freshTicket.title !== ticket.title
                || freshInfo.owner_id !== ticketInfo.owner_id) {
              logger.info(
                { ticketId: ticket.id, listState: ticketInfo.state, freshState: freshInfo.state, listTitle: ticket.title,
                  freshTitle: freshTicket.title, listOwnerId: ticketInfo.owner_id, freshOwnerId: freshInfo.owner_id },
                "List API was stale, using fresh individual ticket data"
              );
            }
          } catch (err) {
            // Could not confirm: keep what the thread shows rather than apply data known to lag.
            keepThreadName = true;
            logger.warn({ ticketId: ticket.id, err }, "Failed to fetch fresh ticket data, leaving the thread name as it is");
          }
        }

        // Update the header embed in case state/assignee changed
        try {
          await updateHeaderEmbed(client, existing.channel_id, existing.header_message_id, verifiedTicketInfo);
          updated++;
        } catch (err) {
          logger.warn({ ticketId: ticket.id, err }, "Failed to update existing thread embed");
        }

        // Periodic article catch-up: sync any articles missed by webhooks.
        // Runs every Nth cycle to avoid hammering the Zammad API every 30 s.
        //
        // MUST be enqueued through the per-ticket queue so it serializes
        // with webhook-triggered syncs for the same ticket. Without this,
        // a backfill cycle running concurrently with a webhook sync will
        // post messages to Discord in interleaved order, even though each
        // call sorts by article ID, because discordQueue has concurrency
        // 10 and both callers' thread.send() requests race at the API.
        if (syncCycleCount % ARTICLE_CATCHUP_INTERVAL === 0) {
          try {
            await enqueueForTicket(ticket.id, () =>
              syncAllUnsyncedArticles(client, existing.thread_id, ticket.id),
            );
          } catch (err) {
            logger.warn({ ticketId: ticket.id, err }, "Failed to catch up articles during periodic sync");
          }
        }

        // Ensure all role members are in the thread (catches newly added members)
        // Skip for hidden states (pending close, waiting for reply, on-site, project), members were intentionally removed
        if (!isHiddenState(verifiedTicketInfo.state)) {
          try {
            // MUST run through the per-ticket queue: a /close command or
            // close-webhook can archive+lock the thread and remove members
            // while this backfill iteration is mid-flight. Unqueued, the
            // force-unarchive below would then undo the close permanently
            // DB says "closed" so neither the open-list loop nor the
            // stale-close loop ever re-archives it. Inside the queue we
            // re-read the DB state and skip if the ticket went terminal.
            await enqueueForTicket(ticket.id, async () => {
              const current = getThreadByTicketId(ticket.id);
              if (!current || isClosedState(current.state) || isHiddenState(current.state)) return;
              const thread = await client.channels.fetch(existing.thread_id, { force: true }) as ThreadChannel | null;
              if (!thread?.isThread()) return;
              // Always force-unarchive non-hidden/non-closed threads.
              // Discord auto-archives after inactivity and the cached state
              // may not reflect reality. This is cheap (Discord ignores
              // no-op edits) and guarantees the thread stays visible.
              await discordQueue.add(async () => {
                await thread.edit({ archived: false, locked: false, reason: "Ticket is open, ensuring thread is visible" });
              });
              await addRoleMembersToThread(thread);
            });
          } catch (err) {
            logger.debug({ ticketId: ticket.id, err }, "Failed to sync role members to thread");
          }
        } else {
          // Ensure hidden-state threads stay archived (catches manual unarchives or bot restarts)
          try {
            const thread = await client.channels.fetch(existing.thread_id) as ThreadChannel | null;
            if (thread?.isThread() && !thread.archived && isDashboardState(verifiedTicketInfo.state)) {
              await discordQueue.add(async () => {
                await thread.edit({ archived: true, reason: `Re-archiving ${verifiedTicketInfo.state} thread` });
              });
              logger.info({ ticketId: ticket.id, state: verifiedTicketInfo.state }, "Re-archived dashboard-state thread");
            }
          } catch (err) {
            logger.debug({ ticketId: ticket.id, err }, "Failed to ensure hidden thread stays archived");
          }
        }

        // Update state if changed
        if (verifiedTicketInfo.state !== existing.state) {
          updateThreadState(ticket.id, verifiedTicketInfo.state);

          // Reopen thread if it was closed but ticket is now open
          // BUT: Add grace period to avoid race condition with /ticket close command
          // or stale Zammad API data (the API list can lag behind individual ticket state)
          if (isClosedState(existing.state) && !isClosedState(verifiedTicketInfo.state)) {
            // Skip recently changed threads to avoid race condition:
            // If /ticket close was just run, the Zammad API might still show stale
            // "open" state while the webhook is processing. Wait 120 seconds before
            // reopening to avoid fighting with the close command or stale API data.
            const updatedAt = new Date(existing.updated_at);
            const ageSeconds = (Date.now() - updatedAt.getTime()) / 1000;
            if (ageSeconds < 120) {
              logger.debug(
                { ticketId: ticket.id, ageSeconds, dbState: existing.state, apiState: verifiedTicketInfo.state },
                "Skipping reopen of recently closed thread (grace period)"
              );
              // Revert DB state, don't adopt stale list state during grace period
              updateThreadState(ticket.id, existing.state);
            } else {
              await reopenTicketThread(client, existing.thread_id);
              logger.info({ ticketId: ticket.id, freshState: verifiedTicketInfo.state }, "Reopened thread for ticket that is no longer closed");
              // Sync any articles that were missed while the ticket was closed.
              // Through the per-ticket queue so it serializes with any in-flight webhook.
              await enqueueForTicket(ticket.id, () =>
                syncAllUnsyncedArticles(client, existing.thread_id, ticket.id),
              );
            }
          }

          // Handle hidden state transitions (catches changes that happened while bot was down)
          if (isHiddenState(verifiedTicketInfo.state) && !isHiddenState(existing.state)) {
            try {
              await removeRoleMembersFromThread(client, existing.thread_id);
              if (isDashboardState(verifiedTicketInfo.state)) {
                const thread = await client.channels.fetch(existing.thread_id) as ThreadChannel | null;
                if (thread?.isThread() && !thread.archived) {
                  await discordQueue.add(async () => {
                    await thread.edit({ archived: true, reason: `Ticket is ${verifiedTicketInfo.state}` });
                  });
                }
              }
            } catch (err) {
              logger.warn({ ticketId: ticket.id, err }, "Failed to hide thread for hidden state");
            }
          }

          // Transition OUT of hidden state → unarchive and re-add members
          if (isHiddenState(existing.state) && !isHiddenState(verifiedTicketInfo.state) && !isClosedState(verifiedTicketInfo.state)) {
            try {
              const thread = await client.channels.fetch(existing.thread_id) as ThreadChannel | null;
              if (thread?.isThread()) {
                if (thread.archived) {
                  await discordQueue.add(async () => {
                    await thread.edit({ archived: false, reason: "Ticket no longer in hidden state" });
                  });
                }
                await addRoleMembersToThread(thread);
              }
            } catch (err) {
              logger.warn({ ticketId: ticket.id, err }, "Failed to unhide thread from hidden state");
            }
          }
        }

        // Update title/owner in thread name
        const ownerLabel = verifiedTicketInfo.owner ? formatOwnerLabelFromFull(verifiedTicketInfo.owner) : undefined;
        if (verifiedTitle !== existing.title) {
          updateThreadTitle(ticket.id, verifiedTitle);
        }
        // Rename only with confirmed data, it skips by itself when the name hasn't actually changed
        if (!keepThreadName) {
          try {
            await renameTicketThread(client, existing.thread_id, existing.ticket_number, verifiedTitle, ownerLabel);
          } catch (err) {
            logger.warn({ ticketId: ticket.id, err }, "Failed to rename thread");
          }
        }
      }
    } catch (err) {
      failed++;
      logger.error({ ticketId: ticket.id, err }, "Failed to sync ticket");
    }
  }

  // Close threads for tickets that are no longer open
  const allMappings = getAllTicketThreads();
  for (const mapping of allMappings) {
    if (isClosedState(mapping.state)) continue; // already closed
    if (openTicketIds.has(mapping.ticket_id)) continue; // still open

    // Skip recently created OR recently updated threads to avoid race conditions:
    // - A webhook may create a thread DURING this sync (after we fetched tickets)
    // - A ticket may temporarily be missing from the paginated list due to API lag
    const createdAt = new Date(mapping.created_at);
    const updatedAt = new Date(mapping.updated_at);
    const createAgeMinutes = (Date.now() - createdAt.getTime()) / (1000 * 60);
    const updateAgeMinutes = (Date.now() - updatedAt.getTime()) / (1000 * 60);
    if (createAgeMinutes < 2 || updateAgeMinutes < 2) {
      logger.debug(
        { ticketId: mapping.ticket_id, createAgeMinutes, updateAgeMinutes },
        "Skipping recently created/updated thread"
      );
      continue;
    }

    // Always verify with a fresh individual ticket fetch before closing.
    // The paginated list can miss tickets due to pagination race conditions
    // or API caching; closing an open ticket is far worse than a brief delay.
    try {
      const freshTicket = await getTicket(mapping.ticket_id);
      const freshState = freshTicket.state.toLowerCase();
      if (!isClosedState(freshState)) {
        logger.info(
          { ticketId: mapping.ticket_id, listMissing: true, freshState },
          "Skipping close - fresh API shows ticket is still open (list was incomplete)"
        );
        // Update DB state to match reality
        updateThreadState(mapping.ticket_id, freshState);
        continue;
      }

      updateThreadState(mapping.ticket_id, freshState);
      await closeTicketThread(client, mapping.thread_id);
      closed++;
      logger.info({ ticketId: mapping.ticket_id, freshState }, "Closed thread for ticket confirmed closed");
    } catch (err) {
      if (err instanceof Error && /Zammad API 404:/.test(err.message)) {
        // The ticket no longer exists in Zammad (deleted/merged away). Retire the
        // thread once instead of re-fetching it every sync cycle forever.
        updateThreadState(mapping.ticket_id, "deleted");
        try {
          const thread = (await client.channels.fetch(mapping.thread_id)) as ThreadChannel | null;
          if (thread?.isThread()) {
            await discordQueue.add(() => thread.send("\u{1F5D1}\uFE0F This ticket was deleted in Zammad. Thread archived."));
          }
          await closeTicketThread(client, mapping.thread_id);
        } catch (closeErr) {
          logger.warn({ ticketId: mapping.ticket_id, err: closeErr }, "Ticket deleted in Zammad but the thread could not be archived");
        }
        closed++;
        logger.info({ ticketId: mapping.ticket_id }, "Ticket deleted in Zammad, thread retired");
        continue;
      }
      logger.warn({ ticketId: mapping.ticket_id, err }, "Failed to verify/close stale thread");
    }
  }

  // Update the Other Tickets dashboard thread
  await updateDashboards(client);

  syncCycleCount++;
  logger.info({ created, updated, closed, failed, total: tickets.length, articleCatchup: (syncCycleCount - 1) % ARTICLE_CATCHUP_INTERVAL === 0 }, "Ticket sync complete");
}

async function buildTicketInfo(ticket: {
  id: number;
  number: string;
  title: string;
  state: string;
  priority: string;
  owner_id: number;
  customer_id: number;
  customer: string;
  group: string;
  created_at: string;
  escalation_at?: string | null;
}): Promise<TicketInfo> {
  let ownerName: string | undefined;
  if (ticket.owner_id && ticket.owner_id > 1) {
    try {
      const owner = await getUser(ticket.owner_id);
      ownerName = `${owner.firstname} ${owner.lastname}`.trim() || undefined;
    } catch {
      // non-critical
    }
  }

  let customerName: string | undefined;
  if (ticket.customer_id) {
    try {
      const customer = await getUser(ticket.customer_id);
      customerName = `${customer.firstname} ${customer.lastname}`.trim() || undefined;
    } catch {
      customerName = ticket.customer || undefined;
    }
  }

  return {
    id: ticket.id,
    number: ticket.number,
    title: ticket.title,
    state: ticket.state.toLowerCase(),
    priority: ticket.priority,
    customer: customerName,
    owner: ownerName,
    owner_id: ticket.owner_id,
    group: ticket.group,
    created_at: ticket.created_at,
    escalation_at: ticket.escalation_at,
    url: ticketUrl(ticket.id),
  };
}
