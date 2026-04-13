# Phantom Deployment Checklist

Step-by-step guide to deploy a Phantom agent for a user.

## Prerequisites

Before you start, you need:

1. **Specter installed and configured** (`specter init` done, golden image built)
2. **An Anthropic API key** (sk-ant-...)
3. **A Slack workspace** where the user is a member

## Step 1: Spin Up a VM via Specter

Use the Specter TUI or CLI:

```bash
specter deploy <agent-name> --server-type cx53 --location fsn1 --yes
```

- **agent-name**: lowercase, letters/numbers/hyphens only. Becomes the subdomain (e.g., `scout` -> `scout.ghostwright.dev`)
- **cx53**: 16 vCPU, 32GB RAM, 320GB disk, $18.99/month. Recommended size.
- **fsn1**: Falkenstein datacenter. Use this if nbg1 has availability issues.

Wait for the deploy to complete (~90 seconds). Note the IP address from the output.

## Step 2: Create a Slack App for This User

Each user gets their own Slack app. This takes 30 seconds:

1. Go to https://api.slack.com/apps
2. Click **Create New App** > **From an app manifest**
3. Select the workspace
4. Switch to the **YAML** tab
5. Paste this manifest (change the name for each user):

```yaml
display_information:
  name: <Users Name> Phantom
  description: Your AI co-worker
  background_color: "#22D3EE"

features:
  bot_user:
    display_name: Phantom
    always_online: true
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false

oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - chat:write.public
      - groups:history
      - im:history
      - im:read
      - im:write
      - reactions:read
      - reactions:write
      - users:read
      - team:read
      - users.profile:read

settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - reaction_added
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false
```

6. Click **Create**
7. Click **Install to Workspace** > **Allow**
8. Copy the **Bot User OAuth Token** (xoxb-...) from **OAuth & Permissions**
9. Go to **Basic Information** > **App-Level Tokens** > **Generate Token and Scopes**
   - Name: `socket`
   - Add scope: `connections:write`
   - Click **Generate**
   - Copy the **App Token** (xapp-...)

Note: Do NOT use apostrophes in the app name (e.g., use "Janes Phantom" not "Jane's Phantom")

## Step 3: Get the User's Slack ID

The user clicks their profile in Slack > three dots > **Copy member ID**

Or you find it in the Slack admin panel.

Format: `U` followed by alphanumeric characters (e.g., `UKWMQ41F0`)

## Step 4: Create the Env File

Create a file at `.env.<name>` in the Phantom repo root:

```
ANTHROPIC_API_KEY=sk-ant-your-api-key
SLACK_BOT_TOKEN=xoxb-their-bot-token
SLACK_APP_TOKEN=xapp-their-app-token
OWNER_SLACK_USER_ID=UTHEIR_USER_ID
```

No channel ID needed. Phantom will DM the user directly.

## Step 5: Fix SSH Key (if needed)

If the IP was previously used by another VM, SSH will reject the connection:

```bash
ssh-keygen -R <IP_ADDRESS>
```

## Step 6: Deploy Phantom to the VM

Run these commands in order. Replace `<IP>` with the VM's IP and `<name>` with the agent name.

```bash
# 1. Sync code to VM
rsync -az -e "ssh -o StrictHostKeyChecking=no" \
  --exclude='node_modules' --exclude='.git' --exclude='data' \
  --exclude='.env*' --exclude='local' --exclude='*.db' \
  /path/to/phantom/ specter@<IP>:/home/specter/phantom/

# 2. Copy env file
scp -o StrictHostKeyChecking=no \
  /path/to/phantom/.env.<name> \
  specter@<IP>:/home/specter/phantom/.env.local

# 3. Install dependencies
ssh -o StrictHostKeyChecking=no specter@<IP> \
  "cd /home/specter/phantom && bun install --production"

# 4. Start Docker services (Qdrant + Ollama)
ssh -o StrictHostKeyChecking=no specter@<IP> \
  "cd /home/specter/phantom && docker compose up -d"

# 5. Pull embedding model (takes 15-30 seconds first time)
ssh -o StrictHostKeyChecking=no specter@<IP> \
  "docker exec phantom-ollama ollama pull nomic-embed-text"

# 6. Initialize Phantom config (reads env vars, generates MCP tokens)
ssh -o StrictHostKeyChecking=no specter@<IP> \
  "cd /home/specter/phantom && rm -rf config/phantom.yaml config/channels.yaml config/mcp.yaml phantom-config/meta/version.json && source .env.local && PHANTOM_NAME=<name> bun run src/cli/main.ts init --yes"

# 7. Start Phantom
ssh -T -o StrictHostKeyChecking=no specter@<IP> << 'ENDSSH'
cd /home/specter/phantom
pkill -f bun 2>/dev/null || true
sleep 2
source .env.local
nohup bun run src/index.ts > /tmp/phantom.log 2>&1 &
sleep 8
tail -15 /tmp/phantom.log
ENDSSH
```

## Step 7: Verify

Check the logs from Step 6 output. You should see:

