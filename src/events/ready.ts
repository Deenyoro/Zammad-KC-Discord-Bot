import type { Client } from "discord.js";
import { logger } from "../util/logger.js";

export function onReady(client: Client): void {
  client.on("ready", () => {
    logger.info(
      { user: client.user?.tag, guilds: client.guilds.cache.size },
      "Discord bot ready"
    );
  });
}
