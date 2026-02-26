/**
 * Authentication middleware and helpers.
 *
 * If LAUNCHER_TOKEN is empty/unset, auth is disabled (allow all).
 * Otherwise, all /api/ routes require `Authorization: Bearer <token>` or `?token=<token>`.
 * Uses crypto.timingSafeEqual for constant-time comparison.
 */

import { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { URL } from "node:url";

const LAUNCHER_TOKEN = process.env.LAUNCHER_TOKEN || "";

/**
 * Constant-time string comparison.
 * Returns true if both strings are non-empty and equal.
 */
function safeCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Express middleware — require Bearer token for all /api/ routes.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!LAUNCHER_TOKEN) {
    // Auth disabled — no token configured
    next();
    return;
  }

  if (!req.path.startsWith("/api/")) {
    next();
    return;
  }

  const authHeader = req.headers.authorization || "";
  const queryToken = (req.query.token as string) || "";

  let provided = "";
  if (authHeader.startsWith("Bearer ")) {
    provided = authHeader.slice(7);
  } else if (queryToken) {
    provided = queryToken;
  }

  if (!safeCompare(provided, LAUNCHER_TOKEN)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

/**
 * Validate ?token= parameter from a WebSocket upgrade URL.
 * Returns true if auth is disabled or the token matches.
 */
export function validateWsToken(url: string): boolean {
  if (!LAUNCHER_TOKEN) return true; // auth disabled
  try {
    // url might be a relative path like "/api/logs/abc123/stream?token=xyz"
    const parsed = new URL(url, "http://localhost");
    const token = parsed.searchParams.get("token") || "";
    return safeCompare(token, LAUNCHER_TOKEN);
  } catch {
    return false;
  }
}
