# Nextcloud Talk Bot Setup Guide

This guide explains how to install and configure a Nextcloud Talk bot for Phantom integration.

## Prerequisites

- Nextcloud server with Talk app installed and enabled
- SSH access to your Nextcloud server (for running `occ` commands)
- Phantom instance with public HTTPS URL (e.g., `https://phantom.example.com`)

## Step 1: Generate a Shared Secret

Generate a secure random string for the webhook HMAC signature verification:

```bash
openssl rand -hex 32
```

Save this secret - you'll need it for both Nextcloud bot installation and Phantom configuration.

## Step 2: Install the Talk Bot

SSH into your Nextcloud server and run the following commands:

### Install the Bot

```bash
# Replace placeholders with your actual values:
sudo -u www-data php occ talk:bot:install \
  "Phantom" \
  "YOUR_SHARED_SECRET_FROM_STEP_1" \
  "https://phantom.example.com/nextcloud/webhook" \
  --feature webhook \
  --feature response \
  --feature reaction
```

**Parameters:**
- `"Phantom"` - Bot display name (can be any name you prefer)
- `YOUR_SHARED_SECRET_FROM_STEP_1` - The secret you generated in Step 1
- `"https://phantom.example.com/nextcloud/webhook"` - Phantom's webhook URL
- `--feature webhook` - Enable webhook notifications (required)
- `--feature response` - Enable sending messages (required)
- `--feature reaction` - Enable emoji reactions (optional, for status feedback)

The command will output a bot ID (e.g., `Bot installed with ID 3`). **Save this ID** - you'll need it for Step 4.

### Configure the Bot for Your Room

```bash
# Replace BOT_ID with the ID from the install command
# Replace ROOM_TOKEN with your Talk room token (from the room URL)
sudo -u www-data php occ talk:bot:setup BOT_ID ROOM_TOKEN
```

**Example:**
```bash
sudo -u www-data php occ talk:bot:setup 3 oh5eggbq
```

**Finding your room token:**
- Open your Talk room in Nextcloud
- The room token is in the URL: `https://nextcloud.example.com/index.php/call/ROOM_TOKEN`
- Or use `sudo -u www-data php occ talk:room:list` to list all rooms

### Verify Bot Installation

```bash
sudo -u www-data php occ talk:bot:list
```

**Expected output:**
```
+----+---------+-------------+-------------+-------+-----------------------------+
| id | name    | description | error_count | state | features                    |
+----+---------+-------------+-------------+-------+-----------------------------+
| 3  | Phantom |             | 0           | 1     | webhook, response, reaction |
+----+---------+-------------+-------------+-------+-----------------------------+
```

**Key values:**
- `id` - Your bot ID (e.g., `3`) - **save this for Step 4**
- `state` - Should be `1` (enabled)
- `features` - Should include `webhook`, `response`, and optionally `reaction`

## Step 3: Configure Phantom

Add the Nextcloud channel configuration to your Phantom config:

**Option A: Using environment variables (`.env`)**

```bash
# Required configuration
NEXTCLOUD_SHARED_SECRET="YOUR_SHARED_SECRET_FROM_STEP_1"
NEXTCLOUD_ROOM_TOKEN="ROOM_TOKEN_FROM_STEP_2"
NEXTCLOUD_TALK_SERVER="nextcloud.example.com"
NEXTCLOUD_BOT_ID="BOT_ID_FROM_STEP_2"

# Optional configuration (with defaults)
NEXTCLOUD_SESSION_WINDOW_MINUTES="30"
NEXTCLOUD_OWNER_USER_ID="your_nextcloud_user_id"
NEXTCLOUD_SEND_INTRO="false"
NEXTCLOUD_ENABLE_PROGRESSIVE_UPDATES="true"
NEXTCLOUD_ENABLE_FEEDBACK="true"
NEXTCLOUD_PROGRESSIVE_UPDATE_THROTTLE_MS="1000"
```

**Security Best Practice:** Always use environment variables for sensitive values like `NEXTCLOUD_SHARED_SECRET`. Never hardcode secrets directly in `config/channels.yaml` as this file may be committed to version control. The `.env` file is already gitignored for your protection.

