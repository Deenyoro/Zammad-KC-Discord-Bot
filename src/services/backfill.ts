import { Client, ThreadChannel } from "discord.js";
import { logger } from "../util/logger.js";
import {
  getThreadByTicketId,
  getAllTicketThreads,
  updateThreadState,
  updateThreadTitle,
} from "../db/index.js";
import { getAllOpenTickets, getTicket, getUser } from "./zammad.js";
import {
  addRoleMembersToThread,
  removeRoleMembersFromThread,
  createTicketThread,
  updateHeaderEmbed,
  closeTicketThread,
  reopenTicketThread,
  renameTicketThread,
  ticketUrl,
  type TicketInfo,
} from "./threads.js";
import { discordQueue } from "../queue/index.js";

/**
 * Sync all non-closed Zammad tickets to Discord threads.
 * - Creates threads for tickets that don't have one yet
 * - Updates the header embed for tickets that already have a thread
 * - Closes threads for tickets that became closed since last sync
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

        // Ensure all role members are in the thread (catches newly added members)
        // Skip for "pending close" and "waiting for reply" — members were intentionally removed
        const isHiddenState = ticketInfo.state === "pending close" || ticketInfo.state === "waiting for reply";
        if (!isHiddenState) {
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
          const isClosedState = (s: string) => s === "closed" || s === "closed (locked)" || s === "closed (locked until)";

          // Reopen thread if it was closed but ticket is now open
          // BUT: Add grace period to avoid race condition with /ticket close command
          // or stale Zammad API data (the API list can lag behind individual ticket state)
          if (isClosedState(existing.state) && !isClosedState(ticketInfo.state)) {
            // Skip recently closed threads to avoid race condition:
            // If /ticket close was just run, the Zammad API might still show stale
            // "open" state while the webhook is processing. Wait 60 seconds before
            // reopening to avoid fighting with the close command or stale API data.
            const updatedAt = new Date(existing.updated_at);
            const ageSeconds = (Date.now() - updatedAt.getTime()) / 1000;
            if (ageSeconds < 60) {
              logger.debug(
                { ticketId: ticket.id, ageSeconds, dbState: existing.state, apiState: ticketInfo.state },
                "Skipping reopen of recently closed thread (grace period)"
              );
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
                }
              } catch (err) {
                logger.warn({ ticketId: ticket.id, err }, "Failed to verify/reopen thread");
              }
            }
          }

          // Handle hidden state transitions (catches changes that happened while bot was down)
          const isHiddenStateFn = (s: string) => s === "pending close" || s === "waiting for reply";
          if (isHiddenStateFn(ticketInfo.state) && !isHiddenStateFn(existing.state)) {
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
          if (isHiddenStateFn(existing.state) && !isHiddenStateFn(ticketInfo.state) && !isClosedState(ticketInfo.state)) {
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

        // Update title if changed
        if (ticket.title !== existing.title) {
          try {
            await renameTicketThread(client, existing.thread_id, existing.ticket_number, ticket.title);
            updateThreadTitle(ticket.id, ticket.title);
            logger.info({ ticketId: ticket.id, oldTitle: existing.title, newTitle: ticket.title }, "Renamed thread via sync for title change");
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
    if (mapping.state === "closed" || mapping.state === "closed (locked)" || mapping.state === "closed (locked until)") continue; // already closed
    if (openTicketIds.has(mapping.ticket_id)) continue; // still open

    // Skip recently created threads to avoid race condition:
    // If a webhook creates a thread DURING this sync (after we fetched tickets),
    // the thread won't be in openTicketIds but the ticket IS actually open.
    // Wait 2 minutes before considering a thread "stale" to avoid false positives.
    const createdAt = new Date(mapping.created_at);
    const ageMinutes = (Date.now() - createdAt.getTime()) / (1000 * 60);
    if (ageMinutes < 2) {
      logger.debug({ ticketId: mapping.ticket_id, ageMinutes }, "Skipping recently created thread");
      continue;
    }

    try {
      updateThreadState(mapping.ticket_id, "closed");
      await closeTicketThread(client, mapping.thread_id);
      closed++;
      logger.info({ ticketId: mapping.ticket_id }, "Closed thread for ticket no longer open");
    } catch (err) {
      logger.warn({ ticketId: mapping.ticket_id, err }, "Failed to close stale thread");
    }
  }

  logger.info({ created, updated, closed, failed, total: tickets.length }, "Ticket sync complete");
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
