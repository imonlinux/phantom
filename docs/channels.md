# Channels

Phantom communicates through pluggable channel adapters. Each channel implements a standard interface, and the agent does not care where messages originate.

## Web Chat

A browser-based chat interface at `/chat`. No Slack required. This is the simplest way to talk to a Phantom - open the URL in a browser and start typing.

### Access

Navigate to `https://your-phantom-host/chat`. On first visit, you will be prompted to log in.

### Authentication

Cookie-based sessions with magic link login:

1. Enter your email address on the login page
2. Phantom sends a magic link via Resend (requires `RESEND_API_KEY` in `.env`)
3. Click the link to authenticate. The session cookie lasts 30 days.

On first run without Slack configured, Phantom sends a login email to `OWNER_EMAIL` automatically. If Resend is not configured, a bootstrap token is printed to stdout instead.

### Configuration

Set these in `.env`:

```
OWNER_EMAIL=you@example.com     # Required for email-based login
RESEND_API_KEY=re_...           # Required for magic link emails
```

No channel YAML configuration is needed. The chat channel is always available when the HTTP server is running.

### Features

- **SSE streaming** - responses stream token-by-token via Server-Sent Events
- **32-event wire format** - session lifecycle, text, thinking blocks, tool calls with input streaming, subagent progress
- **Multi-tab support** - open the same session in multiple tabs, all stay in sync
- **File attachments** - upload images (JPEG, PNG, GIF, WebP up to 10 MB), PDFs (up to 32 MB), and text/code files (up to 1 MB). Up to 10 files per message.
- **Web Push notifications** - get notified when the agent responds while the tab is in the background. Uses VAPID keys stored in SQLite.
- **Session management** - create, rename, archive, and delete sessions from the sidebar
- **Markdown rendering** - full markdown with code syntax highlighting, tables, and lists
- **Auto-rename** - sessions are automatically titled based on the first exchange

### Tech Stack

The chat client is a React 19 SPA built with Vite, shadcn/ui, and Tailwind v4. The production build lives at `public/chat/` and is served as static files. The Dockerfile includes a dedicated build stage for the chat client.

## Slack

Uses Socket Mode (no public URL required).

### Setup (App Manifest)

The fastest way to set up Slack. The included manifest configures all scopes, events, and bot settings in one step.

