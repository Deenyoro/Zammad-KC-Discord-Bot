/**
 * /remind-me and /reminders.
 *
 * Times use the same parser as /schedule (util/parseTime.ts), in the bot's
 * configured timezone. Reminders are stored in SQLite and delivered by
 * services/reminders.ts.
 */

import { ChatInputCommandInteraction, Role, SlashCommandBuilder, User } from "discord.js";
import {
  cancelReminder,
  countPendingRemindersForUser,
  createReminder,
  getPendingRemindersForUser,
  getReminder,
  getThreadByThreadId,
  getUserMap,
  setReminderSourceUrl,
} from "../db/index.js";
import { parseTime } from "../util/parseTime.js";
import { formatInBotTz, getBotTimezone } from "../util/timezone.js";
import { truncate } from "../util/truncate.js";
import {
  checkReminderTime,
  REMINDER_FORMATS,
  REMINDER_MAX_PENDING_PER_USER,
} from "../services/reminders.js";
import { addTicketNote } from "../services/ticketNotes.js";

export const remindMeCommand = new SlashCommandBuilder()
  .setName("remind-me")
  .setDescription("Ping you here at a time (e.g. 2h, tomorrow 9am, nov 24 9am, 11/24, 2026-10-05 14:00)")
  .addStringOption((o) =>
    o
      .setName("when")
      .setDescription("Duration (30m, 2h, 3d) or date/time (tomorrow 9am, fri 3pm, nov 24 9am, 11/24 2pm, the 24th)")
      .setRequired(true)
      .setMaxLength(64)
  )
  .addStringOption((o) =>
    o.setName("message").setDescription("What to remind you about").setRequired(false).setMaxLength(1000)
  )
  .addStringOption((o) =>
    o
      .setName("ping")
      .setDescription("Also ping @everyone or @here (staff only)")
      .setRequired(false)
      .addChoices({ name: "@everyone", value: "everyone" }, { name: "@here", value: "here" })
  )
  .addMentionableOption((o) =>
    o.setName("who").setDescription("Also ping this person or role").setRequired(false)
  );

export const remindersCommand = new SlashCommandBuilder()
  .setName("reminders")
  .setDescription("List your pending reminders, or cancel one")
  .addIntegerOption((o) =>
    o.setName("cancel").setDescription("ID of a reminder to cancel").setRequired(false).setMinValue(1)
  );

function messageLink(guildId: string | null, channelId: string, messageId?: string | null): string {
  const g = guildId ?? "@me";
  return messageId
    ? `https://discord.com/channels/${g}/${channelId}/${messageId}`
    : `https://discord.com/channels/${g}/${channelId}`;
}

