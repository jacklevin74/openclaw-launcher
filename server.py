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
import threading
import logging
from contextlib import contextmanager
from pathlib import Path
from flask import Flask, render_template, request, jsonify, send_from_directory, Response
try:
    import markdown
except ImportError:
    markdown = None

try:
    from flask_sock import Sock
    _HAS_FLASK_SOCK = True
except ImportError:
    _HAS_FLASK_SOCK = False

import docker
from docker.errors import DockerException, NotFound, APIError

log = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

app = Flask(__name__, template_folder="templates", static_folder="static")

# WebSocket support via flask-sock (optional but strongly recommended)
if _HAS_FLASK_SOCK:
    sock = Sock(app)

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

# ---------------------------------------------------------------------------
# Health reconciler state
# ---------------------------------------------------------------------------

# Global status cache: {instance_id: {"status": str, "cpu_percent": float, "memory_bytes": int, "updated": float}}
_instance_status_cache: dict = {}
_cache_lock = threading.Lock()

# Restart counter per instance (persists in memory for the lifetime of the process)
_restart_counters: dict = {}   # {instance_id: int}

_reconciler_started = False
_reconciler_lock = threading.Lock()

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
# Health reconciler background thread
# ---------------------------------------------------------------------------

def _reconcile_once():
    """Single reconciliation pass — update status cache for all DB instances."""
    db = load_db()
    instances = db.get("instances", {})

    try:
        client = docker_client()
    except DockerException:
        log.warning("Health reconciler: Docker unreachable, skipping pass")
        return

    with _cache_lock:
        current_ids = set(instances.keys())
        # Remove stale entries
        for stale in set(_instance_status_cache.keys()) - current_ids:
            del _instance_status_cache[stale]

    for iid in instances:
        cname = container_name(iid)
        try:
            container = client.containers.get(cname)
            new_status = container.status or "unknown"

            # Detect unexpected stop (was running, now dead)
            with _cache_lock:
                prev = _instance_status_cache.get(iid, {})
                prev_status = prev.get("status", "unknown")

            if prev_status == "running" and new_status in ("exited", "dead", "removing"):
                log.warning(
                    "Health reconciler: instance %s container %s transitioned %s → %s",
                    iid, cname, prev_status, new_status
                )
                with _cache_lock:
                    _restart_counters[iid] = _restart_counters.get(iid, 0) + 1

            # Collect per-instance CPU / memory from Docker stats
            cpu_percent = 0.0
            memory_bytes = 0
            if new_status == "running":
                try:
                    stats = container.stats(stream=False)
                    cpu_stats = stats.get("cpu_stats", {})
                    precpu_stats = stats.get("precpu_stats", {})
                    cpu_delta = (
                        cpu_stats.get("cpu_usage", {}).get("total_usage", 0)
                        - precpu_stats.get("cpu_usage", {}).get("total_usage", 0)
                    )
                    system_delta = cpu_stats.get("system_cpu_usage", 0) - precpu_stats.get("system_cpu_usage", 0)
                    cpu_count = len(cpu_stats.get("cpu_usage", {}).get("percpu_usage", []) or []) or 1
                    if system_delta > 0 and cpu_delta > 0:
                        cpu_percent = (cpu_delta / system_delta) * cpu_count * 100.0
                    memory_bytes = stats.get("memory_stats", {}).get("usage", 0)
                except Exception:
                    pass

            with _cache_lock:
                _instance_status_cache[iid] = {
                    "status": new_status,
                    "cpu_percent": cpu_percent,
                    "memory_bytes": memory_bytes,
                    "updated": time.time(),
                }

        except NotFound:
            with _cache_lock:
                prev_status = _instance_status_cache.get(iid, {}).get("status", "unknown")
                if prev_status not in ("not_found", "unknown"):
                    log.warning(
                        "Health reconciler: container %s for instance %s is gone (was %s)",
                        cname, iid, prev_status
                    )
                _instance_status_cache[iid] = {
                    "status": "not_found",
                    "cpu_percent": 0.0,
                    "memory_bytes": 0,
                    "updated": time.time(),
                }
        except DockerException as e:
            log.error("Health reconciler: DockerException for %s: %s", iid, e)


