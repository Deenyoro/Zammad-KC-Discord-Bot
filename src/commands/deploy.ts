/**
 * Standalone script to register the slash commands with Discord.
 * Run: npm run deploy-commands
 *
 * The bot also registers them on every start (index.ts), so this is only
 * needed to update commands without restarting. Both use commands/all.ts.
 */
import "dotenv/config";
import { REST, Routes } from "discord.js";
import { allCommands } from "./all.js";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error("DISCORD_TOKEN, DISCORD_CLIENT_ID and DISCORD_GUILD_ID are required");
  process.exit(1);
}

const commands = allCommands();
const rest = new REST().setToken(token);

(async () => {
  try {
    console.log(`Deploying ${commands.length} commands...`);
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log(`Guild commands deployed to ${guildId}`);
  } catch (err) {
    console.error("Failed to deploy commands:", err);
    process.exit(1);
  }
})();
