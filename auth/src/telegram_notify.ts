// ── Telegram presence notifications (owner-only, server-side) ────────────────
// A "me only" feature for Matthew: DMs him when someone joins the Minecraft
// server, with a registered bot-command menu to toggle notifications and check
// status. There is NOTHING in the web panel for this — it lives entirely in the
// mc-auth container (which already runs 24/7 and polls in-game presence).
//
// Transport: Telegram long-polling (getUpdates). No webhook, no public route,
// no Caddy change. The bot is LOCKED to a single chat id (Matthew's); every
// other chat is ignored. State (the on/off toggle + the getUpdates offset)
// lives in the settings kv table so it survives redeploys.

import { getSetting, setSetting } from "./db.ts";
import { getPresence, type OnlinePlayer } from "./presence.ts";

const TOKEN = process.env.TELEGRAM_NOTIFY_BOT_TOKEN || "";
const CHAT_ID = String(process.env.TELEGRAM_NOTIFY_CHAT_ID || "");
// In-game usernames to never notify about (default: the owner himself — pinging
// yourself that you joined is just noise). Case-insensitive, comma-separated.
const IGNORE = new Set(
  (process.env.TELEGRAM_NOTIFY_IGNORE ?? "Matthew")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

const SETTING_ENABLED = "tg_notify_enabled";
const SETTING_OFFSET = "tg_update_offset";

const api = (method: string) => `https://api.telegram.org/bot${TOKEN}/${method}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// HTML-escape for parse_mode: "HTML".
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Default ON: the whole point of the feature is to get pinged.
function enabled(): boolean {
  const v = getSetting(SETTING_ENABLED);
  return v === null ? true : v === "1";
}
function setEnabled(on: boolean): void {
  setSetting(SETTING_ENABLED, on ? "1" : "0");
}

async function tg(method: string, body: unknown, timeoutMs = 10000): Promise<any> {
  const r = await fetch(api(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return r.json();
}

async function send(text: string): Promise<void> {
  try {
    await tg("sendMessage", {
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (e: any) {
    console.error("telegram-notify: send failed:", e?.message || e);
  }
}

// Reusable owner DM for OTHER server-side features (e.g. the Feedback form).
// No-ops silently if the bot isn't configured. `text` is sent as HTML — escape
// any user-supplied content with tgEsc() before interpolating it.
export async function notifyOwner(text: string): Promise<void> {
  if (!TOKEN || !CHAT_ID) return;
  await send(text);
}
export const tgEsc = esc;

function onlineList(players: OnlinePlayer[]): string {
  if (!players.length) return "No one is online right now.";
  return `Online now (${players.length}):\n` +
    players.map((p) => `• <b>${esc(p.name)}</b>${p.world ? ` — ${esc(p.world)}` : ""}`).join("\n");
}

async function statusText(): Promise<string> {
  const players = await getPresence();
  return `Notifications: <b>${enabled() ? "ON" : "OFF"}</b>\n\n${onlineList(players)}`;
}

const helpText =
  "<b>Minecraft presence bot</b>\n\n" +
  "/status — notifications on/off + who's online\n" +
  "/on — turn join notifications on\n" +
  "/off — turn join notifications off";

// ── command handling ─────────────────────────────────────────────────────────
async function handleUpdate(u: any): Promise<void> {
  const msg = u?.message;
  if (!msg?.text) return;
  // Hard lock: only the owner's chat is ever answered. Everyone else is ignored
  // silently (no information leak, no "this bot exists" confirmation).
  if (String(msg.chat?.id ?? "") !== CHAT_ID) return;

  // Strip a trailing @botname (Telegram appends it in groups) and any args.
  const cmd = msg.text.trim().split(/\s+/)[0].toLowerCase().replace(/@.*$/, "");
  switch (cmd) {
    case "/start":
    case "/help":
      await send(helpText);
      break;
    case "/on":
      setEnabled(true);
      await send("Notifications <b>ON</b>. I'll ping you when someone joins.");
      break;
    case "/off":
      setEnabled(false);
      await send("Notifications <b>OFF</b>. Use /on to re-enable.");
      break;
    case "/status":
      await send(await statusText());
      break;
    default:
      await send("Unknown command. Try /status, /on, or /off.");
  }
}

// Long-poll getUpdates forever. Survives transient network errors with a short
// backoff. Only one consumer (this single mc-auth instance) ever runs.
async function getUpdatesLoop(): Promise<void> {
  // Clear any stale webhook so getUpdates is allowed (the login widget never
  // sets one, but this makes the loop robust regardless).
  await tg("deleteWebhook", {}).catch(() => {});
  let offset = Number(getSetting(SETTING_OFFSET) ?? "0") || 0;
  for (;;) {
    try {
      const r = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] }, 55000);
      const updates: any[] = Array.isArray(r?.result) ? r.result : [];
      for (const u of updates) {
        offset = u.update_id + 1;
        try {
          await handleUpdate(u);
        } catch (e: any) {
          console.error("telegram-notify: handler error:", e?.message || e);
        }
      }
      if (updates.length) setSetting(SETTING_OFFSET, String(offset));
    } catch (e: any) {
      // Includes the long-poll timeout when idle (expected) and real errors.
      await sleep(3000);
    }
  }
}

// ── presence watcher ─────────────────────────────────────────────────────────
// `prev` is null until the first poll so a container restart doesn't announce
// everyone already online as a fresh join. It always tracks the real online set
// (even while notifications are OFF) so re-enabling never back-fires for people
// who were already on.
let prev: Set<string> | null = null;

async function pollPresence(): Promise<void> {
  try {
    const players = await getPresence();
    const cur = new Set(players.map((p) => p.name.toLowerCase()));
    if (prev === null) {
      prev = cur; // seed only
      return;
    }
    if (enabled()) {
      const joins = players.filter((p) => !prev!.has(p.name.toLowerCase()) && !IGNORE.has(p.name.toLowerCase()));
      for (const p of joins) {
        await send(
          `<b>${esc(p.name)}</b> joined Minecraft${p.world ? ` (world: ${esc(p.world)})` : ""}\n\n${onlineList(players)}`,
        );
      }
    }
    prev = cur;
  } catch {
    /* presence endpoint hiccup — try again next tick */
  }
}

export function startTelegramNotifications(): void {
  if (!TOKEN || !CHAT_ID) {
    console.log("telegram-notify: disabled (set TELEGRAM_NOTIFY_BOT_TOKEN + TELEGRAM_NOTIFY_CHAT_ID to enable)");
    return;
  }
  // Register the slash-command menu (shows in Telegram's "/" autocomplete).
  tg("setMyCommands", {
    commands: [
      { command: "status", description: "Notifications on/off + who's online" },
      { command: "on", description: "Turn join notifications on" },
      { command: "off", description: "Turn join notifications off" },
    ],
  }).catch(() => {});

  setInterval(pollPresence, 5000); // presence is cached ~3s upstream
  void getUpdatesLoop();
  console.log(`telegram-notify: started (chat ${CHAT_ID}, default ${enabled() ? "ON" : "OFF"})`);
}
