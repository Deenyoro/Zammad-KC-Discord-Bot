/**
 * Standalone script to register slash commands with Discord.
 * Run: npx tsx src/commands/deploy.ts
 *
 * Deploys guild commands (instant) when DISCORD_GUILD_ID is set,
 * otherwise deploys global commands (~1h propagation).
 */
import "dotenv/config";
import { REST, Routes } from "discord.js";
import { ticketCommand } from "./ticket.js";
import { setupCommand } from "./setup.js";
import { helpCommand } from "./help.js";
import { replyCommand, noteCommand, ownerCommand, pendingCommand } from "./shortcuts.js";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId) {
  console.error("DISCORD_TOKEN and DISCORD_CLIENT_ID are required");
  process.exit(1);
}

const commands = [
  ticketCommand.toJSON(),
  setupCommand.toJSON(),
  helpCommand.toJSON(),
  replyCommand.toJSON(),
  noteCommand.toJSON(),
  ownerCommand.toJSON(),
  pendingCommand.toJSON(),
];
const rest = new REST().setToken(token);

(async () => {
  try {
    console.log(`Deploying ${commands.length} commands...`);

    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
        body: commands,
      });
      console.log(`Guild commands deployed to ${guildId}`);
    } else {
      await rest.put(Routes.applicationCommands(clientId), {
        body: commands,
      });
      console.log("Global commands deployed (may take up to 1 hour)");
    }
  } catch (err) {
    console.error("Failed to deploy commands:", err);
    process.exit(1);
  }
})();
