/**
 * Docker container management — launch, stop, destroy, logs, stats.
 */

import { createHash } from "node:crypto";
import Dockerode from "dockerode";
import type { Readable } from "node:stream";
import { getProxyPort } from "./proxy.js";

const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });

// Constants
export const OPENCLAW_IMAGE = "openclaw:local";
const TAILSCALE_IP = process.env.TAILSCALE_IP || "100.118.141.107";
const PROXY_NETWORK_NAME = "openclaw-proxy-net";
const PROXY_NETWORK_SUBNET = "172.28.0.0/16";
const PROXY_NETWORK_GATEWAY = "172.28.0.1";

/** Cached gateway IP for the proxy network. */
let proxyNetworkGateway: string | null = null;

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

/**
 * Ensure the custom Docker bridge network for proxy routing exists.
 * Creates 'openclaw-proxy-net' if it doesn't exist.
 * Returns the gateway IP for proxy binding.
 */
export async function ensureProxyNetwork(): Promise<string> {
  if (proxyNetworkGateway) return proxyNetworkGateway;

  try {
    // Check if network already exists
    const networks = await docker.listNetworks({
      filters: { name: [PROXY_NETWORK_NAME] },
    });

    const existing = networks.find((n: any) => n.Name === PROXY_NETWORK_NAME);
    if (existing) {
      // Extract gateway from existing network
      const network = docker.getNetwork(existing.Id);
      const info = await network.inspect();
      const ipamConfig = info.IPAM?.Config?.[0];
      proxyNetworkGateway = ipamConfig?.Gateway || PROXY_NETWORK_GATEWAY;
      console.log(`[docker] Proxy network '${PROXY_NETWORK_NAME}' already exists (gateway: ${proxyNetworkGateway})`);
      return proxyNetworkGateway;
    }

    // Create the network
    await docker.createNetwork({
      Name: PROXY_NETWORK_NAME,
      Driver: "bridge",
      IPAM: {
        Driver: "default",
        Config: [
          {
            Subnet: PROXY_NETWORK_SUBNET,
            Gateway: PROXY_NETWORK_GATEWAY,
          },
        ],
      },
      Options: {
        "com.docker.network.bridge.enable_icc": "false", // Disable inter-container communication
      },
    });

    proxyNetworkGateway = PROXY_NETWORK_GATEWAY;
    console.log(`[docker] Created proxy network '${PROXY_NETWORK_NAME}' (gateway: ${proxyNetworkGateway})`);
    return proxyNetworkGateway;
  } catch (err: any) {
    console.error(`[docker] Failed to ensure proxy network: ${err.message}`);
    // Fall back to default gateway — proxy may still work if manually configured
    proxyNetworkGateway = PROXY_NETWORK_GATEWAY;
    return proxyNetworkGateway;
  }
}

/**
 * Get the proxy network gateway IP (or null if not initialized).
 */
export function getProxyNetworkGateway(): string | null {
  return proxyNetworkGateway;
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
 * Attaches to the proxy network and sets HTTP_PROXY/HTTPS_PROXY env vars.
 */
export async function launchContainer(params: LaunchParams): Promise<Dockerode.Container> {
  // Ensure proxy network exists and get gateway IP
  const gatewayIP = await ensureProxyNetwork();
  const proxyPort = getProxyPort();
  const proxyUrl = `http://${gatewayIP}:${proxyPort}`;

  const container = await docker.createContainer({
    Image: OPENCLAW_IMAGE,
    name: params.name,
    Cmd: ["node", "dist/index.js", "gateway", "--bind", "lan", "--port", "18789"],
    Env: [
      `HOME=/home/node`,
      `TERM=xterm-256color`,
      `OPENCLAW_GATEWAY_TOKEN=${params.gatewayToken}`,
      `HTTP_PROXY=${proxyUrl}`,
      `HTTPS_PROXY=${proxyUrl}`,
      `http_proxy=${proxyUrl}`,
      `https_proxy=${proxyUrl}`,
      `NO_PROXY=localhost,127.0.0.1`,
      `no_proxy=localhost,127.0.0.1`,
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
      NetworkMode: PROXY_NETWORK_NAME,
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
