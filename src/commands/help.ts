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
    .setTitle("Zammad Discord Bot — Commands")
    .setColor(0x7289da)
    .addFields(
      {
        name: "Quick Commands (use inside a ticket thread)",
        value: [
          "`/reply <text> [file]` — Reply to the customer (email/SMS/Teams)",
          "`/note <text> [file]` — Add an internal note",
          "`/owner [user]` — Set ticket owner (defaults to yourself)",
        ].join("\n"),
        inline: false,
      },
      {
        name: "Ticket Commands (use inside a ticket thread)",
        value: [
          "`/ticket info` — Show ticket details",
          "`/ticket link` — Get a link to the Zammad ticket",
          "`/ticket reply <text> [file]` — Reply to the customer (same as /reply)",
          "`/ticket note <text> [file]` — Add an internal note (same as /note)",
          "`/ticket close` — Close the ticket",
          "`/ticket state <name>` — Change state (open, pending reminder, pending close, closed)",
          "`/ticket assign <user>` — Assign to a Discord user",
          "`/ticket priority <level>` — Change priority (1 low, 2 normal, 3 high)",
          "`/ticket time <minutes>` — Log time accounting",
        ].join("\n"),
        inline: false,
      },
      {
        name: "Setup Commands (admin only)",
        value:
          "`/setup usermap <discord_user> <zammad_email>` — Map a Discord user to a Zammad agent",
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
