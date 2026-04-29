# Telegram Bot Setup Guide

This guide explains how to create and configure a Telegram bot for Phantom integration.

## Prerequisites

- Telegram account (you'll need to chat with BotFather)
- Phantom instance with public URL (required for webhook mode)
- Basic familiarity with Telegram commands

## Step 1: Create Your Bot with BotFather

BotFather is the official Telegram bot for creating and managing bots.

### Starting the Conversation

1. Open Telegram and search for `@BotFather`
2. Send the command `/start` to begin
3. BotFather will respond with a list of commands

### Creating a New Bot

1. Send `/newbot` to BotFather
2. Choose a display name for your bot (e.g., "Phantom Assistant")
3. Choose a username for your bot (must end in 'bot', e.g., "phantom_assistant_bot")

**Example conversation:**
```
You: /newbot
BotFather: Alright, a new bot. How are we going to call it? Please choose a name for your bot.

You: Phantom Assistant

BotFather: Good. Now let's choose a username for your bot. It must end in `bot`. Like this, for example: TetrisBot or tetris_bot.

You: phantom_assistant_bot

BotFather: Done! Congratulations on your new bot. You will find it at t.me/phantom_assistant_bot. You can now add a description, about section and profile picture for your bot, see /help for a list of commands.

Use this token to access the HTTP API:
123456789:ABCdefGHIjklMNOpqrsTUVwxyz

Keep your token secure and store it safely, it can be used by anyone to control your bot.
```

**Save the bot token** - you'll need it for Phantom configuration.

### Step 2: Get Your Owner ID

Phantom needs to know your Telegram user ID to enforce owner-only access control.

### Finding Your User ID

1. Send `/start` to your new bot (search for the username you chose, e.g., @phantom_assistant_bot)
2. Send any message to the bot (e.g., "hello")
3. Check Phantom logs when it receives the message:

```bash
# Docker
docker logs phantom --tail 100 | grep "Actor ID"

# Look for output like:
# [telegram] Message from actorId: 123456789
```

The `actorId` is your Telegram user ID. **Save this ID** - you'll need it for configuration.

**Alternative method using userinfobot:**
1. Open Telegram and search for `@userinfobot`
2. Send `/start` to the bot
3. It will reply with your user ID: `Id: 123456789`

### Step 3: Configure Phantom

Choose your transport mode (long-polling or webhook) and configure accordingly.

## Transport Modes

Telegram bots can receive updates in two ways:

| Mode | Description | Pros | Cons | Best For |
|------|-------------|------|------|----------|
| **Long-polling** | Phantom actively polls Telegram for updates | No public URL needed, simpler setup | Higher latency, more API calls | Development, private networks |
| **Webhook** | Telegram pushes updates to Phantom | Lower latency, fewer API calls, scales better | Requires public URL, SSL certificate | Production, high-traffic bots |

## Option A: Long-Polling Mode (Default)

Long-polling is the simplest mode and works without a public URL.

### Configure Phantom

**Using environment variables (`.env`):**

```bash
TELEGRAM_BOT_TOKEN="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
TELEGRAM_OWNER_USER_IDS="123456789"
TELEGRAM_ENABLE_MESSAGE_REACTIONS="true"
TELEGRAM_SEND_INTRO="true"
```

**Using `config/channels.yaml`:**

```yaml
channels:
  telegram:
    enabled: true
    bot_token: "123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
    owner_user_ids:
      - 123456789
    enable_message_reactions: true
    send_intro: true
```

**Configuration fields:**
- `bot_token` - Bot token from BotFather
- `owner_user_ids` - List of Telegram user IDs allowed to interact with the bot
- `enable_message_reactions` - Enable emoji status updates (default: false)
- `send_intro` - Send proactive introduction message (default: false)
- `session_window_minutes` - Time window for session coalescing (default: 30)

### Restart Phantom

```bash
# Docker
docker compose restart phantom

# Systemd
sudo systemctl restart phantom

# Manual
bun run src/index.ts
```

### Test the Integration

1. **Send a message to your bot:**
   - Open Telegram and search for your bot's username
   - Send a message like `@phantom hello`

2. **Verify Phantom receives messages:**
   ```bash
   docker logs phantom --tail 100 -f
   # Look for: "[telegram] Received message from owner: hello"
   ```

3. **Verify bot responses:**
   - The bot should respond in the chat

## Option B: Webhook Mode (Recommended for Production)

Webhook mode provides lower latency and better scalability but requires a public URL.

### Step 1: Generate a Webhook Secret

Generate a secure random string for webhook verification:

```bash
openssl rand -hex 32
```

Save this secret - you'll need it for configuration.

### Step 2: Configure Phantom with Webhook

**Using environment variables (`.env`):**

```bash
TELEGRAM_BOT_TOKEN="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
TELEGRAM_WEBHOOK_URL="https://phantom.example.com/telegram/webhook"
TELEGRAM_WEBHOOK_SECRET="your_generated_secret_here"
TELEGRAM_OWNER_USER_IDS="123456789"
TELEGRAM_ENABLE_MESSAGE_REACTIONS="true"
TELEGRAM_SEND_INTRO="true"
```

**Using `config/channels.yaml`:**

```yaml
channels:
  telegram:
    enabled: true
    bot_token: "123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
    webhook_url: "https://phantom.example.com/telegram/webhook"
    webhook_secret: "your_generated_secret_here"
    verify_webhook_source_ip: false
    owner_user_ids:
      - 123456789
    enable_message_reactions: true
    send_intro: true
```

**Additional webhook configuration fields:**
- `webhook_url` - Public HTTPS URL where Phantom receives webhooks
- `webhook_secret` - Random secret for HMAC verification (optional but recommended)
- `verify_webhook_source_ip` - Verify requests come from Telegram IPs (default: false)

### Step 3: Configure SSL/TLS

Telegram requires webhook URLs to use HTTPS with valid SSL certificates.

**Using Caddy (recommended):**

```json
{
  "apps": {
    "http": {
      "servers": {
        "srv0": {
          "listen": [":443"],
          "routes": [
            {
              "handle": [
                {
                  "handler": "reverse_proxy",
                  "upstreams": [
                    {"dial": "localhost:3200"}
                  ]
                }
              ]
            }
          ],
          "tls_connection_policies": [
            {
              "match": {"sni": ["phantom.example.com"]},
              "certificate_selection": {
                "any_tag": ["cert"]
              }
            }
          ]
        }
      }
    }
  },
  "pki": {
    "certificates": {
      "install_tls": true,
      "automation": {
        "policies": [
          {
            "subjects": ["phantom.example.com"],
            "issuers": [{"module": "acme"}],
            "challenges": {"http": {"port": 80}}
          ]
        }
      }
    }
  }
}
```

Caddy will automatically obtain and renew Let's Encrypt certificates.

### Step 4: Restart Phantom

```bash
# Docker
docker compose restart phantom

# Systemd
sudo systemctl restart phantom

# Manual
bun run src/index.ts
```

When Phantom starts in webhook mode, it automatically registers the webhook with Telegram using `setWebhook()`.

### Step 5: Test the Webhook Integration

1. **Verify webhook registration:**
   ```bash
   # Check Phantom logs
   docker logs phantom --tail 100 | grep webhook
   # Should see: "[telegram] Webhook registered: https://phantom.example.com/telegram/webhook"
   ```

2. **Test webhook connectivity:**
   - Send a message to your bot in Telegram
   - Check Phantom logs for incoming messages
   ```bash
   docker logs phantom --tail 100 -f
   # Look for: "[telegram] Received webhook update"
   ```

3. **Verify webhook secret verification (if configured):**
   - Check logs for HMAC verification messages
   ```bash
   docker logs phantom --tail 100 | grep "HMAC"
   ```

## Switching Between Modes

You can switch between long-polling and webhook modes by updating the configuration:

### From Long-polling to Webhook

1. Add `webhook_url` and `webhook_secret` to configuration
2. Restart Phantom
3. Phantom will automatically call `setWebhook()` to register with Telegram

### From Webhook to Long-polling

1. Remove `webhook_url` from configuration
2. Restart Phantom
3. Phantom will automatically call `deleteWebhook()` to unregister

## Troubleshooting

### Bot not receiving messages

**1. Verify bot token is correct:**
```bash
# Test bot token manually
curl "https://api.telegram.org/bot123456789:ABCdefGHIjklMNOpqrsTUVwxyz/getMe"

# Expected response:
# {"ok":true,"result":{"id":123456789,"is_bot":true,"first_name":"Phantom Assistant","username":"phantom_assistant_bot"}}
```

**2. Check bot is running:**
```bash
docker logs phantom --tail 100 | grep telegram
# Look for: "[telegram] Bot started as @bot_username"
```

**3. Verify owner ID configuration:**
```bash
# Check logs for rejected messages from non-owners
docker logs phantom --tail 100 | grep "not in owner list"

# If you see this, add your user ID to owner_user_ids
```

**4. Test webhook connectivity (webhook mode):**
```bash
# Check webhook is registered
curl "https://api.telegram.org/botTOKEN/getWebhookInfo"

# Expected response should include your webhook_url
# {"ok":true,"result":{"url":"https://phantom.example.com/telegram/webhook",...}}
```

### Bot responds to itself

If you see the bot in a loop responding to its own messages:

**1. Verify bot is filtering self-messages:**
```bash
docker logs phantom --tail 100 | grep "Ignoring message from bot"
# Should see this when bot receives its own messages
```

**2. Check for actorType filtering:**
```bash
# Telegram marks bot messages with from.is_bot === true
# Phantom should filter these out
docker logs phantom --tail 100 | grep "is_bot"
```

**3. Verify no duplicate message handlers:**
- Check that you don't have multiple Phantom instances running
- Each instance will create the same bot and cause duplicate handling

### Bot doesn't react to messages

**1. Verify message reactions are enabled:**
```bash
# Check .env or channels.yaml
grep TELEGRAM_ENABLE_MESSAGE_REACTIONS .env
# Should be: TELEGRAM_ENABLE_MESSAGE_REACTIONS="true"

# or check channels.yaml
grep enable_message_reactions config/channels.yaml
# Should be: enable_message_reactions: true
```

**2. Check Bot API version:**
- Telegram requires Bot API 6.2+ for message reactions
- Verify your bot token supports this feature
- Test manually: `curl "https://api.telegram.org/botTOKEN/getMe"`

**3. Check for reaction errors:**
```bash
docker logs phantom --tail 100 | grep "setMessageReaction"
# Look for error codes like 400 REACTION_INVALID
```

**4. Verify emoji allowlist:**
Telegram has a limited emoji allowlist for reactions. If you see `400 REACTION_INVALID`:
- Check that you're using allowed emoji (🤔, 👌, 😱, 👀, 🥱, 🨄)
- See docs/channels.md for the complete allowlist

### Bot is rate limited

**1. Check for rate limit errors:**
```bash
docker logs phantom --tail 100 | grep "429"
# Telegram returns 429 Too Many Requests when rate limited
```

**2. Verify backoff logic:**
```bash
# Phantom implements exponential backoff: 1s → 2s → 4s → 8s
# Check logs for retry messages
docker logs phantom --tail 100 | grep "retry"
```

**3. Reduce reaction frequency:**
- Message reactions have ~1/sec rate limit
- Phantom debounces reactions to 1100ms intervals
- If still rate limited, reactions may be disabled temporarily

**4. Check for high-traffic scenarios:**
- Webhook mode handles high traffic better than long-polling
- Consider switching to webhook mode if frequently rate limited

### Webhook verification failures

**1. Check webhook secret matches:**
```bash
# The secret in Phantom config must match the secret used in setWebhook()
grep TELEGRAM_WEBHOOK_SECRET .env
# or
grep webhook_secret config/channels.yaml
```

**2. Verify Telegram is sending the secret:**
- Telegram sends the secret in `X-Telegram-Bot-Api-Secret-Token` header
- Phantom validates this header on every webhook request
- Check logs for HMAC verification messages

**3. Test webhook without secret (development only):**
```bash
# Remove webhook_secret from config to disable verification
# Restart Phantom
# Test again
```

### Webhook not receiving updates

**1. Verify webhook URL is accessible:**
```bash
# Test from outside your network
curl -X POST https://phantom.example.com/telegram/webhook \
  -H "Content-Type: application/json" \
  -d '{"update_id":123,"message":{"text":"test"}}'

# Should return: {"status":"ok"} or 401/403 if security checks fail
```

**2. Check firewall rules:**
```bash
# Ensure port 443 (HTTPS) is open
sudo ufw status
# Should allow: 443/tcp

# Or with firewalld
sudo firewall-cmd --list-all
```

**3. Verify SSL certificate:**
```bash
# Check certificate is valid
curl -vI https://phantom.example.com/telegram/webhook
# Look for: "subject: CN=phantom.example.com" and "issuer: C=US; O=Let's Encrypt"
```

**4. Check webhook registration:**
```bash
curl "https://api.telegram.org/botTOKEN/getWebhookInfo"
# Verify url matches your Phantom webhook URL
# Verify last_error_date is 0 (no errors)
```

### Source IP verification issues

**1. Verify IP ranges:**
Telegram webhooks come from these IP ranges:
- `149.154.160.0/20`
- `91.108.4.0/22`

**2. Check X-Forwarded-For header:**
```bash
# If behind reverse proxy, ensure it forwards the real IP
# Phantom checks the X-Forwarded-For header
docker logs phantom --tail 100 | grep "webhook from"
```

**3. Disable IP verification (if needed):**
```yaml
channels:
  telegram:
    verify_webhook_source_ip: false  # Default: false
```

### Bot API version issues

**1. Check minimum version requirements:**
- Bot API 5.2+ for reactions
- Bot API 6.2+ for message reactions
- Bot API 7.0+ for webhooks with secret token

**2. Test your bot's API version:**
```bash
curl "https://api.telegram.org/botTOKEN/getMe"
# Check response includes all required fields
```

**3. Update bot token (if needed):**
- If using an old bot token, create a new bot via BotFather
- New tokens support the latest Bot API features

## Security Best Practices

### 1. Protect Your Bot Token

```bash
# Never commit bot tokens to git
echo "*.env" >> .gitignore
echo "config/channels.yaml" >> .gitignore

# Use environment variables in production
export TELEGRAM_BOT_TOKEN="your_token"
```

### 2. Use Strong Webhook Secrets

```bash
# Always generate secrets with openssl
openssl rand -hex 32

# Never use predictable or weak secrets
# Bad: "secret123", "webhook_token", "telegram_secret"
```

### 3. Enable Owner Access Control

```yaml
channels:
  telegram:
    owner_user_ids:
      - 123456789  # Only this user can interact
```

### 4. Use HTTPS for Webhooks

- Never use HTTP for webhook URLs
- Use valid SSL certificates (Let's Encrypt is free)
- Configure automatic certificate renewal

### 5. Monitor Bot Activity

```bash
# Check logs regularly for suspicious activity
docker logs phantom --tail 1000 | grep "telegram"

# Look for:
# - Messages from unknown user IDs
# - High frequency of requests from same IP
# - Rejected owner access attempts
```

### 6. Rotate Secrets Periodically

```bash
# Generate new webhook secret
NEW_SECRET=$(openssl rand -hex 32)

# Update Phantom config
# Telegram will automatically use the new secret on next webhook
```

### 7. Limit Bot Permissions

- Only enable features you need: `enable_message_reactions: false` if not needed
- Use `send_intro: false` for bots that don't need proactive messaging
- Restrict owner IDs to trusted users only

## Advanced Configuration

### Message Reactions

Phantom uses emoji reactions to show bot status:

| Emoji | Status | Description |
|-------|--------|-------------|
| 👀 | Queued | Message received, waiting to process |
| 🤔 | Thinking | Agent is processing the request |
| 👨‍💻 | Tool | Agent is using tools |
| 👌 | Done | Request completed successfully |
| 😱 | Error | An error occurred |
| 🥱 | Stall (soft) | Temporary slowdown, retrying |
| 🨄 | Stall (hard) | Permanent failure, giving up |

**Note:** Telegram has a limited emoji allowlist. Phantom uses substitutions that work within Telegram's constraints.

### Session Coalescing

Phantom groups messages within a time window into a single conversation session:

```yaml
channels:
  telegram:
    session_window_minutes: 30  # Default: 30 minutes
```

This improves context awareness for multi-turn interactions.

### Custom Rejection Reply

Customize the message sent to non-owners:

```yaml
channels:
  telegram:
    rejection_reply: "Sorry, this bot is only available to authorized users."
```

### Proactive Introduction

Send a welcome message to owners when the bot starts:

```yaml
channels:
  telegram:
    send_intro: true
```

The intro message explains the bot's capabilities and how to interact with it.

## Telegram Bot API Reference

### Webhook Management

**Set webhook:**
```bash
curl "https://api.telegram.org/botTOKEN/setWebhook" \
  -d "url=https://phantom.example.com/telegram/webhook" \
  -d "secret_token=your_secret"
```

**Get webhook info:**
```bash
curl "https://api.telegram.org/botTOKEN/getWebhookInfo"
```

**Delete webhook:**
```bash
curl "https://api.telegram.org/botTOKEN/deleteWebhook"
```

### Manual Testing

**Send a message:**
```bash
curl "https://api.telegram.org/botTOKEN/sendMessage" \
  -d "chat_id=123456789" \
  -d "text=Hello from Phantom!"
```

**Set a reaction:**
```bash
curl "https://api.telegram.org/botTOKEN/setMessageReaction" \
  -d "chat_id=123456789" \
  -d "message_id=42" \
  -d "reaction=[{\"type\":\"emoji\",\"emoji\":\"🤔\"}]"
```

**Get bot info:**
```bash
curl "https://api.telegram.org/botTOKEN/getMe"
```

## Additional Resources

- [Telegram Bot API Documentation](https://core.telegram.org/bots/api)
- [Telegraf Framework Documentation](https://telegraf.js.org/)
- [BotFather Commands](https://core.telegram.org/bots#botfather)
- [Phantom Channel Configuration](channels.md)
- [Phantom Security Guide](security.md)
- [Phantom Troubleshooting](getting-started.md#troubleshooting)
