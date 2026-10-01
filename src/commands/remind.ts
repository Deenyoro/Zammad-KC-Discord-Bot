/**
 * /remind-me and /reminders.
 *
 * Times use the same parser as /schedule (util/parseTime.ts), in the bot's
 * configured timezone. Reminders are stored in SQLite and delivered by
 * services/reminders.ts.
 */

import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import {
  cancelReminder,
  countPendingRemindersForUser,
  createReminder,
  getPendingRemindersForUser,
  setReminderSourceUrl,
} from "../db/index.js";
import { parseTime } from "../util/parseTime.js";
import { getBotTimezone } from "../util/timezone.js";
import { truncate } from "../util/truncate.js";
import {
  checkReminderTime,
  REMINDER_FORMATS,
  REMINDER_MAX_PENDING_PER_USER,
} from "../services/reminders.js";

export const remindMeCommand = new SlashCommandBuilder()
  .setName("remind-me")
  .setDescription("Ping you here after a time (e.g. 2h, 3d, tomorrow 9am, 2026-10-05 14:00)")
  .addStringOption((o) =>
    o
      .setName("when")
      .setDescription("Duration (30m, 2h, 3d, 1w) or date/time (tomorrow 9am, friday 3pm, 2026-10-05 14:00)")
      .setRequired(true)
      .setMaxLength(64)
  )
  .addStringOption((o) =>
    o.setName("message").setDescription("What to remind you about").setRequired(false).setMaxLength(1000)
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

  const id = createReminder({
    user_id: interaction.user.id,
    guild_id: interaction.guildId,
    channel_id: interaction.channelId,
    message,
    due_at: check.due.toISOString(),
  });
  // Link back to the conversation as it was when the reminder was set.
  const lastMessageId =
    interaction.channel && "lastMessageId" in interaction.channel ? interaction.channel.lastMessageId : null;
  setReminderSourceUrl(id, messageLink(interaction.guildId, interaction.channelId, lastMessageId));

  const unix = Math.floor(check.due.getTime() / 1000);
  const tz = getBotTimezone();
  await interaction.reply({
    content:
      `Reminder **#${id}** set for <t:${unix}:f> (<t:${unix}:R>)` +
      (tz ? `, parsed in ${tz}` : "") +
      `. I will ping you in this ${interaction.channel?.isThread() ? "thread" : "channel"}` +
      (message ? `: ${truncate(message, 200)}` : ".") +
      `\nCancel with \`/reminders cancel:${id}\`.`,
    ephemeral: true,
  });
}

export async function handleReminders(interaction: ChatInputCommandInteraction) {
  const cancelId = interaction.options.getInteger("cancel");
  if (cancelId !== null) {
    const ok = cancelReminder(cancelId, interaction.user.id);
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
