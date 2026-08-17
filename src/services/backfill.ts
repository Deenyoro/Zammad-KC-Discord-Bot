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
        // The list API (/tickets?expand=true) can return STALE data — it lags
        // behind individual ticket fetches by seconds to minutes.  When the list
        // state/title disagrees with what our DB says (which is updated in
        // real-time by webhooks and bot commands), verify with a fresh individual
        // ticket fetch before trusting the list data.  This prevents the sync
        // from undoing rename/state changes the user just made.
        const listDisagreesOnState = ticketInfo.state !== existing.state;
        const listDisagreesOnTitle = ticket.title !== existing.title;
        let verifiedTicketInfo = ticketInfo;
        let verifiedTitle = ticket.title;

        if (listDisagreesOnState || listDisagreesOnTitle) {
          try {
            const freshTicket = await getTicket(ticket.id);
            const freshInfo = await buildTicketInfo(freshTicket);
            verifiedTicketInfo = freshInfo;
            verifiedTitle = freshTicket.title;
            if (freshInfo.state !== ticketInfo.state || freshTicket.title !== ticket.title) {
              logger.info(
                { ticketId: ticket.id, listState: ticketInfo.state, freshState: freshInfo.state, listTitle: ticket.title, freshTitle: freshTicket.title },
                "List API was stale — using fresh individual ticket data"
              );
            }
          } catch (err) {
            logger.warn({ ticketId: ticket.id, err }, "Failed to fetch fresh ticket data — using list data");
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
        // post messages to Discord in interleaved order — even though each
        // call sorts by article ID — because discordQueue has concurrency
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
        // Skip for hidden states (pending close, waiting for reply, on-site, project) — members were intentionally removed
        if (!isHiddenState(verifiedTicketInfo.state)) {
          try {
            // MUST run through the per-ticket queue: a /close command or
            // close-webhook can archive+lock the thread and remove members
            // while this backfill iteration is mid-flight. Unqueued, the
            // force-unarchive below would then undo the close permanently —
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
                await thread.edit({ archived: false, locked: false, reason: "Ticket is open — ensuring thread is visible" });
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
              // Revert DB state — don't adopt stale list state during grace period
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
        // Always pass current owner to rename — it will skip if the name hasn't actually changed
        try {
          await renameTicketThread(client, existing.thread_id, existing.ticket_number, verifiedTitle, ownerLabel);
        } catch (err) {
          logger.warn({ ticketId: ticket.id, err }, "Failed to rename thread");
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
