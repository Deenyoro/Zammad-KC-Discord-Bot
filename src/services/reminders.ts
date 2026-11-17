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
  getThreadByTicketId,
  markReminderDelivered,
  markReminderFailed,
  type Reminder,
} from "../db/index.js";
import { addTicketNote } from "./ticketNotes.js";
import { formatInBotTz } from "../util/timezone.js";

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
  "`30m`, `2h`, `3d`, `tomorrow 9am`, `friday 3pm`, `nov 24 9am`, `11/24`, `the 24th`, `17:30`, `2026-10-05 14:00`";

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

/** Extra user/role ids a reminder pings ("u:<id>" / "r:<id>"), parsed defensively. */
export function reminderMentionIds(r: Reminder): { users: string[]; roles: string[] } {
  const users: string[] = [];
  const roles: string[] = [];
  let list: unknown = [];
  try {
    list = r.mention_ids ? JSON.parse(r.mention_ids) : [];
  } catch {
    list = [];
  }
  if (Array.isArray(list)) {
    for (const v of list) {
      const m = typeof v === "string" ? v.match(/^([ur]):(\d{5,25})$/) : null;
      if (!m) continue;
      (m[1] === "u" ? users : roles).push(m[2]);
    }
  }
  return { users: [...new Set(users)], roles: [...new Set(roles)] };
}

/** Who the reminder pings: the creator, @everyone/@here, and any extra users or roles. */
export function reminderAllowedMentions(r: Reminder): { users: string[]; roles: string[]; parse: ("everyone")[] } {
  const extra = reminderMentionIds(r);
  return {
    users: [...new Set([r.user_id, ...extra.users])],
    roles: extra.roles,
    parse: r.mention_everyone ? ["everyone"] : [],
  };
}

/** Plain-text description of who is pinged, for ticket notes and confirmations. */
export function describeReminderAudience(r: Reminder, names: { users?: Map<string, string>; roles?: Map<string, string> } = {}): string {
  const extra = reminderMentionIds(r);
  const parts: string[] = [];
  if (r.mention_everyone) parts.push(`@${r.mention_everyone}`);
  for (const id of extra.roles) parts.push(`@${names.roles?.get(id) ?? `role ${id}`}`);
  for (const id of extra.users) parts.push(`@${names.users?.get(id) ?? `user ${id}`}`);
  return parts.length ? parts.join(", ") : "only the person who set it";
}

/** The reminder ping text. */
export function renderReminder(r: Reminder, now: Date = new Date()): string {
  const created = Math.floor(new Date(r.created_at.includes("T") ? r.created_at : `${r.created_at.replace(" ", "T")}Z`).getTime() / 1000);
  const dueMs = new Date(r.due_at).getTime();
  const extra = reminderMentionIds(r);
  const pings = [
    ...(r.mention_everyone ? [`@${r.mention_everyone}`] : []),
    ...extra.roles.map((id) => `<@&${id}>`),
    ...extra.users.filter((id) => id !== r.user_id).map((id) => `<@${id}>`),
  ];
  const lines = [
    `⏰ ${pings.length ? `${pings.join(" ")} ` : ""}<@${r.user_id}> reminder${r.message ? `: ${r.message}` : "."}`,
  ];
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
  const allowedMentions = reminderAllowedMentions(r);
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
    await noteReminderFired(r, msgId);
    return;
  } catch (channelErr) {
    // Channel gone or no access: fall back to a direct message.
    try {
      const user = await client.users.fetch(r.user_id);
      await user.send({ content: `${content}\n-# (could not post in <#${r.channel_id}>)`, allowedMentions: { users: [r.user_id] } });
      markReminderDelivered(r.id, "delivered by DM");
      logger.warn({ reminderId: r.id, channelId: r.channel_id, err: channelErr }, "Reminder delivered by DM (channel failed)");
      await noteReminderFired(r, null, " (sent by DM: the thread could not be reached)");
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

/** Internal ticket note when a reminder set in a ticket thread fires. Never throws. */
async function noteReminderFired(r: Reminder, msgId: string | null, suffix = ""): Promise<void> {
  if (!r.ticket_id) return;
  const thread = getThreadByTicketId(r.ticket_id);
  await addTicketNote(
    r.ticket_id,
    `Reminder #${r.id} went off${suffix} (due ${formatInBotTz(r.due_at)}), pinging ${describeReminderAudience(r)} and the person who set it.` +
      (r.message ? `\n${r.message}` : ""),
    { threadId: thread?.thread_id ?? r.channel_id, discordMsgId: msgId, echo: false },
  );
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
