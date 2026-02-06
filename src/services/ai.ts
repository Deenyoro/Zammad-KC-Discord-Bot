import { logger } from "../util/logger.js";
import { getSettingOrEnv } from "../db/index.js";
import { getTicket, getArticles, getUser, getAgents, getTicketTags } from "./zammad.js";

// ---------------------------------------------------------------
// Provider abstraction
// ---------------------------------------------------------------

interface AIProvider {
  chat(systemPrompt: string, userMessage: string): Promise<string>;
}

const PROVIDER_DEFAULTS: Record<string, { baseURL: string; model: string }> = {
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    model: "anthropic/claude-sonnet-4",
  },
  openai: {
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4o",
  },
  anthropic: {
    baseURL: "https://api.anthropic.com",
    model: "claude-sonnet-4-5-20250929",
  },
};

function buildOpenAICompatibleProvider(
  apiKey: string,
  baseURL: string,
  model: string
): AIProvider {
  return {
    async chat(systemPrompt: string, userMessage: string): Promise<string> {
      const res = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          max_tokens: 1024,
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`AI API ${res.status}: ${body}`);
      }

      const data = (await res.json()) as {
        choices: { message: { content: string } }[];
      };
      return data.choices?.[0]?.message?.content ?? "";
    },
  };
}

function buildAnthropicProvider(apiKey: string, model: string): AIProvider {
  return {
    async chat(systemPrompt: string, userMessage: string): Promise<string> {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Anthropic API ${res.status}: ${body}`);
      }

      const data = (await res.json()) as {
        content: { type: string; text: string }[];
      };
      return data.content?.find((c) => c.type === "text")?.text ?? "";
    },
  };
}

function buildProvider(
  apiKey: string,
  provider: string,
  model?: string,
  baseURL?: string
): AIProvider {
  const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.openrouter;
  const finalModel = model || defaults.model;
  const finalBaseURL = baseURL || defaults.baseURL;

  if (provider === "anthropic") {
    return buildAnthropicProvider(apiKey, finalModel);
  }
  return buildOpenAICompatibleProvider(apiKey, finalBaseURL, finalModel);
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

export function isAIConfigured(): boolean {
  return !!getSettingOrEnv("AI_API_KEY");
}

export async function aiChat(
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const apiKey = getSettingOrEnv("AI_API_KEY");
  const provider = getSettingOrEnv("AI_PROVIDER") ?? "openrouter";
  const model = getSettingOrEnv("AI_MODEL");
  const baseURL = getSettingOrEnv("AI_BASE_URL");

  if (!apiKey) throw new Error("AI not configured (no API key)");

  // Try primary provider
  try {
    const primary = buildProvider(apiKey, provider, model, baseURL);
    return await primary.chat(systemPrompt, userMessage);
  } catch (primaryErr) {
    logger.warn({ err: primaryErr, provider }, "Primary AI provider failed, trying fallback");

    // Try fallback
    const fallbackKey = getSettingOrEnv("AI_FALLBACK_API_KEY");
    const fallbackProvider = getSettingOrEnv("AI_FALLBACK_PROVIDER");
    if (!fallbackKey || !fallbackProvider) throw primaryErr;

    const fallbackModel = getSettingOrEnv("AI_FALLBACK_MODEL");
    const fallback = buildProvider(fallbackKey, fallbackProvider, fallbackModel);
    return await fallback.chat(systemPrompt, userMessage);
  }
}

/**
 * Build a comprehensive text summary of a ticket for AI context.
 * Includes ticket metadata, conversation history, and situational awareness.
 */
export async function buildTicketContext(ticketId: number): Promise<string> {
  const ticket = await getTicket(ticketId);
  const articles = await getArticles(ticketId);

  // Fetch customer details
  let customerName = ticket.customer || "Unknown";
  let customerEmail = "";
  let customerPhone = "";
  if (ticket.customer_id) {
    try {
      const customer = await getUser(ticket.customer_id);
      customerName = `${customer.firstname} ${customer.lastname}`.trim() || customerName;
      customerEmail = customer.email || "";
      customerPhone = customer.phone || customer.mobile || "";
    } catch {
      // non-critical
    }
  }

  // Fetch assigned agent details
  let agentName = "Unassigned";
  if (ticket.owner_id && ticket.owner_id > 1) {
    try {
      const owner = await getUser(ticket.owner_id);
      agentName = `${owner.firstname} ${owner.lastname}`.trim() || agentName;
    } catch {
      // non-critical
    }
  }

  // Fetch all agents for context
  let agentsList = "";
  try {
    const agents = await getAgents();
    const agentNames = agents.map((a) => `${a.firstname} ${a.lastname}`.trim()).filter(Boolean);
    if (agentNames.length > 0) {
      agentsList = agentNames.join(", ");
    }
  } catch {
    // non-critical
  }

  // Fetch ticket tags
  let tags: string[] = [];
  try {
    tags = await getTicketTags(ticketId);
  } catch {
    // non-critical
  }

  // Calculate time metrics
  const now = new Date();
  const createdAt = new Date(ticket.created_at);
  const updatedAt = new Date(ticket.updated_at);
  const ticketAgeMs = now.getTime() - createdAt.getTime();
  const ticketAgeDays = Math.floor(ticketAgeMs / (1000 * 60 * 60 * 24));
  const ticketAgeHours = Math.floor((ticketAgeMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const lastActivityMs = now.getTime() - updatedAt.getTime();
  const lastActivityMins = Math.floor(lastActivityMs / (1000 * 60));

  // Analyze conversation metrics
  const customerMessages = articles.filter(a => a.sender === "Customer" && !a.internal);
  const agentMessages = articles.filter(a => a.sender === "Agent" && !a.internal);
  const internalNotes = articles.filter(a => a.internal);
  const lastCustomerMsg = customerMessages[customerMessages.length - 1];
  const lastAgentMsg = agentMessages[agentMessages.length - 1];

  // Determine communication channel from most recent article types
  const channelTypes = articles.slice(-5).map(a => a.type).filter(Boolean);
  const primaryChannel = channelTypes.length > 0
    ? getMostCommon(channelTypes)
    : "unknown";

  // Time since last customer response
  let timeSinceCustomer = "N/A";
  if (lastCustomerMsg) {
    const customerMsgTime = new Date(lastCustomerMsg.created_at);
    const diffMs = now.getTime() - customerMsgTime.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    if (diffMins < 60) {
      timeSinceCustomer = `${diffMins} minutes ago`;
    } else if (diffMins < 1440) {
      timeSinceCustomer = `${Math.floor(diffMins / 60)} hours ago`;
    } else {
      timeSinceCustomer = `${Math.floor(diffMins / 1440)} days ago`;
    }
  }

  // Check if awaiting first response
  const isFirstResponse = agentMessages.length === 0;

  // SLA status
  let slaStatus = "No SLA";
  if (ticket.escalation_at) {
    const escalationDate = new Date(ticket.escalation_at);
    if (escalationDate <= now) {
      slaStatus = "BREACHED - Respond immediately";
    } else {
      const diffMs = escalationDate.getTime() - now.getTime();
      const diffMins = Math.round(diffMs / 60_000);
      if (diffMins < 60) {
        slaStatus = `${diffMins} minutes remaining - URGENT`;
      } else {
        slaStatus = `${Math.floor(diffMins / 60)}h ${diffMins % 60}m remaining`;
      }
    }
  }

  // Build context
  const lines = [
    "=== TICKET INFORMATION ===",
    `Ticket #${ticket.number}: ${ticket.title}`,
    `State: ${ticket.state}`,
    `Priority: ${ticket.priority}`,
    `Group: ${ticket.group}`,
    tags.length > 0 ? `Tags: ${tags.join(", ")}` : "",
    `SLA Status: ${slaStatus}`,
    "",
    "=== PEOPLE ===",
    `Customer: ${customerName}${customerEmail ? ` <${customerEmail}>` : ""}${customerPhone ? ` (${customerPhone})` : ""}`,
    `Assigned Agent: ${agentName}`,
    agentsList ? `All Support Agents: ${agentsList}` : "",
    "",
    "=== SITUATION ===",
    `Ticket Age: ${ticketAgeDays > 0 ? `${ticketAgeDays} days ` : ""}${ticketAgeHours} hours`,
    `Last Activity: ${lastActivityMins < 60 ? `${lastActivityMins} mins ago` : `${Math.floor(lastActivityMins / 60)} hours ago`}`,
    `Last Customer Message: ${timeSinceCustomer}`,
    `Communication Channel: ${formatChannelType(primaryChannel)}`,
    `Messages: ${customerMessages.length} from customer, ${agentMessages.length} from agents${internalNotes.length > 0 ? `, ${internalNotes.length} internal notes` : ""}`,
    isFirstResponse ? "*** THIS WILL BE THE FIRST AGENT RESPONSE TO THIS TICKET ***" : "",
    "",
    "=== IMPORTANT CONTEXT ===",
    "You are drafting a response on behalf of the AGENT, not the customer.",
    `The assigned agent is "${agentName}". Do NOT sign as or impersonate any customer.`,
    "Customers are external people contacting support. Agents are internal staff.",
    agentsList ? `These are all AGENTS (internal staff): ${agentsList}` : "",
    "",
    "=== CONVERSATION HISTORY ===",
  ].filter(Boolean);

  // Include articles with timestamps and better formatting
  const recent = articles.slice(-20);
  for (const article of recent) {
    if (article.sender === "System") continue;

    // Format timestamp
    const msgDate = new Date(article.created_at);
    const timestamp = msgDate.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });

    // Extract the person's name from the "from" field
    let personName = article.sender;
    if (article.from) {
      const nameMatch = article.from.match(/^(.+?)\s*<[^>]+>$/);
      if (nameMatch) {
        personName = nameMatch[1].trim();
      } else if (!article.from.includes("@") || article.from.includes(" ")) {
        personName = article.from.trim();
      }
    }

    const role = article.sender;
    const channelIndicator = article.type && article.type !== "note" ? ` via ${formatChannelType(article.type)}` : "";
    const internalTag = article.internal ? " [INTERNAL NOTE]" : "";
    const label = `[${timestamp}] ${personName} (${role})${channelIndicator}${internalTag}`;

    const body = article.body
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // Cap each article at 600 chars
    const truncatedBody = body.length > 600 ? body.slice(0, 600) + "..." : body;
    lines.push(`${label}:\n${truncatedBody}\n`);
  }

  return lines.join("\n");
}

/** Get the most common element in an array */
function getMostCommon(arr: string[]): string {
  const counts: Record<string, number> = {};
  for (const item of arr) {
    counts[item] = (counts[item] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? arr[0];
}

/** Format channel type for display */
function formatChannelType(type: string): string {
  const typeMap: Record<string, string> = {
    email: "Email",
    note: "Internal Note",
    phone: "Phone",
    sms: "SMS",
    web: "Web Form",
    twitter: "Twitter",
    facebook: "Facebook",
    telegram: "Telegram",
    teams_chat_message: "Microsoft Teams",
    ringcentral_sms_message: "SMS (RingCentral)",
  };
  return typeMap[type] || type;
}
