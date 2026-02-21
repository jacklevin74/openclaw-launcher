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

**Docker command (generated):**
```bash
docker run -d \
  --name openclaw-[INSTANCE_ID] \
  -p [PORT]:18789 \
  -v [CONFIG_DIR]:/home/node/.openclaw \
  -v [WORKSPACE_DIR]:/home/node/.openclaw/workspace \
  --restart unless-stopped \
  openclaw:local
```

**Environment:**
- Internal port: 18789 (OpenClaw gateway default)
- External port: 19000+ (mapped dynamically)
- User: `node` (inside container)
- Restart policy: `unless-stopped`

---

## API Reference

### Endpoints

**`GET /`**  
Web UI (main dashboard)

**`GET /api/instances`**  
List all instances with status

**Response:**
```json
{
  "instances": [
    {
      "id": "60839bdbe7f2",
      "pubkey": "aVuLr...",
      "port": 19000,
      "status": "running",
      "cpu": "12.5%",
      "mem": "1.2GB / 4GB",
      "mem_pct": "30%",
      "created_at": 1708473600,
      "last_started": 1708473600
    }
  ]
}
```

**`POST /api/launch`**  
Deploy or restart instance

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
    "access_url": "http://host:19000/?token=abc123..."
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

**`POST /api/stop/[INSTANCE_ID]`**  
Stop running instance

**Response:**
```json
{
  "message": "Instance stopped",
  "id": "60839bdbe7f2"
}
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
- Launcher on port 8780 (Tailscale MagicDNS)
- Instances on ports 19000+ (same network)

**Production recommendations:**
- Firewall rules to limit access
- HTTPS reverse proxy (nginx/Caddy)
- VPN/Tailscale for remote access
- Rate limiting on API endpoints

### Container Isolation

**What's isolated:**
- Filesystem (workspace, config)
- Process namespace
- Network (ports mapped)

**What's shared:**
- Host resources (CPU, memory)
- Docker daemon access
- Host network (via port mapping)

**Risk:** 
Compromised instance could affect other containers or host. Limit to trusted wallet holders only.

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
