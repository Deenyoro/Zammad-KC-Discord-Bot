import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";

export const helpCommand = new SlashCommandBuilder()
  .setName("help")
  .setDescription("Show all available bot commands");

export async function handleHelpCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle("Zammad Discord Bot -Commands")
    .setColor(0x7289da)
    .addFields(
      {
        name: "Communication (use inside a ticket thread)",
        value: [
          "`/reply <text> [cc] [file]` -Reply to the customer (email/SMS/Teams)",
          "`/note <text> [file]` -Add an internal note",
          "`/textmodule use <name>` -Send a Zammad text module as reply",
          "Use `::shortcut` in /reply or /note text to auto-expand text modules",
        ].join("\n"),
        inline: false,
      },
      {
        name: "Ticket Management (use inside a ticket thread)",
        value: [
          "`/info` -Show ticket details",
          "`/link` -Get a link to the Zammad ticket",
          "`/assign [user]` -Assign ticket (defaults to yourself)",
          "`/close [note]` -Close the ticket (optional internal note)",
          "`/lock [duration]` - Lock ticket (permanent or timed: 30m, 2h, 4h, 8h, 16h, 1d, 2d, 1w, 1mo)",
          "`/state <name>` -Change state",
          "`/pending <type> <duration>` -Set pending state with expiration",
          "`/priority <level>` -Change priority (1 low, 2 normal, 3 high)",
          "`/time <minutes>` -Log time accounting",
          "`/tags list|add|remove` -Manage ticket tags",
          "`/merge <target>` -Merge this ticket into another",
          "`/history` -Show recent ticket history",
        ].join("\n"),
        inline: false,
      },
      {
        name: "Scheduled Replies (use inside a ticket thread)",
        value: [
          "`/schedule <text> <time>` -Schedule a reply (2h, 1d, tomorrow 9am)",
          "`/schedules` -List pending scheduled replies",
          "`/unschedule <id>` -Cancel a scheduled reply",
        ].join("\n"),
        inline: false,
      },
      {
        name: "Search & Create",
        value: [
          "`/search <query>` -Search Zammad tickets",
          "`/newticket <type> <to> <subject> <body>` -Create a new ticket (email/sms/phone-log)",
        ].join("\n"),
        inline: false,
      },
      {
        name: "AI Features (use inside a ticket thread)",
        value: [
          "`/aireply [context] [language]` - AI-suggested reply",
          "`/aisummary [context] [language]` - Ticket summary with next steps",
          "`/aihelp [context] [language]` - Troubleshooting with web search",
          "`/aiproofread <message> [language]` - Fix spelling/grammar/flow",
        ].join("\n"),
        inline: false,
      },
      {
        name: "Text Modules (from Zammad)",
        value: [
          "`/textmodule list` -List all available text modules",
          "`/textmodule search <query>` -Search by name or keyword",
          "`/textmodule use <name>` -Send as reply to customer",
          "`/textmodule preview <name>` -Preview without sending",
          "`/textmodule refresh` -Refresh cache from Zammad",
        ].join("\n"),
        inline: false,
      },
      {
        name: "Setup Commands (admin only)",
        value: [
          "`/setup usermap <user> <email>` -Map Discord user to Zammad agent",
          "`/setup ai <api_key> [provider] [model]` -Configure AI provider",
          "`/setup search <api_key> [provider]` -Configure web search",
          "`/setup summary <hour|off>` -Configure daily summary",
        ].join("\n"),
        inline: false,
      },
      {
        name: "Thread Messages",
        value:
          "Any message you type in a ticket thread is automatically sent to Zammad as an internal note with attachments. Use `/reply` to send a reply to the customer instead.",
        inline: false,
      }
    );

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
