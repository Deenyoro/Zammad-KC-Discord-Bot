# Zammad Discord Bot

Bridges Zammad helpdesk tickets to Discord threads with bidirectional message sync, slash commands, file attachments, and automatic ticket lifecycle management.

## Features

- **Automatic thread creation** — every open Zammad ticket gets a Discord thread with a color-coded embed
- **Real-time sync** — Zammad webhooks push new articles, state changes, and title updates to Discord instantly
- **Bidirectional messaging** — Discord thread messages become Zammad internal notes; Zammad articles appear in Discord
- **Full attachment support** — images, documents, and files sync in both directions (base64-encoded through the Zammad API)
- **Multi-channel replies** — `/reply` detects whether a ticket is email, SMS (RingCentral), or Teams and sends via the correct channel
- **Slash commands** — close, assign, change state/priority, log time, add notes, reply to customers, set owner
- **Shorthand commands** — `/reply`, `/note`, and `/owner` work directly without the `/ticket` prefix
- **Role-based membership** — users with a configured Discord role are auto-added to every open ticket thread
- **Thread lifecycle** — threads lock/archive on close, unlock/unarchive on reopen, rename on title change
- **Health monitoring** — bot goes busy (red) and sends `@everyone` alert if Zammad becomes unreachable; recovers automatically
- **Sequential article ordering** — articles are always posted to Discord in chronological order regardless of webhook arrival order
- **Deduplication** — webhook delivery dedup, article sync dedup, and per-ticket serial queues prevent duplicates and race conditions

## Prerequisites

- Docker and Docker Compose (or Kubernetes)
- A running Zammad instance accessible over the network
- A Discord bot application ([discord.com/developers](https://discord.com/developers/applications))

## Quick Start

### 1. Create the Discord Bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. **New Application** → name it → go to the **Bot** tab
3. Copy the **Bot Token** → this is your `DISCORD_TOKEN`
4. Enable **Message Content Intent** and **Server Members Intent**
5. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`, permissions: Send Messages, Create Public Threads, Send Messages in Threads, Manage Threads, Embed Links, Attach Files, Read Message History
6. Open the generated URL to invite the bot to your server

### 2. Get Discord IDs

Enable Developer Mode (User Settings → Advanced → Developer Mode):

- **Guild ID**: right-click server name → Copy Server ID
- **Channel ID**: right-click the channel for ticket threads → Copy Channel ID
- **Role ID** (optional): right-click the role to auto-add to threads → Copy Role ID

### 3. Configure

```bash
cp .env.example .env
```

```env
# Discord
DISCORD_TOKEN=<bot token>
DISCORD_CLIENT_ID=<application ID>
DISCORD_GUILD_ID=<server ID>
DISCORD_TICKETS_CHANNEL_ID=<channel ID>
DISCORD_TICKET_ROLE_ID=<role ID>           # optional

# Zammad
ZAMMAD_BASE_URL=http://zammad-nginx:8080   # internal Docker/K8s URL
ZAMMAD_PUBLIC_URL=https://support.example.com
ZAMMAD_API_TOKEN=<token with admin + ticket.agent>
ZAMMAD_WEBHOOK_SECRET=<random secret>

# Server
PORT=3100
LOG_LEVEL=info
```

### 4. Create the Zammad API Token

Admin → System → API → **New Token**:
- Permissions: `admin`, `ticket.agent`

### 5. Create the Zammad Webhook + Triggers

**Webhook** (Admin → Manage → Webhooks → New):
- Endpoint: `http://zammad-discord-bot:3100/webhooks/zammad`
- HMAC SHA1 Token: same as `ZAMMAD_WEBHOOK_SECRET`
- SSL Verify: No (internal network)

**Triggers** (Admin → Manage → Triggers):
- "Discord: New Tickets" — Condition: Action is **created** → Execute: Webhook
- "Discord: Ticket Updates" — Condition: Action is **updated** → Execute: Webhook

### 6. Deploy Slash Commands

Run once to register commands with Discord (guild commands are instant):

```bash
docker run --rm --env-file .env zammad-discord-bot node dist/commands/deploy.js
```

### 7. Start

```bash
docker compose up -d
docker logs -f zammad-discord-bot
```

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
# Copy and fill in the secret
cp k8s/secret.example.yaml k8s/secret.yaml
# Edit k8s/secret.yaml with your values

kubectl apply -f k8s/secret.yaml
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
```

- The Zammad webhook endpoint becomes `http://zammad-discord-bot.<namespace>.svc.cluster.local:3100/webhooks/zammad`
- `ZAMMAD_BASE_URL` should be the internal K8s service URL for Zammad
- SQLite data is persisted on a 1Gi PVC mounted at `/app/data`
- Liveness probe: `GET /healthz` (process alive)
- Readiness probe: `GET /readyz` (Zammad reachable)
- Deployment uses `Recreate` strategy since SQLite only supports one writer

## Commands

### Quick Commands (use inside a ticket thread)

| Command | Description |
|---------|-------------|
| `/reply <text> [file]` | Reply to the customer (auto-detects email/SMS/Teams) |
| `/note <text> [file]` | Add an internal note |
| `/owner [user]` | Set ticket owner (defaults to yourself) |

### Ticket Commands (use inside a ticket thread)

| Command | Description |
|---------|-------------|
| `/ticket info` | Show ticket details |
| `/ticket link` | Get Zammad ticket URL |
| `/ticket reply <text> [file]` | Reply to the customer |
| `/ticket note <text> [file]` | Add an internal note |
| `/ticket close` | Close the ticket |
| `/ticket state <name>` | Change state |
| `/ticket assign <user>` | Assign to a Discord user |
| `/ticket priority <level>` | Change priority (1 low, 2 normal, 3 high) |
| `/ticket time <minutes>` | Log time accounting |

### Admin Commands

| Command | Description |
|---------|-------------|
| `/setup usermap <user> <email>` | Map a Discord user to a Zammad agent |
| `/help` | Show all commands |

### Thread Messages

Any message typed in a ticket thread is automatically forwarded to Zammad as an internal note (with attachments). Use `/reply` to send an external reply to the customer.

## Architecture

```
Discord ←──WebSocket──→ Bot ←──HTTP POST──→ Zammad (webhooks)
                         │
                         ├──REST API──→ Zammad (tickets, articles, users)
                         │
                         └──SQLite──→ data/bot.db (mappings, dedup)
```

| Component | Purpose |
|-----------|---------|
| **Fastify** | Webhook receiver with HMAC SHA1 signature verification |
| **discord.js v14** | Gateway connection, threads, embeds, slash commands |
| **better-sqlite3** | Ticket↔thread mappings, article sync dedup, webhook dedup |
| **p-queue** | Per-ticket serial queues + global Discord rate limiter |
| **Zod** | Environment variable validation |
| **Pino** | Structured JSON logging (pretty-printed in dev) |

## Health Monitoring

The bot checks Zammad connectivity every 30 seconds:

- **3 consecutive failures** → bot status changes to **busy** (red), sends `@everyone` alert in the tickets channel
- **Recovery** → bot status returns to **online** (green), sends recovery notice
- `GET /healthz` — liveness probe (always 200 if process is up)
- `GET /readyz` — readiness probe (503 if Zammad is unreachable)

## License

MIT
