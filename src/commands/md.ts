/**
 * /md — export the ticket of the current thread to Markdown.
 *
 * The .md file is posted in the thread and added to the Zammad ticket as an
 * internal note attachment. See services/ticketExport.ts for the format.
 */

import {
  AttachmentBuilder,
  ChatInputCommandInteraction,
  GuildPremiumTier,
  SlashCommandBuilder,
  type Guild,
} from "discord.js";
import { logger } from "../util/logger.js";
import { env } from "../util/env.js";
import { getUserMap, markArticleSynced } from "../db/index.js";
import { enqueueForTicket } from "../queue/index.js";
import {
  createArticle,
  getAllArticles,
  getTicket,
  getTicketTags,
  getUser,
  type ZammadUser,
} from "../services/zammad.js";
import { buildTicketMarkdown, splitMarkdown, type ExportTicket } from "../services/ticketExport.js";
import { getBotTimezone } from "../util/timezone.js";
import { requireMapping } from "./ticket.js";

export const mdCommand = new SlashCommandBuilder()
  .setName("md")
  .setDescription("Export this ticket (all articles) to a Markdown file, here and as a Zammad note");

const MiB = 1024 * 1024;

/** Per-file upload limit for bots in this guild (Discord: 10 MiB, more with boosts). */
export function discordUploadLimit(guild: Pick<Guild, "premiumTier"> | null | undefined): number {
  switch (guild?.premiumTier) {
    case GuildPremiumTier.Tier3:
      return 100 * MiB;
    case GuildPremiumTier.Tier2:
      return 50 * MiB;
    default:
      return 10 * MiB;
  }
}

/** "2026-09-30 14:12 EDT" in the bot timezone. */
export function formatExportTime(iso: string, tz = getBotTimezone()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).formatToParts(d);
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const hour = g("hour") === "24" ? "00" : g("hour");
    return `${g("year")}-${g("month")}-${g("day")} ${hour}:${g("minute")} ${g("timeZoneName")}`.trim();
  } catch {
    return d.toISOString();
  }
}

function personLabel(u: ZammadUser | null, fallback?: string): string | undefined {
  if (!u) return fallback || undefined;
  const name = `${u.firstname ?? ""} ${u.lastname ?? ""}`.trim();
  const email = u.email?.trim();
  if (name && email) return `${name} <${email}>`;
  return name || email || u.login || fallback || undefined;
}

async function userOrNull(id: number | undefined | null): Promise<ZammadUser | null> {
  if (!id || id <= 1) return null;
  try {
    return await getUser(id);
  } catch {
    return null;
  }
}

function fmtBytes(n: number): string {
  return n < MiB ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / MiB).toFixed(1)} MB`;
}

export async function handleMd(interaction: ChatInputCommandInteraction) {
  const mapping = await requireMapping(interaction);
  if (!mapping) return;
  await interaction.deferReply();

  // Run in the ticket's queue so the Zammad note created below is marked
  // synced before the webhook for it is processed (no echo into the thread).
  await enqueueForTicket(mapping.ticket_id, async () => {
    const ticket = await getTicket(mapping.ticket_id);
    const [owner, customer, tags, articles] = await Promise.all([
      userOrNull(ticket.owner_id),
      userOrNull(ticket.customer_id),
      getTicketTags(ticket.id).catch(() => [] as string[]),
      getAllArticles(ticket),
    ]);

    const exportTicket: ExportTicket = {
      id: ticket.id,
      number: ticket.number,
      title: ticket.title,
      state: ticket.state,
      priority: ticket.priority,
      group: ticket.group,
      owner: personLabel(owner, ticket.owner && ticket.owner !== "-" ? ticket.owner : undefined),
      customer: personLabel(customer, ticket.customer),
      organization: ticket.organization ?? undefined,
      created_at: ticket.created_at,
      updated_at: ticket.updated_at,
      pending_time: ticket.pending_time,
      close_at: ticket.close_at,
      tags,
    };

    const caller = getUserMap(interaction.user.id);
    const exportedBy = interaction.member && "displayName" in interaction.member
      ? `${interaction.member.displayName} (Discord)`
      : `${interaction.user.username} (Discord)`;
    const baseUrl = (env().ZAMMAD_PUBLIC_URL ?? env().ZAMMAD_BASE_URL).replace(/\/+$/, "");
    const doc = buildTicketMarkdown(exportTicket, articles, {
      baseUrl,
      formatTime: (iso) => formatExportTime(iso),
      exportedAt: new Date().toISOString(),
      exportedBy,
    });

    const filename = `ticket-${ticket.number}.md`;
    const fullBuf = Buffer.from(doc.full, "utf8");
    // Leave headroom under the limit for the multipart envelope.
    const parts = splitMarkdown(doc, discordUploadLimit(interaction.guild) - 64 * 1024);
    const partFiles = parts.map((p, i) =>
      new AttachmentBuilder(Buffer.from(p, "utf8"), {
        name: parts.length === 1 ? filename : `ticket-${ticket.number}-part${i + 1}of${parts.length}.md`,
      })
    );

    const summary =
      `Ticket #${ticket.number} exported to Markdown by ${interaction.user}: ` +
      `${articles.length} article${articles.length === 1 ? "" : "s"}, ${fmtBytes(fullBuf.length)}` +
      (parts.length > 1 ? ` (split into ${parts.length} files for Discord's upload limit)` : "") +
      ".";

    const first = await interaction.editReply({
      content: summary,
      files: [partFiles[0]],
      allowedMentions: { parse: [] },
    });
    for (let i = 1; i < partFiles.length; i++) {
      await interaction.followUp({ files: [partFiles[i]], allowedMentions: { parse: [] } });
    }

    try {
      const article = await createArticle({
        ticket_id: ticket.id,
        body:
          `Ticket exported to Markdown from Discord by ${exportedBy}: ` +
          `${filename}, ${articles.length} articles, ${fmtBytes(fullBuf.length)}.`,
        type: "note",
        sender: "Agent",
        internal: true,
        content_type: "text/plain",
        origin_by_id: caller?.zammad_id ?? undefined,
        on_behalf_of: caller?.zammad_id ?? null,
        attachments: [{ filename, data: fullBuf.toString("base64"), "mime-type": "text/markdown" }],
      });
      markArticleSynced(article.id, ticket.id, mapping.thread_id, first.id, "discord_to_zammad");
      logger.info(
        { ticketId: ticket.id, articleId: article.id, articles: articles.length, bytes: fullBuf.length, parts: parts.length },
        "Exported ticket to Markdown"
      );
    } catch (err) {
      logger.error({ ticketId: ticket.id, err }, "Markdown export: failed to add the Zammad note");
      const msg = err instanceof Error ? err.message : String(err);
      await interaction.followUp({
        content: `The file is above, but adding it to Zammad as an internal note failed: ${msg.slice(0, 1500)}`,
        ephemeral: true,
      });
    }
  });
}