def _reconciler_loop():
    """Background thread: runs _reconcile_once() every 60 seconds."""
    log.info("Health reconciler thread started")
    while True:
        try:
            _reconcile_once()
        except Exception as e:
            log.error("Health reconciler unhandled error: %s", e)
        time.sleep(60)


def start_reconciler():
    """Start the health reconciler thread exactly once."""
    global _reconciler_started
    with _reconciler_lock:
        if _reconciler_started:
            return
        _reconciler_started = True
    t = threading.Thread(target=_reconciler_loop, name="health-reconciler", daemon=True)
    t.start()
    log.info("Health reconciler started (daemon thread)")


# Register as Flask app startup hook so gunicorn also starts it
try:
    # Flask >= 2.2
    @app.before_request
    def _ensure_reconciler():
        # Only fire once per process; check_auth runs after this so we must
        # not block or raise.  We call it here rather than with_appcontext so
        # it works regardless of how the WSGI server manages threads.
        start_reconciler()
except Exception:
    pass


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
    """Check live container status (used for write paths; reads prefer the cache)."""
    try:
        client = docker_client()
        container = client.containers.get(name)
        return container.status or "unknown"
    except NotFound:
        return "not_found"
    except DockerException:
        return "docker_unreachable"


def cached_status(instance_id: str) -> str:
    """Return status from the reconciler cache, falling back to a live check."""
    with _cache_lock:
        entry = _instance_status_cache.get(instance_id)
    if entry:
        return entry["status"]
    # Cache not populated yet — live check
    return get_container_status(container_name(instance_id))


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
# Routes — Prometheus /metrics
# ---------------------------------------------------------------------------

@app.route("/metrics")
def metrics():
    """Prometheus-format metrics endpoint (text/plain; version=0.0.4)."""
    db = load_db()
    instances = db.get("instances", {})
    total = len(instances)

    running_count = 0
    lines = []

    # Header comments + gauges
    lines.append("# HELP openclaw_instances_total Total number of instances in the database")
    lines.append("# TYPE openclaw_instances_total gauge")
    lines.append(f"openclaw_instances_total {total}")

    lines.append("# HELP openclaw_instances_running Number of currently running containers")
    lines.append("# TYPE openclaw_instances_running gauge")

    lines.append("# HELP openclaw_instance_restarts_total Restart counter per instance")
    lines.append("# TYPE openclaw_instance_restarts_total counter")

    lines.append("# HELP openclaw_instance_cpu_percent CPU usage percent per instance")
    lines.append("# TYPE openclaw_instance_cpu_percent gauge")

    lines.append("# HELP openclaw_instance_memory_bytes Memory usage in bytes per instance")
    lines.append("# TYPE openclaw_instance_memory_bytes gauge")

    restart_lines = []
    cpu_lines = []
    mem_lines = []

    for iid, inst in instances.items():
        label = f'instance="{iid}",pubkey="{inst.get("pubkey","unknown")}"'

        with _cache_lock:
            cache_entry = _instance_status_cache.get(iid, {})
            restarts = _restart_counters.get(iid, 0)

        status = cache_entry.get("status", "unknown")
        if status == "running":
            running_count += 1

        cpu_pct = cache_entry.get("cpu_percent", 0.0)
        mem_bytes = cache_entry.get("memory_bytes", 0)

        restart_lines.append(f"openclaw_instance_restarts_total{{{label}}} {restarts}")
        cpu_lines.append(f"openclaw_instance_cpu_percent{{{label}}} {cpu_pct:.4f}")
        mem_lines.append(f"openclaw_instance_memory_bytes{{{label}}} {mem_bytes}")

    # Insert running count now that we've computed it
    lines.append(f"openclaw_instances_running {running_count}")

    lines.extend(restart_lines)
    lines.extend(cpu_lines)
    lines.extend(mem_lines)
    lines.append("")  # trailing newline

    body = "\n".join(lines)
    return Response(body, mimetype="text/plain; version=0.0.4; charset=utf-8")


