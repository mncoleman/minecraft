import type { Hono } from "hono";
import { signSession } from "../jwt.ts";
import { setSessionCookie, clientIp, rateLimited } from "../session.ts";
import { resolveEmailLogin } from "../db.ts";

export function mountEmail(app: Hono): void {
  app.post("/auth/email", async (c) => {
    if (rateLimited("login:" + clientIp(c))) return c.redirect("/login?error=too_many_attempts");
    const form = await c.req.parseBody();
    const email = String(form.email ?? "").trim().toLowerCase();
    const password = String(form.password ?? "");
    if (!email || !password) return c.redirect("/login?error=email_missing");
    if (password.length < 12) return c.redirect("/login?error=weak_password");

    const res = await resolveEmailLogin(email, password);
    if ("error" in res) return c.redirect(`/login?error=${encodeURIComponent(res.error)}`);

    const token = await signSession({
      sub: res.user.id,
      username: res.user.username,
      provider: "email",
      admin: !!res.user.is_admin,
    });
    setSessionCookie(c, token);
    return c.redirect("/");
  });
}
