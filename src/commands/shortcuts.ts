import { SlashCommandBuilder } from "discord.js";

export const replyCommand = new SlashCommandBuilder()
  .setName("reply")
  .setDescription("Send a reply to the customer (email/SMS/Teams)")
  .addStringOption((o) =>
    o.setName("text").setDescription("Reply text").setRequired(true)
  )
  .addStringOption((o) =>
    o.setName("cc").setDescription("CC emails (comma-separated, email only)").setRequired(false)
  )
  .addAttachmentOption((o) =>
    o.setName("file").setDescription("Attach a file (image, document, etc.)").setRequired(false)
  );

export const noteCommand = new SlashCommandBuilder()
  .setName("note")
  .setDescription("Add an internal note to the ticket")
  .addStringOption((o) =>
    o.setName("text").setDescription("Note text").setRequired(true)
  )
  .addAttachmentOption((o) =>
    o.setName("file").setDescription("Attach a file (image, document, etc.)").setRequired(false)
  );

export const closeCommand = new SlashCommandBuilder()
  .setName("close")
  .setDescription("Close the ticket linked to this thread");

export const assignCommand = new SlashCommandBuilder()
  .setName("assign")
  .setDescription("Assign ticket to a user")
  .addUserOption((o) =>
    o.setName("user").setDescription("Discord user to assign").setRequired(true)
  );

export const ownerCommand = new SlashCommandBuilder()
  .setName("owner")
  .setDescription("Set ticket owner (defaults to yourself)")
  .addUserOption((o) =>
    o.setName("user").setDescription("Discord user to assign (leave empty for yourself)").setRequired(false)
  );

export const timeCommand = new SlashCommandBuilder()
  .setName("time")
  .setDescription("Add time accounting entry")
  .addNumberOption((o) =>
    o.setName("minutes").setDescription("Minutes to log").setRequired(true)
  );

export const priorityCommand = new SlashCommandBuilder()
  .setName("priority")
  .setDescription("Change ticket priority")
  .addStringOption((o) =>
    o
      .setName("level")
      .setDescription("Priority level")
      .setRequired(true)
      .addChoices(
        { name: "1 low", value: "1" },
        { name: "2 normal", value: "2" },
        { name: "3 high", value: "3" }
      )
  );

export const stateCommand = new SlashCommandBuilder()
  .setName("state")
  .setDescription("Change ticket state")
  .addStringOption((o) =>
    o
      .setName("name")
      .setDescription("State name")
      .setRequired(true)
      .addChoices(
        { name: "open", value: "open" },
        { name: "waiting for reply", value: "waiting for reply" },
        { name: "pending reminder", value: "pending reminder" },
        { name: "pending close", value: "pending close" },
        { name: "closed", value: "closed" },
        { name: "closed (locked)", value: "closed (locked)" }
      )
  );

export const pendingCommand = new SlashCommandBuilder()
  .setName("pending")
  .setDescription("Set ticket to a pending state with a duration")
  .addStringOption((o) =>
    o
      .setName("type")
      .setDescription("Pending type")
      .setRequired(true)
      .addChoices(
        { name: "pending reminder", value: "pending reminder" },
        { name: "pending close", value: "pending close" }
      )
  )
  .addStringOption((o) =>
    o
      .setName("duration")
      .setDescription("How long until the pending time expires")
      .setRequired(true)
      .addChoices(
        { name: "1 day", value: "1d" },
        { name: "3 days", value: "3d" },
        { name: "1 week", value: "1w" },
        { name: "2 weeks", value: "2w" },
        { name: "1 month", value: "1m" },
        { name: "3 months", value: "3m" }
      )
  );

export const infoCommand = new SlashCommandBuilder()
  .setName("info")
  .setDescription("Show ticket details");

export const linkCommand = new SlashCommandBuilder()
  .setName("link")
  .setDescription("Get a link to the Zammad ticket");

export const lockCommand = new SlashCommandBuilder()
  .setName("lock")
  .setDescription("Close and lock the ticket (prevents customer from reopening)");
