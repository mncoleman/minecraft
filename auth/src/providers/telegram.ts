import type { Hono } from "hono";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";
import { signSession } from "../jwt.ts";
import { setSessionCookie } from "../session.ts";
import { resolveTelegramUser } from "../db.ts";

// Validate the Telegram Login Widget payload per
// https://core.telegram.org/widgets/login#checking-authorization
function checkTelegramAuth(data: Record<string, string>): boolean {
  const { hash, ...fields } = data;
  if (!hash || !config.telegram.botToken) return false;

  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");

  const secretKey = createHash("sha256").update(config.telegram.botToken).digest();
  const computed = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  // reject stale logins (>24h)
  const authDate = Number(fields.auth_date ?? 0);
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > 86400) return false;

  return true;
}

export function mountTelegram(app: Hono): void {
  app.get("/auth/telegram/callback", async (c) => {
    if (!config.telegram.botToken) return c.text("telegram disabled", 404);
    const q = c.req.query() as Record<string, string>;
    if (!checkTelegramAuth(q)) return c.redirect("/login?error=telegram");

    const res = resolveTelegramUser({ id: String(q.id), username: q.username, firstName: q.first_name });
    if ("error" in res) return c.redirect(`/login?error=${encodeURIComponent(res.error)}`);

    const token = await signSession({
      sub: res.user.id,
      username: res.user.username,
      provider: "telegram",
      admin: !!res.user.is_admin,
    });
    setSessionCookie(c, token);
    return c.redirect("/");
  });
}
