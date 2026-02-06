import { logger } from "../util/logger.js";
import { getSettingOrEnv } from "../db/index.js";

// ---------------------------------------------------------------
// Search providers
// ---------------------------------------------------------------

async function tavilySearch(query: string, apiKey: string): Promise<string> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "basic",
      max_results: 5,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Tavily API ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    results: { title: string; url: string; content: string }[];
  };

  return data.results
    .map((r) => `**${r.title}** (${r.url})\n${r.content}`)
    .join("\n\n");
}

async function braveSearch(query: string, apiKey: string): Promise<string> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Brave Search API ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    web?: { results: { title: string; url: string; description: string }[] };
  };

  const results = data.web?.results ?? [];
  return results
    .map((r) => `**${r.title}** (${r.url})\n${r.description}`)
    .join("\n\n");
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

export function isSearchConfigured(): boolean {
  return !!getSettingOrEnv("SEARCH_API_KEY");
}

export async function webSearch(query: string): Promise<string> {
  const apiKey = getSettingOrEnv("SEARCH_API_KEY");
  const provider = getSettingOrEnv("SEARCH_PROVIDER") ?? "tavily";

  if (!apiKey) throw new Error("Search not configured (no API key)");

  // Try primary
  try {
    if (provider === "brave") {
      return await braveSearch(query, apiKey);
    }
    return await tavilySearch(query, apiKey);
  } catch (primaryErr) {
    logger.warn({ err: primaryErr, provider }, "Primary search failed, trying fallback");

    // Try fallback
    const fallbackKey = getSettingOrEnv("SEARCH_FALLBACK_API_KEY");
    const fallbackProvider = getSettingOrEnv("SEARCH_FALLBACK_PROVIDER");
    if (!fallbackKey || !fallbackProvider) throw primaryErr;

    if (fallbackProvider === "brave") {
      return await braveSearch(query, fallbackKey);
    }
    return await tavilySearch(query, fallbackKey);
  }
}
