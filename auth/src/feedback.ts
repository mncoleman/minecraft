// ── Feedback tab ─────────────────────────────────────────────────────────────
// A panel form where any logged-in user can send general feedback, request a
// feature, or report a bug. Each submission is:
//   1. recorded in the `feedback` table (audit + "your recent submissions"),
//   2. DM'd to the owner over Telegram (reuses the presence-notify bot), and
//   3. filed as a GitHub issue in the project repo (mncoleman/minecraft).
// Steps 2 and 3 are best-effort: a submission is never lost just because
// Telegram or GitHub is unreachable/unconfigured.

import type { Hono, Context } from "hono";
import { randomUUID } from "node:crypto";
import { db } from "./db.ts";
import { config } from "./config.ts";
import { currentSession, clientIp, rateLimited } from "./session.ts";
import { shell, esc, icon } from "./layout.ts";
import { notifyOwner, tgEsc } from "./telegram_notify.ts";

const now = () => Math.floor(Date.now() / 1000);
const MAX_MSG = 4000;

// kind → human label, icon name, badge class, and the GitHub label we tag it with.
const KINDS = {
  general: { label: "General feedback", iconName: "message", badge: "badge", ghLabel: "feedback" },
  feature: { label: "Feature request", iconName: "sparkles", badge: "badge badge-owner", ghLabel: "enhancement" },
  bug: { label: "Bug report", iconName: "bug", badge: "badge badge-muted", ghLabel: "bug" },
} as const;
type Kind = keyof typeof KINDS;
function isKind(k: string): k is Kind {
  return k === "general" || k === "feature" || k === "bug";
}

interface FeedbackRow {
  id: string;
  user_id: string;
  username: string;
  kind: string;
  message: string;
  page: string | null;
  issue_number: number | null;
  issue_url: string | null;
  created_at: number;
}

