/**
 * OpenClaw Launcher — Wallet-Linked Docker Orchestrator
 * Deploys unique OpenClaw instances linked to SVM wallet public keys.
 *
 * TypeScript/Express rewrite of the original Python/Flask server.
 */

import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { Marked } from "marked";

import { authMiddleware, validateWsToken } from "./auth.js";
import { loadDb, withLockedDb } from "./db.js";
import type { Instance } from "./db.js";
import {
  walletToId,
  containerName,
  getContainerStatus,
  getContainerStats,
  launchContainer,
  startContainer,
  stopContainer,
  destroyContainer,
  getContainerLogs,
  streamContainerLogs,
} from "./docker.js";
import { statusCache, restartCounters, startReconciler } from "./reconciler.js";
import { formatMetrics } from "./metrics.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_DIR = resolve(".");
const DATA_DIR = resolve("data");
const INSTANCES_DIR = resolve(DATA_DIR, "instances");
const BASE_PORT = 19000;
const MAX_INSTANCES = 20;
const PORT = parseInt(process.env.PORT || "8780", 10);
const TAILSCALE_IP = process.env.TAILSCALE_IP || "100.118.141.107";

// Ensure directories exist
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(INSTANCES_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// Auth middleware — checks all /api/ routes
app.use(authMiddleware);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getNextPort(instances: Record<string, Instance>): number {
  const usedPorts = new Set(
    Object.values(instances)
      .map((inst) => inst.port)
      .filter(Boolean)
  );
  let port = BASE_PORT;
  while (usedPorts.has(port)) port++;
  return port;
}

function cachedStatus(instanceId: string): string {
  const entry = statusCache.get(instanceId);
  if (entry) return entry.status;
  // Cache not populated yet — return unknown (live check is async)
  return "unknown";
}

function safeFilename(filename: string): boolean {
  return (
    (filename.endsWith(".md") || filename.endsWith(".json")) &&
    !filename.includes("/") &&
    !filename.includes("\\") &&
    !filename.includes("..") &&
    filename.length <= 64
  );
}

function dockerUnreachableError(): { error: string } {
  return { error: "Docker daemon is unreachable. Is the Docker service running?" };
}

/**
 * Seed workspace from templates/workspace/ if it exists.
 */
function seedWorkspace(workspaceDir: string): void {
  const tmplDir = resolve(BASE_DIR, "templates", "workspace");
  if (!existsSync(tmplDir)) return;
  try {
    const entries = readdirSync(tmplDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const dest = join(workspaceDir, entry.name);
      if (!existsSync(dest)) {
        copyFileSync(join(tmplDir, entry.name), dest);
      }
    }
  } catch {
    // Never break a deploy over missing templates
  }
}

// ---------------------------------------------------------------------------
// Routes — Static & Pages
// ---------------------------------------------------------------------------

// Serve frontend SPA
app.get("/", (_req, res) => {
  res.sendFile(resolve("public", "index.html"));
});

// Docs page — render README.md as HTML in the docs template
app.get("/docs", (_req, res) => {
  const readmePath = resolve(BASE_DIR, "README.md");
  if (!existsSync(readmePath)) {
    res.status(404).send("Documentation not found");
    return;
  }

  const readmeContent = readFileSync(readmePath, "utf-8");
  const marked = new Marked();
  const htmlContent = marked.parse(readmeContent) as string;

  // Read the docs template and inject content
  const templatePath = resolve("public", "docs.html");
  if (existsSync(templatePath)) {
    const template = readFileSync(templatePath, "utf-8");
    res.send(template.replace("{{ content }}", htmlContent));
  } else {
    // Inline fallback — same style as the original Jinja template
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>OpenClaw Docs</title>
<style>body{font-family:sans-serif;max-width:900px;margin:0 auto;padding:32px;background:#0a0a0f;color:#e0e0e8;}
a{color:#818cf8;}</style></head><body>${htmlContent}</body></html>`);
  }
});

// Health check
app.get("/health", (_req, res) => {
  const db = loadDb();
  res.json({ ok: true, instances: Object.keys(db.instances).length });
});

// Prometheus metrics (no auth required but NO pubkeys in labels)
app.get("/metrics", (_req, res) => {
  res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(formatMetrics());
});

// ---------------------------------------------------------------------------
// Routes — API
// ---------------------------------------------------------------------------

// List all instances (fast path using reconciler cache)
app.get("/api/instances", (_req, res) => {
  const db = loadDb();
  const instances = Object.entries(db.instances).map(([iid, inst]) => {
    const status = cachedStatus(iid);
    // Return a copy without gateway_token (sensitive credential)
    const { gateway_token, ...safe } = inst;
    return { ...safe, id: iid, status };
  });
  res.json({ instances });
});

// Launch (or restart) an instance
app.post("/api/launch", async (req, res) => {
  const pubkey = (req.body?.pubkey || "").trim();

  if (!pubkey || pubkey.length < 32 || pubkey.length > 64) {
    res.status(400).json({ error: "Invalid wallet public key" });
    return;
  }

  const iid = walletToId(pubkey);

  try {
    const result = await withLockedDb(async (db) => {
      // Check if already exists
      if (iid in db.instances) {
        const existing = db.instances[iid];
        const cname = containerName(iid);
        const status = await getContainerStatus(cname);

        if (status === "docker_unreachable") {
          return { code: 503, body: dockerUnreachableError() };
        }

        if (status === "running") {
          const { gateway_token, ...safe } = existing;
          return {
            code: 409,
            body: {
              error: "Instance already running",
              instance: { ...safe, id: iid, status },
            },
          };
        }

        // Exists but stopped — restart it
        try {
          await startContainer(cname);
          // Wait a moment for container to start
          await new Promise((r) => setTimeout(r, 2000));
          const newStatus = await getContainerStatus(cname);
          existing.last_started = Math.floor(Date.now() / 1000);
          // Invalidate cache so next poll reflects new state
          statusCache.delete(iid);
          // Return full data including gateway_token on (re)launch
          return {
            code: 200,
            body: { instance: { ...existing, id: iid, status: newStatus } },
          };
        } catch (err: any) {
          if (err.statusCode === 404) {
            return { code: 404, body: { error: "Container not found" } };
          }
          return { code: 503, body: dockerUnreachableError() };
        }
      }

      // Check instance limit
      if (Object.keys(db.instances).length >= MAX_INSTANCES) {
        return {
          code: 429,
          body: { error: `Maximum ${MAX_INSTANCES} instances reached` },
        };
      }

      // Create new instance
      const port = getNextPort(db.instances);
      const gatewayToken = randomBytes(24).toString("hex");
      const instanceDir = resolve(INSTANCES_DIR, iid);
      const configDir = resolve(instanceDir, "config");
      const workspaceDir = resolve(instanceDir, "workspace");
      mkdirSync(configDir, { recursive: true });
      mkdirSync(workspaceDir, { recursive: true });

      // Seed workspace from templates
      seedWorkspace(workspaceDir);

      // Write minimal openclaw config
      const ocConfig = {
        agents: {
          defaults: {
            workspace: "/home/node/.openclaw/workspace",
            bootstrapMaxChars: 30000,
            bootstrapTotalMaxChars: 80000,
          },
        },
        gateway: {
          port: 18789,
          mode: "local",
          bind: "lan",
          auth: {
            mode: "token",
            token: gatewayToken,
          },
          controlUi: {
            allowInsecureAuth: true,
          },
        },
      };
      writeFileSync(
        join(configDir, "openclaw.json"),
        JSON.stringify(ocConfig, null, 2)
      );

      // Write IDENTITY.md linked to wallet
      const now = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
      writeFileSync(
        join(workspaceDir, "IDENTITY.md"),
        `# Identity\n\n- **Wallet:** \`${pubkey}\`\n- **Instance:** \`${iid}\`\n- **Created:** ${now}\n`
      );

      // Launch container
      const cname = containerName(iid);
      try {
        const container = await launchContainer({
          name: cname,
          port,
          gatewayToken,
          configDir,
          workspaceDir,
        });

        const info = await container.inspect();
        const containerId = info.Id.slice(0, 12);

        const instanceData: Instance = {
          pubkey,
          port,
          gateway_token: gatewayToken,
          created: Math.floor(Date.now() / 1000),
          last_started: Math.floor(Date.now() / 1000),
          container_id: containerId,
        };
        db.instances[iid] = instanceData;

        // Seed cache immediately so first poll is instant
        statusCache.set(iid, {
          status: "starting",
          cpu_percent: 0,
          memory_bytes: 0,
          updated: Date.now() / 1000,
        });

        // gateway_token IS returned on launch so caller can configure dashboard
        return {
          code: 200,
          body: { instance: { ...instanceData, id: iid, status: "starting" } },
        };
      } catch (err: any) {
        if (err.statusCode) {
          return {
            code: 500,
            body: { error: `Docker launch failed: ${String(err.message || err).slice(0, 500)}` },
          };
        }
        return { code: 503, body: dockerUnreachableError() };
      }
    });

    res.status(result.code).json(result.body);
  } catch (err) {
    console.error("Launch error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Stop an instance
app.post("/api/stop", async (req, res) => {
  const pubkey = (req.body?.pubkey || "").trim();
  if (!pubkey) {
    res.status(400).json({ error: "Missing pubkey" });
    return;
  }

  const iid = walletToId(pubkey);
  const cname = containerName(iid);

  try {
    await stopContainer(cname);
    statusCache.delete(iid);
    res.json({ status: "stopped", id: iid });
  } catch (err: any) {
    if (err.statusCode === 404) {
      res.status(404).json({ error: "Container not found or already stopped" });
    } else {
      res.status(503).json(dockerUnreachableError());
    }
  }
});

// Destroy an instance (stop + remove container + remove from DB)
app.post("/api/destroy", async (req, res) => {
  const pubkey = (req.body?.pubkey || "").trim();
  if (!pubkey) {
    res.status(400).json({ error: "Missing pubkey" });
    return;
  }

  const iid = walletToId(pubkey);
  const cname = containerName(iid);

  try {
    await destroyContainer(cname);
  } catch (err: any) {
    if (err.statusCode !== 404) {
      res.status(503).json(dockerUnreachableError());
      return;
    }
    // 404 is fine — container might already be gone
  }

  try {
    await withLockedDb((db) => {
      if (iid in db.instances) {
        delete db.instances[iid];
      }
    });
  } catch (err) {
    console.error("DB error during destroy:", err);
  }

  statusCache.delete(iid);
  restartCounters.delete(iid);

  res.json({ status: "destroyed", id: iid });
});

// Live stats for a running instance
app.get("/api/stats/:id", async (req, res) => {
  const cname = containerName(req.params.id);
  const status = await getContainerStatus(cname);

  if (status === "docker_unreachable") {
    res.status(503).json(dockerUnreachableError());
    return;
  }

  const stats = status === "running" ? await getContainerStats(cname) : {};
  res.json({ status, stats });
});

// HTTP logs (backward compat — tail N lines)
app.get("/api/logs/:id", async (req, res) => {
  const cname = containerName(req.params.id);
  let lines = parseInt((req.query.lines as string) || "50", 10);
  if (isNaN(lines)) lines = 50;
  lines = Math.max(1, Math.min(lines, 500)); // clamp [1, 500]

  try {
    const logs = await getContainerLogs(cname, lines);
    res.json({ logs });
  } catch (err: any) {
    if (err.statusCode === 404) {
      res.status(404).json({ logs: "Container not found" });
    } else {
      res.status(503).json({ logs: "Docker daemon is unreachable" });
    }
  }
});

// ---------------------------------------------------------------------------
// File API
// ---------------------------------------------------------------------------

// List workspace .md files
app.get("/api/files/:iid", (req, res) => {
  const db = loadDb();
  if (!(req.params.iid in db.instances)) {
    res.status(404).json({ error: "Instance not found" });
    return;
  }

  const workspace = resolve(INSTANCES_DIR, req.params.iid, "workspace");
  if (!existsSync(workspace)) {
    res.json({ files: [] });
    return;
  }

  const files = readdirSync(workspace)
    .filter((f) => f.endsWith(".md"))
    .sort();
  res.json({ files });
});

// Read a file
app.get("/api/files/:iid/:filename", (req, res) => {
  const { iid, filename } = req.params;
  if (!safeFilename(filename)) {
    res.status(400).json({ error: "Invalid filename" });
    return;
  }

  const db = loadDb();
  if (!(iid in db.instances)) {
    res.status(404).json({ error: "Instance not found" });
    return;
  }

  const filePath = resolve(INSTANCES_DIR, iid, "workspace", filename);
  if (!existsSync(filePath)) {
    res.json({ content: "", filename, exists: false });
    return;
  }

  const content = readFileSync(filePath, "utf-8");
  res.json({ content, filename, exists: true });
});

// Write a file (existing only)
app.put("/api/files/:iid/:filename", (req, res) => {
  const { iid, filename } = req.params;
  if (!safeFilename(filename)) {
    res.status(400).json({ error: "Invalid filename" });
    return;
  }

  const db = loadDb();
  if (!(iid in db.instances)) {
    res.status(404).json({ error: "Instance not found" });
    return;
  }

  const filePath = resolve(INSTANCES_DIR, iid, "workspace", filename);
  if (!existsSync(filePath)) {
    res.status(403).json({ error: "Cannot create new files, only edit existing ones" });
    return;
  }

  const content = req.body?.content ?? "";
  writeFileSync(filePath, content);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// HTTP server + WebSocket
// ---------------------------------------------------------------------------

const server = createServer(app);

// WebSocket server for log streaming
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = request.url || "";

  // Must match /api/logs/:id/stream
  const match = url.match(/^\/api\/logs\/([a-f0-9]+)\/stream/);
  if (!match) {
    socket.destroy();
    return;
  }

  // Validate auth token on upgrade! (was bypassed in Python version)
  if (!validateWsToken(url)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const instanceId = match[1];

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request, instanceId);
  });
});

wss.on("connection", async (ws: WebSocket, _request: any, instanceId: string) => {
  const cname = containerName(instanceId);

  let stream: NodeJS.ReadableStream | null = null;

  try {
    stream = await streamContainerLogs(cname, 50);

    stream.on("data", (chunk: Buffer | string) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      ws.send(text);
    });

    stream.on("end", () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });

    stream.on("error", () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });
  } catch (err: any) {
    const msg =
      err.statusCode === 404
        ? "[error] Container not found\n"
        : "[error] Docker daemon unreachable\n";
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
      ws.close();
    }
    return;
  }

  // Handle client disconnect gracefully — destroy stream
  ws.on("close", () => {
    if (stream && typeof (stream as any).destroy === "function") {
      (stream as any).destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Copy docs template to public/ if it doesn't exist there
const docsTemplateSrc = resolve("templates", "docs.html");
const docsTemplateDest = resolve("public", "docs.html");
if (existsSync(docsTemplateSrc) && !existsSync(docsTemplateDest)) {
  try {
    // Convert Jinja {{ content | safe }} to {{ content }} for our simple replace
    let tmpl = readFileSync(docsTemplateSrc, "utf-8");
    tmpl = tmpl.replace("{{ content | safe }}", "{{ content }}");
    writeFileSync(docsTemplateDest, tmpl);
  } catch {
    // Non-critical
  }
}

// Start the reconciler
startReconciler();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`OpenClaw Launcher listening on 0.0.0.0:${PORT}`);
});
