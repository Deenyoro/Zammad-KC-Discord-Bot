import { Client, GatewayIntentBits } from "discord.js";
import { logger } from "./util/logger.js";
import { onReady } from "./events/ready.js";
import { onInteractionCreate } from "./events/interactionCreate.js";
import { onMessageCreate } from "./events/messageCreate.js";

export function createClient(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // Wire event handlers
  onReady(client);
  onInteractionCreate(client);
  onMessageCreate(client);

  // Connection lifecycle logging
  client.on("warn", (msg) => logger.warn({ discordMsg: msg }, "Discord warning"));
  client.on("error", (err) => logger.error({ err }, "Discord error"));
  client.on("shardDisconnect", (ev, id) =>
    logger.warn({ shardId: id, code: ev.code }, "Shard disconnected")
  );
  client.on("shardReconnecting", (id) =>
    logger.info({ shardId: id }, "Shard reconnecting")
  );
  client.on("shardResume", (id) =>
    logger.info({ shardId: id }, "Shard resumed")
  );

  return client;
}