**Option B: Using `config/channels.yaml`**

```yaml
channels:
  nextcloud:
    enabled: true
    shared_secret: "${NEXTCLOUD_SHARED_SECRET}"
    room_token: "${NEXTCLOUD_ROOM_TOKEN}"
    talk_server: "${NEXTCLOUD_TALK_SERVER}"
    bot_id: "${NEXTCLOUD_BOT_ID}"
    webhook_path: "/nextcloud/webhook"
    port: 3200
    session_window_minutes: 30
    owner_user_id: "${NEXTCLOUD_OWNER_USER_ID}"
    send_intro: "${NEXTCLOUD_SEND_INTRO}"
    enable_progressive_updates: "${NEXTCLOUD_ENABLE_PROGRESSIVE_UPDATES}"
    enable_feedback: "${NEXTCLOUD_ENABLE_FEEDBACK}"
    progressive_update_throttle_ms: "${NEXTCLOUD_PROGRESSIVE_UPDATE_THROTTLE_MS}"
```

**Configuration fields:**
- `shared_secret` - The secret from Step 1 (env: `NEXTCLOUD_SHARED_SECRET`)
- `room_token` - Your Talk room token (env: `NEXTCLOUD_ROOM_TOKEN`)
- `talk_server` - Nextcloud server hostname (env: `NEXTCLOUD_TALK_SERVER`, no protocol, no trailing slash)
- `bot_id` - Bot ID from `talk:bot:list` (env: `NEXTCLOUD_BOT_ID`, optional but recommended)
- `webhook_path` - Webhook endpoint path (default: `/nextcloud/webhook`)
- `port` - Port for the webhook server (default: `3200`)
- `session_window_minutes` - Time window for session coalescing (env: `NEXTCLOUD_SESSION_WINDOW_MINUTES`, default: `30`)
- `owner_user_id` - **NEW**: Only respond to this Nextcloud user ID (env: `NEXTCLOUD_OWNER_USER_ID`, optional)
- `send_intro` - **NEW**: Send welcome message on first startup (env: `NEXTCLOUD_SEND_INTRO`, default: `false`)
- `enable_progressive_updates` - **NEW**: Show "Working on it..." updates (env: `NEXTCLOUD_ENABLE_PROGRESSIVE_UPDATES`, default: `true`) - **NOT AVAILABLE**: Nextcloud API limitation prevents message editing without message ID tracking
- `enable_feedback` - **NEW**: Collect feedback via reactions (env: `NEXTCLOUD_ENABLE_FEEDBACK`, default: `true`)
- `progressive_update_throttle_ms` - **NEW**: Throttle progressive updates (env: `NEXTCLOUD_PROGRESSIVE_UPDATE_THROTTLE_MS`, default: `1000`) - **NOT AVAILABLE**: See above

## Step 4: Restart Phantom

After adding the configuration, restart Phantom to apply the changes:

```bash
# Docker
docker compose restart phantom

# Systemd
sudo systemctl restart phantom

# Manual
bun run src/index.ts
```

## Step 5: Test the Integration

1. **Verify webhook connectivity:**
   - Send a message in your Nextcloud Talk room
   - Check Phantom logs for: `[nextcloud] Webhook server listening on :3200/nextcloud/webhook`
   - Look for incoming message logs: `[nextcloud] Create in "room-name" from Person Username: ...`

2. **Verify bot responses:**
   - Send `@phantom hello` in the Talk room
   - The bot should respond with a message

3. **Verify reactions (if enabled):**
   - Send a long-running query
   - The bot should set a 🧠 (thinking) reaction while processing
   - When complete, it should replace with ✅ (done) or ⚠️ (error)


## Features

### Status Reactions

Phantom uses emoji reactions to show activity state while processing messages (matches Slack defaults):

| Emoji | Meaning |
|-------|---------|
| 👀 | Queued |
| 🧠 | Thinking |
| 🔧 | Running tools (generic) |
| 💻 | Running tools (coding) |
| 🌐 | Running tools (web) |
| ✅ | Done |
| ⚠️ | Error |
| ⏳ | Stall warning (soft) |
| ❗ | Stall error (hard) |

