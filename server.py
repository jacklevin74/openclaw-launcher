#!/usr/bin/env python3
"""
OpenClaw Launcher — Wallet-Linked Docker Orchestrator
Deploys unique OpenClaw instances linked to SVM wallet public keys.
"""

import os
import json
import fcntl
import hashlib
import time
import secrets
import shutil
from contextlib import contextmanager
from pathlib import Path
from flask import Flask, render_template, request, jsonify, send_from_directory
try:
    import markdown
except ImportError:
    markdown = None

import docker
from docker.errors import DockerException, NotFound, APIError

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

# Tailscale IP — read from env, fallback to default
TAILSCALE_IP = os.environ.get("TAILSCALE_IP", "100.118.141.107")

# Auth token — if set, all /api/ routes require Authorization: Bearer <token>
LAUNCHER_TOKEN = os.environ.get("LAUNCHER_TOKEN", "")

# Docker client (lazy init)
_docker_client = None

def docker_client():
    global _docker_client
    if _docker_client is None:
        _docker_client = docker.from_env()
    return _docker_client


def docker_unreachable_error() -> dict:
    return {"error": "Docker daemon is unreachable. Is the Docker service running?"}


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------

@app.before_request
def check_auth():
    """Require Bearer token for all /api/ routes if LAUNCHER_TOKEN is set."""
    if not LAUNCHER_TOKEN:
        return  # Auth disabled — no token configured
    if not request.path.startswith("/api/"):
        return  # Only protect API routes

    # Accept token via Authorization header or ?token= query param
    auth_header = request.headers.get("Authorization", "")
    query_token = request.args.get("token", "")

    provided = ""
    if auth_header.startswith("Bearer "):
        provided = auth_header[7:]
    elif query_token:
        provided = query_token

    if not secrets.compare_digest(provided, LAUNCHER_TOKEN):
        return jsonify({"error": "Unauthorized"}), 401


# ---------------------------------------------------------------------------
# Database with file locking
# ---------------------------------------------------------------------------

