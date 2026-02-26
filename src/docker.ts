/**
 * Docker container management — launch, stop, destroy, logs, stats.
 */

import { createHash } from "node:crypto";
import Dockerode from "dockerode";
import type { Readable } from "node:stream";

const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });

// Constants
export const OPENCLAW_IMAGE = "openclaw:local";
const TAILSCALE_IP = process.env.TAILSCALE_IP || "100.118.141.107";

/**
 * Deterministic short ID from wallet pubkey — sha256 hex[:12].
 */
export function walletToId(pubkey: string): string {
  return createHash("sha256").update(pubkey).digest("hex").slice(0, 12);
}

/**
 * Container name from instance ID.
 */
export function containerName(id: string): string {
  return `openclaw-${id}`;
}

/**
 * Get live container status string.
 */
export async function getContainerStatus(name: string): Promise<string> {
  try {
    const container = docker.getContainer(name);
    const info = await container.inspect();
    return info.State?.Status || "unknown";
  } catch (err: any) {
    if (err.statusCode === 404) return "not_found";
    return "docker_unreachable";
  }
}

/**
 * Get CPU/memory stats for a running container.
 */
export async function getContainerStats(name: string): Promise<Record<string, string>> {
  try {
    const container = docker.getContainer(name);
    const stats = await container.stats({ stream: false }) as any;

    const cpuStats = stats.cpu_stats || {};
    const precpuStats = stats.precpu_stats || {};
    const cpuDelta =
      (cpuStats.cpu_usage?.total_usage || 0) -
      (precpuStats.cpu_usage?.total_usage || 0);
    const systemDelta =
      (cpuStats.system_cpu_usage || 0) -
      (precpuStats.system_cpu_usage || 0);
    const cpuCount = (cpuStats.cpu_usage?.percpu_usage?.length || 1);

    let cpuPercent = 0;
    if (systemDelta > 0 && cpuDelta > 0) {
      cpuPercent = (cpuDelta / systemDelta) * cpuCount * 100;
    }

    const memUsage = stats.memory_stats?.usage || 0;
    const memLimit = stats.memory_stats?.limit || 0;
    const memPercent = memLimit ? (memUsage / memLimit * 100) : 0;

    return {
      cpu: `${cpuPercent.toFixed(2)}%`,
      mem: `${formatBytes(memUsage)} / ${formatBytes(memLimit)}`,
      mem_pct: `${memPercent.toFixed(2)}%`,
    };
  } catch (err: any) {
    if (err.statusCode === 404) return {};
    return { error: "docker_unreachable" };
  }
}

function formatBytes(num: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  while (num >= 1024 && i < units.length - 1) {
    num /= 1024;
    i++;
  }
  return `${num.toFixed(1)}${units[i]}`;
}

export interface LaunchParams {
  name: string;
  port: number;
  gatewayToken: string;
  configDir: string;
  workspaceDir: string;
}

/**
 * Launch a new container with full security config.
 */
export async function launchContainer(params: LaunchParams): Promise<Dockerode.Container> {
  const container = await docker.createContainer({
    Image: OPENCLAW_IMAGE,
    name: params.name,
    Cmd: ["node", "dist/index.js", "gateway", "--bind", "lan", "--port", "18789"],
    Env: [
      `HOME=/home/node`,
      `TERM=xterm-256color`,
      `OPENCLAW_GATEWAY_TOKEN=${params.gatewayToken}`,
    ],
    ExposedPorts: { "18789/tcp": {} },
    HostConfig: {
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,size=64m" },
      CapDrop: ["ALL"],
      CapAdd: ["NET_BIND_SERVICE"],
      SecurityOpt: ["no-new-privileges"],
      Memory: 512 * 1024 * 1024,
      MemorySwap: 512 * 1024 * 1024,
      NanoCpus: 500_000_000,
      RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      Init: true,
      PortBindings: {
        "18789/tcp": [{ HostIp: TAILSCALE_IP, HostPort: String(params.port) }],
      },
      Binds: [
        `${params.configDir}:/home/node/.openclaw:rw`,
        `${params.workspaceDir}:/home/node/.openclaw/workspace:rw`,
      ],
    },
  });

  await container.start();
  return container;
}

/**
 * Start an existing (stopped) container by name.
 */
export async function startContainer(name: string): Promise<void> {
  const container = docker.getContainer(name);
  await container.start();
}

/**
 * Stop a running container.
 */
export async function stopContainer(name: string): Promise<void> {
  const container = docker.getContainer(name);
  await container.stop({ t: 30 });
}

/**
 * Destroy (stop + remove) a container.
 */
export async function destroyContainer(name: string): Promise<void> {
  const container = docker.getContainer(name);
  try {
    await container.stop({ t: 15 });
  } catch {
    // Already stopped or not running — fine
  }
  await container.remove({ force: true });
}

/**
 * Get container logs (tail N lines).
 */
export async function getContainerLogs(name: string, lines: number): Promise<string> {
  const container = docker.getContainer(name);
  const buffer = await container.logs({
    stdout: true,
    stderr: true,
    tail: lines,
  });
  // Dockerode returns Buffer or string
  const text = typeof buffer === "string" ? buffer : buffer.toString("utf-8");
  return text.slice(-5000);
}

/**
 * Stream container logs (tail + follow). Returns a readable stream.
 */
export async function streamContainerLogs(
  name: string,
  tail: number = 50
): Promise<Readable> {
  const container = docker.getContainer(name);
  const stream = (await container.logs({
    stdout: true,
    stderr: true,
    follow: true,
    tail,
  })) as unknown as Readable;
  return stream;
}

/**
 * Inspect a container and return its short ID.
 */
export async function inspectContainer(name: string): Promise<{ id: string }> {
  const container = docker.getContainer(name);
  const info = await container.inspect();
  return { id: info.Id.slice(0, 12) };
}
