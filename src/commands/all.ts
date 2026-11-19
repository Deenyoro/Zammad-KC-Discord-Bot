/**
 * Every slash command the bot registers. The bot (on startup) and
 * `npm run deploy-commands` both use this list, so the two cannot drift:
 * registering replaces the whole command set, and a shorter list would
 * silently remove commands.
 */
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import { setupCommand } from "./setup.js";
import { helpCommand } from "./help.js";
import * as shortcuts from "./shortcuts.js";
import { mdCommand } from "./md.js";
import { remindMeCommand, remindersCommand } from "./remind.js";

export function allCommands(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return [
    setupCommand,
    helpCommand,
    shortcuts.replyCommand,
    shortcuts.replyallCommand,
    shortcuts.noteCommand,
    shortcuts.closeCommand,
    shortcuts.assignCommand,
    shortcuts.timeCommand,
    shortcuts.priorityCommand,
    shortcuts.stateCommand,
    shortcuts.pendingCommand,
    shortcuts.infoCommand,
    shortcuts.linkCommand,
    shortcuts.lockCommand,
    shortcuts.searchCommand,
    shortcuts.tagsCommand,
    shortcuts.mergeCommand,
    shortcuts.historyCommand,
    shortcuts.relatedCommand,
    shortcuts.scheduleCommand,
    shortcuts.schedulesCommand,
    shortcuts.unscheduleCommand,
    shortcuts.newticketCommand,
    shortcuts.textmoduleCommand,
    shortcuts.aireplyCommand,
    shortcuts.aisummaryCommand,
    shortcuts.aihelpCommand,
    shortcuts.aiproofreadCommand,
    shortcuts.aitranslateCommand,
    shortcuts.participantsCommand,
    shortcuts.weeklyCommand,
    shortcuts.checknoteCommand,
    shortcuts.renameCommand,
    mdCommand,
    remindMeCommand,
    remindersCommand,
  ].map((c) => c.toJSON());
}