function recentForUser(userId: string, limit = 10): FeedbackRow[] {
  return db
    .query("SELECT * FROM feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, limit) as FeedbackRow[];
}

function ymd(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

// ── GitHub issue creation ────────────────────────────────────────────────────
// POST to the Issues API. Best-effort: returns null (and logs) on any failure so
// the submission still records + notifies even if GitHub is down or unconfigured.
async function createGithubIssue(
  kind: Kind,
  title: string,
  body: string,
): Promise<{ number: number; url: string } | null> {
  if (!config.github.token) {
    console.warn("[feedback] GITHUB_ISSUES_TOKEN unset; skipping issue creation");
    return null;
  }
  // repo comes from trusted env, but guard the shape anyway (it goes into a URL).
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.github.repo)) {
    console.error(`[feedback] invalid GITHUB_REPO "${config.github.repo}"; skipping issue creation`);
    return null;
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${config.github.repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.github.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "mc-auth-feedback",
      },
      body: JSON.stringify({ title, body, labels: [KINDS[kind].ghLabel, "panel-feedback"] }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.error(`[feedback] GitHub issue create failed ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = (await res.json()) as { number?: number; html_url?: string };
    if (typeof data.number !== "number" || !data.html_url) return null;
    console.log(`[feedback] filed issue #${data.number}: ${data.html_url}`);
    return { number: data.number, url: data.html_url };
  } catch (e: any) {
    console.error("[feedback] GitHub issue create error:", e?.message || e);
    return null;
  }
}

function issueTitle(kind: Kind, message: string): string {
  const firstLine = message.split("\n")[0].trim();
  const short = firstLine.length > 80 ? firstLine.slice(0, 79) + "…" : firstLine;
  return `[${KINDS[kind].label}] ${short || "(no summary)"}`;
}

function issueBody(o: { username: string; kind: Kind; message: string; page: string | null }): string {
  return [
    `**Type:** ${KINDS[o.kind].label}`,
    `**From:** ${o.username}`,
    o.page ? `**Where:** ${o.page}` : null,
    "",
    "---",
    "",
    o.message,
    "",
    "---",
    "_Filed automatically from the Minecraft panel feedback form._",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

// ── live issue status (for "your recent submissions") ────────────────────────
// Each submission's status is read from its GitHub issue: open vs closed, plus
// the resolution label we attach on close. The labeling convention lives in
// CLAUDE.md: when a panel-feedback issue is closed it MUST get `complete` (done)
// or `could-not-fulfil` (won't/can't do) so the submitter sees it here. One
// cached batch call (per-minute) covers everyone's recent submissions.
interface LiveIssue {
  state: string;
  stateReason: string | null;
  labels: string[];
}

const DONE_LABELS = ["complete", "completed", "done", "addressed", "fixed", "shipped", "resolved"];
const WONT_LABELS = ["could-not-fulfil", "could-not-fulfill", "cannot-fulfil", "cant-do", "wontfix", "wont-fix", "not-planned", "declined"];
const PROGRESS_LABELS = ["in-progress", "in progress", "wip", "working-on-it"];

let issueCache: { at: number; map: Map<number, LiveIssue> } | null = null;
const ISSUE_TTL_MS = 60_000;

async function fetchIssueStatuses(): Promise<Map<number, LiveIssue>> {
  const empty = new Map<number, LiveIssue>();
  if (!config.github.token || !/^[\w.-]+\/[\w.-]+$/.test(config.github.repo)) return empty;
  if (issueCache && Date.now() - issueCache.at < ISSUE_TTL_MS) return issueCache.map;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${config.github.repo}/issues?labels=panel-feedback&state=all&per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${config.github.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "mc-auth-feedback",
        },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) {
      console.error(`[feedback] issue status fetch failed ${res.status}`);
      return issueCache?.map ?? empty; // serve stale on transient error
    }
    const arr = (await res.json()) as any[];
    const map = new Map<number, LiveIssue>();
    for (const it of arr) {
      if (typeof it?.number !== "number") continue;
      const labels = (Array.isArray(it.labels) ? it.labels : [])
        .map((l: any) => String(typeof l === "string" ? l : l?.name ?? "").toLowerCase())
        .filter(Boolean);
      map.set(it.number, { state: String(it.state || "open"), stateReason: it.state_reason ?? null, labels });
    }
    issueCache = { at: Date.now(), map };
    return map;
  } catch (e: any) {
    console.error("[feedback] issue status fetch error:", e?.message || e);
    return issueCache?.map ?? empty;
  }
}

interface Status {
  label: string;
  badge: string;
}
function statusFor(iss: LiveIssue | undefined): Status | null {
  if (!iss) return null;
  const has = (arr: string[]) => iss.labels.some((l) => arr.includes(l));
  if (iss.state === "open") {
    return has(PROGRESS_LABELS)
      ? { label: "In progress", badge: "badge badge-owner" }
      : { label: "Open", badge: "badge" };
  }
  // Closed: the resolution LABEL is the source of truth (CLAUDE.md convention).
  // GitHub's default close reason is "completed", so we don't trust it for "done"
  // — only the explicit label — but we do honor a "not_planned" close reason.
  if (has(DONE_LABELS)) return { label: "Completed", badge: "badge badge-ok" };
  if (has(WONT_LABELS) || iss.stateReason === "not_planned") return { label: "Couldn't do this", badge: "badge badge-muted" };
  return { label: "Closed", badge: "badge badge-member" };
}

// ── page ─────────────────────────────────────────────────────────────────────
function feedbackPage(
  me: { sub: string; username: string; admin: boolean },
  statuses: Map<number, LiveIssue>,
  presetKind?: string | null,
  msg?: string,
  err?: string,
): string {
  const kind: Kind = presetKind && isKind(presetKind) ? presetKind : "general";
  const recent = recentForUser(me.sub);

  const opt = (v: Kind) =>
    `<option value="${v}"${v === kind ? " selected" : ""}>${esc(KINDS[v].label)}</option>`;

  const recentBlock = recent.length
    ? `<div class="card">${recent
        .map((r) => {
          const k = isKind(r.kind) ? r.kind : "general";
          const preview = r.message.length > 90 ? r.message.slice(0, 89) + "…" : r.message;
          const st = r.issue_number != null ? statusFor(statuses.get(r.issue_number)) : null;
          const statusBadge = st ? `<span class="${st.badge}">${esc(st.label)}</span>` : "";
          const right = r.issue_url
            ? `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:.3rem">
                 ${statusBadge}
                 <a class="pill" href="${esc(r.issue_url)}" target="_blank" rel="noopener">#${r.issue_number} ↗</a>
               </div>`
            : `<span class="hint">sent</span>`;
          return `<div class="row" style="justify-content:space-between;align-items:flex-start;margin:.4rem 0">
            <span style="flex:1;min-width:0">
              <span class="${KINDS[k].badge}">${icon(KINDS[k].iconName)} ${esc(KINDS[k].label)}</span>
              <span class="hint" style="margin-left:.4rem">${ymd(r.created_at)}</span>
              <div style="margin-top:.2rem;word-break:break-word">${esc(preview)}</div>
            </span>
            <span style="flex:none;margin-left:.6rem">${right}</span>
          </div>`;
        })
        .join("")}</div>`
    : "";

  const body = `
    <h1>Feedback</h1>
    <p class="sub">Have an idea, want a new feature, or hit a bug? Let us know. Every submission goes straight to the admin, and feature requests and bug reports are tracked on the project's GitHub so they don't get lost.</p>

    <div class="card">
      <form method="post" action="/feedback">
        <label class="hint" style="display:block;margin-bottom:.3rem">What kind of feedback is this?</label>
        <div class="row" style="margin:0 0 .8rem">
          <select name="kind" style="flex:none;min-width:220px">
            ${opt("general")}${opt("feature")}${opt("bug")}
          </select>
        </div>

        <label class="hint" style="display:block;margin-bottom:.3rem">Tell us about it</label>
        <textarea name="message" required maxlength="${MAX_MSG}" placeholder="Describe your feedback, the feature you'd like, or what went wrong (and how to reproduce it)…" style="min-height:150px;font-family:inherit;font-size:1rem;resize:vertical"></textarea>

        <label class="hint" style="display:block;margin:.8rem 0 .3rem">Where in the game/panel was this? <span style="opacity:.7">(optional)</span></label>
        <input name="page" maxlength="200" placeholder="e.g. the Worlds tab, or in-game in my world" autocomplete="off" style="width:100%"/>

        <div class="row" style="margin:1rem 0 0;justify-content:flex-end">
          <button class="btn-primary" type="submit">Send feedback</button>
        </div>
      </form>
    </div>

    ${recent.length ? `<h2>Your recent submissions</h2>
    <p class="hint" style="margin:-.3rem 0 .6rem">The status updates on its own as we work through them — you'll see <b>Completed</b> or <b>Couldn't do this</b> once an item is wrapped up.</p>${recentBlock}` : ""}
  `;
  return shell({ title: "Feedback", active: "feedback", username: me.username, admin: me.admin, body, msg, err });
}

// ── routes ───────────────────────────────────────────────────────────────────
async function me(c: Context) {
  const s = await currentSession(c);
  if (!s) return null;
  return { sub: s.sub, username: s.username, admin: !!s.admin };
}

export function mountFeedback(app: Hono): void {
  app.get("/feedback", async (c) => {
    const m = await me(c);
    if (!m) return c.redirect("/login");
    const statuses = await fetchIssueStatuses();
    return c.html(feedbackPage(m, statuses, c.req.query("kind"), c.req.query("msg"), c.req.query("err")));
  });

  app.post("/feedback", async (c) => {
    // The floating widget submits over fetch with this header and expects a JSON
    // reply (so the page doesn't navigate); the full-page form gets a redirect.
    const wantsJson = c.req.header("x-feedback-widget") === "1";
    const fail = (status: 400 | 401 | 429, msg: string, redirectQs: string) =>
      wantsJson ? c.json({ ok: false, error: msg }, status) : c.redirect("/feedback?" + redirectQs);

    const m = await me(c);
    if (!m) return fail(401, "Please log in again.", "");
    // Light throttle so the form can't be used to spam GitHub issues / Telegram.
    if (rateLimited("feedback:" + clientIp(c), 6, 600)) {
      const msg = "You're sending feedback quickly — please wait a few minutes and try again.";
      return fail(429, msg, "err=" + encodeURIComponent(msg));
    }
    const form = await c.req.parseBody();
    const kindRaw = String(form.kind ?? "general").trim();
    const kind: Kind = isKind(kindRaw) ? kindRaw : "general";
    const message = String(form.message ?? "").trim().slice(0, MAX_MSG);
    const page = String(form.page ?? "").trim().slice(0, 200) || null;
    if (message.length < 3) {
      const msg = "Please write a little more so we know what you mean.";
      return fail(400, msg, "kind=" + kind + "&err=" + encodeURIComponent(msg));
    }

    const id = randomUUID();
    db.run(
      "INSERT INTO feedback (id, user_id, username, kind, message, page, created_at) VALUES (?,?,?,?,?,?,?)",
      [id, m.sub, m.username, kind, message, page, now()],
    );

    // 1) File a GitHub issue (best-effort).
    const issue = await createGithubIssue(kind, issueTitle(kind, message), issueBody({ username: m.username, kind, message, page }));
    if (issue) db.run("UPDATE feedback SET issue_number = ?, issue_url = ? WHERE id = ?", [issue.number, issue.url, id]);

    // 2) DM the owner over Telegram (best-effort; no-ops if the bot is unset).
    const k = KINDS[kind];
    const preview = message.length > 600 ? message.slice(0, 600) + "…" : message;
    await notifyOwner(
      `<b>New ${tgEsc(k.label.toLowerCase())}</b> from <b>${tgEsc(m.username)}</b>\n\n` +
        `${tgEsc(preview)}` +
        (page ? `\n\n<i>Where: ${tgEsc(page)}</i>` : "") +
        (issue ? `\n\nIssue #${issue.number}: ${tgEsc(issue.url)}` : ""),
    ).catch(() => {});

    const thanks = issue
      ? `Thanks! Your ${k.label.toLowerCase()} was sent and filed as issue #${issue.number}.`
      : `Thanks! Your ${k.label.toLowerCase()} was sent to the admin.`;
    if (wantsJson) {
      return c.json({ ok: true, message: thanks, issue: issue ? { number: issue.number, url: issue.url } : null });
    }
    return c.redirect("/feedback?msg=" + encodeURIComponent(thanks));
  });
}