1. Go to [api.slack.com/apps](https://api.slack.com/apps) > **Create New App** > **From an app manifest**
2. Select your workspace, switch to the **YAML** tab
3. Paste the contents of [`slack-app-manifest.yaml`](../slack-app-manifest.yaml) from the repo root
4. Click **Create**
5. Click **Install to Workspace** and approve the permissions
6. Copy the **Bot Token** (`xoxb-`) from **OAuth & Permissions** in the sidebar
7. Go to **Basic Information** > **App-Level Tokens** > **Generate Token and Scopes**
8. Name it anything (e.g., "socket"), add the `connections:write` scope, click **Generate**
9. Copy the **App Token** (`xapp-`)
10. Get your **Channel ID**: in Slack, right-click the target channel > **View channel details** > scroll to the bottom

### Bot Token Scopes

All of these are configured by the manifest. If you are setting up manually, add them under **OAuth & Permissions** > **Bot Token Scopes**.

| Scope | Purpose |
|-------|---------|
| `app_mentions:read` | Hear @Phantom mentions in channels |
| `channels:history` | Read messages in public channels |
| `channels:read` | See public channel list |
| `chat:write` | Send messages and replies |
| `chat:write.public` | Post to public channels without being invited |
| `groups:history` | Read messages in private channels |
| `im:history` | Read direct messages |
| `im:read` | See DM list |
| `im:write` | Start DM conversations |
| `reactions:read` | Track feedback reactions (thumbs up/down) |
| `reactions:write` | Add status reactions (eyes, brain, checkmark) |

### App Token Scopes

Created under **Basic Information** > **App-Level Tokens**.

| Scope | Purpose |
|-------|---------|
| `connections:write` | Socket Mode WebSocket connection |

### Event Subscriptions

Configured by the manifest under **Event Subscriptions** > **Subscribe to bot events**:

| Event | Purpose |
|-------|---------|
| `app_mention` | When someone @mentions the bot in a channel |
| `message.channels` | Messages in public channels the bot is in |
| `message.groups` | Messages in private channels the bot is in |
| `message.im` | Direct messages to the bot |
| `reaction_added` | When someone reacts to a message |

### Configuration

In `config/channels.yaml`:

```yaml
slack:
  enabled: true
  bot_token: ${SLACK_BOT_TOKEN}
  app_token: ${SLACK_APP_TOKEN}
  default_channel_id: C04ABC123
```

Set the tokens as environment variables (in `.env.local` or your shell):

```bash
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_APP_TOKEN=xapp-...
export SLACK_CHANNEL_ID=C04ABC123
```

### Public vs. Private Channels

With the `chat:write.public` scope (included in the manifest), Phantom can post to any **public** channel by channel ID without being invited. You do NOT need to `/invite @Phantom` for public channels.

For **private** channels, the bot must be invited with `/invite @Phantom` before it can read or write messages.

### Features

- **Thread replies** - all responses are posted as thread replies to the original message
- **Status reactions** - emoji reactions cycle through processing states:
  - :eyes: (queued) -> :brain: (thinking) -> :wrench: (using tools) -> :white_check_mark: (done)
  - :computer: for code-related tools, :globe_with_meridians: for web tools
  - :warning: on errors, :hourglass_flowing_sand: / :exclamation: on stalls
- **Progressive message updates** - "Working on it..." messages update with tool activity in real time
- **Feedback buttons** - [Helpful] [Not helpful] [Could be better] after every response
- **Reaction feedback** - thumbsup/thumbsdown reactions feed into the evolution pipeline
- **Proactive intro** - on first start with `default_channel_id` set, Phantom introduces itself

## Telegram

Bot interface with two transport modes: **long-polling** (default) and **webhook** (optional, opt-in). No public URL required for long-polling mode.

### Transport Modes

**Long-polling (default):**
- Bot polls Telegram servers for updates
- Works behind NAT/firewalls
- No HTTPS certificate required
- Simplest setup for development/testing

**Webhook (optional):**
- Telegram pushes updates to your Phantom instance
- Requires public HTTPS URL with valid certificate
- More efficient for production deployments
- Lower latency than polling
- Reuses existing HTTP infrastructure

### Minimum Telegram Bot API Version Requirements

| Feature | Minimum Bot API Version | Notes |
|---------|------------------------|-------|
| Basic messaging | 5.0 | `/newbot` creates bots with API 7.0+ by default |
| Inline keyboards | 5.0 | `reply_markup` with inline keyboard support |
| Message editing | 5.0 | `editMessageText` API |
| setMessageReaction | 7.0 | Emoji reactions on bot messages |
| message_reaction updates | 7.0 | Event for receiving user reactions |
| Webhook transport | 5.0 | `setWebhook` API |

**Important:** Reaction feedback requires Bot API 7.0+. If your bot was created before this version, you may need to update it via BotFather.

### BotFather Setup

#### For Long-Polling Mode (Default)

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Create a new bot with `/newbot`
3. Save the bot token

#### For Webhook Mode

1. Follow the long-polling setup steps above
2. Your Phantom instance must have a public HTTPS URL with a valid SSL certificate
3. The webhook endpoint is `https://your-phantom-host/telegram/webhook`
4. See the webhook configuration section below for details

### Configuration (Long-Polling Mode)

```yaml
channels:
  telegram:
    enabled: true
    bot_token: ${TELEGRAM_BOT_TOKEN}
```

### Configuration (Webhook Mode)

```yaml
channels:
  telegram:
    enabled: true
    bot_token: ${TELEGRAM_BOT_TOKEN}
    webhook_url: https://phantom.example.com/telegram/webhook
    webhook_secret: ${TELEGRAM_WEBHOOK_SECRET}
    verify_webhook_source_ip: false  # Optional defense-in-depth
```

**Webhook configuration fields:**
- `webhook_url` - Your public HTTPS URL where Telegram will send updates
- `webhook_secret` - Optional token for verifying webhook requests are from Telegram
- `verify_webhook_source_ip` - Optional: verify requests come from Telegram's IP ranges (defense-in-depth)

**Set the webhook secret as an environment variable:**

```bash
# In .env
TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 32)
```

**Webhook endpoint requirements:**
- Public HTTPS URL with valid SSL certificate (self-signed certificates are NOT accepted by Telegram)
- Endpoint path: `/telegram/webhook` (hardcoded, not configurable)
- POST requests from Telegram servers
- Maximum request body: 64 KB (enforced by Phantom)

**Telegram webhook source IP ranges** (for `verify_webhook_source_ip: true`):
- `149.154.160.0/20`
- `91.108.4.0/22`

### Access Control

By default, Phantom's Telegram bot will respond to anyone who messages it.
For a personal bot, you almost certainly want to lock this down to just
yourself (and possibly a few trusted accounts).

To find your Telegram numeric user ID:

1. Send any message to [@userinfobot](https://t.me/userinfobot) on Telegram
2. It replies with a card showing your `Id:` field — that's the number you want

**Use the numeric ID, not your @username.** The `@username` is mutable and
changes when you change your handle; the numeric ID is permanent. You can add
additional Telegram users IDs to allow them access to your bot.

Then add it to your .env file:

```bash
# ========================
# OPTIONAL: Telegram
# ========================
TELEGRAM_BOT_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_OWNER_USER_ID=xxxxxxxxxxx
TELEGRAM_OWNER_USER_ID2=
TELEGRAM_OWNER_USER_ID3=
TELEGRAM_WEBHOOK_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Then update the config/channels.yaml file accordingly:

```yaml
channels:
  telegram:
    enabled: true
    bot_token: ${TELEGRAM_BOT_TOKEN}
    owner_user_ids:
      - "${TELEGRAM_OWNER_USER_ID}"
      - "${TELEGRAM_OWNER_USER_ID2}"   # Additional owner
    # send_intro: true  # Optional: send welcome message on first startup
    # rejection_reply: "Custom message"  # Optional: override default rejection message
    # enable_message_reactions: true  # Optional: enable reaction feedback in groups
    # webhook_url: https://phantom.example.com/telegram/webhook  # Optional: webhook mode
    # webhook_secret: ${TELEGRAM_WEBHOOK_SECRET}
    # verify_webhook_source_ip: false  # Optional: verify webhook source IP
```

**Configuration fields:**
- `bot_token` - Bot token from BotFather (required)
- `owner_user_ids` - Array of numeric Telegram user IDs authorized to interact with the bot
- `send_intro` - Send welcome message on first startup (default: false)
- `rejection_reply` - Custom rejection message for non-owners in DMs
- `enable_message_reactions` - Enable emoji reaction feedback in groups (default: false)
- `webhook_url` - Public HTTPS URL for webhook mode (optional)
- `webhook_secret` - Secret token for webhook verification (required with webhook_url)
- `verify_webhook_source_ip` - Verify requests come from Telegram IPs (default: false)

**Behavior with access control enabled:**

- **Owners in 1:1 DMs:** full access, normal interaction
- **Owners in groups:** full access (they're trusted regardless of room)
- **Non-owners in 1:1 DMs:** receive one rejection reply explaining
  Phantom is a personal bot, then silently dropped on subsequent messages
- **Non-owners in groups:** silently ignored, no rejection reply (avoiding
  noise for other group members)

If you put the wrong number in the config, every message will be silently
rejected (DMs) or silently ignored (groups). Phantom will not crash or
lock you out — fix the YAML and restart. There's no lockable state.

The startup log confirms which mode you're in:

```
[telegram] Access control active: 1 owner ID(s) configured
```

or

```
[telegram] No access control configured — all users can interact with the bot
```

### Proactive Intro Message

When you first set up Phantom on Telegram, you may want it to send you a welcome message to confirm it's connected and listening. Enable `send_intro` to send a welcome message to the first owner in `owner_user_ids`:

```yaml
channels:
  telegram:
    enabled: true
    bot_token: ${TELEGRAM_BOT_TOKEN}
    owner_user_ids: ["123456789"]  # Your Telegram user ID
    send_intro: true  # Enable proactive intro
```

On first startup, Phantom will send you this DM:

> "Hi, I'm Phantom. I'm now connected and listening here. Send /help to see what I can do."

The intro is only sent once per channel - tracked in the database to avoid re-sending on restart. If `send_intro` is false (default) or `owner_user_ids` is empty, no intro message is sent (silent startup).

### Features

**Core capabilities:**
- Inline keyboard buttons (feedback, actions)
- Persistent typing indicator (re-fires every 4s to stay active)
- Message editing for progressive updates
- MarkdownV2 formatting with code block preservation
- Message splitting for long messages (>4096 chars)
- Commands: `/start`, `/status`, `/help`

**Status reactions (Telegram emoji substitutes):**
- 👀 (eyes) - Queued
- 🤔 (thinking) - Processing (substitute for 🧠)
- 👨‍💻 (coder) - Using code tools
- 👌 (OK) - Done (substitute for ✅)
- 😱 (scream) - Error (substitute for ⚠️)
- 🥱 (yawning face) - Soft stall
- 🏁 (chequered flag) - Hard stall

**Note:** Telegram has a limited emoji allowlist (~70 emoji). The substitutes above provide the best experience within Telegram's constraints.

### Progressive Updates & Tool Activity

Phantom provides real-time progress updates during tool execution:

1. **"Working on it..."** - Initial response when starting tool use
2. **Live updates** - Each tool activity updates the message
3. **Final response** - Complete answer replaces the working message

Updates happen via message editing, so you see one evolving message instead of multiple messages.

### Feedback Collection

Phantom collects feedback in two ways:

**Inline keyboard buttons (works everywhere):**
- [👍 Helpful] [👎 Not helpful] [🤔 Could be better]
- Appears under each response
- Works in 1:1 DMs and groups
- Primary feedback mechanism

**Reaction-based feedback (groups only, opt-in):**

Phantom can collect feedback signals from emoji reactions to its messages
(👍 / ❤ / 🔥 → positive, 👎 → negative). This feature is **only available
in shared groups where the bot has been promoted to administrator**.

**DM vs Group Constraint:**

It does not work in 1:1 DMs. Telegram requires the bot to be a chat
admin to deliver `message_reaction` updates, and 1:1 DMs have no admin
role. There is no workaround. For DMs, use the inline-keyboard feedback
buttons under each response.

To enable in groups:

```yaml
channels:
  telegram:
    enabled: true
    bot_token: ${TELEGRAM_BOT_TOKEN}
    enable_message_reactions: true
```

Then, in the Telegram group:

1. Add the bot to the group
2. Promote the bot to administrator (any admin permissions are sufficient)
3. Restart Phantom

You'll see this on startup:

```
[telegram] Reaction-as-feedback enabled; bot must be admin in groups
to receive reaction events. Has no effect in 1:1 DMs.
```

After restart, reactions on the bot's messages flow as feedback signals
through the same evolution engine that processes Slack reaction feedback.

### Security Features (Webhook Mode)

When webhook mode is enabled, Phantom implements multiple security layers:

**1. Secret token verification:**
- Shared secret configured via `webhook_secret`
- Verified via `X-Telegram-Bot-Api-Secret-Token` header
- 401 Unauthorized on mismatch

**2. Update deduplication:**
- LRU cache for `update_id` (1000 entries, 5 minute TTL)
- Prevents replay attacks from duplicate webhook deliveries
- Same proven pattern as NextCloud's nonce cache

**3. Body size limit:**
- 64 KB maximum request body size
- Checked via `Content-Length` header before parsing
- 413 Payload Too Large on exceeded

**4. Source IP verification (optional):**
- Checks requests come from Telegram's published IP ranges
- Defense-in-depth (secret_token is the primary security mechanism)
- Enabled via `verify_webhook_source_ip: true`

### Error Handling & Retry

**Transient error handling (all modes):**
- 429 Too Many Requests: respects `retry_after` header
- 5xx server errors: exponential backoff (1s → 2s → 4s → 8s)
- Maximum 3 retry attempts
- Logs retry attempts with context

**Circuit breaker (reactions):**
- Per-chat circuit breaker for reaction errors
- 400 REACTION_INVALID disables reactions for that chat (rest of session)
- Prevents repeated failures on unsupported clients
- Logged once per chat when disabled

### Webhook vs Long-Polling Mode Tradeoffs

**Long-polling (default):**
- ✅ No public URL required
- ✅ Works behind NAT/firewalls
- ✅ Simpler setup
- ✅ No SSL certificate needed
- ❌ Uses long-polling slot (can have contention issues)
- ❌ Health check polling required

**Webhook (optional):**
- ✅ No long-polling slot contention
- ✅ Faster update delivery (push vs pull)
- ✅ No health check needed (push-based)
- ✅ More efficient for production
- ❌ Requires public HTTPS URL
- ❌ Requires valid SSL certificate
- ❌ More complex setup

Choose long-polling for development/testing. Choose webhook for production deployments that already have a public HTTPS URL.

### Commands

Available bot commands (send in Telegram):

- `/start` - Introduction to Phantom
- `/status` - Connection status and capabilities
- `/help` - List available commands

### Troubleshooting

**Bot not receiving messages (long-polling):**
- Check bot token is correct in `.env`
- Verify `enabled: true` in `channels.yaml`
- Check Phantom logs for connection errors
- Try restarting Phantom

**Bot not receiving messages (webhook):**
- Verify webhook URL is publicly accessible
- Check SSL certificate is valid (not self-signed)
- Verify webhook_secret matches between Phantom and Telegram
- Check firewall allows incoming POST to `/telegram/webhook`
- Check Phantom logs for webhook errors

**Reactions not working:**
- Verify bot is admin in the group (required for message_reaction events)
- Check `enable_message_reactions: true` in config
- Restart Phantom after enabling
- Does not work in 1:1 DMs (Telegram limitation)

**Rate limiting (429 errors):**
- Phantom implements retry with `retry_after` respect
- If frequent, consider spacing out requests
- Check for other bots using same API token

**"Bot responds to itself" loop:**
- Verify TELEGRAM_BOT_ID is configured in Phantom (webhook mode only)
- Check logs for self-filtering: "[telegram] Ignoring message from self"
- Bot ID is shown in Nextcloud setup output

**Webhook mode not activating:**
- Verify `webhook_url` is set in config
- Check Phantom logs for webhook registration confirmation
- Verify secret token matches between config and Telegram
- Check that previous webhook was deleted (Telegram doesn't allow both)

**Long-polling slot contention:**
- If process was killed uncleanly, slot may be held for ~90 seconds
- Wait for timeout or use webhook mode instead
- Multiple Phantom instances will contend for the same slot

## Email

IMAP/SMTP with push notifications via IDLE.

### Setup

Use any email provider that supports IMAP and SMTP. Gmail, Fastmail, and custom mail servers work.

### Configuration

```yaml
email:
  enabled: true
  imap:
    host: imap.gmail.com
    port: 993
    user: phantom@example.com
    pass: ${EMAIL_PASSWORD}
    tls: true
  smtp:
    host: smtp.gmail.com
    port: 587
    user: phantom@example.com
    pass: ${EMAIL_PASSWORD}
    tls: false
  from_address: phantom@example.com
  from_name: Phantom
```

### Features

- IMAP IDLE for push notifications on new emails
- HTML email responses with clean formatting
- Email threading via In-Reply-To and References headers
- Auto-reply detection (out of office, delivery notifications)
- Code block formatting with monospace font

## Webhook

Generic HTTP endpoint for programmatic integration.

### Configuration

```yaml
webhook:
  enabled: true
  secret: ${WEBHOOK_SECRET}
  sync_timeout_ms: 25000
```

### Usage

```bash
# Synchronous (wait for response)
curl -X POST https://your-phantom/webhook \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: sha256=..." \
  -H "X-Webhook-Timestamp: 1711375200" \
  -d '{"text": "What is the status of the deploy?", "sender_id": "ci-bot"}'

# Asynchronous (immediate 202, callback later)
curl -X POST https://your-phantom/webhook \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: sha256=..." \
  -d '{"text": "Run the test suite", "sender_id": "ci-bot", "callback_url": "https://my-server/callback"}'
```

HMAC-SHA256 signature verification with timing-safe comparison. 5-minute timestamp freshness window.

## CLI

Local terminal interface for development. Auto-enabled when no Slack or Telegram is configured.

```bash
bun run phantom start
# Type messages directly in the terminal
```

## Channel Interface

All channels implement the same interface:

```typescript
interface Channel {
  id: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(conversationId: string, message: OutboundMessage): Promise<void>;
  onMessage(handler: MessageHandler): void;
  isConnected(): boolean;
}
```

Adding a new channel means implementing this interface and registering it with the channel router.
