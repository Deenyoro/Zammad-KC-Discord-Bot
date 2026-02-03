import { Client, Events } from "discord.js";
import { logger } from "../util/logger.js";
import {
  handleReply,
  handleNote,
  handleOwner,
  handlePending,
  handleClose,
  handleAssign,
  handleTime,
  handlePriority,
  handleState,
  handleInfo,
  handleLink,
} from "../commands/ticket.js";
import { handleSetupCommand } from "../commands/setup.js";
import { handleHelpCommand } from "../commands/help.js";

export function onInteractionCreate(client: Client): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    try {
      switch (commandName) {
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
        case "pending":
          await handlePending(interaction);
          break;
        case "close":
          await handleClose(interaction);
          break;
        case "assign":
          await handleAssign(interaction);
          break;
        case "time":
          await handleTime(interaction);
          break;
        case "priority":
          await handlePriority(interaction);
          break;
        case "state":
          await handleState(interaction);
          break;
        case "info":
          await handleInfo(interaction);
          break;
        case "link":
          await handleLink(interaction);
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
