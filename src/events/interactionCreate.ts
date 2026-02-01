import { Client, Events } from "discord.js";
import { logger } from "../util/logger.js";
import { handleTicketCommand, handleReply, handleNote, handleOwner } from "../commands/ticket.js";
import { handleSetupCommand } from "../commands/setup.js";
import { handleHelpCommand } from "../commands/help.js";

export function onInteractionCreate(client: Client): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    try {
      switch (commandName) {
        case "ticket":
          await handleTicketCommand(interaction);
          break;
        case "setup":
          await handleSetupCommand(interaction);
          break;
        case "help":
          await handleHelpCommand(interaction);
          break;
        case "reply":
          await handleReply(interaction);
          break;
        case "note":
          await handleNote(interaction);
          break;
        case "owner":
          await handleOwner(interaction);
          break;
        default:
          logger.warn({ commandName }, "Unknown command");
          await interaction.reply({ content: "Unknown command.", ephemeral: true });
      }
    } catch (err) {
      logger.error({ commandName, err }, "Unhandled interaction error");
    }
  });
}
