/**
 * File-backed JSON database with file locking.
 *
 * Uses proper-lockfile for cross-process safe file locking.
 * DB_FILE = data/instances.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import lockfile from "proper-lockfile";

export interface Instance {
  pubkey: string;
  port: number;
  gateway_token: string;
  created: number;
  last_started: number;
  container_id: string;
}

export interface DB {
  instances: Record<string, Instance>;
}

const DATA_DIR = resolve("data");
const DB_FILE = resolve(DATA_DIR, "instances.json");

// Ensure data directory exists
mkdirSync(DATA_DIR, { recursive: true });

/**
 * Read the database (no lock). For read-only operations.
 */
export function loadDb(): DB {
  if (!existsSync(DB_FILE)) {
    return { instances: {} };
  }
  try {
    const raw = readFileSync(DB_FILE, "utf-8").trim();
    if (!raw) return { instances: {} };
    return JSON.parse(raw) as DB;
  } catch {
    return { instances: {} };
  }
}

/**
 * Acquire file lock, read DB, call fn, write result, release lock.
 * Returns whatever fn returns.
 */
export async function withLockedDb<T>(fn: (db: DB) => T | Promise<T>): Promise<T> {
  // Ensure the file exists before locking
  if (!existsSync(DB_FILE)) {
    writeFileSync(DB_FILE, JSON.stringify({ instances: {} }, null, 2));
  }

  const release = await lockfile.lock(DB_FILE, {
    retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 },
    stale: 10000,
  });

  try {
    const raw = readFileSync(DB_FILE, "utf-8").trim();
    const db: DB = raw ? (JSON.parse(raw) as DB) : { instances: {} };
    const result = await fn(db);
    writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    return result;
  } finally {
    await release();
  }
}
