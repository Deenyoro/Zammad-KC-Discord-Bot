import { Client, ThreadChannel } from "discord.js";
import { logger } from "../util/logger.js";
import {
  getThreadByTicketId,
  getAllTicketThreads,
  updateThreadState,
} from "../db/index.js";
import { getAllOpenTickets, getUser } from "./zammad.js";
import {
  addRoleMembersToThread,
  createTicketThread,
  updateHeaderEmbed,
  closeTicketThread,
  ticketUrl,
  type TicketInfo,
} from "./threads.js";

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
        // Skip for "pending close" — members were intentionally removed
        if (ticketInfo.state !== "pending close") {
          try {
            const thread = await client.channels.fetch(existing.thread_id) as ThreadChannel | null;
            if (thread?.isThread() && !thread.archived) {
              await addRoleMembersToThread(thread);
            }
          } catch (err) {
            logger.debug({ ticketId: ticket.id, err }, "Failed to sync role members to thread");
          }
        }

        // Update state if changed
        if (ticketInfo.state !== existing.state) {
          updateThreadState(ticket.id, ticketInfo.state);
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
    if (mapping.state === "closed") continue; // already closed
    if (openTicketIds.has(mapping.ticket_id)) continue; // still open

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
    url: ticketUrl(ticket.id),
  };
}
