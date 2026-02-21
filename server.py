#!/usr/bin/env python3
"""
OpenClaw Launcher — Wallet-Linked Docker Orchestrator
Deploys unique OpenClaw instances linked to SVM wallet public keys.
"""

import os
import json
import uuid
import subprocess
import hashlib
import time
import secrets
from pathlib import Path
from flask import Flask, render_template, request, jsonify, send_from_directory
try:
    import markdown
except ImportError:
    markdown = None

app = Flask(__name__, template_folder="templates", static_folder="static")

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
INSTANCES_DIR = DATA_DIR / "instances"
DATA_DIR.mkdir(exist_ok=True)
INSTANCES_DIR.mkdir(exist_ok=True)

DB_FILE = DATA_DIR / "instances.json"
OPENCLAW_IMAGE = "openclaw:local"
BASE_PORT = 19000  # Instances get ports 19000+
MAX_INSTANCES = 20  # Safety limit for this NUC

def load_db():
    if DB_FILE.exists():
        return json.loads(DB_FILE.read_text())
    return {"instances": {}}

def save_db(db):
    DB_FILE.write_text(json.dumps(db, indent=2))

def wallet_to_id(pubkey: str) -> str:
    """Deterministic short ID from wallet pubkey."""
    return hashlib.sha256(pubkey.encode()).hexdigest()[:12]

def get_next_port(db):
    used_ports = {inst["port"] for inst in db["instances"].values() if "port" in inst}
    port = BASE_PORT
    while port in used_ports:
        port += 1
    return port

def container_name(instance_id: str) -> str:
    return f"openclaw-{instance_id}"

