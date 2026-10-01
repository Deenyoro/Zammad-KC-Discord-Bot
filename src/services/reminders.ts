/**
 * /remind-me delivery.
 *
 * Reminders live in the bot's SQLite database (data/bot.db on the bot's
 * persistent volume), so they survive restarts and redeploys. A timer checks
 * for due reminders every 15 seconds; reminders that fell due while the bot
 * was down are delivered on startup, marked as late.
 */

import type { Client, Message, ThreadChannel } from "discord.js";
import { logger } from "../util/logger.js";
import { discordQueue } from "../queue/index.js";
import {
  getDueReminders,
  markReminderDelivered,
  markReminderFailed,
  type Reminder,
} from "../db/index.js";

export const REMINDER_MIN_LEAD_MS = 30_000;
export const REMINDER_MAX_AHEAD_MS = 366 * 24 * 3600_000;
export const REMINDER_MAX_PENDING_PER_USER = 100;
const POLL_MS = 15_000;
const MAX_ATTEMPTS = 8;
/** Delivered later than this after due_at → the message says it is late. */
const LATE_AFTER_MS = 2 * 60_000;

export type ReminderTimeCheck =
  | { ok: true; due: Date }
  | { ok: false; error: string };

export const REMINDER_FORMATS =
  "`30m`, `2h`, `1h30m`, `3d`, `1w`, `tomorrow 9am`, `friday 3pm`, `17:30`, `2026-10-05 14:00`";

/** Validate a parsed reminder time (from parseTime) against now. */
export function checkReminderTime(parsedIso: string | null, input: string, now: Date = new Date()): ReminderTimeCheck {
  if (!parsedIso) {
    return { ok: false, error: `Could not understand \`${input.slice(0, 64)}\`. Use for example ${REMINDER_FORMATS}.` };
  }
  const due = new Date(parsedIso);
  if (Number.isNaN(due.getTime())) {
    return { ok: false, error: `Could not understand \`${input.slice(0, 64)}\`. Use for example ${REMINDER_FORMATS}.` };
  }
  const unix = Math.floor(due.getTime() / 1000);
  if (due.getTime() <= now.getTime()) {
    return { ok: false, error: `That time is in the past (<t:${unix}:f>). Pick a time in the future.` };
  }
  if (due.getTime() - now.getTime() < REMINDER_MIN_LEAD_MS) {
    return { ok: false, error: "That is less than 30 seconds from now. Pick a later time." };
  }
  if (due.getTime() - now.getTime() > REMINDER_MAX_AHEAD_MS) {
    return { ok: false, error: `That is more than a year away (<t:${unix}:f>). Reminders can be set up to 366 days ahead.` };
  }
  return { ok: true, due };
}

/** The reminder ping text. */
export function renderReminder(r: Reminder, now: Date = new Date()): string {
  const created = Math.floor(new Date(r.created_at.includes("T") ? r.created_at : `${r.created_at.replace(" ", "T")}Z`).getTime() / 1000);
  const dueMs = new Date(r.due_at).getTime();
  const lines = [`⏰ <@${r.user_id}> reminder${r.message ? `: ${r.message}` : "."}`];
  const meta: string[] = [];
  if (Number.isFinite(created)) meta.push(`set <t:${created}:R>`);
  if (r.source_url) meta.push(`[jump to where it was set](${r.source_url})`);
  if (now.getTime() - dueMs > LATE_AFTER_MS) meta.push(`delivered late: it was due <t:${Math.floor(dueMs / 1000)}:f>`);
  if (meta.length) lines.push(`-# ${meta.join(" · ")}`);
  return lines.join("\n");
}

async function sendInChannel(client: Client, r: Reminder, content: string): Promise<string> {
  const channel = await client.channels.fetch(r.channel_id);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    throw new Error("channel not found or not text based");
  }
  const allowedMentions = { users: [r.user_id] };
  if (channel.isThread()) {
    const thread = channel as ThreadChannel;
    const wasArchived = thread.archived;
    const wasLocked = thread.locked;
    if (wasArchived) {
      await discordQueue.add(() => thread.edit({ archived: false, reason: "Delivering a reminder" }));
    }
    const msg = (await discordQueue.add(() => thread.send({ content, allowedMentions }))) as Message;
    if (wasArchived) {
      // Restore the ticket thread's archived (and locked) state.
      await discordQueue
        .add(() => thread.edit({ archived: true, ...(wasLocked ? { locked: true } : {}), reason: "Re-archiving after reminder" }))
        .catch((err) => logger.warn({ threadId: thread.id, err }, "Failed to re-archive thread after reminder"));
    }
    return msg.id;
  }
  const msg = (await discordQueue.add(() => (channel as any).send({ content, allowedMentions }))) as Message;
  return msg.id;
}

export async function deliverReminder(client: Client, r: Reminder): Promise<void> {
  const content = renderReminder(r);
  try {
    const msgId = await sendInChannel(client, r, content);
    markReminderDelivered(r.id);
    logger.info({ reminderId: r.id, channelId: r.channel_id, msgId }, "Reminder delivered");
    return;
  } catch (channelErr) {
    // Channel gone or no access: fall back to a direct message.
    try {
      const user = await client.users.fetch(r.user_id);
      await user.send({ content: `${content}\n-# (could not post in <#${r.channel_id}>)`, allowedMentions: { users: [r.user_id] } });
      markReminderDelivered(r.id, "delivered by DM");
      logger.warn({ reminderId: r.id, channelId: r.channel_id, err: channelErr }, "Reminder delivered by DM (channel failed)");
      return;
    } catch (dmErr) {
      const msg = `${channelErr instanceof Error ? channelErr.message : channelErr}; DM: ${dmErr instanceof Error ? dmErr.message : dmErr}`;
      const attempts = markReminderFailed(r.id, msg, Math.min(2 ** (r.attempts + 1), 60) * 60_000);
      if (attempts >= MAX_ATTEMPTS) {
        markReminderDelivered(r.id, `undeliverable: ${msg}`);
        logger.error({ reminderId: r.id, attempts, msg }, "Reminder undeliverable, giving up");
      } else {
        logger.warn({ reminderId: r.id, attempts, msg }, "Reminder delivery failed, will retry");
      }
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function runDueReminders(client: Client, now: Date = new Date()): Promise<number> {
  if (running) return 0;
  running = true;
  let n = 0;
  try {
    for (;;) {
      const due = getDueReminders(now.toISOString(), 25);
      if (due.length === 0) break;
      for (const r of due) {
        await deliverReminder(client, r);
        n++;
      }
      if (due.length < 25) break;
    }
  } catch (err) {
    logger.error({ err }, "Reminder sweep failed");
  } finally {
    running = false;
  }
  return n;
}

export function startReminders(client: Client): void {
  if (timer) return;
  void runDueReminders(client);
  timer = setInterval(() => void runDueReminders(client), POLL_MS);
}

export function stopReminders(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
