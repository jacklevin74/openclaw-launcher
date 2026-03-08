# OpenClaw Launcher — Container Architecture & Security Policies

## Overview

The launcher is a TypeScript/Express orchestrator that deploys isolated OpenClaw AI agent instances, each linked to an SVM wallet public key. Each instance runs in a hardened Docker container with per-instance Telegram bot tokens, model configs, and workspace files.

## Container Security

### Filesystem

| Policy | Setting |
|--------|---------|
| Root filesystem | `ReadonlyRootfs: true` |
| Temp storage | `tmpfs /tmp` — 64MB, in-memory, lost on restart |
| Config directory | Bind mount, read-write (`/home/node/.openclaw`) |
| Workspace directory | Bind mount, read-write (`/home/node/.openclaw/workspace`) |
| Protected workspace files | Individual bind mounts, **read-only** (see below) |

### Protected Files (Read-Only Mounts)

These files are mounted individually as `:ro` on top of the writable workspace mount. The agent cannot modify them regardless of instructions or prompt injection.

| File | Purpose |
|------|---------|
| `SOUL.md` | Core personality, behavioral rules, identity |
| `AGENTS.md` | Agent behavior policies, crypto guidelines, hard rules |
| `IDENTITY.md` | Wallet binding, instance metadata, chain identity |
| `USER.md` | Operator profile |

### Writable Files

These files remain writable so the agent can update them during operation:

| File | Purpose |
|------|---------|
| `MEMORY.md` | Learned knowledge, ecosystem data |
| `HEARTBEAT.md` | Periodic task checklist |
| `TOOLS.md` | Infrastructure notes, available tools |

### Capabilities & Privileges

| Policy | Setting |
|--------|---------|
| Linux capabilities | `CapDrop: ALL`, `CapAdd: NET_BIND_SERVICE` |
| Privilege escalation | `no-new-privileges` |
| Container user | `node` (uid 1000) — unprivileged |
| Init process | `Init: true` — proper signal handling, zombie reaping |

### Resource Limits

| Resource | Limit |
|----------|-------|
| Memory | 512 MiB (hard, no swap) |
| CPU | 0.5 cores |
| Restart policy | `unless-stopped` |

### Network

| Policy | Setting |
|--------|---------|
| Exposed port | `18789/tcp` (gateway) |
| Host binding | `TAILSCALE_IP:<assigned_port>` — not exposed on all interfaces |
| Port range | Starting at `19000`, auto-incremented per instance |
| Max instances | 20 |

## Environment Variables

### Provider API Keys (Anti-Auto-Discovery)

OpenClaw's upstream `pi-coding-agent` library auto-discovers providers from standard env var names (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.), registering hundreds of built-in models. To prevent this, we rename all API key env vars to non-standard names:

| Host Env Var | Container Env Var | Purpose |
|-------------|-------------------|---------|
| `ANTHROPIC_API_KEY` | `OC_ANTHROPIC_KEY` | Anthropic API access |
| `OPENROUTER_API_KEY` | `OC_OPENROUTER_KEY` | OpenRouter API access |
| `OLLAMA_API_KEY` | `OC_OLLAMA_KEY` | Ollama/Puter.to API access |
| `OPENAI_API_KEY` | `OC_OPENAI_KEY` | OpenAI API access |

The openclaw config references these via explicit `apiKey` fields:
```json
"apiKey": { "source": "env", "provider": "default", "id": "OC_ANTHROPIC_KEY" }
```

### Per-Instance Variables

| Env Var | Source |
|---------|--------|
| `TELEGRAM_BOT_TOKEN` | Per-instance (from launch request) or global fallback |
| `OPENCLAW_GATEWAY_TOKEN` | Generated per-instance (random 24 bytes hex) |

## Model Restriction

### Config-Level (`models.mode: "replace"`)

Only explicitly defined providers are used for inference. Does **not** prevent the built-in model catalog from appearing in `/models`.

### Allowlist (`agents.defaults.models`)

Controls which models appear in the `/models` command and are selectable by users:

```json
"models": {
  "ollama/kimi-k2.5:cloud": {},
  "anthropic/claude-sonnet-4-6": {},
  "anthropic/claude-haiku-4-5": {},
  "openrouter/openai/gpt-5.3-codex": {}
}
```

### Command Restrictions

| Setting | Value | Effect |
|---------|-------|--------|
| `commands.config` | `false` | Users cannot modify config via chat |
| `configWrites` | `false` | Per-channel, prevents config changes from Telegram |
| `ownerAllowFrom` | `[107303489]` | Only operator can use owner commands |

## Docker Image

Base image: `openclaw:local` extended via `Dockerfile.openclaw`:

- Official OpenClaw image (Node.js, gateway, agent runtime)
- Solana CLI tools (`solana`, `solana-keygen` v2.2.18) from Anza release

## Directory Layout

```
openclaw-launcher/
├── src/                    # TypeScript source
│   ├── server.ts           # Express server, routes, config template
│   ├── docker.ts           # Container lifecycle, security config
│   ├── auth.ts             # API authentication
│   ├── db.ts               # Instance database (JSON file with locking)
│   ├── reconciler.ts       # Health polling, auto-restart
│   └── metrics.ts          # Prometheus metrics
├── dist/                   # Compiled JS
├── public/                 # Web UI (index.html, docs.html)
├── templates/workspace/    # Template .md files seeded to new instances
├── data/
│   ├── instances.json      # Instance database
│   └── instances/
│       └── <instance-id>/
│           ├── config/     # openclaw.json (mounted as /home/node/.openclaw)
│           └── workspace/  # Agent workspace files (SOUL.md, MEMORY.md, etc.)
├── Dockerfile              # Launcher image (not used for agent containers)
├── Dockerfile.openclaw     # Extended openclaw image with Solana CLI
├── .env                    # Host env vars (LAUNCHER_TOKEN, API keys, etc.)
└── ARCHITECTURE.md         # This file
```

## Instance Lifecycle

1. **Launch** (`POST /api/launch`): Accepts `pubkey` and optional `telegram_bot_token`. Creates instance directory, writes config from template, seeds workspace from templates, launches container.
2. **Stop** (`POST /api/stop`): Stops container, preserves all data.
3. **Start** (re-launch existing): Starts stopped container with existing config.
4. **Destroy** (`POST /api/destroy`): Removes container and DB entry. Workspace files remain on disk.

## Gateway Access

| Method | Details |
|--------|---------|
| Telegram | Per-instance bot token, DM allowlist policy |
| Control UI | HTTP on assigned port, `dangerouslyDisableDeviceAuth: true` for non-HTTPS access |
| API | Bearer token auth (`OPENCLAW_GATEWAY_TOKEN`) |