@contextmanager
def locked_db():
    """Open instances.json with an exclusive lock, yield parsed data, write on exit."""
    DB_FILE.touch(exist_ok=True)  # ensure file exists
    with open(DB_FILE, "r+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            fh.seek(0)
            raw = fh.read().strip()
            db = json.loads(raw) if raw else {"instances": {}}
            yield db
            fh.seek(0)
            fh.truncate()
            fh.write(json.dumps(db, indent=2))
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def load_db():
    if DB_FILE.exists():
        raw = DB_FILE.read_text().strip()
        return json.loads(raw) if raw else {"instances": {}}
    return {"instances": {}}

def save_db(db):
    DB_FILE.write_text(json.dumps(db, indent=2))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

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
        client = docker_client()
        container = client.containers.get(name)
        return container.status or "unknown"
    except NotFound:
        return "not_found"
    except DockerException:
        return "docker_unreachable"


def get_container_stats(name: str) -> dict:
    """Get CPU/memory stats for a running container."""
    try:
        client = docker_client()
        container = client.containers.get(name)
        stats = container.stats(stream=False)

        cpu_stats = stats.get("cpu_stats", {})
        precpu_stats = stats.get("precpu_stats", {})
        cpu_delta = cpu_stats.get("cpu_usage", {}).get("total_usage", 0) - precpu_stats.get("cpu_usage", {}).get("total_usage", 0)
        system_delta = cpu_stats.get("system_cpu_usage", 0) - precpu_stats.get("system_cpu_usage", 0)
        cpu_count = len(cpu_stats.get("cpu_usage", {}).get("percpu_usage", []) or []) or 1
        cpu_percent = 0.0
        if system_delta > 0 and cpu_delta > 0:
            cpu_percent = (cpu_delta / system_delta) * cpu_count * 100.0

        mem_usage = stats.get("memory_stats", {}).get("usage", 0)
        mem_limit = stats.get("memory_stats", {}).get("limit", 0)
        mem_percent = (mem_usage / mem_limit * 100.0) if mem_limit else 0.0

        def format_bytes(num):
            for unit in ["B", "KiB", "MiB", "GiB", "TiB"]:
                if num < 1024.0:
                    return f"{num:.1f}{unit}"
                num /= 1024.0
            return f"{num:.1f}PiB"

        return {
            "cpu": f"{cpu_percent:.2f}%",
            "mem": f"{format_bytes(mem_usage)} / {format_bytes(mem_limit)}",
            "mem_pct": f"{mem_percent:.2f}%"
        }
    except NotFound:
        return {}
    except DockerException:
        return {"error": "docker_unreachable"}


# ---------------------------------------------------------------------------
# Routes — UI
# ---------------------------------------------------------------------------

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


@app.route("/health")
def health():
    return jsonify({"ok": True, "instances": len(load_db().get("instances", {}))})


# ---------------------------------------------------------------------------
# Routes — API
# ---------------------------------------------------------------------------

@app.route("/api/instances", methods=["GET"])
def list_instances():
    db = load_db()
    instances = []
    for iid, inst in db["instances"].items():
        cname = container_name(iid)
        status = get_container_status(cname)
        # Return a copy without gateway_token (sensitive credential)
        safe = {k: v for k, v in inst.items() if k != "gateway_token"}
        safe["status"] = status
        safe["id"] = iid
        instances.append(safe)
    return jsonify({"instances": instances})


@app.route("/api/launch", methods=["POST"])
def launch_instance():
    data = request.json or {}
    pubkey = data.get("pubkey", "").strip()

    if not pubkey or len(pubkey) < 32 or len(pubkey) > 64:
        return jsonify({"error": "Invalid wallet public key"}), 400

    iid = wallet_to_id(pubkey)

    with locked_db() as db:
        # Check if already exists
        if iid in db["instances"]:
            existing = db["instances"][iid]
            cname = container_name(iid)
            status = get_container_status(cname)
            if status == "docker_unreachable":
                return jsonify(docker_unreachable_error()), 503
            if status == "running":
                return jsonify({
                    "error": "Instance already running",
                    "instance": {k: v for k, v in existing.items() if k != "gateway_token"} | {"id": iid, "status": status}
                }), 409
            # Exists but stopped — restart it
            try:
                client = docker_client()
                container = client.containers.get(cname)
                container.start()
                time.sleep(2)
                existing["status"] = get_container_status(cname)
                existing["last_started"] = int(time.time())
                # Return full data including gateway_token on (re)launch
                return jsonify({"instance": {**existing, "id": iid}})
            except NotFound:
                return jsonify({"error": "Container not found"}), 404
            except DockerException:
                return jsonify(docker_unreachable_error()), 503

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

        # Seed workspace from templates/workspace/ if it exists
        try:
            tmpl_dir = BASE_DIR / "templates" / "workspace"
            if tmpl_dir.exists():
                for src in tmpl_dir.iterdir():
                    if src.is_file():
                        dest = workspace_dir / src.name
                        if not dest.exists():  # don't overwrite on restart
                            shutil.copy2(src, dest)
        except Exception:
            pass  # never break a deploy over missing templates

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
                    "allowInsecureAuth": True
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
        try:
            client = docker_client()
            container = client.containers.run(
                image=OPENCLAW_IMAGE,
                name=cname,
                detach=True,
                restart_policy={"Name": "unless-stopped"},
                init=True,
                # Drop all capabilities, add only what openclaw needs
                cap_drop=["ALL"],
                cap_add=["NET_BIND_SERVICE"],
                # Prevent privilege escalation via SUID/SGID binaries
                security_opt=["no-new-privileges"],
                environment={
                    "HOME": "/home/node",
                    "TERM": "xterm-256color",
                    "OPENCLAW_GATEWAY_TOKEN": gateway_token
                },
                volumes={
                    str(config_dir): {"bind": "/home/node/.openclaw", "mode": "rw"},
                    str(workspace_dir): {"bind": "/home/node/.openclaw/workspace", "mode": "rw"}
                },
                # Bind only to Tailscale IP — not reachable from LAN
                ports={"18789/tcp": (TAILSCALE_IP, port)},
                # Resource limits per instance
                mem_limit="512m",
                memswap_limit="512m",
                nano_cpus=500_000_000,  # 0.5 CPU
                command=["node", "dist/index.js", "gateway", "--bind", "lan", "--port", "18789"]
            )
        except APIError as e:
            return jsonify({"error": f"Docker launch failed: {str(e)[:500]}"}), 500
        except DockerException:
            return jsonify(docker_unreachable_error()), 503

        instance_data = {
            "pubkey": pubkey,
            "port": port,
            "gateway_token": gateway_token,
            "created": int(time.time()),
            "last_started": int(time.time()),
            "container_id": container.id[:12]
        }
        db["instances"][iid] = instance_data

    # gateway_token IS returned on launch so the caller can configure the dashboard link
    return jsonify({"instance": {**instance_data, "id": iid, "status": "starting"}})


@app.route("/api/stop", methods=["POST"])
def stop_instance():
    data = request.json or {}
    pubkey = data.get("pubkey", "").strip()
    if not pubkey:
        return jsonify({"error": "Missing pubkey"}), 400

    iid = wallet_to_id(pubkey)
    cname = container_name(iid)

    try:
        client = docker_client()
        container = client.containers.get(cname)
        container.stop(timeout=30)
    except NotFound:
        return jsonify({"error": "Container not found or already stopped"}), 404
    except DockerException:
        return jsonify(docker_unreachable_error()), 503

    return jsonify({"status": "stopped", "id": iid})


@app.route("/api/destroy", methods=["POST"])
def destroy_instance():
    data = request.json or {}
    pubkey = data.get("pubkey", "").strip()
    if not pubkey:
        return jsonify({"error": "Missing pubkey"}), 400

    iid = wallet_to_id(pubkey)
    cname = container_name(iid)

    try:
        client = docker_client()
        container = client.containers.get(cname)
        try:
            container.stop(timeout=15)
        except APIError:
            pass
        container.remove(force=True)
    except NotFound:
        pass
    except DockerException:
        return jsonify(docker_unreachable_error()), 503

    with locked_db() as db:
        if iid in db["instances"]:
            del db["instances"][iid]

    return jsonify({"status": "destroyed", "id": iid})


@app.route("/api/stats/<instance_id>", methods=["GET"])
def instance_stats(instance_id):
    cname = container_name(instance_id)
    status = get_container_status(cname)
    if status == "docker_unreachable":
        return jsonify(docker_unreachable_error()), 503
    stats = get_container_stats(cname) if status == "running" else {}
    return jsonify({"status": status, "stats": stats})


@app.route("/api/logs/<instance_id>", methods=["GET"])
def instance_logs(instance_id):
    cname = container_name(instance_id)
    try:
        lines = int(request.args.get("lines", "50"))
    except ValueError:
        lines = 50
    lines = min(max(lines, 1), 500)  # clamp to [1, 500]
    try:
        client = docker_client()
        container = client.containers.get(cname)
        logs = container.logs(tail=lines)
        text = logs.decode("utf-8", errors="replace")
        return jsonify({"logs": text[-5000:]})
    except NotFound:
        return jsonify({"logs": "Container not found"}), 404
    except DockerException:
        return jsonify({"logs": "Docker daemon is unreachable"}), 503


def _safe_filename(filename: str) -> bool:
    """Allow only .md/.json filenames with no path traversal."""
    return (
        filename.endswith((".md", ".json"))
        and "/" not in filename
        and "\\" not in filename
        and ".." not in filename
        and len(filename) <= 64
    )


@app.route("/api/files/<iid>", methods=["GET"])
def list_files(iid):
    db = load_db()
    if iid not in db["instances"]:
        return jsonify({"error": "Instance not found"}), 404
    workspace = INSTANCES_DIR / iid / "workspace"
    files = sorted(p.name for p in workspace.glob("*.md")) if workspace.exists() else []
    return jsonify({"files": files})


@app.route("/api/files/<iid>/<filename>", methods=["GET"])
def read_file(iid, filename):
    if not _safe_filename(filename):
        return jsonify({"error": "Invalid filename"}), 400
    db = load_db()
    if iid not in db["instances"]:
        return jsonify({"error": "Instance not found"}), 404
    path = INSTANCES_DIR / iid / "workspace" / filename
    if not path.exists():
        return jsonify({"content": "", "filename": filename, "exists": False})
    return jsonify({"content": path.read_text(errors="replace"), "filename": filename, "exists": True})


@app.route("/api/files/<iid>/<filename>", methods=["PUT"])
def write_file(iid, filename):
    if not _safe_filename(filename):
        return jsonify({"error": "Invalid filename"}), 400
    db = load_db()
    if iid not in db["instances"]:
        return jsonify({"error": "Instance not found"}), 404
    path = INSTANCES_DIR / iid / "workspace" / filename
    # Only allow editing existing files — no new file creation via API
    if not path.exists():
        return jsonify({"error": "Cannot create new files, only edit existing ones"}), 403
    data = request.json or {}
    content = data.get("content", "")
    path.write_text(content)
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8780, debug=False)
