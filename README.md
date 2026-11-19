# Zammad KC Discord Bot

Part of the [KawaConnect](https://github.com/kawaconnect/zammad-kc) support structure - a unified platform that brings every support channel (email, SMS, Teams, phone) into one place. This bot bridges Zammad tickets to Discord threads, replacing Zammad's lack of a mobile app with Discord's cross-platform presence for fast, on-the-go ticket operations.

Built for [Zammad-KC](https://github.com/kawaconnect/zammad-kc) (which adds SMS, Teams Chat, scheduled replies, and custom ticket states on top of Zammad), but **should work with any standard Zammad installation** - the KC-specific features (scheduled replies, SMS conversations) simply won't be available if the KC endpoints don't exist.

## Features

### Core

- **Automatic thread creation** - every open Zammad ticket gets a Discord thread with a color-coded embed showing state, priority, assignee, SLA, and a direct link to Zammad
- **Real-time sync** - Zammad webhooks push new articles, state changes, and title updates to Discord instantly
- **Bidirectional messaging** - messages in a ticket thread become Zammad internal notes; Zammad articles appear in Discord
- **Attachment support** - images, documents, and files sync in both directions. Size limits are set with `/setup attachments` (default 5 MB per file; larger Zammad attachments are linked instead of uploaded)
- **Links kept** - links in HTML emails and notes are shown inline as `[text](<url>)` (no preview embeds), so a button-only email such as a sign-in / magic-link email is usable from the thread; long messages are split between links, never inside one
- **Inline images** - images embedded in an article body (Zammad `ticket_attachment` URLs, `cid:` references, `data:` URIs) are posted as Discord image attachments, for emails and notes alike. Images in a reply's quoted chain are posted too, but an image is posted only once per ticket (matched by content), so quoted copies of earlier screenshots are not repeated. HEIC images are converted to JPEG when the bundled image library can decode them
- **All notes** - every Zammad note reaches the thread, internal or public, agent or System (e.g. Zammad-KC call activity notes); only System-sender non-note articles (trigger auto-replies) are skipped
- **Multi-channel replies** - `/reply` auto-detects whether a ticket is email, SMS (RingCentral), or Teams and sends via the correct channel
- **Thread lifecycle** - threads lock/archive on close, unlock/unarchive on reopen, rename on title change
- **Role-based membership** - users with a configured Discord role are auto-added to every open ticket thread

### Ticket Management

- **Slash commands** - reply, reply-all, note, close, lock, assign, rename, state, priority, time accounting, pending, info, link, search, tags, merge, history, scheduled replies, new ticket creation, text modules, and more (see [Commands Reference](#commands-reference))
- **SLA indicators** - embeds turn red on SLA breach, `/info` shows time remaining
- **Ticket search** - `/search` finds tickets by number, title, or keyword without leaving Discord
- **Tags** - list, add, and remove tags directly from Discord
- **Merge** - merge duplicate tickets from Discord
- **History** - view the last 15 ticket history entries
- **Markdown export** - `/md` exports the whole ticket to `ticket-<number>.md`, posted in the thread and attached to the Zammad ticket as an internal note

### Reminders

- **`/remind-me <when> [message]`** - pings you in the same channel or thread later; `when` takes the same syntax as `/schedule`
- **`/reminders [cancel]`** - list your pending reminders or cancel one
- Stored in the bot's SQLite database, so reminders survive restarts and redeploys

### Scheduled Replies (Zammad-KC)

- **`/schedule`** - queue a reply for future delivery (e.g. `2h`, `1d`, `tomorrow 9am`)
- **`/schedules`** - list pending scheduled replies
- **`/unschedule`** - cancel a scheduled reply

### New Ticket Creation

- **`/newticket email`** - create a new email ticket
- **`/newticket sms`** - start a new SMS conversation (Zammad-KC)
- **`/newticket phone`** - log a phone call as an internal note

### Text Modules

- **`/textmodule use <name>`** - send a Zammad text module as a customer reply
- **`/textmodule list|search|preview|refresh`** - browse the text modules defined in Zammad
- Typing `::shortcut` in `/reply`, `/note` or a thread message expands the matching text module

### AI Commands (optional)

- **`/aireply`** - a suggested draft reply based on the ticket conversation
- **`/aisummary`** - a summary of the ticket with next steps
- **`/aihelp`** - troubleshooting steps, optionally with live web search results
- **`/aiproofread`**, **`/aitranslate`** - proofread or translate text
- Supports OpenRouter, OpenAI and Anthropic, with an optional fallback provider
- Results are posted in the ticket thread for the agents there. Nothing is sent to the customer unless an agent sends it with `/reply`
- The ticket conversation is sent to the configured AI provider (and search terms to the search provider) when one of these commands is run

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
4. Under **Privileged Gateway Intents**, enable **Message Content Intent** and
   **Server Members Intent**. The bot does not start without them ("Used
   disallowed intents" in the log). Message content is needed to turn thread
   messages into ticket notes, server members to add the ticket role to threads.
5. Turn **Public Bot** off so nobody else can add the bot to their server.
6. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`, permissions:
   - View Channels
   - Send Messages
   - Create Public Threads
   - Send Messages in Threads
   - Manage Threads
   - Manage Messages
   - Embed Links
   - Attach Files
   - Read Message History
   - Mention Everyone (for the "Zammad is unreachable" alert and `/remind-me ping:`)
7. Open the generated URL to invite the bot to your server

Everyone who can see the tickets channel can read the ticket threads, and any
message typed in a ticket thread is saved on the ticket as an internal note.
Make the channel private to your support staff.

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

Fill in the values. A variable left blank counts as not set.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DISCORD_TOKEN` | yes | | Bot token |
| `DISCORD_CLIENT_ID` | yes | | Application ID |
| `DISCORD_GUILD_ID` | yes | | Server the slash commands are registered on |
| `DISCORD_TICKETS_CHANNEL_ID` | yes | | Channel in which ticket threads are created |
| `DISCORD_TICKET_ROLE_ID` | no | | Role whose members are added to every open ticket thread |
| `ZAMMAD_BASE_URL` | yes | | Zammad URL for API calls (internal Docker/Kubernetes URL is fine) |
| `ZAMMAD_PUBLIC_URL` | no | `ZAMMAD_BASE_URL` | Zammad URL used in links shown to people |
| `ZAMMAD_API_TOKEN` | yes | | Token with `admin` and `ticket.agent` |
| `ZAMMAD_WEBHOOK_SECRET` | yes | | Shared secret that signs the webhook (use a long random string) |
| `ADMIN_USER_IDS` | no | empty | Comma-separated Discord user IDs allowed to run `/setup`; empty means nobody |
| `PORT` | no | `3100` | HTTP port (webhook, `/healthz`, `/readyz`) |
| `LOG_LEVEL` | no | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `DEBUG_TOKEN` | no | | Enables `/debug/*`, which then require `Authorization: Bearer <token>` |
| `SETTINGS_ENCRYPTION_KEY` | no | | Encrypts the API keys saved with `/setup ai` and `/setup search` in `data/bot.db`, see [Stored API keys](#stored-api-keys) |
| `AI_API_KEY`, `AI_PROVIDER`, `AI_MODEL`, `AI_BASE_URL` | no | provider `openrouter` | AI commands, see [Optional Features](#optional-features) |
| `AI_FALLBACK_API_KEY`, `AI_FALLBACK_PROVIDER`, `AI_FALLBACK_MODEL` | no | | Fallback AI provider |
| `SEARCH_API_KEY`, `SEARCH_PROVIDER` | no | provider `tavily` | Web search for `/aihelp` |
| `SEARCH_FALLBACK_API_KEY`, `SEARCH_FALLBACK_PROVIDER` | no | | Fallback search provider |
| `DAILY_SUMMARY_HOUR` | no | off | Hour (0-23) for the daily summary |

Values set with `/setup` (summary hour, timezone, AI provider and model and
the rest) are stored in `data/bot.db` and win over the environment. The API
keys are the exception: a non-blank `AI_API_KEY`, `AI_FALLBACK_API_KEY`,
`SEARCH_API_KEY` or `SEARCH_FALLBACK_API_KEY` in the environment wins over a key
saved with `/setup`, so a deployment can inject the keys from a secret store and
keep none in the database. A key from the environment is used with the provider
from the environment (`AI_PROVIDER`, `SEARCH_PROVIDER`); while it is set,
`/setup ai` or `/setup search` refuses to save a key.

#### Stored API keys

Keys saved with `/setup ai` and `/setup search` are encrypted in `data/bot.db`
when `SETTINGS_ENCRYPTION_KEY` is set (any long random string, e.g.
`openssl rand -base64 32`): AES-256-GCM, stored as `enc:v1:<iv>:<tag>:<data>`,
the same scheme as the Uptime Discord bot. Keys saved before the variable was
set are encrypted at the next start. Without it the bot works as before, stores
the keys in plaintext and logs a warning at startup, so protect the data volume
and its backups like the `.env` file.

Keep the encryption key with the other bot secrets. If it is lost or changed,
the stored keys can no longer be read: the bot keeps running, logs which
setting is affected, and the AI commands answer that an admin needs to run
`/setup ai` (or `/setup search`) again. Restoring the old key also works.

### 5. Create the Zammad Webhook + Triggers

**Webhook** (Admin → Manage → Webhooks → New):
- Endpoint: `http://zammad-discord-bot:3100/webhooks/zammad` (adjust hostname for your network)
- HMAC SHA1 Token: same value as `ZAMMAD_WEBHOOK_SECRET`
- SSL Verify: No is acceptable only on a private network between the two containers; use `https://` and Yes if the webhook crosses anything else

The bot rejects any webhook request whose `X-Hub-Signature` does not match the secret.

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

With Docker Compose the database is kept in `./data` on the host. The
container starts as root only long enough to give the unprivileged `bot` user
ownership of `./data` (Docker creates it as root on a fresh install, and older
installs may have root-owned files there), then runs the bot as `bot`. No
manual step is needed, and existing data stays where it is. When the container
is started as another user (Kubernetes `runAsUser`, `docker run --user`), that
step is skipped and the platform must make `/app/data` writable, e.g. with
`fsGroup` as in `k8s/deployment.yaml`.

The compose file publishes port 3100 on `127.0.0.1` only. Zammad on the shared
Docker network reaches the bot by container name and does not need it; remove
the `ports:` entry if nothing on the host uses it, or change the address if
Zammad runs on another machine (then put TLS in front).

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
      - "127.0.0.1:3100:3100"
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

## Building / Releases (GitLab CI)

Container images are built by GitLab CI (`.gitlab-ci.yml`). GitHub Actions is
disabled; `.github/workflows/build-and-push.yml` is kept only for reference.

Pipelines run on a `v*` tag, or when started manually from the GitLab UI or API.
A merge request (e.g. a Renovate MR) also gets a pipeline that runs `check` and
builds the image, but never publishes anything (no registry push, no GHCR
mirror). Plain pushes do not start a pipeline.

1. **test** stage, `check` job (`ci/check.sh`, cluster runner, `node:24-alpine`,
   which is the same image both Dockerfile stages use):
   - fails if the job's Node major differs from the Dockerfile's `FROM node:<N>`;
   - on a release (a `v*` tag, or `RELEASE_VERSION`), fails unless `package.json`
     and `package-lock.json` carry that version;
   - `npm ci`, a load check of the native modules (`better-sqlite3`, `sharp`),
     `npm run typecheck`, `npm run lint`, `npm run build`, and `npm test`
     (Zammad webhook signature checks, attachment image conversion, settings
     encryption).
   - `compose-test` job (`ci/compose-test.sh`, Docker-in-Docker): starts the
     image with the shipped `docker-compose.yml` on a fresh `./data` and on a
     root-owned `./data` holding a database, and checks the database opens and
     keeps its data. Runs on merge requests that change the image or compose
     file, and on every release.
2. **build** stage, `build` job: builds the `Dockerfile` with the shared
   `dean/ci-templates` docker template. It runs only if `check` passed. It pushes
   to the GitLab container registry and mirrors to
   `ghcr.io/kawaconnect/zammad-kc-discord-bot` (the image `k8s/deployment.yaml`
   uses; `GHCR_OWNER` in `.gitlab-ci.yml`).
   A tag `v1.2.3` publishes `1.2.3`, `1.2` and `latest`, plus `sha-<commit>`.
   A manual run without `RELEASE_VERSION` publishes `sha-<commit>`, `<branch>` and
   `<branch>-<commit>`, and also `latest` when run on `master`.

To release, bump `version` in `package.json` and `package-lock.json` (for example
with `npm version patch --no-git-tag-version`), add a `CHANGELOG.md` entry, commit,
and push a matching `v*` tag.

Manual runs (GitLab: Build > Pipelines > Run pipeline) accept these variables:

| Variable | Effect |
|---|---|
| `RELEASE_VERSION=v1.2.3` | Build and publish as that version without a tag (package.json must match) |
| `DOCKER_PUSH=false` | Run the checks and build the image, but publish nothing |

To run the same checks locally with Node 24: `sh ci/check.sh`. With Docker:
`sh ci/compose-test.sh`.

Linting: `npm run lint`. ESLint and typescript-eslint live in `tools/lint` with
their own `package.json`, because typescript-eslint needs the TypeScript 6
compiler API while the bot builds with TypeScript 7; the script installs them on
first use. The config is `eslint.config.js`.

## Commands Reference

### Communication (use inside a ticket thread)

| Command | Description |
|---------|-------------|
| `/reply <text> [to] [cc] [file] [convert] [close]` | Reply to the customer (auto-detects email/SMS/Teams) |
| `/replyall <text> [file] [convert] [close]` | Reply to everyone on the last email (To and CC) |
| `/note <text> [file] [close]` | Add an internal note |
| `/textmodule use <name>` | Send a Zammad text module as a reply |
| `/participants` | Show the email addresses and contacts on the ticket |

### Ticket Management (use inside a ticket thread)

| Command | Description |
|---------|-------------|
| `/info` | Show ticket details, SLA status, and tags |
| `/link` | Get a direct link to the Zammad ticket |
| `/assign [user]` | Assign the ticket to a mapped Discord user (defaults to yourself) |
| `/rename <title>` | Rename the ticket |
| `/close [note]` | Close the ticket, optionally with an internal note |
| `/lock [duration]` | Lock ticket permanently, or for a duration (30m, 2h, 4h, 8h, 16h, 1d, 2d, 1w, 1mo) |
| `/state <name>` | Change state (open, waiting for reply, pending reminder, pending close, closed, closed (locked)) |
| `/pending <type> <duration>` | Set pending state with expiration (1d, 3d, 1w, 2w, 1m, 3m) |
| `/priority <level>` | Change priority (1 low, 2 normal, 3 high) |
| `/time <minutes>` | Log time accounting |
| `/tags list\|add\|remove` | Manage ticket tags |
| `/merge <target>` | Merge this ticket into another by ticket number |
| `/history` | Show last 15 history entries |
| `/related` | List merged and linked tickets, each with its Zammad link and Discord thread |
| `/md` | Export the whole ticket to Markdown (`ticket-<number>.md`): a header (number, title, state, priority, group, owner, customer, organization, created/updated, tags) and every article in order with time, from/to/cc, type, sender, internal flag, the body converted from HTML, and attachment links. The file is posted in the thread (split into parts if it exceeds Discord's upload limit) and added to the Zammad ticket as an internal note attachment |

### Reminders (any channel or thread)

| Command | Description |
|---------|-------------|
| `/remind-me <when> [message] [ping] [who]` | `ping:` adds @everyone or @here and `who:` a person or role (pinging everyone, here or a role needs a mapped agent). Ping you in this channel/thread at `when`, with the message and a link back. `when` accepts a duration (`30m`, `2h`, `1h30m`, `3d`, `1w`, `2mo`, `in 2h`) or a date/time (`tomorrow 9am`, `today 5pm`, `friday 3pm`, `17:30`, `2026-10-05`, `2026-10-05 14:00`), read in the bot timezone (`/setup timezone`). Past times and times more than 366 days ahead are rejected |
| `/reminders [cancel:<id>]` | List your pending reminders, or cancel one |

Reminders are stored in SQLite (`data/bot.db`), checked every 15 seconds, and delivered after a restart if they fell due while the bot was down (marked as late). If the channel is gone the reminder is sent by DM.

### Scheduled Replies (use inside a ticket thread)

| Command | Description |
|---------|-------------|
| `/schedule <text> <time>` | Schedule a reply (e.g. `2h`, `1d`, `tomorrow 9am`, `2026-10-05 14:00`; same syntax as `/remind-me`) |
| `/schedules` | List pending scheduled replies for this ticket |
| `/unschedule <id>` | Cancel a scheduled reply by ID |

### Search & Create

| Command | Description |
|---------|-------------|
| `/search <query>` | Search Zammad tickets by number, title, or keyword |
| `/newticket <type> <to> <subject> <body> [send]` | Create a new ticket (email, sms, teams, or phone-log) |
| `/weekly [start] [end] [email]` | Create a Weekly Check ticket |
| `/checknote` | Add a snapshot of another bot's status board to the ticket as a note (`/setup checknote`) |

### AI (use inside a ticket thread)

| Command | Description |
|---------|-------------|
| `/aireply` | Suggested draft reply for this ticket |
| `/aisummary` | Summary with suggested next steps |
| `/aihelp` | Troubleshooting steps with optional web search |
| `/aiproofread <message>` | Proofread a message |
| `/aitranslate <language> [content]` | Translate text, or the ticket when `content` is omitted |

### Text Modules

| Command | Description |
|---------|-------------|
| `/textmodule list` | List the text modules defined in Zammad |
| `/textmodule search <query>` | Search by name or keyword |
| `/textmodule preview <name>` | Show a text module without sending it |
| `/textmodule refresh` | Reload the list from Zammad |

### Setup (only users in `ADMIN_USER_IDS`)

| Command | Description |
|---------|-------------|
| `/setup usermap <user> <email>` | Map a Discord user to a Zammad agent |
| `/setup ai <api_key> [provider] [model]` | Configure the smart suggestion provider |
| `/setup search <api_key> [provider]` | Configure web search for `/aihelp` |
| `/setup summary <hour\|off>` | Configure or disable the daily summary |
| `/setup model <model>`, `/setup language <lang>` | Change the AI model or default language |
| `/setup timezone <tz>` | Bot timezone for dates and schedules |
| `/setup keepalive <hour\|off>` | Daily silent refresh that keeps threads from being hidden |
| `/setup status-refresh <minutes>` | How often ticket status embeds refresh |
| `/setup attachments [...]` | Show or set attachment size limits |
| `/setup weekly-email <email>`, `/setup checknote [bot_id] [channel]` | Defaults for `/weekly` and `/checknote` |
| `/help` | Show all commands |

### Thread Messages

Any message typed in a ticket thread is forwarded to Zammad as an internal note (with attachments), whatever the ticket's channel. Mapped agents author the note as themselves; anyone else is named in the note text. Nothing typed in a thread reaches the customer: use `/reply` for that.

Ticket commands only work for Discord users mapped to a Zammad agent (`/setup usermap`).

## Optional Features

### AI Setup

Configure via environment variables or at runtime with `/setup ai`:

```env
AI_API_KEY=<your API key>
# openrouter | openai | anthropic
AI_PROVIDER=openrouter
# optional: provider default when unset
AI_MODEL=
# optional: custom endpoint
AI_BASE_URL=
```

**Fallback provider** (used if the primary fails):

```env
AI_FALLBACK_API_KEY=<fallback key>
AI_FALLBACK_PROVIDER=openai
AI_FALLBACK_MODEL=gpt-4o
```

Or configure at runtime (stored in the bot's database, encrypted when
`SETTINGS_ENCRYPTION_KEY` is set; only used while `AI_API_KEY` is not set in
the environment, see [Configure](#4-configure)):

```
/setup ai <api_key> [provider] [model]
```

### Web Search Setup

Adds web search results to `/aihelp`. Configure via env or `/setup search`:

```env
SEARCH_API_KEY=<your API key>
# tavily | brave
SEARCH_PROVIDER=tavily
# optional
SEARCH_FALLBACK_API_KEY=
SEARCH_FALLBACK_PROVIDER=
```

### Daily Summary Setup

Posts a ticket statistics embed once per day at the configured hour:

```env
# 0-23, leave empty to disable
DAILY_SUMMARY_HOUR=9
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
2. **Discord → Zammad**: Message in thread → look up user mapping → create internal note → mark as synced (suppresses webhook echo)
3. **Periodic sync**: Every 30 seconds all open tickets are fetched and compared against local state, and every 10 seconds new articles are caught up. Missing threads are created, stale threads are closed, state/title changes are applied. This catches anything webhooks might have missed.

### Database Tables

| Table | Purpose |
|-------|---------|
| `ticket_threads` | Maps Zammad ticket IDs to Discord thread/message IDs, tracks state and title |
| `user_map` | Links Discord user IDs to Zammad agent emails and IDs |
| `synced_articles` | Tracks which articles have been synced (prevents duplicates) |
| `webhook_dedup` | Prevents processing the same webhook delivery twice |
| `templates` | Unused (replaced by Zammad text modules) |
| `settings` | Runtime configuration overrides (from `/setup` commands) |
| `posted_media` | Content hashes of images already posted per ticket (inline-image de-duplication) |
| `reminders` | `/remind-me` reminders and their delivery state |

## Compatibility

This bot is built for [Zammad-KC](https://github.com/kawaconnect/zammad-kc), which extends Zammad with additional features. However, it **works with standard Zammad** installations with the following differences:

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

**The AI commands say "not configured"**
- Set up a provider with `/setup ai <api_key>` or the `AI_API_KEY` env var

**The AI commands say the stored key "cannot be decrypted"**
- `SETTINGS_ENCRYPTION_KEY` was removed or changed after the key was saved. Run `/setup ai` (or `/setup search`) again, or restore the previous value. The log names the affected setting.

**`/setup ai` says the key is set in the environment**
- `AI_API_KEY` (or `SEARCH_API_KEY`) in the environment wins over the database. Change it in the deployment, or remove it there to manage the key with `/setup`.

**Bot shows "ZAMMAD UNREACHABLE"**
- Check that `ZAMMAD_BASE_URL` is correct and Zammad is running
- The bot retries automatically and will recover when connectivity is restored

**Bot exits with "Missing or invalid environment variables"**
- The lines below the message name each variable. See the table under [Configure](#4-configure).

**Bot exits with "Used disallowed intents"**
- Enable Message Content Intent and Server Members Intent on the bot's page in the Developer Portal.

**Bot exits with "unable to open database file"**
- `data/` is not writable by the container user. With the shipped image and compose file this is fixed at start; it can still happen when the container runs as a fixed user (`--user`, Kubernetes `runAsUser`) on a volume that user cannot write. See [Build & Start](#6-build--start).

**Slash commands are missing**
- Check the log for "Failed to deploy slash commands". The bot must be in the server named by `DISCORD_GUILD_ID` and invited with the `applications.commands` scope.

**"You are not authorised to use setup commands"**
- Add your Discord user ID to `ADMIN_USER_IDS` and restart. Discord roles do not count.

**Webhook answers 401 "Invalid signature"**
- The webhook's HMAC SHA1 token in Zammad differs from `ZAMMAD_WEBHOOK_SECRET`.

**Threads are not created or messages fail with "Missing Permissions"**
- Give the bot the permissions listed under [Create the Discord Bot](#1-create-the-discord-bot) in the tickets channel.

## Security Notes

- `/webhooks/zammad` accepts only requests signed with `ZAMMAD_WEBHOOK_SECRET` (HMAC-SHA1, as Zammad sends it). `/healthz` and `/readyz` are open; `/debug/*` exist only with `DEBUG_TOKEN`.
- Do not expose port 3100 to the internet. Zammad is the only client.
- Set `SETTINGS_ENCRYPTION_KEY` so API keys saved with `/setup` are not stored in plaintext, or inject the keys through the environment and save none.
- `/setup` is limited to `ADMIN_USER_IDS`; ticket commands to Discord users mapped to a Zammad agent. The bot acts in Zammad with an admin token, so treat the mapping as granting agent access.
- Ticket text relayed into Discord never pings anyone: mentions in it are not resolved.
