import { config } from "./config.ts";

// Transactional email via the Resend REST API (no SDK; one fetch). If no API key
// is configured the mailer no-ops and logs what it would have sent, so local/dev
// runs never fail on a missing key.

const RESEND_URL = "https://api.resend.com/emails";
const LOGO_URL = `${config.publicBaseUrl}/email-logo.png`;
const BRAND = "MNColeman Minecraft";

export interface MailResult { ok: boolean; id?: string; error?: string }

function esc(s: string): string {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// Plain-text fallback derived from the HTML (strip tags, keep links readable).
function toText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
}

export async function sendMail(to: string, subject: string, html: string): Promise<MailResult> {
  if (!config.resend.apiKey) {
    console.warn(`[mailer] RESEND_API_KEY unset; would send to ${to}: "${subject}"`);
    return { ok: false, error: "mailer_disabled" };
  }
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.resend.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: config.resend.from, to, subject, html, text: toText(html) }),
    });
    if (!res.ok) {
      console.error(`[mailer] send failed ${res.status}: ${await res.text()}`);
      return { ok: false, error: `resend_${res.status}` };
    }
    const data = (await res.json()) as { id?: string };
    console.log(`[mailer] sent "${subject}" to ${to} (id ${data.id ?? "?"})`);
    return { ok: true, id: data.id };
  } catch (e: any) {
    console.error("[mailer] send error:", e?.message || e);
    return { ok: false, error: "network" };
  }
}

// ── branded HTML shell ────────────────────────────────────────────────────────
// Table-based, inline styles, light card with the dark MC logo: the layout most
// email clients (Gmail, Apple Mail, Outlook) render reliably.
function shell(opts: { heading: string; intro: string; cta?: { label: string; url: string }; outro?: string }): string {
  const { heading, intro, cta, outro } = opts;
  const button = cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0"><tr>
         <td bgcolor="#18181b" style="border-radius:10px">
           <a href="${esc(cta.url)}" style="display:inline-block;padding:13px 26px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px">${esc(cta.label)}</a>
         </td></tr></table>
       <p style="margin:0 0 4px;font-size:13px;color:#8b95a3">Or paste this link into your browser:</p>
       <p style="margin:0 0 8px;font-size:13px;word-break:break-all"><a href="${esc(cta.url)}" style="color:#2f6f4f">${esc(cta.url)}</a></p>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px">
 <tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e6e8eb;border-radius:16px;overflow:hidden">
   <tr><td style="padding:28px 32px 8px" align="left">
     <img src="${LOGO_URL}" width="48" height="48" alt="${esc(BRAND)}" style="display:block;border-radius:11px"/>
   </td></tr>
   <tr><td style="padding:8px 32px 28px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2329">
     <h1 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#18181b">${esc(heading)}</h1>
     <p style="margin:0 0 8px;font-size:15px;line-height:1.55;color:#3c4149">${intro}</p>
     ${button}
     ${outro ? `<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:#8b95a3">${outro}</p>` : ""}
   </td></tr>
  </table>
  <p style="max-width:480px;margin:16px auto 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#9aa4b2;text-align:center">
    ${esc(BRAND)} &middot; <a href="${esc(config.publicBaseUrl)}" style="color:#9aa4b2">minecraft.mncoleman.com</a>
  </p>
 </td></tr>
</table>
</body></html>`;
}

// ── specific emails ───────────────────────────────────────────────────────────

export function sendPasswordReset(to: string, url: string): Promise<MailResult> {
  return sendMail(to, "Reset your Minecraft password", shell({
    heading: "Reset your password",
    intro: "We got a request to reset the password on your Minecraft account. Click below to choose a new one. This link expires in 1 hour.",
    cta: { label: "Reset password", url },
    outro: "If you did not request this, you can safely ignore this email. Your password will not change.",
  }));
}

export function sendVerifyEmail(to: string, url: string): Promise<MailResult> {
  return sendMail(to, "Confirm your email", shell({
    heading: "Confirm your email",
    intro: "Click below to confirm this is your email address for your Minecraft account. This link expires in 24 hours.",
    cta: { label: "Confirm email", url },
    outro: "If you did not create this account, you can ignore this email.",
  }));
}

export function sendEmailChange(to: string, url: string): Promise<MailResult> {
  return sendMail(to, "Confirm your new email", shell({
    heading: "Confirm your new email",
    intro: `Confirm you want to use <b>${esc(to)}</b> as the email on your Minecraft account. The change only takes effect after you click. This link expires in 24 hours.`,
    cta: { label: "Confirm new email", url },
    outro: "If you did not request this change, you can ignore this email and nothing will change.",
  }));
}

export function sendInvite(to: string, url: string, opts: { inviter?: string; role?: string } = {}): Promise<MailResult> {
  const who = opts.inviter ? `${esc(opts.inviter)} invited you` : "You have been invited";
  const asRole = opts.role === "admin" ? " as an admin" : "";
  return sendMail(to, "You are invited to play Minecraft", shell({
    heading: "You are invited to play",
    intro: `${who} to the private Minecraft server${asRole}. It runs in your browser, no install needed. Click below to pick your username and password, and you are in.`,
    cta: { label: "Create my account", url },
    outro: "This invite link is single-use and expires in 14 days.",
  }));
}