def get_container_status(name: str) -> str:
    try:
        result = subprocess.run(
            ["docker", "inspect", "--format", "{{.State.Status}}", name],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except:
        pass
    return "not_found"

def get_container_stats(name: str) -> dict:
    """Get CPU/memory stats for a running container."""
    try:
        result = subprocess.run(
            ["docker", "stats", "--no-stream", "--format",
             '{"cpu":"{{.CPUPerc}}","mem":"{{.MemUsage}}","mem_pct":"{{.MemPerc}}"}',
             name],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout.strip())
    except:
        pass
    return {}


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/docs")
def docs():
    readme_path = BASE_DIR / "README.md"
    if not readme_path.exists():
        return "Documentation not found", 404
    
    readme_content = readme_path.read_text()
    
    # Convert markdown to HTML if library available
    if markdown:
        html_content = markdown.markdown(
            readme_content,
            extensions=['fenced_code', 'tables', 'toc']
        )
    else:
        # Fallback: wrap in <pre> if markdown not installed
        html_content = f"<pre>{readme_content}</pre>"
    
    return render_template("docs.html", content=html_content)


@app.route("/api/instances", methods=["GET"])
def list_instances():
    db = load_db()
    instances = []
    for iid, inst in db["instances"].items():
        cname = container_name(iid)
        status = get_container_status(cname)
        inst["status"] = status
        inst["id"] = iid
        instances.append(inst)
    return jsonify({"instances": instances})


@app.route("/api/launch", methods=["POST"])
def launch_instance():
    data = request.json or {}
    pubkey = data.get("pubkey", "").strip()

    if not pubkey or len(pubkey) < 32 or len(pubkey) > 64:
        return jsonify({"error": "Invalid wallet public key"}), 400

    db = load_db()
    iid = wallet_to_id(pubkey)

    # Check if already exists
    if iid in db["instances"]:
        existing = db["instances"][iid]
        cname = container_name(iid)
        status = get_container_status(cname)
        if status == "running":
            return jsonify({
                "error": "Instance already running",
                "instance": {**existing, "id": iid, "status": status}
            }), 409
        # Exists but stopped — restart it
        subprocess.run(["docker", "start", cname], capture_output=True, timeout=15)
        time.sleep(2)
        existing["status"] = get_container_status(cname)
        existing["last_started"] = int(time.time())
        save_db(db)
        return jsonify({"instance": {**existing, "id": iid}})

    if len(db["instances"]) >= MAX_INSTANCES:
        return jsonify({"error": f"Maximum {MAX_INSTANCES} instances reached"}), 429

    # Create new instance
    port = get_next_port(db)
    gateway_token = secrets.token_hex(24)
    instance_dir = INSTANCES_DIR / iid
    config_dir = instance_dir / "config"
    workspace_dir = instance_dir / "workspace"
    config_dir.mkdir(parents=True, exist_ok=True)
    workspace_dir.mkdir(parents=True, exist_ok=True)

    # Write minimal openclaw config
    oc_config = {
        "agents": {
            "defaults": {
                "workspace": "/home/node/.openclaw/workspace",
                "bootstrapMaxChars": 30000,
                "bootstrapTotalMaxChars": 80000
            }
        },
        "gateway": {
            "port": 18789,
            "mode": "local",
            "bind": "lan",
            "auth": {
                "mode": "token",
                "token": gateway_token
            },
            "controlUi": {
                "allowInsecureAuth": true
            }
        }
    }
    (config_dir / "openclaw.json").write_text(json.dumps(oc_config, indent=2))

    # Write IDENTITY.md linked to wallet
    (workspace_dir / "IDENTITY.md").write_text(
        f"# Identity\n\n- **Wallet:** `{pubkey}`\n- **Instance:** `{iid}`\n- **Created:** {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}\n"
    )

    cname = container_name(iid)

    # Launch container
    cmd = [
        "docker", "run", "-d",
        "--name", cname,
        "--restart", "unless-stopped",
        "--init",
        "-e", "HOME=/home/node",
        "-e", "TERM=xterm-256color",
        "-e", f"OPENCLAW_GATEWAY_TOKEN={gateway_token}",
        "-v", f"{config_dir}:/home/node/.openclaw",
        "-v", f"{workspace_dir}:/home/node/.openclaw/workspace",
        "-p", f"{port}:18789",
        OPENCLAW_IMAGE,
        "node", "dist/index.js", "gateway",
        "--bind", "lan", "--port", "18789"
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        return jsonify({"error": f"Docker launch failed: {result.stderr[:500]}"}), 500

    instance_data = {
        "pubkey": pubkey,
        "port": port,
        "gateway_token": gateway_token,
        "created": int(time.time()),
        "last_started": int(time.time()),
        "container_id": result.stdout.strip()[:12]
    }
    db["instances"][iid] = instance_data
    save_db(db)

    return jsonify({"instance": {**instance_data, "id": iid, "status": "starting"}})


@app.route("/api/stop", methods=["POST"])
def stop_instance():
    data = request.json or {}
    pubkey = data.get("pubkey", "").strip()
    if not pubkey:
        return jsonify({"error": "Missing pubkey"}), 400

    iid = wallet_to_id(pubkey)
    cname = container_name(iid)

    result = subprocess.run(["docker", "stop", cname], capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        return jsonify({"error": "Container not found or already stopped"}), 404

    return jsonify({"status": "stopped", "id": iid})


@app.route("/api/destroy", methods=["POST"])
def destroy_instance():
    data = request.json or {}
    pubkey = data.get("pubkey", "").strip()
    if not pubkey:
        return jsonify({"error": "Missing pubkey"}), 400

    db = load_db()
    iid = wallet_to_id(pubkey)
    cname = container_name(iid)

    subprocess.run(["docker", "stop", cname], capture_output=True, timeout=15)
    subprocess.run(["docker", "rm", "-f", cname], capture_output=True, timeout=15)

    if iid in db["instances"]:
        del db["instances"][iid]
        save_db(db)

    return jsonify({"status": "destroyed", "id": iid})


@app.route("/api/stats/<instance_id>", methods=["GET"])
def instance_stats(instance_id):
    cname = container_name(instance_id)
    status = get_container_status(cname)
    stats = get_container_stats(cname) if status == "running" else {}
    return jsonify({"status": status, "stats": stats})


@app.route("/api/logs/<instance_id>", methods=["GET"])
def instance_logs(instance_id):
    cname = container_name(instance_id)
    lines = request.args.get("lines", "50")
    try:
        result = subprocess.run(
            ["docker", "logs", "--tail", lines, cname],
            capture_output=True, text=True, timeout=10
        )
        return jsonify({"logs": result.stdout[-5000:] + result.stderr[-2000:]})
    except:
        return jsonify({"logs": "Failed to fetch logs"}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8780, debug=False)
