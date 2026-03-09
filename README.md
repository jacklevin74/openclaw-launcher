# OpenClaw Launcher

**Docker Orchestrator for AI Agent Instances — One Agent Per Wallet**

Deploy isolated [OpenClaw](https://github.com/openclaw/openclaw) AI agents tied to SVM wallet public keys. Each validator gets a personal AI agent with dedicated resources, personality, Telegram bot, and workspace.

---

## Quick Start (Operator Setup)

### Prerequisites

- Linux host (Ubuntu recommended)
- Docker installed and running
- Node.js 20+ (24 recommended)
- Ollama installed (for free cloud models — no GPU needed)
- API keys for at least one LLM provider

### 1. Clone and install

```bash
git clone https://github.com/jacklevin74/openclaw-launcher.git
cd openclaw-launcher
npm install
```

### 2. Build the Docker image

The launcher needs an `openclaw:local` Docker image. Build it in two steps:

```bash
# Step 1: Base image with latest OpenClaw
cat > /tmp/Dockerfile.openclaw <<'EOF'
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g openclaw@latest
USER node
WORKDIR /home/node
RUN mkdir -p .openclaw/workspace
EXPOSE 18789
CMD ["openclaw", "gateway", "run"]
EOF
docker build -t openclaw:base -f /tmp/Dockerfile.openclaw /tmp/

# Step 2: Add Solana CLI tools (optional, for onchain agents)
docker build -t openclaw:local -f Dockerfile.openclaw .
```

### 3. Set up Ollama (free cloud models, no GPU)

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

If port 11434 is in use, bind to a different port:
```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
echo -e '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0:11435"' | \
  sudo tee /etc/systemd/system/ollama.service.d/override.conf
sudo systemctl daemon-reload && sudo systemctl restart ollama
```

Create an account at [ollama.com](https://ollama.com), add your server's public key (found in the ollama startup logs), then test:
```bash
OLLAMA_HOST=http://127.0.0.1:11435 ollama run kimi-k2.5:cloud "hello"
```

### 4. Configure environment

Create `.env`:
```bash
# Required
LAUNCHER_TOKEN=your-secret-launcher-token

# LLM Provider API Keys (at least one required)
ANTHROPIC_API_KEY=sk-ant-...          # Claude models
OPENROUTER_API_KEY=sk-or-v1-...      # OpenRouter models
OLLAMA_API_KEY=ollama-local           # For local ollama (any non-empty value)

# Optional
TELEGRAM_BOT_TOKEN=...               # Default Telegram bot (per-instance tokens override)
TAILSCALE_IP=100.x.x.x              # Bind address for instance ports
PORT=8780                            # Launcher web UI port
```

### 5. Build and run

```bash
npm run build
sudo env $(grep -v '^#' .env | xargs) node dist/server.js
```

Access the web UI at `http://your-server:8780/?token=your-secret-launcher-token`

---

## Deploying an Agent

### Via Web UI

1. Open the launcher dashboard
2. Enter an **agent name** (e.g., "Theo"), **wallet public key**, and optionally a **Telegram bot token**
3. Click **Deploy**
4. The agent gets its own container, port, config, and personality

### Via API

```bash
curl -X POST http://localhost:8780/api/launch \
  -H "Authorization: Bearer $LAUNCHER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pubkey": "YOUR_WALLET_PUBKEY", "name": "Theo", "telegram_bot_token": "optional"}'
```

### What happens on deploy

1. Instance ID generated from `sha256(pubkey)[:12]`
2. Directories created: `data/instances/<id>/config/` and `workspace/`
3. Template files copied to workspace with `{{AGENT_NAME}}` replaced
4. OpenClaw config written with model providers and Telegram setup
5. Docker container launched with security hardening
6. Agent connects to Telegram and starts responding

---

## Agent Personality & Templates

Templates live in `templates/workspace/`. Each new agent gets these files seeded into their workspace:

| File | Purpose | Mutable by Agent |
|------|---------|-----------------|
| `SOUL.md` | Core personality, voice, values | No (read-only mount) |
| `IDENTITY.md` | Wallet binding, instance metadata | No (read-only mount) |
| `AGENTS.md` | Behavioral rules and policies | No (read-only mount) |
| `USER.md` | Operator profile | No (read-only mount) |
| `MEMORY.md` | Long-term knowledge, ecosystem data | Yes |
| `HEARTBEAT.md` | Periodic task config | Yes |
| `TOOLS.md` | Infrastructure notes | Yes |

Templates use `{{AGENT_NAME}}` as a placeholder — replaced with the actual name on deploy.

Protected files are bind-mounted as `:ro` at the Docker level, so agents cannot modify their own identity regardless of instructions or prompt injection.

---

## Model Configuration

The launcher configures agents with multiple LLM providers:

| Provider | Model | Notes |
|----------|-------|-------|
| Ollama (local) | `kimi-k2.5:cloud` | Free via ollama.com cloud — primary model |
| Anthropic | `claude-sonnet-4-6` | Fallback, also used for subagents |
| Anthropic | `claude-haiku-4-5` | Fast/cheap option |
| OpenRouter | `openai/gpt-5.3-codex` | Additional option |

The ollama provider points at `http://172.17.0.1:<port>/v1` (Docker bridge gateway) so containers reach the host's ollama instance.

**Anti-auto-discovery:** API keys use non-standard env var names (`OC_ANTHROPIC_KEY`, `OC_OLLAMA_KEY`, etc.) to prevent OpenClaw's built-in model catalog from auto-registering hundreds of models. Only models in the `agents.defaults.models` allowlist are selectable.

---

## Container Security

Each agent runs in a hardened Docker container:

| Setting | Value |
|---------|-------|
| Memory | 2 GB (with 1.5 GB Node.js heap) |
| CPU | 0.5 cores |
| Capabilities | `ALL` dropped, only `NET_BIND_SERVICE` added |
| Privilege escalation | Blocked (`no-new-privileges`) |
| Restart policy | `unless-stopped` |
| Init | `true` (proper PID 1) |
| Port binding | Specific IP only (not 0.0.0.0) |
| Protected files | Read-only bind mounts for identity files |

---

## Architecture

```
openclaw-launcher/
├── src/
│   ├── server.ts          # Express server, routes, config template
│   ├── docker.ts          # Container lifecycle, security config
│   ├── auth.ts            # Bearer token middleware
│   ├── db.ts              # JSON database with file locking
│   ├── reconciler.ts      # Health polling (60s interval)
│   └── metrics.ts         # Prometheus metrics
├── public/
│   └── index.html         # Web UI dashboard
├── templates/workspace/   # Template .md files for new agents
├── data/
│   ├── instances.json     # Instance database
│   └── instances/<id>/    # Per-instance data
│       ├── config/        # openclaw.json
│       └── workspace/     # SOUL.md, MEMORY.md, etc.
├── Dockerfile.openclaw    # Extended image with Solana CLI
└── .env                   # API keys, tokens (gitignored)
```

### Instance Lifecycle

| Action | Endpoint | Effect |
|--------|----------|--------|
| **Deploy** | `POST /api/launch` | Create instance, seed workspace, start container |
| **Stop** | `POST /api/stop` | Stop container, preserve all data |
| **Restart** | `POST /api/launch` (same pubkey) | Start existing container, update name if changed |
| **Destroy** | `POST /api/destroy` | Remove container, wipe instance directory |

Destroying an instance wipes all data (`config/` and `workspace/`), ensuring clean state on redeploy.

---

## API Reference

All `/api/*` endpoints require `Authorization: Bearer <LAUNCHER_TOKEN>` header.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/instances` | List all instances (tokens excluded) |
| `POST` | `/api/launch` | Deploy or restart instance |
| `POST` | `/api/stop` | Stop instance |
| `POST` | `/api/destroy` | Remove instance and wipe data |
| `GET` | `/api/stats/:id` | Live CPU/memory stats |
| `GET` | `/api/logs/:id` | Fetch recent logs |
| `WS` | `/api/logs/:id/stream` | Stream logs via WebSocket |
| `GET` | `/api/files/:id` | List workspace files |
| `GET` | `/api/files/:id/:file` | Read workspace file |
| `PUT` | `/api/files/:id/:file` | Edit workspace file |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/health` | Health check |

### Launch request body

```json
{
  "pubkey": "YOUR_WALLET_PUBLIC_KEY",
  "name": "AgentName",
  "telegram_bot_token": "optional-per-instance-token"
}
```

---

## Customization

### Changing the personality

Edit `templates/workspace/SOUL.md`. Use `{{AGENT_NAME}}` wherever the agent's name should appear. Changes apply to newly deployed instances only — existing instances keep their files unless destroyed and redeployed.

### Adding models

Edit the `ocConfig` object in `src/server.ts` to add providers and models. Add new models to both the `providers` section and the `agents.defaults.models` allowlist.

### Adjusting resources

Edit `src/docker.ts`:
- `Memory` — container memory limit
- `NanoCpus` — CPU allocation (500_000_000 = 0.5 cores)
- `NODE_OPTIONS` env var — Node.js heap size

---

## Monitoring

- **Web UI:** Auto-refreshing dashboard with CPU/memory per instance
- **CLI:** `docker stats --no-stream $(docker ps -f name=openclaw- -q)`
- **Prometheus:** Scrape `http://localhost:8780/metrics`

---

## Troubleshooting

**Instance OOM:** OpenClaw v2026.3.8+ needs ~1.5 GB heap. Ensure containers have 2+ GB memory and `NODE_OPTIONS=--max-old-space-size=1536`.

**Ollama timeout:** Check `sudo systemctl status ollama` and that containers can reach it via `http://172.17.0.1:<port>`.

**Model auto-discovery (700+ models):** Ensure API key env vars use non-standard names (`OC_ANTHROPIC_KEY`, not `ANTHROPIC_API_KEY`) inside containers.

**Port binding error:** Verify `TAILSCALE_IP` in `.env` matches an active interface on the host.

---

## License

MIT

**Built for X1 Validators by Jack Levin**
