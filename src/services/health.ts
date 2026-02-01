import { ActivityType, Client, TextChannel } from "discord.js";
import { env } from "../util/env.js";
import { logger } from "../util/logger.js";

const CHECK_INTERVAL = 30_000; // 30 seconds
const FAILURE_THRESHOLD = 3;   // alert after 3 consecutive failures (90s)

let failureCount = 0;
let alertSent = false;
let checking = false;
let timer: ReturnType<typeof setInterval> | null = null;

function setPresence(client: Client, status: "ok" | "down") {
  if (!client.user) return;

  if (status === "ok") {
    client.user.setPresence({
      status: "online",
      activities: [{ name: "Zammad tickets", type: ActivityType.Watching }],
    });
  } else {
    client.user.setPresence({
      status: "dnd",
      activities: [{ name: "ZAMMAD UNREACHABLE", type: ActivityType.Playing }],
    });
  }
}

async function checkZammad(): Promise<boolean> {
  try {
    const url = `${env().ZAMMAD_BASE_URL}/api/v1/monitoring/health_check`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env().ZAMMAD_API_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function sendAlert(client: Client) {
  try {
    const channelId = env().DISCORD_TICKETS_CHANNEL_ID;
    const channel = (await client.channels.fetch(channelId)) as TextChannel | null;
    if (!channel?.isTextBased()) return;

    await channel.send(
      "@everyone **Zammad is unreachable.** The bot cannot sync tickets or process webhooks until connectivity is restored."
    );
    logger.warn("Zammad health alert sent to Discord");
  } catch (err) {
    logger.error({ err }, "Failed to send Zammad health alert");
  }
}

async function sendRecovery(client: Client) {
  try {
    const channelId = env().DISCORD_TICKETS_CHANNEL_ID;
    const channel = (await client.channels.fetch(channelId)) as TextChannel | null;
    if (!channel?.isTextBased()) return;

    await channel.send(
      "Zammad connectivity has been **restored**. Ticket sync is operational."
    );
    logger.info("Zammad recovery notice sent to Discord");
  } catch (err) {
    logger.error({ err }, "Failed to send Zammad recovery notice");
  }
}

export function startHealthCheck(client: Client): void {
  // Set initial presence
  setPresence(client, "ok");

  timer = setInterval(async () => {
    if (checking) return; // prevent overlapping checks
    checking = true;
    const healthy = await checkZammad();
    checking = false;

    if (healthy) {
      if (failureCount >= FAILURE_THRESHOLD && alertSent) {
        // Recovered
        setPresence(client, "ok");
        await sendRecovery(client);
      }
      failureCount = 0;
      alertSent = false;
    } else {
      failureCount++;
      logger.warn({ failureCount }, "Zammad health check failed");

      if (failureCount >= FAILURE_THRESHOLD && !alertSent) {
        setPresence(client, "down");
        await sendAlert(client);
        alertSent = true;
      }
    }
  }, CHECK_INTERVAL);
}

export function stopHealthCheck(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
