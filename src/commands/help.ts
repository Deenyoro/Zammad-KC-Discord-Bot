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
          "`/template use <name>` -Send a canned template as reply",
        ].join("\n"),
        inline: false,
      },
      {
        name: "Ticket Management (use inside a ticket thread)",
        value: [
          "`/info` -Show ticket details",
          "`/link` -Get a link to the Zammad ticket",
          "`/owner [user]` -Set ticket owner (defaults to yourself)",
          "`/assign <user>` -Assign to a Discord user",
          "`/close` -Close the ticket",
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
          "`/aireply` - Get AI-suggested reply for this ticket",
          "`/aisummary` - Get AI summary with next steps",
          "`/aihelp [language]` - AI troubleshooting (en/pt/ar)",
        ].join("\n"),
        inline: false,
      },
      {
        name: "Templates",
        value: [
          "`/template list` -List saved templates",
          "`/template add <name> <body>` -Add template (admin)",
          "`/template remove <name>` -Remove template (admin)",
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
