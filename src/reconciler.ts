/**
 * Health reconciler — periodically checks all instance containers,
 * updates a shared status cache, detects state transitions, collects stats.
 *
 * Runs via setInterval (no thread forking).
 */

import { loadDb } from "./db.js";
import { containerName, getContainerStatus } from "./docker.js";
import { isProxyRunning } from "./proxy.js";
import Dockerode from "dockerode";

const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });

export interface StatusEntry {
  status: string;
  cpu_percent: number;
  memory_bytes: number;
  updated: number;
}

/** Cached status per instance ID. */
export const statusCache = new Map<string, StatusEntry>();

/** Restart counter per instance ID (in-memory, process lifetime). */
export const restartCounters = new Map<string, number>();

let reconcilerInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Single reconciliation pass.
 */
async function reconcileOnce(): Promise<void> {
  // Check proxy health
  if (!isProxyRunning()) {
    console.warn("[reconciler] WARNING: Egress proxy is NOT running — container traffic is unfiltered!");
  }

  const db = loadDb();
  const instances = db.instances;
  const currentIds = new Set(Object.keys(instances));

  // Remove stale entries not in DB
  for (const key of statusCache.keys()) {
    if (!currentIds.has(key)) {
      statusCache.delete(key);
    }
  }

  for (const iid of currentIds) {
    const cname = containerName(iid);

    try {
      const container = docker.getContainer(cname);
      const info = await container.inspect();
      const newStatus = info.State?.Status || "unknown";

      // Detect unexpected stop (was running, now dead/exited)
      const prev = statusCache.get(iid);
      const prevStatus = prev?.status || "unknown";

      if (
        prevStatus === "running" &&
        ["exited", "dead", "removing"].includes(newStatus)
      ) {
        console.warn(
          `Health reconciler: instance ${iid} container ${cname} transitioned ${prevStatus} → ${newStatus}`
        );
        restartCounters.set(iid, (restartCounters.get(iid) || 0) + 1);
      }

      // Collect CPU/memory for running containers
      let cpuPercent = 0;
      let memoryBytes = 0;

      if (newStatus === "running") {
        try {
          const stats = (await container.stats({ stream: false })) as any;
          const cpuStats = stats.cpu_stats || {};
          const precpuStats = stats.precpu_stats || {};
          const cpuDelta =
            (cpuStats.cpu_usage?.total_usage || 0) -
            (precpuStats.cpu_usage?.total_usage || 0);
          const systemDelta =
            (cpuStats.system_cpu_usage || 0) -
            (precpuStats.system_cpu_usage || 0);
          const cpuCount =
            cpuStats.cpu_usage?.percpu_usage?.length || 1;

          if (systemDelta > 0 && cpuDelta > 0) {
            cpuPercent = (cpuDelta / systemDelta) * cpuCount * 100;
          }
          memoryBytes = stats.memory_stats?.usage || 0;
        } catch {
          // Stats collection failed — keep defaults
        }
      }

      statusCache.set(iid, {
        status: newStatus,
        cpu_percent: cpuPercent,
        memory_bytes: memoryBytes,
        updated: Date.now() / 1000,
      });
    } catch (err: any) {
      if (err.statusCode === 404) {
        const prev = statusCache.get(iid);
        const prevStatus = prev?.status || "unknown";
        if (prevStatus !== "not_found" && prevStatus !== "unknown") {
          console.warn(
            `Health reconciler: container ${cname} for instance ${iid} is gone (was ${prevStatus})`
          );
        }
        statusCache.set(iid, {
          status: "not_found",
          cpu_percent: 0,
          memory_bytes: 0,
          updated: Date.now() / 1000,
        });
      } else {
        console.error(
          `Health reconciler: DockerException for ${iid}:`,
          err.message || err
        );
      }
    }
  }
}

/**
 * Start the reconciler (setInterval every 60s).
 * Safe to call multiple times — only starts once.
 */
export function startReconciler(): void {
  if (reconcilerInterval) return;

  console.log("Health reconciler started (setInterval, 60s)");

  // Run once immediately
  reconcileOnce().catch((err) =>
    console.error("Health reconciler unhandled error:", err)
  );

  reconcilerInterval = setInterval(() => {
    reconcileOnce().catch((err) =>
      console.error("Health reconciler unhandled error:", err)
    );
  }, 60_000);
}
