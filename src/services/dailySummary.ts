import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { env } from "../util/env.js";
import { logger } from "../util/logger.js";
import { getSettingOrEnv } from "../db/index.js";
import { getAllOpenTickets } from "./zammad.js";

let timer: ReturnType<typeof setInterval> | null = null;
let lastPostedHour = -1;

function getSummaryHour(): number | undefined {
  const val = getSettingOrEnv("DAILY_SUMMARY_HOUR");
  if (val === undefined) return undefined;
  const n = parseInt(val, 10);
  return isNaN(n) || n < 0 || n > 23 ? undefined : n;
}

async function postSummary(client: Client): Promise<void> {
  try {
    const tickets = await getAllOpenTickets();

    const counts: Record<string, number> = {};
    for (const t of tickets) {
      const state = t.state.toLowerCase();
      counts[state] = (counts[state] || 0) + 1;
    }

    const unassigned = tickets.filter((t) => !t.owner_id || t.owner_id <= 1).length;
    const overdue = tickets.filter((t) => t.escalation_at && new Date(t.escalation_at) <= new Date()).length;

    const embed = new EmbedBuilder()
      .setTitle("Daily Ticket Summary")
      .setColor(0x7289da)
      .setTimestamp(new Date())
      .addFields(
        { name: "Total Open", value: String(tickets.length), inline: true },
        { name: "New", value: String(counts["new"] ?? 0), inline: true },
        { name: "Open", value: String(counts["open"] ?? 0), inline: true },
        { name: "Waiting for Reply", value: String(counts["waiting for reply"] ?? 0), inline: true },
        { name: "Pending", value: String((counts["pending reminder"] ?? 0) + (counts["pending close"] ?? 0)), inline: true },
        { name: "Unassigned", value: String(unassigned), inline: true },
        { name: "SLA Overdue", value: String(overdue), inline: true },
      );

    const channelId = env().DISCORD_TICKETS_CHANNEL_ID;
    const channel = (await client.channels.fetch(channelId)) as TextChannel | null;
    if (!channel?.isTextBased()) {
      logger.warn("Daily summary: tickets channel not found");
      return;
    }

    await channel.send({ embeds: [embed] });
    logger.info("Daily summary posted");
  } catch (err) {
    logger.error({ err }, "Failed to post daily summary");
  }
}

export function startDailySummary(client: Client): void {
  // Check every 60 seconds if it's time to post
  timer = setInterval(() => {
    const hour = getSummaryHour();
    if (hour === undefined) return;

    const currentHour = new Date().getHours();
    if (currentHour === hour && lastPostedHour !== currentHour) {
      lastPostedHour = currentHour;
      postSummary(client).catch((err) =>
        logger.error({ err }, "Daily summary post failed")
      );
    }
  }, 60_000);
}

export function stopDailySummary(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
