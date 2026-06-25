import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { config } from "./config.ts";
import { verifySession, type Session } from "./jwt.ts";
import { getUserById } from "./db.ts";

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, config.cookieName, token, {
    path: "/",
    httpOnly: true,
    // Secure so it only travels over https; the browser still attaches it to the
    // same-site wss:// game handshake (SameSite=Lax allows same-site requests).
    secure: !config.devInsecureCookie,
    sameSite: "Lax",
    maxAge: config.sessionTtlDays * 24 * 3600,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, config.cookieName, { path: "/" });
}

export function getSessionToken(c: Context): string | undefined {
  return getCookie(c, config.cookieName);
}

export async function currentSession(c: Context): Promise<Session | null> {
  const tok = getSessionToken(c);
  const s = tok ? await verifySession(tok) : null;
  // JWTs are stateless and valid until expiry, so a deleted account would keep a
  // working session. Invalidate centrally: if the account no longer exists, the
  // session is dead (covers every page, the client gate, and forward_auth).
  if (s && !getUserById(s.sub)) return null;
  return s;
}

// ── lightweight in-memory rate limiter (per-key fixed window) ─────────────────
// Throttles password guessing on login + invite signup. mc-auth is a single
// instance, so an in-process map is enough. Key by client IP (X-Forwarded-For
// from Caddy) + route prefix. Map is pruned of expired buckets when it grows.
const rlBuckets = new Map<string, { count: number; resetAt: number }>();

export function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for") || "";
  return xff.split(",")[0].trim() || "unknown";
}

/** True if `key` is OVER the limit and the request should be rejected. */
export function rateLimited(key: string, max = 8, windowSec = 600): boolean {
  const now = Date.now();
  const b = rlBuckets.get(key);
  if (!b || now > b.resetAt) {
    if (rlBuckets.size > 5000) for (const [k, v] of rlBuckets) if (now > v.resetAt) rlBuckets.delete(k);
    rlBuckets.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return false;
  }
  return ++b.count > max;
}
