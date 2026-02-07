import { env } from "../util/env.js";
import { logger } from "../util/logger.js";

// ---------------------------------------------------------------
// Types matching Zammad REST API responses
// ---------------------------------------------------------------

export interface ZammadTicket {
  id: number;
  number: string;
  title: string;
  state_id: number;
  state: string;
  priority_id: number;
  priority: string;
  group_id: number;
  group: string;
  owner_id: number;
  customer_id: number;
  customer: string;
  created_at: string;
  updated_at: string;
  escalation_at?: string | null;
  preferences?: Record<string, any>;
  tags?: string[];
}

export interface ZammadArticle {
  id: number;
  ticket_id: number;
  sender_id: number;
  sender: string;
  type_id: number;
  type: string;
  subject: string | null;
  from?: string;
  to?: string;
  body: string;
  internal: boolean;
  created_at: string;
  updated_at: string;
  attachments?: ZammadAttachment[];
  preferences?: Record<string, unknown>;
}

export interface ZammadAttachment {
  id: number;
  filename: string;
  size: number;
  preferences: {
    "Content-Type"?: string;
    "Mime-Type"?: string;
  };
}

export interface ZammadUser {
  id: number;
  login: string;
  firstname: string;
  lastname: string;
  email: string;
  phone?: string;
  mobile?: string;
}

// ---------------------------------------------------------------
// API client
// ---------------------------------------------------------------

async function zammadFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${env().ZAMMAD_BASE_URL}/api/v1${path}`;
  const res = await fetch(url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${env().ZAMMAD_API_TOKEN}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.error({ status: res.status, path, body }, "Zammad API error");
    throw new Error(`Zammad API ${res.status}: ${path} — ${body}`);
  }
  return res;
}

// ---------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------

export async function getTicket(ticketId: number): Promise<ZammadTicket> {
  const res = await zammadFetch(`/tickets/${ticketId}?expand=true`);
  return res.json() as Promise<ZammadTicket>;
}

/** Fetch all tickets, paginated. */
export async function getTickets(page = 1, perPage = 100): Promise<ZammadTicket[]> {
  const res = await zammadFetch(
    `/tickets?expand=true&page=${page}&per_page=${perPage}`
  );
  return res.json() as Promise<ZammadTicket[]>;
}

/** Fetch all non-closed tickets by paginating the tickets API. */
export async function getAllOpenTickets(): Promise<ZammadTicket[]> {
  const closedStates = new Set(["closed", "closed (locked)", "merged", "removed"]);
  const all: ZammadTicket[] = [];
  let page = 1;
  const perPage = 100;

  const MAX_PAGES = 50; // safety limit: 5 000 tickets max
  while (page <= MAX_PAGES) {
    const batch = await getTickets(page, perPage);
    if (batch.length === 0) break;

    for (const ticket of batch) {
      if (!closedStates.has(ticket.state.toLowerCase())) {
        all.push(ticket);
      }
    }

    if (batch.length < perPage) break;
    page++;
  }

  return all;
}

export async function updateTicket(
  ticketId: number,
  data: Partial<Pick<ZammadTicket, "title" | "state_id" | "priority_id" | "owner_id" | "group_id">> & { pending_time?: string }
): Promise<ZammadTicket> {
  const res = await zammadFetch(`/tickets/${ticketId}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
  return res.json() as Promise<ZammadTicket>;
}

// ---------------------------------------------------------------
// Articles
// ---------------------------------------------------------------

export async function getArticles(ticketId: number): Promise<ZammadArticle[]> {
  const res = await zammadFetch(`/ticket_articles/by_ticket/${ticketId}?expand=true`);
  return res.json() as Promise<ZammadArticle[]>;
}

export interface ArticleAttachment {
  filename: string;
  data: string;         // base64-encoded
  "mime-type": string;
}

