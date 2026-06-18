import { db } from "./db.ts";
import { teleportTo, upsertLocation } from "./worlds.ts";

const PRESENCE_URL = `http://${process.env.RCON_HOST || "mc-eagler"}:${process.env.PRESENCE_PORT || 25580}/presence`;
const TOKEN = process.env.MC_PRESENCE_TOKEN || "";

export interface OnlinePlayer { name: string; world: string; x?: number; y?: number; z?: number }

let cache: { at: number; players: OnlinePlayer[] } = { at: 0, players: [] };

/** Online players (name + world), cached ~3s. Empty list if the endpoint is down. */
export async function getPresence(): Promise<OnlinePlayer[]> {
  if (Date.now() - cache.at < 3000) return cache.players;
  if (!TOKEN) return [];
  try {
    const r = await fetch(PRESENCE_URL, {
      headers: { Authorization: "Bearer " + TOKEN },
      signal: AbortSignal.timeout(2500),
    });
    const j = r.ok ? ((await r.json()) as { players?: OnlinePlayer[] }) : { players: [] };
    cache = { at: Date.now(), players: Array.isArray(j.players) ? j.players : [] };
  } catch {
    cache = { at: Date.now(), players: [] };
  }
  return cache.players;
}

/** Poll loop: record each online player's location so the command center can
 * show + teleport to last-known spots (even after they log off). */
export function startLocationLogger(): void {
  setInterval(async () => {
    try {
      for (const p of await getPresence()) {
        if (typeof p.x === "number" && typeof p.y === "number" && typeof p.z === "number") {
          upsertLocation(p.name, p.world, p.x, p.y, p.z);
        }
      }
    } catch {}
  }, 6000);
}

/** Poll loop: when a player with a pending hop destination comes online, teleport them. */
export function startHopAutoRoute(): void {
  setInterval(async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const pendings = db.query("SELECT * FROM pending_destination").all() as Array<{ username: string; target_world: string; expires_at: number }>;
    if (!pendings.length) return;
    const online = await getPresence();
    const worldByName = new Map(online.map((p) => [p.name.toLowerCase(), p.world]));
    for (const pd of pendings) {
      if (pd.expires_at < nowSec) { db.run("DELETE FROM pending_destination WHERE username = ?", [pd.username]); continue; }
      const cur = worldByName.get(pd.username.toLowerCase());
      if (cur === undefined) continue;                 // still offline — wait
      if (cur === pd.target_world) { db.run("DELETE FROM pending_destination WHERE username = ?", [pd.username]); continue; } // already there
      await teleportTo(pd.username, pd.target_world).catch(() => {});
      db.run("DELETE FROM pending_destination WHERE username = ?", [pd.username]);
    }
  }, 5000);
}
