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
  .setDescription("Close the ticket linked to this thread")
  .addStringOption((o) =>
    o.setName("note").setDescription("Optional internal note to add before closing").setRequired(false)
  );

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
  .setDescription("Close and lock the ticket (prevents customer from reopening)")
  .addStringOption((o) =>
    o
      .setName("duration")
      .setDescription("Auto-unlock after this duration (omit for permanent lock)")
      .setRequired(false)
      .addChoices(
        { name: "30 minutes", value: "30m" },
        { name: "2 hours", value: "2h" },
        { name: "4 hours", value: "4h" },
        { name: "8 hours", value: "8h" },
        { name: "16 hours", value: "16h" },
        { name: "1 day", value: "1d" },
        { name: "2 days", value: "2d" },
        { name: "1 week", value: "1w" },
        { name: "1 month", value: "1M" }
      )
  );

// ---------------------------------------------------------------
// New commands
// ---------------------------------------------------------------

export const searchCommand = new SlashCommandBuilder()
  .setName("search")
  .setDescription("Search Zammad tickets")
  .addStringOption((o) =>
    o.setName("query").setDescription("Search query (title, number, keyword)").setRequired(true)
  );

export const tagsCommand = new SlashCommandBuilder()
  .setName("tags")
  .setDescription("Manage ticket tags")
  .addSubcommand((sc) =>
    sc.setName("list").setDescription("List tags on this ticket")
  )
  .addSubcommand((sc) =>
    sc
      .setName("add")
      .setDescription("Add a tag to this ticket")
      .addStringOption((o) =>
        o.setName("tag").setDescription("Tag to add").setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("remove")
      .setDescription("Remove a tag from this ticket")
      .addStringOption((o) =>
        o.setName("tag").setDescription("Tag to remove").setRequired(true)
      )
  );

export const mergeCommand = new SlashCommandBuilder()
  .setName("merge")
  .setDescription("Merge this ticket into another ticket")
  .addStringOption((o) =>
    o.setName("target").setDescription("Target ticket number to merge into").setRequired(true)
  );

export const historyCommand = new SlashCommandBuilder()
  .setName("history")
  .setDescription("Show recent ticket history");

export const scheduleCommand = new SlashCommandBuilder()
  .setName("schedule")
  .setDescription("Schedule a reply for later delivery")
  .addStringOption((o) =>
    o.setName("text").setDescription("Reply text").setRequired(true)
  )
  .addStringOption((o) =>
    o.setName("time").setDescription("When to send (e.g. 2h, 1d, tomorrow 9am, ISO date)").setRequired(true)
  );

export const schedulesCommand = new SlashCommandBuilder()
  .setName("schedules")
  .setDescription("List scheduled replies for this ticket");

export const unscheduleCommand = new SlashCommandBuilder()
  .setName("unschedule")
  .setDescription("Cancel a scheduled reply")
  .addStringOption((o) =>
    o.setName("id").setDescription("Scheduled article ID to cancel").setRequired(true)
  );

export const newticketCommand = new SlashCommandBuilder()
  .setName("newticket")
  .setDescription("Create a new ticket")
  .addStringOption((o) =>
    o
      .setName("type")
      .setDescription("Ticket type")
      .setRequired(true)
      .addChoices(
        { name: "email", value: "email" },
        { name: "sms", value: "sms" },
        { name: "phone-log", value: "phone" }
      )
  )
  .addStringOption((o) =>
    o.setName("to").setDescription("Recipient (email address or phone number)").setRequired(true)
  )
  .addStringOption((o) =>
    o.setName("subject").setDescription("Ticket subject/title").setRequired(true)
  )
  .addStringOption((o) =>
    o.setName("body").setDescription("Message body").setRequired(true)
  );

// templateCommand removed — replaced by Zammad text modules (see textmoduleCommand)

export const textmoduleCommand = new SlashCommandBuilder()
  .setName("textmodule")
  .setDescription("Use Zammad text modules (::shortcut)")
  .addSubcommand((sc) =>
    sc.setName("list").setDescription("List all available text modules")
  )
  .addSubcommand((sc) =>
    sc
      .setName("search")
      .setDescription("Search text modules by name or keyword")
      .addStringOption((o) =>
        o.setName("query").setDescription("Search query").setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("use")
      .setDescription("Send a text module as a reply to the customer")
      .addStringOption((o) =>
        o.setName("name").setDescription("Text module name or keyword (e.g. fpn)").setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc
      .setName("preview")
      .setDescription("Preview a text module without sending")
      .addStringOption((o) =>
        o.setName("name").setDescription("Text module name or keyword (e.g. fpn)").setRequired(true)
      )
  )
  .addSubcommand((sc) =>
    sc.setName("refresh").setDescription("Refresh the text modules cache from Zammad")
  );

export const aireplyCommand = new SlashCommandBuilder()
  .setName("aireply")
  .setDescription("Get an AI-suggested reply for this ticket")
  .addStringOption((o) =>
    o.setName("context").setDescription("Additional context for the AI").setRequired(false)
  )
  .addStringOption((o) =>
    o.setName("language").setDescription("Response language").setRequired(false)
      .addChoices(
        { name: "English", value: "en" },
        { name: "Portuguese (Brazilian)", value: "pt-br" },
        { name: "Arabic", value: "ar" },
        { name: "Chinese", value: "zh" }
      )
  )
  .addStringOption((o) =>
    o.setName("tone").setDescription("Override tone").setRequired(false)
      .addChoices(
        { name: "Formal", value: "formal" },
        { name: "Friendly", value: "friendly" },
        { name: "Brief", value: "brief" },
        { name: "Empathetic", value: "empathetic" }
      )
  )
  .addStringOption((o) =>
    o.setName("audience").setDescription("Technical level").setRequired(false)
      .addChoices(
        { name: "Technical", value: "technical" },
        { name: "Non-technical", value: "non-technical" }
      )
  )
  .addStringOption((o) =>
    o.setName("length").setDescription("Response length").setRequired(false)
      .addChoices(
        { name: "Short", value: "short" },
        { name: "Medium", value: "medium" },
        { name: "Detailed", value: "detailed" }
      )
  )
  .addBooleanOption((o) =>
    o.setName("exclude_internal").setDescription("Ignore internal notes").setRequired(false)
  );

export const aisummaryCommand = new SlashCommandBuilder()
  .setName("aisummary")
  .setDescription("Get an AI summary of the ticket with suggested next steps")
  .addStringOption((o) =>
    o.setName("context").setDescription("Additional context for the AI").setRequired(false)
  )
  .addStringOption((o) =>
    o.setName("language").setDescription("Response language").setRequired(false)
      .addChoices(
        { name: "English", value: "en" },
        { name: "Portuguese (Brazilian)", value: "pt-br" },
        { name: "Arabic", value: "ar" },
        { name: "Chinese", value: "zh" }
      )
  )
  .addStringOption((o) =>
    o.setName("tone").setDescription("Override tone").setRequired(false)
      .addChoices(
        { name: "Formal", value: "formal" },
        { name: "Friendly", value: "friendly" },
        { name: "Brief", value: "brief" },
        { name: "Empathetic", value: "empathetic" }
      )
  )
  .addStringOption((o) =>
    o.setName("length").setDescription("Response length").setRequired(false)
      .addChoices(
        { name: "Short", value: "short" },
        { name: "Medium", value: "medium" },
        { name: "Detailed", value: "detailed" }
      )
  )
  .addBooleanOption((o) =>
    o.setName("exclude_internal").setDescription("Ignore internal notes").setRequired(false)
  );

export const aihelpCommand = new SlashCommandBuilder()
  .setName("aihelp")
  .setDescription("Get AI troubleshooting help with web search for this ticket")
  .addStringOption((o) =>
    o.setName("context").setDescription("Additional context for the AI").setRequired(false)
  )
  .addStringOption((o) =>
    o.setName("language").setDescription("Response language").setRequired(false)
      .addChoices(
        { name: "English", value: "en" },
        { name: "Portuguese (Brazilian)", value: "pt-br" },
        { name: "Arabic", value: "ar" },
        { name: "Chinese", value: "zh" }
      )
  )
  .addStringOption((o) =>
    o.setName("tone").setDescription("Override tone").setRequired(false)
      .addChoices(
        { name: "Formal", value: "formal" },
        { name: "Friendly", value: "friendly" },
        { name: "Brief", value: "brief" },
        { name: "Empathetic", value: "empathetic" }
      )
  )
  .addStringOption((o) =>
    o.setName("audience").setDescription("Technical level").setRequired(false)
      .addChoices(
        { name: "Technical", value: "technical" },
        { name: "Non-technical", value: "non-technical" }
      )
  )
  .addStringOption((o) =>
    o.setName("length").setDescription("Response length").setRequired(false)
      .addChoices(
        { name: "Short", value: "short" },
        { name: "Medium", value: "medium" },
        { name: "Detailed", value: "detailed" }
      )
  )
  .addStringOption((o) =>
    o.setName("format").setDescription("Output style").setRequired(false)
      .addChoices(
        { name: "Steps", value: "steps" },
        { name: "Script (for phone)", value: "script" },
        { name: "Checklist", value: "checklist" }
      )
  )
  .addBooleanOption((o) =>
    o.setName("exclude_internal").setDescription("Ignore internal notes").setRequired(false)
  );

export const aiproofreadCommand = new SlashCommandBuilder()
  .setName("aiproofread")
  .setDescription("Proofread a message for spelling, grammar, and flow")
  .addStringOption((o) =>
    o.setName("message").setDescription("The message to proofread").setRequired(true)
  )
  .addStringOption((o) =>
    o.setName("language").setDescription("Response language").setRequired(false)
      .addChoices(
        { name: "English", value: "en" },
        { name: "Portuguese (Brazilian)", value: "pt-br" },
        { name: "Arabic", value: "ar" },
        { name: "Chinese", value: "zh" }
      )
  )
  .addStringOption((o) =>
    o.setName("tone").setDescription("Target tone").setRequired(false)
      .addChoices(
        { name: "Formal", value: "formal" },
        { name: "Friendly", value: "friendly" },
        { name: "Brief", value: "brief" },
        { name: "Empathetic", value: "empathetic" }
      )
  );