These reactions provide real-time feedback without cluttering the chat with status messages.

### Progressive Updates

**⚠️ Not Available for Nextcloud Talk**

Progressive updates (showing "Working on it..." with real-time tool activity) are not supported for Nextcloud Talk due to API limitations. The Nextcloud Bot API's `postToNextcloud()` method returns a boolean success/failure status rather than the message ID, which prevents us from editing the message later with tool activity updates.

**What works instead:**
- Status reactions (👀 queued → 🧠 thinking → 🔧 tool → ✅ done) provide real-time feedback
- Final response is delivered when complete
- Feedback collection via reactions still works

**Comparison with other channels:**
- Slack: ✅ Progressive updates supported (message editing available)
- Telegram: ✅ Progressive updates supported (message editing available)
- Nextcloud: ❌ Progressive updates not supported (API limitation)

### Feedback Collection

When `enable_feedback: true` (default), Phantom appends "💡 Was this helpful? React with 👍, ❤️, or ✅ (yes) or 👎/❌ (no)" to responses. Your reactions feed into the evolution engine to improve future responses.

**Reaction meanings:**
- **Positive reactions** (helpful response):
  - 👍 (thumbs up, including skin tone variants)
  - ❤️ (heart, including color variants)
  - ✅ (check mark variants)
- **Negative reactions** (not helpful):
  - 👎 (thumbs down, including skin tone variants)
  - ❌ (cross mark variants)

This matches Slack's rich feedback reaction system for consistency across channels.

Feedback signals are tracked in the evolution queue and used to refine the agent's configuration over time.

### Owner Access Control

To restrict the bot to only respond to you, set `owner_user_id` in your config:

```yaml
channels:
  nextcloud:
    owner_user_id: "${NEXTCLOUD_OWNER_USER_ID}"
```

**Finding your user ID:**
1. Send a message in the Talk room
2. Check Phantom logs for: `actorId=your_user_id`
3. Copy that ID into your config

When configured:
- Owner messages are processed normally
- Non-owner messages get a one-time rejection in the room
- Repeat non-owner messages are silently ignored (prevents spam)

**Rejection message:**

```
Hi! I'm Phantom, a personal AI co-worker. I can only respond to my owner.
If you need your own, check out github.com/ghostwright/phantom.
```

### Proactive Intro Message

To send a welcome message when Phantom first connects to the room:

```yaml
# In .env file:
NEXTCLOUD_SEND_INTRO="true"
NEXTCLOUD_OWNER_USER_ID="your_nextcloud_user_id"

# In config/channels.yaml:
channels:
  nextcloud:
    send_intro: "${NEXTCLOUD_SEND_INTRO}"
    owner_user_id: "${NEXTCLOUD_OWNER_USER_ID}"
```

The intro is sent once per channel (tracked in database) and says:

```
Hi, I'm Phantom. I'm now connected and listening here. Send /help to see what I can do.
```

**Note:** The intro requires `owner_user_id` to be set to ensure the welcome message goes to the right place.

## Troubleshooting

### Bot not receiving messages

1. **Check webhook URL is correct:**
   ```bash
   sudo -u www-data php occ talk:bot:list
   # Verify the webhook URL matches your Phantom public URL
   ```

2. **Check bot is enabled:**
   ```bash
   sudo -u www-data php occ talk:bot:list
   # State should be 1, not 0
   ```

3. **Check room configuration:**
   ```bash
   sudo -u www-data php occ talk:bot:info BOT_ID
   # Verify the bot is configured for the correct room
   ```

4. **Check Phantom logs:**
   ```bash
   # Docker
   docker logs phantom --tail 100 -f

   # Look for webhook errors:
   # "[nextcloud] HMAC verification failed" -> Secret mismatch
   # "[nextcloud] Replay attack detected" -> Nonce already used (normal for retries)
   ```

### Bot not sending messages

1. **Verify features are enabled:**
   ```bash
   sudo -u www-data php occ talk:bot:list
   # Features should include "response"
   ```

2. **Check bot has permission to post:**
   - Ensure the bot is a participant in the room
   - Check room permissions allow bots to post