export async function createArticle(data: {
  ticket_id: number;
  body: string;
  subject?: string;
  type?: string;
  sender?: string;
  internal?: boolean;
  content_type?: string;
  to?: string;
  cc?: string;
  from?: string;
  origin_by_id?: number;
  attachments?: ArticleAttachment[];
  preferences?: Record<string, unknown>;
}): Promise<ZammadArticle> {
  const payload = {
    type: "note",
    sender: "Agent",
    internal: false,
    content_type: "text/plain",
    ...data,
    preferences: {
      ...data.preferences,
      discord: { synced: true },
    },
  };
  logger.debug({ payload }, "Creating article with payload");
  const res = await zammadFetch("/ticket_articles", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return res.json() as Promise<ZammadArticle>;
}

/** Download an article attachment as a Buffer. */
export async function downloadAttachment(
  ticketId: number,
  articleId: number,
  attachmentId: number
): Promise<{ data: Buffer; contentType: string; filename: string }> {
  const res = await zammadFetch(
    `/ticket_attachment/${ticketId}/${articleId}/${attachmentId}`
  );
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const buf = Buffer.from(await res.arrayBuffer());
  return { data: buf, contentType, filename: `attachment_${attachmentId}` };
}

// ---------------------------------------------------------------
// Users
// ---------------------------------------------------------------

export async function getUser(userId: number): Promise<ZammadUser> {
  const res = await zammadFetch(`/users/${userId}`);
  return res.json() as Promise<ZammadUser>;
}

// Cache for agents list (refreshed every 5 minutes)
let _agentsCache: ZammadUser[] | null = null;
let _agentsCacheFetchedAt = 0;
const AGENTS_CACHE_TTL = 5 * 60_000; // 5 minutes

/**
 * Fetch all agents (users with agent permissions) from Zammad.
 * Uses caching to avoid hammering the API.
 */
export async function getAgents(): Promise<ZammadUser[]> {
  const now = Date.now();
  if (_agentsCache && now - _agentsCacheFetchedAt < AGENTS_CACHE_TTL) {
    return _agentsCache;
  }

  const agents: ZammadUser[] = [];
  let page = 1;
  const perPage = 100;
  const MAX_PAGES = 20; // Safety limit

  while (page <= MAX_PAGES) {
    const res = await zammadFetch(`/users?page=${page}&per_page=${perPage}&expand=true`);
    const users = (await res.json()) as (ZammadUser & { role_ids?: number[]; active?: boolean })[];
    if (users.length === 0) break;

    // Filter for active users who have agent-like role_ids (typically 2 = Agent, 1 = Admin)
    // Role ID 3 is usually Customer, which we exclude
    for (const user of users) {
      if (!user.active) continue;
      // Skip system user (id 1)
      if (user.id === 1) continue;
      // Check if user has agent or admin roles (role_ids 1 or 2)
      const roleIds = user.role_ids ?? [];
      if (roleIds.includes(1) || roleIds.includes(2)) {
        agents.push(user);
      }
    }

    if (users.length < perPage) break;
    page++;
  }

  _agentsCache = agents;
  _agentsCacheFetchedAt = now;
  logger.debug({ count: agents.length }, "Fetched agents list");
  return agents;
}

export async function searchUsers(query: string): Promise<ZammadUser[]> {
  const res = await zammadFetch(`/users/search?query=${encodeURIComponent(query)}&limit=10`);
  return res.json() as Promise<ZammadUser[]>;
}

/**
 * Find a Zammad user by exact email match.
 * Tries Elasticsearch search first, falls back to paginated user list
 * (handles broken/missing Elasticsearch).
 */
export async function findUserByEmail(email: string): Promise<ZammadUser | undefined> {
  const lowerEmail = email.toLowerCase();

  // Try search endpoint first (fast when ES is working)
  try {
    const results = await searchUsers(email);
    const match = results.find((u) => u.email.toLowerCase() === lowerEmail);
    if (match) return match;
  } catch {
    // ES may be down — fall through to pagination
  }

  // Fallback: paginate through all users (capped at 50 pages / 5 000 users)
  let page = 1;
  const perPage = 100;
  const MAX_PAGES = 50;
  while (page <= MAX_PAGES) {
    const res = await zammadFetch(`/users?page=${page}&per_page=${perPage}&expand=true`);
    const users = (await res.json()) as ZammadUser[];
    if (users.length === 0) break;

    const match = users.find((u) => u.email.toLowerCase() === lowerEmail);
    if (match) return match;

    if (users.length < perPage) break;
    page++;
  }

  return undefined;
}

// ---------------------------------------------------------------
// Ticket States (for slash commands)
// ---------------------------------------------------------------

export interface ZammadState {
  id: number;
  name: string;
}

let _statesCache: ZammadState[] | null = null;

export async function getStates(): Promise<ZammadState[]> {
  if (_statesCache) return _statesCache;
  const res = await zammadFetch("/ticket_states");
  _statesCache = (await res.json()) as ZammadState[];
  return _statesCache;
}

export async function getStateByName(name: string): Promise<ZammadState | undefined> {
  const states = await getStates();
  return states.find((s) => s.name.toLowerCase() === name.toLowerCase());
}

// ---------------------------------------------------------------
// Time Accounting
// ---------------------------------------------------------------

export async function addTimeAccounting(data: {
  ticket_id: number;
  time_unit: number;
  type_id?: number;
}): Promise<void> {
  await zammadFetch("/ticket_time_accountings", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// ---------------------------------------------------------------
// Ticket Search
// ---------------------------------------------------------------

export async function searchTickets(query: string, limit = 10): Promise<ZammadTicket[]> {
  const res = await zammadFetch(
    `/tickets/search?query=${encodeURIComponent(query)}&limit=${limit}&expand=true`
  );
  return res.json() as Promise<ZammadTicket[]>;
}

export async function getTicketByNumber(ticketNumber: string): Promise<ZammadTicket | undefined> {
  try {
    const results = await searchTickets(`number:${ticketNumber}`, 1);
    return results.find((t) => t.number === ticketNumber);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------
// Ticket Creation
// ---------------------------------------------------------------

export async function createTicket(data: {
  title: string;
  group: string;
  customer_id?: number;
  customer?: string;
  article: {
    subject?: string;
    body: string;
    type?: string;
    sender?: string;
    internal?: boolean;
    content_type?: string;
    to?: string;
    from?: string;
  };
}): Promise<ZammadTicket> {
  const res = await zammadFetch("/tickets", {
    method: "POST",
    body: JSON.stringify(data),
  });
  return res.json() as Promise<ZammadTicket>;
}

// ---------------------------------------------------------------
// Tags
// ---------------------------------------------------------------

export async function getTicketTags(ticketId: number): Promise<string[]> {
  const res = await zammadFetch(`/tags?object=Ticket&o_id=${ticketId}`);
  const data = (await res.json()) as { tags: string[] };
  return data.tags ?? [];
}

export async function addTicketTag(ticketId: number, tag: string): Promise<void> {
  await zammadFetch("/tags/add", {
    method: "POST",
    body: JSON.stringify({ object: "Ticket", o_id: ticketId, item: tag }),
  });
}

export async function removeTicketTag(ticketId: number, tag: string): Promise<void> {
  await zammadFetch("/tags/remove", {
    method: "DELETE",
    body: JSON.stringify({ object: "Ticket", o_id: ticketId, item: tag }),
  });
}

// ---------------------------------------------------------------
// Merge
// ---------------------------------------------------------------

export async function mergeTickets(sourceTicketId: number, targetTicketId: number): Promise<void> {
  await zammadFetch(`/ticket_merge/${sourceTicketId}/${targetTicketId}`, {
    method: "PUT",
  });
}

// ---------------------------------------------------------------
// History
// ---------------------------------------------------------------

export interface ZammadHistoryEntry {
  id: number;
  created_at: string;
  object: string;
  type: string;
  attribute?: string;
  value_from?: string;
  value_to?: string;
  created_by_id: number;
}

export async function getTicketHistory(ticketId: number): Promise<ZammadHistoryEntry[]> {
  const res = await zammadFetch(`/ticket_history/${ticketId}`);
  const data = (await res.json()) as { history: ZammadHistoryEntry[] };
  return data.history ?? [];
}

// ---------------------------------------------------------------
// KC Scheduled Articles
// ---------------------------------------------------------------

export interface KcScheduledArticle {
  id: number;
  ticket_id: number;
  scheduled_at: string;
  body: string;
  article_type?: string;
  created_at: string;
}

export async function createScheduledArticle(data: {
  ticket_id: number;
  body: string;
  scheduled_at: string;
  article_type?: string;
  to?: string;
}): Promise<KcScheduledArticle> {
  const res = await zammadFetch("/kc/scheduled_articles", {
    method: "POST",
    body: JSON.stringify({ scheduled_article: data }),
  });
  return res.json() as Promise<KcScheduledArticle>;
}

export async function getScheduledArticles(ticketId: number): Promise<KcScheduledArticle[]> {
  const res = await zammadFetch(`/kc/scheduled_articles?ticket_id=${ticketId}`);
  return res.json() as Promise<KcScheduledArticle[]>;
}

export async function cancelScheduledArticle(articleId: number): Promise<void> {
  await zammadFetch(`/kc/scheduled_articles/${articleId}`, {
    method: "DELETE",
  });
}

// ---------------------------------------------------------------
// KC SMS Conversation
// ---------------------------------------------------------------

export async function createSmsConversation(data: {
  to: string;
  body: string;
  channel_id?: number;
}): Promise<ZammadTicket> {
  const res = await zammadFetch("/kc/conversations/sms", {
    method: "POST",
    body: JSON.stringify(data),
  });
  return res.json() as Promise<ZammadTicket>;
}

// ---------------------------------------------------------------
// Text Modules
// ---------------------------------------------------------------

export interface ZammadTextModule {
  id: number;
  name: string;
  keywords: string | null;
  content: string;
  active: boolean;
  group_ids?: number[];
}

// Cache for text modules (refreshed every 5 minutes)
let _textModulesCache: ZammadTextModule[] | null = null;
let _textModulesCacheFetchedAt = 0;
const TEXT_MODULES_CACHE_TTL = 5 * 60_000; // 5 minutes

/** Fetch all active text modules from Zammad. */
export async function getTextModules(): Promise<ZammadTextModule[]> {
  const now = Date.now();
  if (_textModulesCache && now - _textModulesCacheFetchedAt < TEXT_MODULES_CACHE_TTL) {
    return _textModulesCache;
  }

  const res = await zammadFetch("/text_modules.json");
  const modules = (await res.json()) as ZammadTextModule[];
  _textModulesCache = modules.filter((m) => m.active);
  _textModulesCacheFetchedAt = now;
  logger.debug({ count: _textModulesCache.length }, "Fetched text modules");
  return _textModulesCache;
}

/** Clear the text modules cache (e.g. after a change). */
export function clearTextModulesCache(): void {
  _textModulesCache = null;
  _textModulesCacheFetchedAt = 0;
}

/**
 * Find a text module by keyword or name.
 * Matches against the keywords field (comma-separated) and the name.
 */
export async function findTextModule(shortcut: string): Promise<ZammadTextModule | undefined> {
  const modules = await getTextModules();
  const lower = shortcut.toLowerCase();

  // First try exact keyword match
  for (const m of modules) {
    if (m.keywords) {
      const keywords = m.keywords.split(/[,\s]+/).map((k) => k.trim().toLowerCase()).filter(Boolean);
      if (keywords.includes(lower)) return m;
    }
  }

  // Then try exact name match (case-insensitive)
  for (const m of modules) {
    if (m.name.toLowerCase() === lower) return m;
  }

  // Then try partial name match
  for (const m of modules) {
    if (m.name.toLowerCase().includes(lower)) return m;
  }

  return undefined;
}

/**
 * Escape HTML special characters in plain text.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Expand all ::shortcut patterns in text with their corresponding text module content.
 * When text modules are found, the result is returned as HTML (content_type: "text/html")
 * so that images, formatting, and line breaks from the text module are preserved.
 * Returns the expanded body, content type, and a list of which modules were used.
 */
export async function expandTextModules(text: string): Promise<{
  expanded: string;
  contentType: "text/plain" | "text/html";
  used: string[];
}> {
  const pattern = /::(\w+)/g;
  const matches = [...text.matchAll(pattern)];

  if (matches.length === 0) {
    return { expanded: text, contentType: "text/plain", used: [] };
  }

  const used: string[] = [];
  let result = text;
  let hasModule = false;

  // Process in reverse order to maintain correct offsets
  for (const match of matches.reverse()) {
    const shortcut = match[1];
    const module = await findTextModule(shortcut);
    if (module) {
      hasModule = true;
      result = result.slice(0, match.index!) + `\x00TM_START\x00${module.content}\x00TM_END\x00` + result.slice(match.index! + match[0].length);
      used.unshift(`::${shortcut} → ${module.name}`);
    }
  }

  if (!hasModule) {
    return { expanded: result, contentType: "text/plain", used: [] };
  }

  // Build final HTML: escape plain text parts, preserve text module HTML as-is
  const parts = result.split(/\x00TM_START\x00|\x00TM_END\x00/);
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      // Plain text segment — escape and convert newlines to <br>
      html += escapeHtml(parts[i]).replace(/\n/g, "<br>");
    } else {
      // Text module HTML content — insert as-is
      html += parts[i];
    }
  }

  return { expanded: html, contentType: "text/html", used };
}

