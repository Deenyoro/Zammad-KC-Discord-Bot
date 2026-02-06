# Zammad KC Discord Bot

Part of the [KawaConnect](https://github.com/Deenyoro/zammad-kc) support structure - a unified platform that brings every support channel (email, SMS, Teams, phone) into one place. This bot bridges Zammad tickets to Discord threads, replacing Zammad's lack of a mobile app with Discord's cross-platform presence for fast, on-the-go ticket operations.

Built for [Zammad-KC](https://github.com/Deenyoro/zammad-kc) (which adds SMS, Teams Chat, scheduled replies, and custom ticket states on top of Zammad), but **should work with any standard Zammad installation** - the KC-specific features (scheduled replies, SMS conversations) simply won't be available if the KC endpoints don't exist.

## Features

### Core

- **Automatic thread creation** - every open Zammad ticket gets a Discord thread with a color-coded embed showing state, priority, assignee, SLA, and a direct link to Zammad
- **Real-time sync** - Zammad webhooks push new articles, state changes, and title updates to Discord instantly
- **Bidirectional messaging** - messages in a ticket thread become Zammad internal notes; Zammad articles appear in Discord
- **Full attachment support** - images, documents, and files sync in both directions (up to 25 MB)
- **Multi-channel replies** - `/reply` auto-detects whether a ticket is email, SMS (RingCentral), or Teams and sends via the correct channel
- **Thread lifecycle** - threads lock/archive on close, unlock/unarchive on reopen, rename on title change
- **Role-based membership** - users with a configured Discord role are auto-added to every open ticket thread

### Ticket Management

- **25 slash commands** - reply, note, close, lock, assign, owner, state, priority, time accounting, pending, info, link, search, tags, merge, history, scheduled replies, new ticket creation, templates, and more
- **SLA indicators** - embeds turn red on SLA breach, `/info` shows time remaining
- **Ticket search** - `/search` finds tickets by number, title, or keyword without leaving Discord
- **Tags** - list, add, and remove tags directly from Discord
- **Merge** - merge duplicate tickets from Discord
- **History** - view the last 15 ticket history entries

### Scheduled Replies (Zammad-KC)

- **`/schedule`** - queue a reply for future delivery (e.g. `2h`, `1d`, `tomorrow 9am`)
- **`/schedules`** - list pending scheduled replies
- **`/unschedule`** - cancel a scheduled reply

### New Ticket Creation

- **`/newticket email`** - create a new email ticket
- **`/newticket sms`** - start a new SMS conversation (Zammad-KC)
- **`/newticket phone`** - log a phone call as an internal note

### Canned Templates

- **`/template use <name>`** - send a saved template as a customer reply
- **`/template list`** - browse available templates
- **`/template add`** / **`/template remove`** - manage templates (admin only)

### Smart Suggestions

- **`/ai`** - get a suggested draft response based on the full ticket conversation
- **`/aihelp`** - get troubleshooting steps, optionally augmented with live web search results
- **Auto-suggestions** - when a customer replies, the bot can automatically post a suggested response in the thread (visible only to agents, never sent to customers)
- Supports multiple providers (OpenRouter, OpenAI, Anthropic) with automatic fallback
- All suggestions are ephemeral or internal - nothing is ever sent to customers automatically

### Daily Summary

- Posts a daily embed with ticket stats: open, new, waiting for reply, pending, unassigned, SLA overdue
- Configurable hour via `/setup summary` or `DAILY_SUMMARY_HOUR` env var

### Waiting for Reply

- When a ticket is set to "waiting for reply" (in Zammad or via `/state`), the thread is **archived and hidden** from everyone's thread list - just like a closed ticket
- When the customer replies, the thread **automatically reappears**: unarchived, members re-added, and a notification posted
- Works for changes made in Zammad's UI, via Discord commands, or caught during periodic sync

### Health Monitoring

- Checks Zammad connectivity every 30 seconds
- **3 consecutive failures** → bot status goes red, `@everyone` alert in the tickets channel
- **Recovery** → bot returns to online, recovery notice posted
- `GET /healthz` - liveness probe (always 200)
- `GET /readyz` - readiness probe (503 if Zammad unreachable)

### Reliability

- **Sequential article ordering** - articles are always posted in chronological order regardless of webhook arrival order
- **Deduplication** - webhook delivery dedup, article sync dedup, per-ticket serial queues
- **Race condition protection** - grace periods prevent backfill from fighting with slash commands
- **Graceful shutdown** - flushes SQLite WAL, stops all timers, closes Discord gateway cleanly

## Prerequisites

- **Node.js 22+** (or Docker)
- A running **Zammad** instance accessible over the network
- A **Discord bot application** ([discord.com/developers](https://discord.com/developers/applications))

## Quick Start

### 1. Create the Discord Bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. **New Application** → name it → go to the **Bot** tab
3. Copy the **Bot Token** → this is your `DISCORD_TOKEN`
4. Enable **Message Content Intent** and **Server Members Intent**
5. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`, permissions:
   - Send Messages
   - Create Public Threads
   - Send Messages in Threads
   - Manage Threads
   - Manage Messages
   - Embed Links
   - Attach Files
   - Read Message History
6. Open the generated URL to invite the bot to your server

### 2. Get Discord IDs

Enable Developer Mode (User Settings → Advanced → Developer Mode):

- **Guild ID**: right-click server name → Copy Server ID
- **Channel ID**: right-click the channel for ticket threads → Copy Channel ID
- **Client ID**: found on the bot's application page (General Information → Application ID)
- **Role ID** (optional): right-click the role to auto-add to threads → Copy Role ID

### 3. Create the Zammad API Token

Admin → System → API → **New Token**:
- Permissions: `admin`, `ticket.agent`

### 4. Configure

```bash
cp .env.example .env
```

Fill in the required values:

```env
# Discord
DISCORD_TOKEN=<bot token>
DISCORD_CLIENT_ID=<application ID>
DISCORD_GUILD_ID=<server ID>
DISCORD_TICKETS_CHANNEL_ID=<channel ID>
DISCORD_TICKET_ROLE_ID=<role ID>           # optional - auto-adds role members to threads

# Zammad
ZAMMAD_BASE_URL=http://zammad-nginx:8080   # internal Docker/K8s URL
ZAMMAD_PUBLIC_URL=https://support.example.com
ZAMMAD_API_TOKEN=<token with admin + ticket.agent>
ZAMMAD_WEBHOOK_SECRET=<random secret>

# Access Control
ADMIN_USER_IDS=                            # optional - comma-separated Discord user IDs (empty = everyone is admin)

# Server
PORT=3100
LOG_LEVEL=info
```

### 5. Create the Zammad Webhook + Triggers

**Webhook** (Admin → Manage → Webhooks → New):
- Endpoint: `http://zammad-discord-bot:3100/webhooks/zammad` (adjust hostname for your network)
- HMAC SHA1 Token: same value as `ZAMMAD_WEBHOOK_SECRET`
- SSL Verify: No (internal network)

**Triggers** (Admin → Manage → Triggers):

Create two triggers that fire the webhook:

1. **"Discord: New Tickets"** - Condition: Action is **created** → Execute: fire the webhook
2. **"Discord: Ticket Updates"** - Condition: Action is **updated** → Execute: fire the webhook

### 6. Build & Start

**With Docker:**

```bash
docker compose up -d
docker logs -f zammad-discord-bot
```

**Without Docker:**

```bash
npm install
npm run build
npm start
```

Slash commands are automatically deployed to your Discord server on startup. You can also deploy them manually:

```bash
npm run deploy-commands
```

### 7. Map Discord Users to Zammad Agents

In Discord, run:

```
/setup usermap @DiscordUser agent@example.com
```

This links a Discord user to their Zammad agent account. Users must be mapped before they can use ticket commands. The bot looks up the Zammad user by email and stores their Zammad ID for proper attribution on replies and notes.

## Docker Compose

```yaml
services:
  discord-bot:
    build: .
    image: zammad-discord-bot:latest
    container_name: zammad-discord-bot
    restart: unless-stopped
    env_file: .env
    ports:
      - "3100:3100"
    volumes:
      - ./data:/app/data
    networks:
      - default
      - zammad

networks:
  zammad:
    external: true
    name: zammad-kc_default    # match your Zammad Docker network name
```

## Kubernetes

Manifests are in `k8s/`. Create the secret, then apply:

```bash
cp k8s/secret.example.yaml k8s/secret.yaml
# Edit k8s/secret.yaml with your values

kubectl apply -f k8s/secret.yaml
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
```

- Webhook endpoint: `http://zammad-discord-bot.<namespace>.svc.cluster.local:3100/webhooks/zammad`
- `ZAMMAD_BASE_URL` should be the internal K8s service URL for Zammad
- SQLite data persisted on a 1Gi PVC at `/app/data`
- Deployment uses `Recreate` strategy (SQLite supports one writer)

## Commands Reference

### Communication (use inside a ticket thread)

| Command | Description |
|---------|-------------|
| `/reply <text> [cc] [file]` | Reply to the customer (auto-detects email/SMS/Teams) |
| `/note <text> [file]` | Add an internal note |
| `/template use <name>` | Send a saved canned template as a reply |

### Ticket Management (use inside a ticket thread)

| Command | Description |
|---------|-------------|
| `/info` | Show ticket details, SLA status, and tags |
| `/link` | Get a direct link to the Zammad ticket |
| `/owner [user]` | Set ticket owner (defaults to yourself) |
| `/assign <user>` | Assign ticket to a Discord user |
| `/close` | Close the ticket |
| `/lock [duration]` | Lock ticket permanently, or for a duration (30m, 2h, 4h, 8h, 16h, 1d, 2d, 1w, 1mo) |
| `/state <name>` | Change state (open, waiting for reply, pending reminder, pending close, closed, closed (locked)) |
| `/pending <type> <duration>` | Set pending state with expiration (1d, 3d, 1w, 2w, 1m, 3m) |
| `/priority <level>` | Change priority (1 low, 2 normal, 3 high) |
| `/time <minutes>` | Log time accounting |
| `/tags list\|add\|remove` | Manage ticket tags |
| `/merge <target>` | Merge this ticket into another by ticket number |
| `/history` | Show last 15 history entries |

### Scheduled Replies (use inside a ticket thread)

| Command | Description |
|---------|-------------|
| `/schedule <text> <time>` | Schedule a reply (e.g. `2h`, `1d`, `tomorrow 9am`, ISO date) |
| `/schedules` | List pending scheduled replies for this ticket |
| `/unschedule <id>` | Cancel a scheduled reply by ID |

### Search & Create

| Command | Description |
|---------|-------------|
| `/search <query>` | Search Zammad tickets by number, title, or keyword |
| `/newticket <type> <to> <subject> <body>` | Create a new ticket (email, sms, or phone-log) |

### Smart Suggestions (use inside a ticket thread)

| Command | Description |
|---------|-------------|
| `/ai` | Get a suggested draft response for this ticket |
| `/aihelp` | Get troubleshooting steps with optional web search |

### Templates

| Command | Description |
|---------|-------------|
| `/template list` | List all saved templates |
| `/template add <name> <body>` | Add a new template (admin only) |
| `/template remove <name>` | Remove a template (admin only) |

### Setup (admin only)

| Command | Description |
|---------|-------------|
| `/setup usermap <user> <email>` | Map a Discord user to a Zammad agent |
| `/setup ai <api_key> [provider] [model]` | Configure the smart suggestion provider |
| `/setup search <api_key> [provider]` | Configure web search for `/aihelp` |
| `/setup summary <hour\|off>` | Configure or disable the daily summary |
| `/help` | Show all commands |

### Thread Messages

Any message typed in a ticket thread is automatically forwarded to Zammad as an internal note (with attachments). The bot detects the ticket channel type - for Teams and RingCentral SMS tickets, messages are routed through the appropriate channel instead. Use `/reply` to send an external reply to the customer.

## Optional Features

### Smart Suggestions Setup

Configure via environment variables or at runtime with `/setup ai`:

```env
AI_API_KEY=<your API key>
AI_PROVIDER=openrouter              # openrouter | openai | anthropic
AI_MODEL=                           # optional - uses provider default if unset
AI_BASE_URL=                        # optional - custom endpoint override
```

**Fallback provider** (used if the primary fails):

```env
AI_FALLBACK_API_KEY=<fallback key>
AI_FALLBACK_PROVIDER=openai
AI_FALLBACK_MODEL=gpt-4o
```

Or configure at runtime (stored in the bot's database, overrides env vars):

```
/setup ai <api_key> [provider] [model]
```

### Web Search Setup

Enables web-augmented `/aihelp` responses. Configure via env or `/setup search`:

```env
SEARCH_API_KEY=<your API key>
SEARCH_PROVIDER=tavily              # tavily | brave
SEARCH_FALLBACK_API_KEY=            # optional
SEARCH_FALLBACK_PROVIDER=           # optional
```

### Daily Summary Setup

Posts a ticket statistics embed once per day at the configured hour:

```env
DAILY_SUMMARY_HOUR=9                # 0-23, leave empty to disable
```

Or configure at runtime:

```
/setup summary 9        # post at 9:00
/setup summary off      # disable
```

## Architecture

```
Discord <──WebSocket──> Bot <──HTTP POST──> Zammad (webhooks)
                         |
                         |──REST API──> Zammad (tickets, articles, users, states, tags)
                         |
                         |──SQLite──> data/bot.db (mappings, dedup, templates, settings)
                         |
                         |──HTTP──> Smart suggestion providers (optional)
                         |──HTTP──> Web search providers (optional)
```

| Component | Purpose |
|-----------|---------|
| **Fastify** | Webhook receiver with HMAC-SHA1 signature verification |
| **discord.js v14** | Gateway connection, threads, embeds, slash commands |
| **better-sqlite3** | Ticket-thread mappings, article sync dedup, webhook dedup, templates, runtime settings |
| **p-queue** | Per-ticket serial queues + global Discord rate limiter (45 req/s) |
| **Zod** | Environment variable validation |
| **Pino** | Structured JSON logging (pretty-printed in dev) |

### Data Flow

1. **Zammad → Discord**: Webhook fires → signature verified → per-ticket queue → fetch full ticket → create/update thread → sync all unsynced articles in order
2. **Discord → Zammad**: Message in thread → check user mapping → detect channel type → create article → mark as synced (suppresses webhook echo)
3. **Periodic sync**: Every 10 seconds, all open tickets are fetched and compared against local state. Missing threads are created, stale threads are closed, state/title changes are applied. This catches anything webhooks might have missed.

### Database Tables

| Table | Purpose |
|-------|---------|
| `ticket_threads` | Maps Zammad ticket IDs to Discord thread/message IDs, tracks state and title |
| `user_map` | Links Discord user IDs to Zammad agent emails and IDs |
| `synced_articles` | Tracks which articles have been synced (prevents duplicates) |
| `webhook_dedup` | Prevents processing the same webhook delivery twice |
| `templates` | Stores canned response templates |
| `settings` | Runtime configuration overrides (from `/setup` commands) |

## Compatibility

This bot is built for [Zammad-KC](https://github.com/Deenyoro/zammad-kc), which extends Zammad with additional features. However, it **works with standard Zammad** installations with the following differences:

| Feature | Standard Zammad | Zammad-KC |
|---------|----------------|-----------|
| Ticket sync, replies, notes, close, assign, etc. | Full support | Full support |
| Email tickets | Full support | Full support |
| SMS tickets (RingCentral) | N/A | Full support |
| Teams Chat tickets | N/A | Full support |
| Scheduled replies (`/schedule`) | Not available | Full support |
| "Waiting for reply" state | Requires manual state creation | Built-in |
| "Closed (locked)" state | Requires manual state creation | Built-in |
| New SMS conversations (`/newticket sms`) | Not available | Full support |

For standard Zammad, you may need to create the "waiting for reply" and "closed (locked)" ticket states manually in Admin → Manage → Ticket States if you want those features.

## Troubleshooting

**Bot doesn't create threads for existing tickets**
- The bot syncs all open tickets on startup. Wait for the initial sync to complete (check logs). If tickets are already closed, they won't get threads.

**Webhook not firing**
- Check that the webhook URL is reachable from Zammad's network
- Verify the `ZAMMAD_WEBHOOK_SECRET` matches between the bot and Zammad webhook configuration
- Check Zammad's webhook delivery log (Admin → Manage → Webhooks → click the webhook → Deliveries)

**Commands say "not in a ticket thread"**
- Most commands must be run inside a ticket thread, not in the main channel

**User not mapped**
- Run `/setup usermap @user email@example.com` - the email must match the agent's Zammad email exactly

**Thread not hiding on "waiting for reply"**
- The thread is archived and members are removed. It may still appear in search results but will be gone from the channel's thread list and sidebar.

**/ai and /aihelp say "not configured"**
- Set up a provider with `/setup ai <api_key>` or the `AI_API_KEY` env var

**Bot shows "ZAMMAD UNREACHABLE"**
- Check that `ZAMMAD_BASE_URL` is correct and Zammad is running
- The bot retries automatically and will recover when connectivity is restored

## License

MIT
