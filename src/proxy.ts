/**
 * Egress proxy — lightweight HTTP/HTTPS CONNECT proxy for container traffic.
 *
 * Runs in the same Node.js process as the launcher. All container traffic
 * is routed through this proxy via HTTP_PROXY/HTTPS_PROXY env vars.
 *
 * Features:
 * - Allowlist of permitted destination hosts (per-instance + global defaults)
 * - Blocks all RFC 1918, loopback, and link-local addresses
 * - DNS rebinding protection (resolve hostname, check IP, THEN connect)
 * - HTTP CONNECT tunneling for HTTPS
 * - Plain HTTP forward proxy
 * - Prometheus-compatible metrics
 *
 * TODO: API key injection at proxy layer (follow-up)
 * The proxy could inject Authorization headers for Anthropic/OpenAI/etc.
 * so containers never see the actual API keys. For HTTPS CONNECT tunnels
 * this isn't possible (encrypted), but for plain HTTP it would work.
 * A better pattern: use the proxy as a TLS-terminating MITM for specific
 * hosts, or inject keys at the openclaw gateway config level.
 */

import { createServer, IncomingMessage, ServerResponse, request as httpRequest } from "node:http";
import { connect as netConnect, Socket } from "node:net";
import { lookup } from "node:dns";
import { promisify } from "node:util";
import { URL } from "node:url";

const dnsLookup = promisify(lookup);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ProxyConfig {
  port: number;                           // default 3128
  bindAddress: string;                    // bind to Docker bridge gateway IP
  defaultAllowlist: string[];             // hosts allowed for all instances
  instanceAllowlists: Map<string, string[]>; // per-instance overrides
  blockedCIDRs: string[];                 // informational — actual check is isPrivateIP()
}

const DEFAULT_ALLOWLIST: string[] = [
  "api.anthropic.com",
  "api.openai.com",
  "api.telegram.org",
  "generativelanguage.googleapis.com",
];

let proxyConfig: ProxyConfig = {
  port: parseInt(process.env.PROXY_PORT || "3128", 10),
  bindAddress: process.env.PROXY_BIND || "0.0.0.0",
  defaultAllowlist: [...DEFAULT_ALLOWLIST],
  instanceAllowlists: new Map(),
  blockedCIDRs: [
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "127.0.0.0/8",
    "169.254.0.0/16",
  ],
};

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface ProxyMetrics {
  allowedTotal: number;
  blockedTotal: number;
  blockedDestinations: Map<string, number>;
}

export const proxyMetrics: ProxyMetrics = {
  allowedTotal: 0,
  blockedTotal: 0,
  blockedDestinations: new Map(),
};

function recordBlocked(destination: string): void {
  proxyMetrics.blockedTotal++;
  const count = proxyMetrics.blockedDestinations.get(destination) || 0;
  proxyMetrics.blockedDestinations.set(destination, count + 1);
}

function recordAllowed(): void {
  proxyMetrics.allowedTotal++;
}

/**
 * Get the top N blocked destinations.
 */
export function getTopBlockedDestinations(n: number = 10): Array<{ host: string; count: number }> {
  return Array.from(proxyMetrics.blockedDestinations.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([host, count]) => ({ host, count }));
}

// ---------------------------------------------------------------------------
// IP checking
// ---------------------------------------------------------------------------

/**
 * Check if an IP address is in a private/reserved range.
 * Blocks RFC 1918, loopback (127.0.0.0/8), and link-local (169.254.0.0/16).
 */
function isPrivateIP(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    // If we can't parse it, block it to be safe
    return true;
  }

  // 10.0.0.0/8
  if (parts[0] === 10) return true;

  // 172.16.0.0/12
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;

  // 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true;

  // 127.0.0.0/8 (loopback)
  if (parts[0] === 127) return true;

  // 169.254.0.0/16 (link-local)
  if (parts[0] === 169 && parts[1] === 254) return true;

  // 0.0.0.0/8
  if (parts[0] === 0) return true;

  return false;
}

/**
 * Check if an IPv6 address is private/loopback/link-local.
 */
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // ::1 (loopback)
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  // fe80::/10 (link-local)
  if (lower.startsWith("fe80:")) return true;
  // fc00::/7 (unique local)
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Allowlist checking
// ---------------------------------------------------------------------------