export async function handleRemindMe(interaction: ChatInputCommandInteraction) {
  const when = interaction.options.getString("when", true);
  const message = interaction.options.getString("message")?.trim() || null;

  const check = checkReminderTime(parseTime(when), when);
  if (!check.ok) {
    await interaction.reply({ content: check.error, ephemeral: true });
    return;
  }
  if (countPendingRemindersForUser(interaction.user.id) >= REMINDER_MAX_PENDING_PER_USER) {
    await interaction.reply({
      content: `You already have ${REMINDER_MAX_PENDING_PER_USER} pending reminders. Cancel some with \`/reminders cancel:<id>\`.`,
      ephemeral: true,
    });
    return;
  }

  const ping = interaction.options.getString("ping") as "everyone" | "here" | null;
  const who = interaction.options.getMentionable("who");
  const caller = getUserMap(interaction.user.id);
  if (ping && !caller) {
    await interaction.reply({
      content: "Only staff mapped to a Zammad agent can ping @everyone or @here. Ask an admin to run `/setup usermap`.",
      ephemeral: true,
    });
    return;
  }
  let mentionIds: string[] = [];
  let whoLabel = "";
  if (who instanceof Role) {
    mentionIds = [`r:${who.id}`];
    whoLabel = `@${who.name}`;
  } else if (who) {
    const u: User | null = who instanceof User ? who : "user" in who ? (who as { user: User }).user : null;
    if (u && u.id !== interaction.user.id) {
      mentionIds = [`u:${u.id}`];
      whoLabel = `@${u.displayName ?? u.username}`;
    }
  }
  const ticket = getThreadByThreadId(interaction.channelId);

  const id = createReminder({
    user_id: interaction.user.id,
    guild_id: interaction.guildId,
    channel_id: interaction.channelId,
    message,
    due_at: check.due.toISOString(),
    mention_everyone: ping,
    mention_ids: mentionIds,
    ticket_id: ticket?.ticket_id ?? null,
  });
  // Link back to the conversation as it was when the reminder was set.
  const lastMessageId =
    interaction.channel && "lastMessageId" in interaction.channel ? interaction.channel.lastMessageId : null;
  setReminderSourceUrl(id, messageLink(interaction.guildId, interaction.channelId, lastMessageId));

  const unix = Math.floor(check.due.getTime() / 1000);
  const tz = getBotTimezone();
  const audience = [ping ? `@${ping}` : "", whoLabel].filter(Boolean);
  await interaction.reply({
    content:
      `Reminder **#${id}** set for <t:${unix}:f> (<t:${unix}:R>)` +
      (tz ? `, parsed in ${tz}` : "") +
      `. I will ping you${audience.length ? ` and ${audience.join(" and ")}` : ""} in this ${interaction.channel?.isThread() ? "thread" : "channel"}` +
      (message ? `: ${truncate(message, 200)}` : ".") +
      `\nCancel with \`/reminders cancel:${id}\`.` +
      (ticket ? `\n-# Added to ticket #${ticket.ticket_number} as an internal note.` : ""),
    ephemeral: true,
  });

  if (ticket) {
    const who2 = caller ? "" : ` (Discord user ${interaction.user.username})`;
    await addTicketNote(
      ticket.ticket_id,
      `Reminder #${id} set${who2} for ${formatInBotTz(check.due)}${tz ? ` (${tz})` : ""}, pinging ` +
        `${audience.length ? `${audience.join(", ")} and ` : ""}${interaction.user.displayName ?? interaction.user.username} in the Discord thread.` +
        (message ? `\n${message}` : ""),
      { zammadId: caller?.zammad_id ?? null, threadId: ticket.thread_id },
    );
  }
}

export async function handleReminders(interaction: ChatInputCommandInteraction) {
  const cancelId = interaction.options.getInteger("cancel");
  if (cancelId !== null) {
    const before = getReminder(cancelId);
    const ok = cancelReminder(cancelId, interaction.user.id);
    if (ok && before?.ticket_id) {
      const thread = getThreadByThreadId(before.channel_id);
      await addTicketNote(
        before.ticket_id,
        `Reminder #${cancelId} (due ${formatInBotTz(before.due_at)}) was cancelled by ${interaction.user.displayName ?? interaction.user.username}.` +
          (before.message ? `\n${before.message}` : ""),
        { zammadId: getUserMap(interaction.user.id)?.zammad_id ?? null, threadId: thread?.thread_id ?? null },
      );
    }
    await interaction.reply({
      content: ok ? `Reminder #${cancelId} cancelled.` : `No pending reminder #${cancelId} of yours was found.`,
      ephemeral: true,
    });
    return;
  }

  const list = getPendingRemindersForUser(interaction.user.id);
  if (list.length === 0) {
    await interaction.reply({
      content: `You have no pending reminders. Set one with \`/remind-me\` (${REMINDER_FORMATS}).`,
      ephemeral: true,
    });
    return;
  }
  const lines = list.slice(0, 25).map((r) => {
    const unix = Math.floor(new Date(r.due_at).getTime() / 1000);
    const text = r.message ? truncate(r.message.replace(/\s+/g, " "), 80) : "_(no message)_";
    return `**#${r.id}** <t:${unix}:f> (<t:${unix}:R>) in <#${r.channel_id}>: ${text}`;
  });
  if (list.length > 25) lines.push(`…and ${list.length - 25} more.`);
  await interaction.reply({ content: truncate(lines.join("\n"), 1990), ephemeral: true });
}