# ---------------------------------------------------------------------------
# Routes — API
# ---------------------------------------------------------------------------

@app.route("/api/instances", methods=["GET"])
def list_instances():
    """List all instances, using the reconciler cache for status (fast path)."""
    db = load_db()
    instances = []
    for iid, inst in db["instances"].items():
        # Use cached status — avoids a Docker API call per instance on every poll
        status = cached_status(iid)
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
                new_status = get_container_status(cname)
                existing["status"] = new_status
                existing["last_started"] = int(time.time())
                # Invalidate cache so next poll reflects new state
                with _cache_lock:
                    _instance_status_cache.pop(iid, None)
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
                # Read-only root filesystem; workspace & config are rw bind mounts
                read_only=True,
                # /tmp must be writable for OpenClaw runtime scratch space
                tmpfs={"/tmp": "size=64m"},
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

    # Seed cache immediately so first poll is instant
    with _cache_lock:
        _instance_status_cache[iid] = {
            "status": "starting",
            "cpu_percent": 0.0,
            "memory_bytes": 0,
            "updated": time.time(),
        }

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
        with _cache_lock:
            _instance_status_cache.pop(iid, None)
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

    with _cache_lock:
        _instance_status_cache.pop(iid, None)
        _restart_counters.pop(iid, None)

    return jsonify({"status": "destroyed", "id": iid})


@app.route("/api/stats/<instance_id>", methods=["GET"])
def instance_stats(instance_id):
    cname = container_name(instance_id)
    status = get_container_status(cname)
    if status == "docker_unreachable":
        return jsonify(docker_unreachable_error()), 503
    stats = get_container_stats(cname) if status == "running" else {}
    return jsonify({"status": status, "stats": stats})


# ---------------------------------------------------------------------------
# Logs — HTTP (backward-compatible) + WebSocket streaming
# ---------------------------------------------------------------------------

@app.route("/api/logs/<instance_id>", methods=["GET"])
def instance_logs(instance_id):
    """HTTP GET: fetch recent logs (tail). Kept for backward compatibility."""
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


if _HAS_FLASK_SOCK:
    @sock.route("/api/logs/<instance_id>/stream")
    def stream_logs(ws, instance_id):
        """WebSocket endpoint: tail then follow container logs in real-time.

        Client connects → receives last 50 lines immediately → then live output
        until connection closes or container stops.
        """
        cname = container_name(instance_id)
        try:
            client = docker_client()
            container = client.containers.get(cname)
        except NotFound:
            try:
                ws.send("[error] Container not found\n")
            except Exception:
                pass
            return
        except DockerException:
            try:
                ws.send("[error] Docker daemon unreachable\n")
            except Exception:
                pass
            return

        try:
            log_stream = container.logs(stream=True, follow=True, tail=50)
            for chunk in log_stream:
                if isinstance(chunk, bytes):
                    chunk = chunk.decode("utf-8", errors="replace")
                # Each chunk may contain multiple lines
                ws.send(chunk)
        except Exception:
            # Connection closed by client or container stopped — both are normal
            pass
else:
    # Graceful fallback: plain HTTP SSE if flask-sock isn't installed
    @app.route("/api/logs/<instance_id>/stream")
    def stream_logs_sse(instance_id):
        """SSE fallback when flask-sock is unavailable."""
        cname = container_name(instance_id)

        def generate():
            try:
                client = docker_client()
                container = client.containers.get(cname)
                log_stream = container.logs(stream=True, follow=True, tail=50)
                for chunk in log_stream:
                    if isinstance(chunk, bytes):
                        chunk = chunk.decode("utf-8", errors="replace")
                    for line in chunk.splitlines():
                        yield f"data: {line}\n\n"
            except NotFound:
                yield "data: [error] Container not found\n\n"
            except DockerException:
                yield "data: [error] Docker daemon unreachable\n\n"

        return Response(generate(), mimetype="text/event-stream",
                        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------------------
# File API
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Start the health reconciler immediately when running directly
    start_reconciler()
    app.run(host="0.0.0.0", port=8780, debug=False)
