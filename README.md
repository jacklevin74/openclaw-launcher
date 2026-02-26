# OpenClaw Launcher

**Wallet-Linked Docker Orchestrator for X1 Validator AI Agents**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub](https://img.shields.io/badge/GitHub-jacklevin74%2Fopenclaw--launcher-blue)](https://github.com/jacklevin74/openclaw-launcher)

Deploy isolated OpenClaw instances tied to SVM wallet public keys. Each validator gets their own personal AI agent with dedicated resources, configuration, and workspace.

---

## Overview

**What it does:**
- Deploys unique OpenClaw instances per wallet address
- Each instance runs in isolated Docker container
- Automatic resource management (CPU, memory, ports)
- Web UI for deployment and monitoring
- Maximum 20 concurrent instances (configurable)

**Use case:**
X1 validators can spin up their own AI agent without manual OpenClaw setup. Your wallet is your identity — deploy once, access anywhere.

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

**Start/Stop:**  
- Use the web UI to start/stop your instance
- Stopped instances preserve all data (workspace, config, memory)
- Restart anytime with same wallet address

**Resource Limits:**
- **CPU:** Shared across all instances
- **Memory:** Monitored per-container
- **Storage:** Isolated workspace per instance
- **Max instances:** 20 total on this host

**Your Data:**
- **Workspace:** `/data/instances/[INSTANCE_ID]/workspace/`
- **Config:** `/data/instances/[INSTANCE_ID]/config/`
- **Persistent:** Survives container restarts

---

## For Operators

### Installation

**Clone the repository:**
```bash
git clone https://github.com/jacklevin74/openclaw-launcher.git
cd openclaw-launcher
```

**Install dependencies:**
```bash
pip3 install -r requirements.txt
```

### Prerequisites

**System Requirements:**
- Linux host (tested on Ubuntu)
- Docker installed and running
- Python 3.8+
- 32GB+ RAM recommended for multiple instances
- 500GB+ storage

**Docker Image:**
Build OpenClaw image first:
```bash
docker build -t openclaw:local /path/to/openclaw
```

### Running the Launcher

**Start server:**
```bash
cd /home/jack/.openclaw/workspace/openclaw-launcher
python3 server.py
```

**Default port:** 8780  
**Access:** `http://localhost:8780`

**Background mode:**
```bash
nohup python3 server.py > launcher.log 2>&1 &
```

### Configuration

**Edit `server.py` constants:**

```python
BASE_PORT = 19000          # First instance port
MAX_INSTANCES = 20         # Safety limit
OPENCLAW_IMAGE = "openclaw:local"  # Docker image name
```

**Port allocation:**
- **Launcher UI:** 8780
- **Instance 1:** 19000
- **Instance 2:** 19001
- **Instance N:** 19000 + (N-1)

### Database

**Location:** `data/instances.json`

**Structure:**
```json
{
  "instances": {
    "60839bdbe7f2": {
      "pubkey": "aVuLr2twoecnZGWqHFVtRtPM6W5iwSPfHRr9cpp9mMf",
      "port": 19000,
      "gateway_token": "abc123...",
      "created_at": 1708473600,
      "last_started": 1708473600,
      "status": "running"
    }
  }
}
```

**Backup:**
```bash
cp data/instances.json data/instances.json.backup
```

---

## Architecture

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
Generate gateway token (48 hex chars)
   ↓
Write openclaw.json config
   ↓
Docker run:
   - Image: openclaw:local
   - Name: openclaw-[ID]
   - Port: 19000+
   - Volumes: config, workspace
   ↓
Update instances.json database
   ↓
Return instance details to user
```

### Container Configuration

Each instance is launched with hardened defaults:

**Resource limits (per instance):**
- **Memory:** 512MB hard limit (no swap)
- **CPU:** 0.5 cores (`nano_cpus=500_000_000`)
- These prevent any single instance from starving others

**Security hardening:**
- All Linux capabilities dropped (`--cap-drop ALL`)
- Only `NET_BIND_SERVICE` re-added (needed for port binding)
- `--security-opt no-new-privileges` — blocks SUID/SGID privilege escalation
- Bound only to the Tailscale IP (`100.x.x.x`) — not reachable from LAN

**Network isolation:**
- Internal port: 18789 (OpenClaw gateway default)
- External port: 19000+ (mapped dynamically, Tailscale-only)
- User: `node` (inside container)
- Restart policy: `unless-stopped`

**Generated Docker run (equivalent):**
```bash
docker run -d \
  --name openclaw-[INSTANCE_ID] \
  --cap-drop ALL --cap-add NET_BIND_SERVICE \
  --security-opt no-new-privileges \
  --memory 512m --memory-swap 512m \
  --cpus 0.5 \
  -p 100.x.x.x:[PORT]:18789 \
  -v [CONFIG_DIR]:/home/node/.openclaw \
  -v [WORKSPACE_DIR]:/home/node/.openclaw/workspace \
  --restart unless-stopped \
  -e HOME=/home/node \
  -e OPENCLAW_GATEWAY_TOKEN=[TOKEN] \
  openclaw:local \
  node dist/index.js gateway --bind lan --port 18789
```

### Workspace Seeding

On first deploy, the launcher seeds the instance workspace from `templates/workspace/`:

```
templates/
└── workspace/
    ├── SOUL.md        # Default agent persona
    ├── AGENTS.md      # Behavioral guidelines
    └── BOOTSTRAP.md   # First-run setup instructions
```

Files are only copied if they don't already exist — safe to redeploy without overwriting user data.

**IDENTITY.md** is always generated fresh per instance:
```markdown
# Identity

- **Wallet:** `aVuLr2twoecnZGWqHFVtRtPM6W5iwSPfHRr9cpp9mMf`
- **Instance:** `60839bdbe7f2`
- **Created:** 2026-02-21 03:49:00 UTC
```

### Token Masking

The gateway token in instance details is masked in the web UI (shown as `••••••••...`). The full token is only returned once at launch time and stored in `instances.json`. Users should copy it immediately on first deploy.

---

## API Reference

### Endpoints

**`GET /`**  
Web UI (main dashboard)

**`GET /docs`**  
Rendered README documentation (HTML)

**`GET /api/instances`**  
List all instances with live Docker status

**Response:**
```json
{
  "instances": [
    {
      "id": "60839bdbe7f2",
      "pubkey": "aVuLr...",
      "port": 19000,
      "status": "running",
      "created": 1708473600,
      "last_started": 1708473600,
      "container_id": "a1b2c3d4e5f6"
    }
  ]
}
```

**`POST /api/launch`**  
Deploy a new instance or restart a stopped one

**Request:**
```json
{
  "pubkey": "aVuLr2twoecnZGWqHFVtRtPM6W5iwSPfHRr9cpp9mMf"
}
```

**Response (new instance):**
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

**Response (already running):**
```json
{
  "error": "Instance already running",
  "instance": { ... }
}
```
HTTP 409 Conflict

**`POST /api/stop`**  
Stop a running instance (data preserved)

**Request:**
```json
{ "pubkey": "aVuLr..." }
```

**Response:**
```json
{ "status": "stopped", "id": "60839bdbe7f2" }
```

**`POST /api/destroy`**  
Stop and permanently remove a container (data preserved on disk)

**Request:**
```json
{ "pubkey": "aVuLr..." }
```

**Response:**
```json
{ "status": "destroyed", "id": "60839bdbe7f2" }
```

**`GET /api/stats/[INSTANCE_ID]`**  
Live CPU and memory stats for a running container

**Response:**
```json
{
  "status": "running",
  "stats": {
    "cpu": "2.34%",
    "mem": "312.5MiB / 512.0MiB",
    "mem_pct": "61.04%"
  }
}
```

**`GET /api/logs/[INSTANCE_ID]?lines=50`**  
Fetch recent container log output

**Response:**
```json
{
  "logs": "[2026-02-21 03:49:12] Gateway listening on port 18789\n..."
}
```

**`GET /api/files/[INSTANCE_ID]`**  
List workspace `.md` files for an instance

**Response:**
```json
{ "files": ["SOUL.md", "MEMORY.md", "IDENTITY.md"] }
```

**`GET /api/files/[INSTANCE_ID]/[filename]`**  
Read a workspace file (`.md` or `.json` only, no path traversal)

**Response:**
```json
{
  "content": "# Identity\n...",
  "filename": "IDENTITY.md",
  "exists": true
}
```

**`PUT /api/files/[INSTANCE_ID]/[filename]`**  
Write/update a workspace file

**Request:**
```json
{ "content": "# Updated content\n..." }
```

**Response:**
```json
{ "ok": true }
```

---

## Monitoring

### Container Status

**Check specific instance:**
```bash
docker ps -f name=openclaw-60839bdbe7f2
docker logs openclaw-60839bdbe7f2
docker stats openclaw-60839bdbe7f2
```

**Check all instances:**
```bash
docker ps -f name=openclaw-*
```

### Resource Usage

**Via web UI:**
- Dashboard shows CPU%, memory per instance
- Auto-refreshes every 30s

**Via CLI:**
```bash
docker stats --no-stream $(docker ps -f name=openclaw- -q)
```

### Logs

**Launcher logs:**
```bash
tail -f launcher.log  # if running in background
```

**Instance logs:**
```bash
docker logs -f openclaw-[INSTANCE_ID]
```

---

## Troubleshooting

### Instance won't start

**Check Docker:**
```bash
docker ps -a -f name=openclaw-[ID]
docker logs openclaw-[ID]
```

**Common issues:**
- Port already in use → Check `instances.json`, kill conflicting process
- Out of memory → Stop other instances, increase host RAM
- Image missing → Build `openclaw:local` Docker image

**Force restart:**
```bash
docker stop openclaw-[ID]
docker rm openclaw-[ID]
# Then redeploy via web UI
```

### "Maximum instances reached"

**Current limit:** 20 instances

**Increase limit:**
Edit `server.py`:
```python
MAX_INSTANCES = 50  # Or whatever your hardware supports
```

**Check active instances:**
```bash
curl http://localhost:8780/api/instances | jq '.instances | length'
```

### Database corruption

**Symptoms:**
- Instances.json malformed
- Missing instance entries
- Port conflicts

**Fix:**
```bash
# Backup current state
cp data/instances.json data/instances.json.broken

# Rebuild from Docker
python3 -c "
import json
import subprocess

result = subprocess.run(
    ['docker', 'ps', '-a', '--filter', 'name=openclaw-', '--format', '{{.Names}}\t{{.Ports}}'],
    capture_output=True, text=True
)

instances = {}
for line in result.stdout.strip().split('\n'):
    if not line:
        continue
    name, ports = line.split('\t')
    iid = name.replace('openclaw-', '')
    port = int(ports.split(':')[1].split('->')[0]) if '->' in ports else 0
    instances[iid] = {'port': port, 'status': 'unknown'}

db = {'instances': instances}
print(json.dumps(db, indent=2))
" > data/instances.json
```

### Port conflicts

**Find what's using a port:**
```bash
lsof -i :19000
netstat -tulpn | grep 19000
```

**Kill process:**
```bash
kill -9 [PID]
```

**Or reassign in database:**
Edit `instances.json`, change port, restart container with new mapping.

---

## Security Considerations

### Gateway Tokens

Each instance has a **unique 48-char hex token** for authentication.

**Access control:**
- Tokens stored in `instances.json` (protect this file)
- Tokens passed via URL parameter: `?token=...`
- No session management — token is the credential

**Recommendations:**
- **Don't share tokens** — they grant full agent access
- **Rotate tokens** by redeploying instance
- **Protect instances.json** — contains all tokens

### Network Exposure

**Current setup:**
- Launcher UI: port 8780 (Tailscale only)
- Instances: ports 19000+ bound to Tailscale IP only (`100.x.x.x`)
- **Not reachable from LAN or internet** — Tailscale access required

**Production recommendations:**
- Keep Tailscale binding (default) for maximum isolation
- Add HTTPS reverse proxy (nginx/Caddy) if exposing publicly
- Rate limiting on `/api/launch` to prevent abuse
- Firewall rule: deny 19000-19020 from non-Tailscale interfaces

### Container Isolation

**What's isolated:**
- Filesystem (workspace, config — per-instance volumes)
- Process namespace
- Capabilities (all dropped except `NET_BIND_SERVICE`)
- Privilege escalation (blocked via `no-new-privileges`)
- Memory (512MB hard cap)
- CPU (0.5 core limit)

**What's shared:**
- Host kernel
- Docker daemon
- Tailscale network interface

**Risk:** 
A kernel exploit or Docker daemon vulnerability could affect other containers. Limit to trusted wallet holders. Do not run on a machine with other sensitive workloads.

### File API Safety

The file editor API (`/api/files/`) enforces strict access controls:
- **Whitelist extensions:** `.md` and `.json` only
- **No path traversal:** `/` and `..` are rejected
- **Max filename length:** 64 chars
- **Instance scoped:** each request is validated against `instances.json` before filesystem access

---

## Maintenance

### Backups

**Critical files:**
```bash
# Database
cp data/instances.json backups/instances-$(date +%Y%m%d).json

# All instance data
tar -czf backups/instances-$(date +%Y%m%d).tar.gz data/instances/
```

**Schedule daily:**
```bash
0 3 * * * /path/to/backup-launcher.sh
```

### Updates

**Update OpenClaw image:**
```bash
# Build new image
docker build -t openclaw:local /path/to/openclaw

# Restart instances (one at a time)
docker restart openclaw-[ID]
```

**Update launcher code:**
```bash
# Stop launcher
pkill -f server.py

# Update server.py
git pull  # or manual edit

# Restart launcher
python3 server.py &
```

### Cleanup

**Remove stopped instances:**
```bash
docker container prune -f --filter "name=openclaw-"
```

**Remove old workspace data:**
```bash
# Find instances not in database
# Compare data/instances/* vs instances.json
# Delete orphaned directories
```

---

## Development

### Local Testing

```bash
# Run without Docker (for UI dev)
python3 server.py

# Test with mock instances
curl -X POST http://localhost:8780/api/launch \
  -H "Content-Type: application/json" \
  -d '{"pubkey":"test123abc456"}'
```

### Adding Features

**Common extensions:**
- Custom resource limits per instance
- Billing/usage tracking
- Auto-scaling (spawn more when needed)
- Health checks (ping instances periodically)
- Metrics export (Prometheus, Grafana)

**Entry points:**
- `server.py` — main Flask app
- `templates/index.html` — web UI
- `data/instances.json` — state database

---

## Support

**Issues:**
- Check logs: `docker logs openclaw-[ID]`
- Check this README troubleshooting section
- Contact: Jack Levin (@mrJackLevin on X)

**Source:**
- OpenClaw: https://github.com/openclaw/openclaw
- Launcher: (this repository)

**Community:**
- X1 Validators Telegram: (group link)
- X1 Discord: https://discord.com/invite/clawd

---

## License

Same as OpenClaw core. Check main repository for details.

---

**Built for X1 Validators by Jack Levin**  
*Making AI agents accessible, one wallet at a time.* 🎩
