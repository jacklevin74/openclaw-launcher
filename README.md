# OpenClaw Launcher

**Wallet-Linked Docker Orchestrator for X1 Validator AI Agents**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub](https://img.shields.io/badge/GitHub-jacklevin74%2Fopenclaw--launcher-blue)](https://github.com/jacklevin74/openclaw-launcher)

Deploy isolated OpenClaw instances tied to SVM wallet public keys. Each validator gets their own personal AI agent with dedicated resources, configuration, and workspace.

---

## Overview

**What it does:**
- Deploys unique OpenClaw instances per wallet address
- Each instance runs in an isolated, hardened Docker container
- Automatic resource management (CPU, memory, ports)
- Web UI for deployment and monitoring
- Real-time log streaming via WebSocket
- Prometheus metrics endpoint
- Health reconciler with automatic state tracking
- Maximum 20 concurrent instances (configurable)

**Use case:**
X1 validators can spin up their own AI agent without manual OpenClaw setup. Your wallet is your identity — deploy once, access anywhere.

**Stack:** TypeScript, Express, WebSocket (ws), Dockerode, Node.js 24

---

## For End Users (Validators)

### How to Deploy Your Agent

1. **Visit the launcher:**
   `http://jack-nucbox-m6-ultra.tail515dc.ts.net:8780/`
   *(Click "📖 Docs" in the header to view this guide)*

2. **Enter your X1/Solana wallet public key**
   Example: `aVuLr2twoecnZGWqHFVtRtPM6W5iwSPfHRr9cpp9mMf`

3. **Click "Deploy"**
   - System creates a unique instance ID (hash of your pubkey)
   - Spins up Docker container
   - Assigns dedicated port (19000+)
   - Generates gateway auth token

4. **Access your agent:**
   - **URL:** `http://jack-nucbox-m6-ultra.tail515dc.ts.net:[PORT]/`
   - **Token:** Shown in instance details
   - **Web UI:** `http://...[PORT]/?token=[YOUR_TOKEN]`

### Instance Management

- Use the web UI to start/stop your instance
- Stopped instances preserve all data (workspace, config, memory)
- Restart anytime with same wallet address
- Live logs via WebSocket streaming in the UI

**Your Data:**
- **Workspace:** `data/instances/[INSTANCE_ID]/workspace/`
- **Config:** `data/instances/[INSTANCE_ID]/config/`
- **Persistent:** Survives container restarts

---

## For Operators

### Prerequisites

- Linux host (tested on Ubuntu)
- Docker installed and running
- Node.js 20+ (24 recommended)
- 32GB+ RAM recommended for multiple instances
- 500GB+ storage

### Installation

```bash
git clone https://github.com/jacklevin74/openclaw-launcher.git
cd openclaw-launcher
npm install
```

**Build the OpenClaw Docker image first:**
```bash
docker build -t openclaw:local /path/to/openclaw
```

### Configuration

Create a `.env` file:
```bash
LAUNCHER_TOKEN=your-secret-token-here    # Required for API auth
TAILSCALE_IP=100.118.141.107             # Optional, default shown
PORT=8780                                # Optional, default 8780
```

**Constants** (edit `src/server.ts`):
```typescript
const BASE_PORT = 19000;        // First instance port
const MAX_INSTANCES = 20;       // Safety limit
```

**Image name** (edit `src/docker.ts`):
```typescript
export const OPENCLAW_IMAGE = "openclaw:local";
```

### Running

**Development:**
```bash
npm run dev
```

**Production:**
```bash
npm run build
npm start
```

**With Docker Compose:**
```bash
docker compose up -d
```

**Access:** `http://localhost:8780/?token=your-secret-token-here`

---

## Architecture

### Project Structure

```
openclaw-launcher/
├── src/
│   ├── server.ts       # Express app, routes, WebSocket setup
│   ├── auth.ts         # Bearer token middleware + WS auth
│   ├── db.ts           # File-locked JSON database
│   ├── docker.ts       # Container lifecycle (launch, stop, destroy, logs, stats)
│   ├── reconciler.ts   # Health reconciler (60s interval)
│   └── metrics.ts      # Prometheus metrics formatter
├── public/
│   ├── index.html      # Frontend SPA (dark cyberpunk theme)
│   └── docs.html       # Documentation page template
├── templates/
│   └── workspace/      # Seed files for new instances
├── package.json
├── tsconfig.json
├── Dockerfile
└── docker-compose.yml
```

### Instance Creation Flow

```
User submits wallet pubkey
   ↓
Generate instance ID: sha256(pubkey)[:12]
   ↓
Create directories:
   - data/instances/[ID]/config/
   - data/instances/[ID]/workspace/
   ↓
Seed workspace from templates/workspace/
   ↓
Generate gateway token (48 hex chars)
   ↓
Write openclaw.json config
   ↓
Docker create + start (hardened container)
   ↓
Update instances.json (file-locked)
   ↓
Return instance details + token to user
```

### Container Security

Each instance runs with hardened defaults:

| Setting | Value | Purpose |
|---------|-------|---------|
| `ReadonlyRootfs` | `true` | Immutable container filesystem |
| `Tmpfs /tmp` | `64MB` | Writable scratch space only |
| `CapDrop` | `ALL` | Drop all Linux capabilities |
| `CapAdd` | `NET_BIND_SERVICE` | Only re-add port binding |
| `SecurityOpt` | `no-new-privileges` | Block SUID/SGID escalation |
| `Memory` | `512MB` (no swap) | Per-instance hard limit |
| `CPU` | `0.5 cores` | Per-instance limit |
| `RestartPolicy` | `unless-stopped` | Auto-restart on crash |
| `Init` | `true` | Proper PID 1 signal handling |
| `PortBinding` | Tailscale IP only | Not reachable from LAN |

**Equivalent Docker run:**
```bash
docker run -d \
  --name openclaw-[ID] \
  --read-only --tmpfs /tmp:rw,size=64m \
  --cap-drop ALL --cap-add NET_BIND_SERVICE \
  --security-opt no-new-privileges \
  --memory 512m --memory-swap 512m --cpus 0.5 \
  --init --restart unless-stopped \
  -p 100.x.x.x:[PORT]:18789 \
  -v [CONFIG]:/home/node/.openclaw:rw \
  -v [WORKSPACE]:/home/node/.openclaw/workspace:rw \
  -e HOME=/home/node \
  -e OPENCLAW_GATEWAY_TOKEN=[TOKEN] \
  openclaw:local \
  node dist/index.js gateway --bind lan --port 18789
```

### Health Reconciler

A background process runs every 60 seconds:
- Checks actual Docker container status for all instances
- Updates an in-memory status cache (avoids Docker API calls on every request)
- Detects state transitions (running → exited/dead)
- Tracks restart counters per instance
- Cleans up stale cache entries

### WebSocket Log Streaming

The `/api/logs/:id/stream` endpoint provides real-time log output:
- Authenticates via `?token=` query parameter on upgrade
- Tails last 50 lines immediately on connect
- Follows new output in real-time
- Cleans up Docker log stream on client disconnect
- Frontend auto-falls back to HTTP polling if WebSocket fails

### Prometheus Metrics

`GET /metrics` returns standard Prometheus text format:

```
openclaw_instances_total 5
openclaw_instances_running 3
openclaw_instance_restarts_total{instance="60839bdbe7f2"} 0
openclaw_instance_cpu_percent{instance="60839bdbe7f2"} 2.3400
openclaw_instance_memory_bytes{instance="60839bdbe7f2"} 327680000
```

**Security:** Instance labels use ID only — no wallet addresses exposed.

---

## API Reference

### Authentication

All `/api/*` endpoints require authentication when `LAUNCHER_TOKEN` is set:

```bash
# Header auth (recommended)
curl -H "Authorization: Bearer $TOKEN" http://localhost:8780/api/instances

# Query param auth (for browser/UI)
curl http://localhost:8780/api/instances?token=$TOKEN
```

Token comparison uses `crypto.timingSafeEqual` (constant-time, safe against timing attacks).

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | No | Web UI dashboard |
| `GET` | `/docs` | No | Rendered README documentation |
| `GET` | `/health` | No | Health check |
| `GET` | `/metrics` | No | Prometheus metrics |
| `GET` | `/api/instances` | Yes | List all instances |
| `POST` | `/api/launch` | Yes | Deploy or restart instance |
| `POST` | `/api/stop` | Yes | Stop instance |
| `POST` | `/api/destroy` | Yes | Remove instance |
| `GET` | `/api/stats/:id` | Yes | Live CPU/memory stats |
| `GET` | `/api/logs/:id` | Yes | Fetch recent logs (HTTP) |
| `WS` | `/api/logs/:id/stream` | Yes | Stream logs (WebSocket) |
| `GET` | `/api/files/:iid` | Yes | List workspace files |
| `GET` | `/api/files/:iid/:file` | Yes | Read file |
| `PUT` | `/api/files/:iid/:file` | Yes | Edit existing file |

### Key Responses

**Launch:**
```json
{
  "instance": {
    "id": "60839bdbe7f2",
    "pubkey": "aVuLr...",
    "port": 19000,
    "gateway_token": "abc123...",
    "status": "starting"
  }
}
```

**List instances** (gateway_token is never included):
```json
{
  "instances": [
    { "id": "60839bdbe7f2", "pubkey": "aVuLr...", "port": 19000, "status": "running" }
  ]
}
```

**Stats:**
```json
{
  "status": "running",
  "stats": { "cpu": "2.34%", "mem": "312.5MiB / 512.0MiB", "mem_pct": "61.04%" }
}
```

---

## Database

**Location:** `data/instances.json`

Protected by file locking (`proper-lockfile`) for safe concurrent access. All write operations (launch, destroy) acquire an exclusive lock before read→modify→write.

**Backup:**
```bash
cp data/instances.json data/instances.json.backup
```

---

## Monitoring

**Via web UI:** Dashboard shows status, CPU%, memory per instance. Auto-refreshes every 5 seconds.

**Via CLI:**
```bash
docker stats --no-stream $(docker ps -f name=openclaw- -q)
```

**Via Prometheus:** Scrape `http://localhost:8780/metrics`

---

## Troubleshooting

### Instance won't start
```bash
docker ps -a -f name=openclaw-[ID]
docker logs openclaw-[ID]
```

Common issues:
- Port already in use → check `instances.json`, kill conflicting process
- Out of memory → stop other instances
- Image missing → build `openclaw:local`

### "Maximum instances reached"
Current limit: 20. Change `MAX_INSTANCES` in `src/server.ts`.

### Database issues
```bash
cp data/instances.json data/instances.json.broken
echo '{"instances":{}}' > data/instances.json
```
Then redeploy instances via the UI.

---

## Development

```bash
# Dev mode (auto-reload via tsx)
npm run dev

# Type check
npx tsc --noEmit

# Build
npm run build

# Test locally
LAUNCHER_TOKEN=dev-secret npm run dev
```

---

## License

MIT

---

**Built for X1 Validators by Jack Levin** 🎩
