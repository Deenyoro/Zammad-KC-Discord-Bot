import { logger } from "../util/logger.js";
import { getSettingOrEnv } from "../db/index.js";
import { getTicket, getArticles, getUser, getAgents } from "./zammad.js";

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
 * Build a text summary of a ticket and its articles for AI context.
 * Includes agent/owner identity so the AI knows who it's drafting for.
 */
export async function buildTicketContext(ticketId: number): Promise<string> {
  const ticket = await getTicket(ticketId);
  const articles = await getArticles(ticketId);

  let customerName = ticket.customer || "Unknown";
  if (ticket.customer_id) {
    try {
      const customer = await getUser(ticket.customer_id);
      customerName = `${customer.firstname} ${customer.lastname}`.trim() || customerName;
    } catch {
      // non-critical
    }
  }

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

  const lines = [
    `Ticket #${ticket.number}: ${ticket.title}`,
    `State: ${ticket.state}`,
    `Priority: ${ticket.priority}`,
    `Customer: ${customerName}`,
    `Assigned Agent: ${agentName}`,
    `Group: ${ticket.group}`,
    "",
    agentsList ? `Our support team agents: ${agentsList}` : "",
    "",
    "IMPORTANT: You are drafting a response on behalf of the assigned AGENT, not any of the customers.",
    `The agent's name is "${agentName}". Do NOT sign as or impersonate any customer in the conversation.`,
    "Customers are external people contacting support. Agents are internal staff responding.",
    agentsList ? `The people listed as "Our support team agents" above are all AGENTS (internal staff), not customers.` : "",
    "",
    "--- Conversation ---",
  ].filter(Boolean);

  // Include last 20 articles max to keep context manageable
  const recent = articles.slice(-20);
  for (const article of recent) {
    if (article.sender === "System") continue;

    // Extract the person's name from the "from" field for clearer attribution
    let personName = article.sender; // fallback: "Customer" or "Agent"
    if (article.from) {
      const nameMatch = article.from.match(/^(.+?)\s*<[^>]+>$/);
      if (nameMatch) {
        personName = nameMatch[1].trim();
      } else if (!article.from.includes("@") || article.from.includes(" ")) {
        personName = article.from.trim();
      }
    }

    const role = article.sender; // "Customer" or "Agent"
    const internalTag = article.internal ? " (Internal Note)" : "";
    const label = `${personName} [${role}]${internalTag}`;

    const body = article.body
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();

    // Cap each article at 500 chars to prevent context overflow
    const truncatedBody = body.length > 500 ? body.slice(0, 500) + "..." : body;
    lines.push(`[${label}] ${truncatedBody}`);
  }

  return lines.join("\n");
}