3. **Check Phantom configuration:**
   - Verify `talk_server` hostname is correct (no protocol prefix)
   - Verify `room_token` matches the target room

### Bot responding to its own messages

If you see the bot in a loop responding to itself:

1. **Verify bot ID is configured:**
   ```bash
   # Check .env or channels.yaml includes NEXTCLOUD_BOT_ID or bot_id
   grep NEXTCLOUD_BOT_ID .env
   # or
   grep bot_id config/channels.yaml
   ```

2. **Verify bot ID is correct:**
   ```bash
   sudo -u www-data php occ talk:bot:list
   # The ID should match your configuration
   ```

3. **Check logs for self-filtering:**
   ```bash
   # Should see: "[nextcloud] Ignoring message from self (botId=3)"
   docker logs phantom --tail 100 | grep "Ignoring message from self"
   ```

### HMAC verification failures

1. **Verify shared secret matches:**
   ```bash
   # The secret in Phantom config must EXACTLY match the secret used in talk:bot:install
   grep NEXTCLOUD_SHARED_SECRET .env
   ```

2. **Regenerate bot with correct secret:**
   ```bash
   # Uninstall existing bot
   sudo -u www-data php occ talk:bot:uninstall BOT_ID

   # Reinstall with correct secret
   sudo -u www-data php occ talk:bot:install "Phantom" "CORRECT_SECRET" "https://phantom.example.com/nextcloud/webhook" --feature webhook --feature response --feature reaction
   ```

### Multiple bots in the same room

If you have multiple bots in the same Talk room:

1. **Each bot must have a unique bot ID configured**
2. **Each bot must ignore messages from other bots**
   - The `actorType === "Application"` check handles this
   - The `botId` self-filter prevents self-replies
3. **Test bot isolation:**
   - Send a message directed at one bot
   - Verify only that bot responds
   - Other bots should ignore the message

## Security Best Practices

1. **Use strong random secrets:**
   - Always generate secrets with `openssl rand -hex 32`
   - Never use predictable or weak secrets

2. **Enable HTTPS only:**
   - Never expose Talk bots over HTTP
   - The webhook URL must use HTTPS

3. **Limit bot permissions:**
   - Only enable features you need: `--feature webhook --feature response`
   - Disable reactions if not needed: remove `--feature reaction`

4. **Monitor bot activity:**
   ```bash
   # Check error count regularly
   sudo -u www-data php occ talk:bot:list
   # High error_count may indicate configuration issues
   ```

5. **Rotate secrets periodically:**
   ```bash
   # Generate new secret
   NEW_SECRET=$(openssl rand -hex 32)

   # Update Phantom config first
   # Then reinstall bot with new secret
   sudo -u www-data php occ talk:bot:install "Phantom" "$NEW_SECRET" "https://phantom.example.com/nextcloud/webhook" --feature webhook --feature response --feature reaction
   ```

## Advanced Configuration

### Time-Window Session Coalescing

Phantom can continue conversations across multiple messages within a time window:

```yaml
channels:
  nextcloud:
    # ... other config ...
    session_window_minutes: 30  # Default: 30 minutes
```

This treats messages within the same room as part of one conversation, improving context awareness for multi-turn interactions.

### Custom Webhook Path

If you need a custom webhook path (e.g., behind reverse proxy with path routing):

```yaml
channels:
  nextcloud:
    webhook_path: "/custom/webhook/path"  # Default: "/nextcloud/webhook"
```

**Important:** You must update the Nextcloud bot installation to use the matching path:

```bash
sudo -u www-data php occ talk:bot:install "Phantom" "SECRET" "https://phantom.example.com/custom/webhook/path" --feature webhook --feature response --feature reaction
```

## Nextcloud Talk Bot API Reference

### Installation Command

```bash
sudo -u www-data php occ talk:bot:install <name> <secret> <webhook_url> [options]
```

- `name` - Bot display name
- `secret` - Shared secret for HMAC signature verification
- `webhook_url` - Phantom's webhook URL
- `--feature` - Features to enable: `webhook`, `response`, `reaction`

### Setup Command