```
[phantom] Config loaded: <name> (claude-opus-4-6, effort: max)
[roles] Loaded role: Software Engineer (swe)
[phantom] Database ready
[memory] Memory system initialized successfully.
[evolution] Engine initialized (v0)
[mcp] MCP server initialized (in-process dynamic tools wired to agent)
[phantom] Slack channel registered
[onboarding] Onboarding prompt injected into agent runtime
[phantom] HTTP server listening on port 3100
[slack] Connected as <@BOT_ID>
[slack] Socket Mode connected
[onboarding] Profiled owner: <User Name> (<Title>)
[onboarding] Introduction sent as DM to user <USER_ID>
[phantom] <name> is ready.
```

Key things to verify:
- "Profiled owner" shows the correct user's name and title
- "Introduction sent as DM" confirms the first message was sent
- No errors in the logs

Also verify the health endpoint:

```bash
curl -s https://<name>.ghostwright.dev/health | python3 -m json.tool
```

Should show: status ok, Slack true, Qdrant true, Ollama true, evolution generation 0.

## Step 8: Confirm with the User

The user should have received a personalized DM from Phantom. Ask them to reply and verify the agent responds.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| SSH key rejection | `ssh-keygen -R <IP>` |
| Docker pull fails | Retry, or check Docker Hub rate limits |
| Ollama model pull slow | Wait, it's a 270MB download |
| Slack not connecting | Check bot token and app token are correct |
| No DM received | Check OWNER_SLACK_USER_ID is correct |
| Health endpoint 502 | Phantom may still be starting, wait 30 seconds |
| "Already initialized" on init | Remove config files first (step 6 does this) |
| TLS cert failure | Let's Encrypt rate limit. Use a different agent name or wait. |

## MCP Tokens

The `phantom init --yes` step prints MCP tokens. Save the Admin token. This is used to connect from Claude Code:

```json
{
  "mcpServers": {
    "phantom": {
      "type": "http",
      "url": "https://<name>.ghostwright.dev/mcp",
      "headers": {
        "Authorization": "Bearer <admin-token>"
      }
    }
  }
}
```

## Updating a Deployed Phantom (bare metal)

To deploy new code to an existing bare metal VM:

```bash
# Sync latest code (does NOT touch .env.local, data, or config)
rsync -az -e "ssh -o StrictHostKeyChecking=no" \
  --exclude='node_modules' --exclude='.git' --exclude='data' \
  --exclude='.env*' --exclude='local' --exclude='*.db' \
  --exclude='config' --exclude='phantom-config' \
  /path/to/phantom/ specter@<IP>:/home/specter/phantom/

# Restart
ssh specter@<IP> "cd /home/specter/phantom && pkill -f bun; sleep 2; source .env.local && nohup bun run src/index.ts > /tmp/phantom.log 2>&1 &"
```

Note: the update rsync excludes config/ and phantom-config/ to preserve the agent's evolved configuration and memory.

## Updating a Deployed Phantom (Docker)

For Docker deployments, rsync the source, rebuild the phantom container, and overlay the updated static files into the `phantom_public` named volume. Two gotchas you must respect.

### Gotcha 1: rsync each directory with matching source and target paths

Do NOT pass multiple sources with trailing slashes to a single target directory. rsync will merge contents into the target root and `--delete` will wipe the original `src/`, `public/`, `scripts/` names. Instead, run one rsync per directory:

```bash
rsync -az --delete src/     specter@<IP>:/home/specter/phantom/src/
rsync -az --delete public/  specter@<IP>:/home/specter/phantom/public/
rsync -az --delete scripts/ specter@<IP>:/home/specter/phantom/scripts/
rsync -az package.json bun.lock tsconfig.json biome.json Dockerfile docker-compose.yaml \
  specter@<IP>:/home/specter/phantom/
```

### Rebuild the phantom container

```bash
ssh specter@<IP> "cd /home/specter/phantom && docker compose up -d --build phantom"
```

This rebuilds the image with the new `src/` and `public/` content and restarts the container. Qdrant and Ollama keep running.

### Gotcha 2: overlay the public volume and chown to uid 999

The `phantom_public` named volume mounts over `/app/public` inside the container, so the new `public/` files baked into the image at build time do not reach the running container. You must overlay the volume from the host. And because the phantom container runs as `uid=999(phantom)`, the overlay must chown the volume contents to 999, or phantom cannot write to `/app/public` and every agent attempt to create a new page fails silently with permission denied.

```bash
ssh specter@<IP> "docker run --rm \
  -v phantom_phantom_public:/dst \
  -v /home/specter/phantom/public:/src \
  alpine sh -c 'cp -av /src/. /dst/ && chown -R 999:999 /dst'"
```

Why the chown is mandatory: alpine runs as root by default and `cp -av` preserves numeric ownership from the host source. The host files are owned by `specter` at uid 1000. Without the chown, every file in the volume lands at uid 1000, which the phantom container (uid 999) cannot modify.

### Verify

```bash
# Container can write to /app/public
ssh specter@<IP> "docker exec phantom sh -c 'touch /app/public/_w && rm /app/public/_w && echo OK'"

# Health endpoint reports the new version
curl -s https://<name>.ghostwright.dev/health | python3 -m json.tool
```

## Deployed Agents Reference

Production deployments are tracked internally. Use `specter list` to see active VMs.
