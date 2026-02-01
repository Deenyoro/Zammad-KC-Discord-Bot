import PQueue from "p-queue";
import { logger } from "../util/logger.js";

/**
 * Per-ticket work queues to serialize Discord operations for the same ticket.
 * Prevents race conditions when multiple webhook deliveries arrive for the
 * same ticket in quick succession.
 */
const ticketQueues = new Map<number, PQueue>();

function getTicketQueue(ticketId: number): PQueue {
  let q = ticketQueues.get(ticketId);
  if (!q) {
    q = new PQueue({ concurrency: 1 });
    q.on("idle", () => {
      ticketQueues.delete(ticketId);
    });
    ticketQueues.set(ticketId, q);
  }
  return q;
}

/**
 * Enqueue a task for a specific ticket. Tasks for the same ticket run
 * serially; tasks for different tickets run in parallel.
 */
export async function enqueueForTicket<T>(
  ticketId: number,
  fn: () => Promise<T>
): Promise<T> {
  const q = getTicketQueue(ticketId);
  return q.add(async () => {
    try {
      return await fn();
    } catch (err) {
      logger.error({ ticketId, err }, "Queued task failed");
      throw err;
    }
  }) as Promise<T>;
}

/** Global outbound Discord queue to respect ~50 req/s global rate limit. */
export const discordQueue: PQueue = new PQueue({
  concurrency: 10,
  intervalCap: 45,
  interval: 1000,
});
