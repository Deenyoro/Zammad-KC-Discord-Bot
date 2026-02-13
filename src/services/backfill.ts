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
import { discordQueue } from "../queue/index.js";
import { isClosedState, isHiddenState } from "../util/states.js";

// Article catch-up cycle counter.  Every ARTICLE_CATCHUP_INTERVAL cycles
// (~5 min at 30 s intervals) we re-sync articles for ALL open tickets so
// that any webhook that was lost or returned stale data is eventually caught.
// Start at 1 so the first catch-up is at cycle ARTICLE_CATCHUP_INTERVAL,
// giving the bot time to stabilize after startup before bulk-downloading
// attachments (avoids OOM on boot when there's a large backlog).
let syncCycleCount = 1;
const ARTICLE_CATCHUP_INTERVAL = 10;

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
        // Update the header embed in case state/assignee changed
        try {
          await updateHeaderEmbed(client, existing.channel_id, existing.header_message_id, ticketInfo);
          updated++;
        } catch (err) {
          logger.warn({ ticketId: ticket.id, err }, "Failed to update existing thread embed");
        }

        // Periodic article catch-up: sync any articles missed by webhooks.
        // Runs every Nth cycle to avoid hammering the Zammad API every 30 s.
        if (syncCycleCount % ARTICLE_CATCHUP_INTERVAL === 0) {
          try {
            await syncAllUnsyncedArticles(client, existing.thread_id, ticket.id);
          } catch (err) {
            logger.warn({ ticketId: ticket.id, err }, "Failed to catch up articles during periodic sync");
          }
        }

        // Ensure all role members are in the thread (catches newly added members)
        // Skip for "pending close" and "waiting for reply" — members were intentionally removed
        if (!isHiddenState(ticketInfo.state)) {
          try {
            const thread = await client.channels.fetch(existing.thread_id) as ThreadChannel | null;
            if (thread?.isThread() && !thread.archived) {
              await addRoleMembersToThread(thread);
            }
          } catch (err) {
            logger.debug({ ticketId: ticket.id, err }, "Failed to sync role members to thread");
          }
        } else {
          // Ensure hidden-state threads stay archived (catches manual unarchives or bot restarts)
          try {
            const thread = await client.channels.fetch(existing.thread_id) as ThreadChannel | null;
            if (thread?.isThread() && !thread.archived && ticketInfo.state === "waiting for reply") {
              await discordQueue.add(async () => {
                await thread.edit({ archived: true, reason: "Re-archiving waiting for reply thread" });
              });
              logger.info({ ticketId: ticket.id }, "Re-archived waiting for reply thread");
            }
          } catch (err) {
            logger.debug({ ticketId: ticket.id, err }, "Failed to ensure hidden thread stays archived");
          }
        }

        // Update state if changed
        if (ticketInfo.state !== existing.state) {
          updateThreadState(ticket.id, ticketInfo.state);

          // Reopen thread if it was closed but ticket is now open
          // BUT: Add grace period to avoid race condition with /ticket close command
          // or stale Zammad API data (the API list can lag behind individual ticket state)
          if (isClosedState(existing.state) && !isClosedState(ticketInfo.state)) {
            // Skip recently changed threads to avoid race condition:
            // If /ticket close was just run, the Zammad API might still show stale
            // "open" state while the webhook is processing. Wait 120 seconds before
            // reopening to avoid fighting with the close command or stale API data.
            const updatedAt = new Date(existing.updated_at);
            const ageSeconds = (Date.now() - updatedAt.getTime()) / 1000;
            if (ageSeconds < 120) {
              logger.debug(
                { ticketId: ticket.id, ageSeconds, dbState: existing.state, apiState: ticketInfo.state },
                "Skipping reopen of recently closed thread (grace period)"
              );
              // Revert DB state — don't adopt stale list state during grace period
              updateThreadState(ticket.id, existing.state);
            } else {
              // Double-check by fetching fresh ticket data directly (bypasses any list caching)
              try {
                const freshTicket = await getTicket(ticket.id);
                const freshState = freshTicket.state.toLowerCase();
                if (isClosedState(freshState)) {
                  logger.info(
                    { ticketId: ticket.id, listState: ticketInfo.state, freshState },
                    "Skipping reopen - fresh API confirms ticket is closed (list was stale)"
                  );
                  // Update the DB state to match and skip reopen
                  updateThreadState(ticket.id, freshState);
                } else {
                  await reopenTicketThread(client, existing.thread_id);
                  logger.info({ ticketId: ticket.id, freshState }, "Reopened thread for ticket that is no longer closed");
                  // Sync any articles that were missed while the ticket was closed
                  // (e.g. customer reply that triggered the reopen)
                  await syncAllUnsyncedArticles(client, existing.thread_id, ticket.id);
                }
              } catch (err) {
                logger.warn({ ticketId: ticket.id, err }, "Failed to verify/reopen thread");
              }
            }
          }

          // Handle hidden state transitions (catches changes that happened while bot was down)
          if (isHiddenState(ticketInfo.state) && !isHiddenState(existing.state)) {
            try {
              await removeRoleMembersFromThread(client, existing.thread_id);
              if (ticketInfo.state === "waiting for reply") {
                const thread = await client.channels.fetch(existing.thread_id) as ThreadChannel | null;
                if (thread?.isThread() && !thread.archived) {
                  await discordQueue.add(async () => {
                    await thread.edit({ archived: true, reason: "Ticket is waiting for reply" });
                  });
                }
              }
            } catch (err) {
              logger.warn({ ticketId: ticket.id, err }, "Failed to hide thread for hidden state");
            }
          }

          // Transition OUT of hidden state → unarchive and re-add members
          if (isHiddenState(existing.state) && !isHiddenState(ticketInfo.state) && !isClosedState(ticketInfo.state)) {
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
        const ownerLabel = ticketInfo.owner ? formatOwnerLabelFromFull(ticketInfo.owner) : undefined;
        if (ticket.title !== existing.title) {
          updateThreadTitle(ticket.id, ticket.title);
        }
        // Always pass current owner to rename — it will skip if the name hasn't actually changed
        try {
          await renameTicketThread(client, existing.thread_id, existing.ticket_number, ticket.title, ownerLabel);
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
