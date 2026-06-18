import type { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { config } from "../config.ts";
import { signSession } from "../jwt.ts";
import { setSessionCookie } from "../session.ts";
import { resolveGoogleUser } from "../db.ts";

const redirectUri = () => `${config.publicBaseUrl}/auth/google/callback`;

export function mountGoogle(app: Hono): void {
  app.get("/auth/google", (c) => {
    if (!config.google.clientId) return c.text("google disabled", 404);

    const state = randomBytes(16).toString("hex");
    setCookie(c, "g_state", state, {
      path: "/auth/google",
      httpOnly: true,
      secure: !config.devInsecureCookie,
      sameSite: "Lax",
      maxAge: 600,
    });

    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", config.google.clientId);
    u.searchParams.set("redirect_uri", redirectUri());
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "openid email profile");
    u.searchParams.set("state", state);
    u.searchParams.set("prompt", "select_account");
    return c.redirect(u.toString());
  });

  app.get("/auth/google/callback", async (c) => {
    const { code, state } = c.req.query();
    const saved = getCookie(c, "g_state");
    deleteCookie(c, "g_state", { path: "/auth/google" });
    if (!code || !state || state !== saved) return c.redirect("/login?error=google_state");

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: redirectUri(),
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) return c.redirect("/login?error=google_token");
    const tok = (await tokenRes.json()) as { access_token?: string };
    if (!tok.access_token) return c.redirect("/login?error=google_token");

    const uiRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (!uiRes.ok) return c.redirect("/login?error=google_userinfo");
    const ui = (await uiRes.json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string };
    if (!ui.sub || !ui.email) return c.redirect("/login?error=google_userinfo");
    if (ui.email_verified === false) return c.redirect("/login?error=google_unverified");

    const res = resolveGoogleUser({ sub: String(ui.sub), email: String(ui.email), name: ui.name });
    if ("error" in res) return c.redirect(`/login?error=${encodeURIComponent(res.error)}`);

    const token = await signSession({
      sub: res.user.id,
      username: res.user.username,
      provider: "google",
      admin: !!res.user.is_admin,
    });
    setSessionCookie(c, token);
    return c.redirect("/");
  });
}
