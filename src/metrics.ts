/**
 * Prometheus metrics formatter.
 *
 * SECURITY: Labels use instance="id" only — NO pubkey in labels
 * (was leaking wallet addresses in the Python version).
 */

import { loadDb } from "./db.js";
import { statusCache, restartCounters } from "./reconciler.js";
import { proxyMetrics, getTopBlockedDestinations } from "./proxy.js";

/**
 * Format all metrics as Prometheus text exposition format.
 */
export function formatMetrics(): string {
  const db = loadDb();
  const instances = db.instances;
  const total = Object.keys(instances).length;

  let runningCount = 0;
  const restartLines: string[] = [];
  const cpuLines: string[] = [];
  const memLines: string[] = [];

  for (const iid of Object.keys(instances)) {
    // Label: instance="id" only — NO pubkey!
    const label = `instance="${iid}"`;

    const cacheEntry = statusCache.get(iid);
    const restarts = restartCounters.get(iid) || 0;

    const status = cacheEntry?.status || "unknown";
    if (status === "running") runningCount++;

    const cpuPct = cacheEntry?.cpu_percent || 0;
    const memBytes = cacheEntry?.memory_bytes || 0;

    restartLines.push(`openclaw_instance_restarts_total{${label}} ${restarts}`);
    cpuLines.push(`openclaw_instance_cpu_percent{${label}} ${cpuPct.toFixed(4)}`);
    memLines.push(`openclaw_instance_memory_bytes{${label}} ${memBytes}`);
  }

  // Proxy metrics
  const topBlocked = getTopBlockedDestinations(10);
  const blockedDestLines: string[] = topBlocked.map(
    ({ host, count }) => `openclaw_proxy_blocked_destinations{host="${host}"} ${count}`
  );

  const lines: string[] = [
    "# HELP openclaw_instances_total Total number of instances in the database",
    "# TYPE openclaw_instances_total gauge",
    `openclaw_instances_total ${total}`,
    "",
    "# HELP openclaw_instances_running Number of currently running containers",
    "# TYPE openclaw_instances_running gauge",
    `openclaw_instances_running ${runningCount}`,
    "",
    "# HELP openclaw_instance_restarts_total Restart counter per instance",
    "# TYPE openclaw_instance_restarts_total counter",
    ...restartLines,
    "",
    "# HELP openclaw_instance_cpu_percent CPU usage percent per instance",
    "# TYPE openclaw_instance_cpu_percent gauge",
    ...cpuLines,
    "",
    "# HELP openclaw_instance_memory_bytes Memory usage in bytes per instance",
    "# TYPE openclaw_instance_memory_bytes gauge",
    ...memLines,
    "",
    "# HELP openclaw_proxy_requests_total Total proxy requests by action",
    "# TYPE openclaw_proxy_requests_total counter",
    `openclaw_proxy_requests_total{action="allowed"} ${proxyMetrics.allowedTotal}`,
    `openclaw_proxy_requests_total{action="blocked"} ${proxyMetrics.blockedTotal}`,
    "",
    "# HELP openclaw_proxy_blocked_destinations Top blocked destination hosts",
    "# TYPE openclaw_proxy_blocked_destinations gauge",
    ...blockedDestLines,
    "",
  ];

  return lines.join("\n");
}