/**
 * Check if a hostname is on the allowlist for a given source.
 * sourceId can be used for per-instance allowlists in the future.
 */
function isHostAllowed(hostname: string, sourceId?: string): boolean {
  const host = hostname.toLowerCase();

  // Check per-instance allowlist first
  if (sourceId) {
    const instanceList = proxyConfig.instanceAllowlists.get(sourceId);
    if (instanceList) {
      if (instanceList.some((h) => host === h.toLowerCase() || host.endsWith("." + h.toLowerCase()))) {
        return true;
      }
    }
  }

  // Check default allowlist
  return proxyConfig.defaultAllowlist.some(
    (h) => host === h.toLowerCase() || host.endsWith("." + h.toLowerCase())
  );
}

/**
 * Resolve a hostname to an IP and verify it's not private.
 * Returns the resolved IP if safe, or throws if blocked.
 */
async function resolveAndCheck(hostname: string): Promise<string> {
  // If hostname is already an IP, check directly
  const ipv4Match = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  if (ipv4Match) {
    if (isPrivateIP(hostname)) {
      throw new Error(`Blocked: private IP ${hostname}`);
    }
    return hostname;
  }

  try {
    const result = await dnsLookup(hostname);
    const ip = typeof result === "string" ? result : result.address;
    const family = typeof result === "string" ? 4 : result.family;

    if (family === 4 && isPrivateIP(ip)) {
      throw new Error(`Blocked: ${hostname} resolves to private IP ${ip}`);
    }
    if (family === 6 && isPrivateIPv6(ip)) {
      throw new Error(`Blocked: ${hostname} resolves to private IPv6 ${ip}`);
    }

    return ip;
  } catch (err: any) {
    if (err.message?.startsWith("Blocked:")) throw err;
    throw new Error(`DNS resolution failed for ${hostname}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Source identification
// ---------------------------------------------------------------------------

/**
 * Try to identify the source container/instance from the connecting IP.
 * For now, returns the source IP as identifier. In the future, this could
 * map Docker container IPs to instance IDs.
 */
function identifySource(remoteAddress: string | undefined): string {
  return remoteAddress || "unknown";
}

// ---------------------------------------------------------------------------
// Proxy server
// ---------------------------------------------------------------------------

let proxyServer: ReturnType<typeof createServer> | null = null;

/**
 * Handle HTTP CONNECT requests (HTTPS tunneling).
 */
function handleConnect(
  req: IncomingMessage,
  clientSocket: Socket,
  head: Buffer,
): void {
  const source = identifySource(req.socket.remoteAddress);
  const target = req.url || "";
  const [hostname, portStr] = target.split(":");
  const port = parseInt(portStr, 10) || 443;

  if (!hostname) {
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.destroy();
    return;
  }

  // Check allowlist
  if (!isHostAllowed(hostname, source)) {
    console.warn(`[proxy] BLOCKED CONNECT ${hostname}:${port} from ${source}`);
    recordBlocked(hostname);
    clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    clientSocket.destroy();
    return;
  }

  // Resolve hostname and check for DNS rebinding
  resolveAndCheck(hostname)
    .then((resolvedIP) => {
      const serverSocket = netConnect(port, resolvedIP, () => {
        clientSocket.write(
          "HTTP/1.1 200 Connection Established\r\n" +
          "Proxy-Agent: openclaw-egress-proxy\r\n" +
          "\r\n"
        );
        recordAllowed();

        // Pipe data bidirectionally
        serverSocket.write(head);
        serverSocket.pipe(clientSocket);
        clientSocket.pipe(serverSocket);
      });

      serverSocket.on("error", (err) => {
        console.error(`[proxy] CONNECT tunnel error to ${hostname}:${port}: ${err.message}`);
        if (!clientSocket.destroyed) {
          clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          clientSocket.destroy();
        }
      });

      clientSocket.on("error", () => {
        serverSocket.destroy();
      });
    })
    .catch((err) => {
      console.warn(`[proxy] BLOCKED CONNECT ${hostname}:${port} from ${source}: ${err.message}`);
      recordBlocked(hostname);
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
    });
}

/**
 * Handle plain HTTP proxy requests.
 */
function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const source = identifySource(req.socket.remoteAddress);

  // Parse target from absolute URL
  let targetUrl: URL;
  try {
    targetUrl = new URL(req.url || "");
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad Request: invalid URL");
    return;
  }

  const hostname = targetUrl.hostname;
  const port = parseInt(targetUrl.port, 10) || 80;

  if (!hostname) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad Request: missing hostname");
    return;
  }

  // Check allowlist
  if (!isHostAllowed(hostname, source)) {
    console.warn(`[proxy] BLOCKED HTTP ${req.method} ${hostname}${targetUrl.pathname} from ${source}`);
    recordBlocked(hostname);
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden: destination not in allowlist");
    return;
  }

  // Resolve and check for private IPs
  resolveAndCheck(hostname)
    .then((resolvedIP) => {
      // Build forwarded request headers (strip proxy-specific headers)
      const headers = { ...req.headers };
      delete headers["proxy-connection"];
      delete headers["proxy-authorization"];
      // Rewrite host header to the target
      headers.host = targetUrl.host;

      const proxyReq = httpRequest(
        {
          hostname: resolvedIP,
          port,
          path: targetUrl.pathname + targetUrl.search,
          method: req.method,
          headers,
        },
        (proxyRes) => {
          recordAllowed();
          res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );

      proxyReq.on("error", (err) => {
        console.error(`[proxy] HTTP forward error to ${hostname}: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain" });
        }
        res.end("Bad Gateway");
      });

      req.pipe(proxyReq);
    })
    .catch((err) => {
      console.warn(`[proxy] BLOCKED HTTP ${hostname} from ${source}: ${err.message}`);
      recordBlocked(hostname);
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: destination blocked");
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the egress proxy server.
 */
export function startProxy(config?: Partial<ProxyConfig>): void {
  if (config) {
    proxyConfig = { ...proxyConfig, ...config };
    if (config.instanceAllowlists) {
      proxyConfig.instanceAllowlists = config.instanceAllowlists;
    }
  }

  proxyServer = createServer(handleRequest);
  proxyServer.on("connect", handleConnect);

  proxyServer.on("error", (err) => {
    console.error(`[proxy] Server error: ${err.message}`);
  });

  proxyServer.listen(proxyConfig.port, proxyConfig.bindAddress, () => {
    console.log(
      `[proxy] Egress proxy listening on ${proxyConfig.bindAddress}:${proxyConfig.port}`
    );
    console.log(
      `[proxy] Default allowlist: ${proxyConfig.defaultAllowlist.join(", ")}`
    );
  });
}

/**
 * Stop the egress proxy server.
 */
export function stopProxy(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!proxyServer) {
      resolve();
      return;
    }
    proxyServer.close((err) => {
      proxyServer = null;
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Check if the proxy is currently running.
 */
export function isProxyRunning(): boolean {
  return proxyServer !== null && proxyServer.listening;
}

/**
 * Get the current proxy configuration.
 */
export function getProxyConfig(): ProxyConfig {
  return { ...proxyConfig };
}

/**
 * Update the allowlist for a specific instance.
 */
export function setInstanceAllowlist(instanceId: string, hosts: string[]): void {
  proxyConfig.instanceAllowlists.set(instanceId, hosts);
}

/**
 * Remove instance-specific allowlist (falls back to defaults).
 */
export function clearInstanceAllowlist(instanceId: string): void {
  proxyConfig.instanceAllowlists.delete(instanceId);
}

/**
 * Get the proxy port (for container env vars).
 */
export function getProxyPort(): number {
  return proxyConfig.port;
}

/**
 * Get stats snapshot for the API.
 */
export function getProxyStats(): {
  running: boolean;
  port: number;
  bindAddress: string;
  allowedTotal: number;
  blockedTotal: number;
  topBlockedDestinations: Array<{ host: string; count: number }>;
  defaultAllowlist: string[];
  instanceAllowlistCount: number;
} {
  return {
    running: isProxyRunning(),
    port: proxyConfig.port,
    bindAddress: proxyConfig.bindAddress,
    allowedTotal: proxyMetrics.allowedTotal,
    blockedTotal: proxyMetrics.blockedTotal,
    topBlockedDestinations: getTopBlockedDestinations(10),
    defaultAllowlist: proxyConfig.defaultAllowlist,
    instanceAllowlistCount: proxyConfig.instanceAllowlists.size,
  };
}
