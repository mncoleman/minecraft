import type { Hono } from "hono";
import {
  getUserByEmail, getUserById, createToken, checkToken, consumeToken, setPassword, setUserEmail, markEmailVerified,
} from "./db.ts";
import { config } from "./config.ts";
import { clientIp, rateLimited } from "./session.ts";
import { sendPasswordReset } from "./mailer.ts";

function esc(s: string): string {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// Standalone dark card page, matching the login / invite signup look.
function page(title: string, inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)} · minecraft.mncoleman.com</title>
<style>
 :root{color-scheme:dark}*{box-sizing:border-box}
 body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;color:#e8eaed;background:radial-gradient(1200px 600px at 50% -10%,#1c2a22,transparent 60%),#0d0f12;padding:1.5rem}
 .card{width:100%;max-width:380px;background:#14171d;border:1px solid #232a35;border-radius:16px;padding:1.75rem;box-shadow:0 20px 60px rgba(0,0,0,.5)}
 h1{font-size:1.35rem;margin:0 0 .2rem}.sub{color:#8b95a3;margin:0 0 1.3rem;font-size:.92rem}
 form{display:grid;gap:.6rem}
 input{width:100%;padding:.7rem .85rem;border-radius:10px;border:1px solid #2c333f;background:#0f1217;color:#e8eaed;font:inherit}
 input:focus{outline:none;border-color:#3a7a57}
 button{padding:.75rem;border-radius:10px;border:1px solid #357a57;background:#2f6f4f;color:#fff;font:inherit;font-weight:700;cursor:pointer}
 button:hover{background:#357f5a}
 .err{background:#3a1d24;border:1px solid #6b2c39;color:#ffb3c0;padding:.55rem .8rem;border-radius:10px;font-size:.88rem;margin-bottom:.8rem}
 .ok{background:#16291f;border:1px solid #2c6b47;color:#9be7bd;padding:.55rem .8rem;border-radius:10px;font-size:.9rem}
 a{color:#7fd0a3}.foot{color:#5c6573;font-size:.82rem;text-align:center;margin:1.1rem 0 0}
</style></head><body><div class="card">${inner}</div></body></html>`;
}

export function mountAccount(app: Hono): void {
  // ── forgot password ─────────────────────────────────────────────────────────
  app.get("/forgot", (c) => {
    const sent = !!c.req.query("sent");
    const inner = sent
      ? `<div class="ok">If an account with that email exists, a reset link is on its way. Check your inbox.</div><p class="foot"><a href="/login">Back to sign in</a></p>`
      : `<form method="post" action="/forgot">
           <input type="email" name="email" placeholder="your email" autocomplete="email" required/>
           <button type="submit">Send reset link</button>
         </form>
         <p class="foot"><a href="/login">Back to sign in</a></p>`;
    return c.html(page("Forgot password", `
      <h1>Reset your password</h1>
      <p class="sub">Enter your account email and we will send you a reset link.</p>
      ${inner}`));
  });

  app.post("/forgot", async (c) => {
    // Rate-limit and ALWAYS respond identically (no account enumeration).
    if (!rateLimited("forgot:" + clientIp(c))) {
      const email = String((await c.req.parseBody()).email ?? "").trim().toLowerCase();
      const u = email ? getUserByEmail(email) : null;
      if (u && u.email && u.password_hash) {
        const raw = createToken(u.id, "reset_password", 3600); // 1 hour
        await sendPasswordReset(u.email, `${config.publicBaseUrl}/reset/${raw}`);
      }
    }
    return c.redirect("/forgot?sent=1");
  });

  // ── reset password (link target) ─────────────────────────────────────────────
  app.get("/reset/:token", (c) => {
    const tok = checkToken(c.req.param("token"), ["reset_password"]);
    if (!tok) {
      return c.html(page("Reset password", `<h1>Link expired</h1><p class="sub">This reset link is invalid, used, or expired.</p><p class="foot"><a href="/forgot">Request a new one</a></p>`), 410);
    }
    return c.html(page("Reset password", `
      <h1>Choose a new password</h1>
      <p class="sub">Pick a strong password (at least 12 characters).</p>
      ${c.req.query("err") ? `<div class="err">${esc(c.req.query("err")!)}</div>` : ""}
      <form method="post" action="/reset/${esc(c.req.param("token"))}">
        <input type="password" name="password" placeholder="new password (min 12 chars)" minlength="12" autocomplete="new-password" required/>
        <input type="password" name="confirm" placeholder="confirm new password" minlength="12" autocomplete="new-password" required/>
        <button type="submit">Set new password</button>
      </form>`));
  });

  app.post("/reset/:token", async (c) => {
    const token = c.req.param("token");
    if (rateLimited("reset:" + clientIp(c))) {
      return c.html(page("Reset password", `<h1>Slow down</h1><p class="sub">Too many attempts. Wait a few minutes and try again.</p>`), 429);
    }
    const form = await c.req.parseBody();
    const password = String(form.password ?? "");
    const confirm = String(form.confirm ?? "");
    if (password.length < 12) return c.redirect(`/reset/${token}?err=` + encodeURIComponent("Password must be at least 12 characters."));
    if (password !== confirm) return c.redirect(`/reset/${token}?err=` + encodeURIComponent("Passwords do not match."));
    const tok = consumeToken(token, ["reset_password"]); // consume only after validation passes
    if (!tok) {
      return c.html(page("Reset password", `<h1>Link expired</h1><p class="sub">This reset link is invalid, used, or expired.</p><p class="foot"><a href="/forgot">Request a new one</a></p>`), 410);
    }
    await setPassword(tok.userId, password);
    return c.html(page("Password updated", `<h1>Password updated</h1><div class="ok">Your password has been changed. You can sign in now.</div><p class="foot"><a href="/login">Go to sign in</a></p>`));
  });

  // ── email confirmation + email change (link target) ──────────────────────────
  app.get("/verify/:token", (c) => {
    const tok = consumeToken(c.req.param("token"), ["verify_email", "change_email"]);
    if (!tok) {
      return c.html(page("Confirm email", `<h1>Link expired</h1><p class="sub">This confirmation link is invalid, used, or expired.</p><p class="foot"><a href="/profile">Go to your profile</a></p>`), 410);
    }
    if (tok.purpose === "change_email") {
      if (!tok.newValue || !setUserEmail(tok.userId, tok.newValue)) {
        return c.html(page("Confirm email", `<h1>Could not update</h1><p class="sub">That email is already in use by another account.</p><p class="foot"><a href="/profile">Back to profile</a></p>`), 409);
      }
      return c.html(page("Email updated", `<h1>Email updated</h1><div class="ok">Your account email is now <b>${esc(tok.newValue)}</b>.</div><p class="foot"><a href="/profile">Back to profile</a></p>`));
    }
    // verify_email
    const u = getUserById(tok.userId);
    if (u) markEmailVerified(u.id);
    return c.html(page("Email confirmed", `<h1>Email confirmed</h1><div class="ok">Thanks, your email is verified.</div><p class="foot"><a href="/">Go play</a></p>`));
  });
}
