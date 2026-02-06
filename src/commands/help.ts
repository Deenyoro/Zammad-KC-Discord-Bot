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
        name: "Communication (use inside a ticket thread)",
        value: [
          "`/reply <text> [cc] [file]` — Reply to the customer (email/SMS/Teams)",
          "`/note <text> [file]` — Add an internal note",
        ].join("\n"),
        inline: false,
      },
      {
        name: "Ticket Management (use inside a ticket thread)",
        value: [
          "`/info` — Show ticket details",
          "`/link` — Get a link to the Zammad ticket",
          "`/owner [user]` — Set ticket owner (defaults to yourself)",
          "`/assign <user>` — Assign to a Discord user",
          "`/close` — Close the ticket",
          "`/lock` — Close and lock (prevents customer from reopening)",
          "`/state <name>` — Change state (open, waiting for reply, pending reminder, pending close, closed, closed (locked))",
          "`/pending <type> <duration>` — Set pending state with expiration",
          "`/priority <level>` — Change priority (1 low, 2 normal, 3 high)",
          "`/time <minutes>` — Log time accounting",
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
