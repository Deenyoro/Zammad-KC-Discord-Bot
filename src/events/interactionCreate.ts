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
  handleLock,
  handleSearch,
  handleTags,
  handleMerge,
  handleHistory,
  handleSchedule,
  handleSchedules,
  handleUnschedule,
  handleNewTicket,
  handleTemplate,
  handleAi,
  handleAiHelp,
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
        case "lock":
          await handleLock(interaction);
          break;
        case "search":
          await handleSearch(interaction);
          break;
        case "tags":
          await handleTags(interaction);
          break;
        case "merge":
          await handleMerge(interaction);
          break;
        case "history":
          await handleHistory(interaction);
          break;
        case "schedule":
          await handleSchedule(interaction);
          break;
        case "schedules":
          await handleSchedules(interaction);
          break;
        case "unschedule":
          await handleUnschedule(interaction);
          break;
        case "newticket":
          await handleNewTicket(interaction);
          break;
        case "template":
          await handleTemplate(interaction);
          break;
        case "ai":
          await handleAi(interaction);
          break;
        case "aihelp":
          await handleAiHelp(interaction);
          break;
        default:
          logger.warn({ commandName }, "Unknown command");
          await interaction.reply({ content: "Unknown command.", ephemeral: true });
      }
    } catch (err) {
      logger.error({ commandName, err }, "Unhandled interaction error");
      try {
        const msg = err instanceof Error ? err.message : "An unexpected error occurred.";
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(`Error: ${msg}`);
        } else {
          await interaction.reply({ content: `Error: ${msg}`, ephemeral: true });
        }
      } catch {
        // Reply itself failed — nothing more we can do
      }
    }
  });
}