```bash
sudo -u www-data php occ talk:bot:setup <bot_id> <room_token>
```

- `bot_id` - Bot ID from installation
- `room_token` - Talk room token

### List Command

```bash
sudo -u www-data php occ talk:bot:list
```

Lists all configured bots with IDs, features, and status.

### Info Command

```bash
sudo -u www-data php occ talk:bot:info <bot_id>
```

Shows detailed information about a specific bot.

### Uninstall Command

```bash
sudo -u www-data php occ talk:bot:uninstall <bot_id>
```

Removes a bot. Use with caution - this cannot be undone.

### Bot responding to non-owners

If the bot is responding to people it shouldn't:

1. **Verify owner_user_id is set:**
   ```bash
   # Check if environment variable is set
   grep NEXTCLOUD_OWNER_USER_ID .env
   # Or verify it's referenced in channels.yaml
   grep NEXTCLOUD_OWNER_USER_ID config/channels.yaml
   ```

2. **Find your correct user ID:**
   - Send a message in the Talk room
   - Check logs: `docker logs phantom | grep "actorId="`
   - Use that exact ID in your config

3. **Restart Phantom after changing config:**
   ```bash
   docker compose restart phantom
   ```

### Feedback not being collected

If reactions aren't generating feedback signals:

1. **Check feedback is enabled:**
   ```bash
   # Check if environment variable is set
   grep NEXTCLOUD_ENABLE_FEEDBACK .env
   # Or verify it's referenced in channels.yaml
   grep NEXTCLOUD_ENABLE_FEEDBACK config/channels.yaml
   # Should be: "true" (default)
   ```

2. **Verify bot has reaction permission:**
   ```bash
   sudo -u www-data php occ talk:bot:list
   # Features should include "reaction"
   ```

3. **Check logs for feedback capture:**
   ```bash
   docker logs phantom | grep "Feedback captured"
   ```

### Intro message not sending

If the welcome message doesn't appear:

1. **Verify send_intro is enabled:**
   ```bash
   # Check if environment variable is set
   grep NEXTCLOUD_SEND_INTRO .env
   # Or verify it's referenced in channels.yaml
   grep NEXTCLOUD_SEND_INTRO config/channels.yaml
   # Should be: "true" to enable
   ```

2. **Verify owner_user_id is set:**
   - Intro requires owner_user_id to know where to send

3. **Check if intro was already sent:**
   ```bash
   # From within the container
   docker exec phantom sqlite3 data/phantom.db "SELECT * FROM channel_intros WHERE channel_id='nextcloud'"
   ```

4. **Clear intro history to re-send:**
   ```bash
   docker exec phantom sqlite3 data/phantom.db "DELETE FROM channel_intros WHERE channel_id='nextcloud'"
   docker compose restart phantom
   ```

### Progressive updates not working

**Not Applicable - Feature Not Available**

Progressive updates are not supported for Nextcloud Talk due to API limitations. See the "Progressive Updates" section in Features above for details.

If you see multiple "Working on it..." messages, this indicates progressive updates are incorrectly enabled. To disable:

1. **Set enable_progressive_updates to false:**
   ```bash
   # In .env file
   NEXTCLOUD_ENABLE_PROGRESSIVE_UPDATES="false"
   ```

2. **Restart Phantom:**
   ```bash
   docker compose restart phantom
   ```

3. **Verify behavior:**
   - You should see status reactions on your message instead
   - Single response when agent completes
   - No multiple "Working on it..." messages

### Multiple bots in the same room

If you have multiple bots in the same Talk room:

1. **Each bot must have a unique bot ID configured**
2. **Each bot must ignore messages from other bots**
   - The `actorType === "Application"` check handles this
   - The `botId` self-filter prevents self-replies
3. **Test bot isolation:**
   - Send a message directed at one bot
   - Verify only that bot responds
   - Other bots should ignore the message


## Additional Resources

- [Nextcloud Talk Bot API Documentation](https://nextcloud-talk.readthedocs.io/en/latest/bot/)
- [Phantom Channel Configuration](channels.md)
- [Phantom Security Guide](security.md)
- [Phantom Troubleshooting](getting-started.md#troubleshooting)
