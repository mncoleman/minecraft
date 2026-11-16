import { db } from "./db.ts";
import { teleportTo, upsertLocation } from "./worlds.ts";
import { SERVERS, enabledServers, type ServerId } from "./servers.ts";

const TOKEN = process.env.MC_PRESENCE_TOKEN || "";

/** An online player. `server` is which edition they're connected to. */
export interface OnlinePlayer { name: string; world: string; server: ServerId; x?: number; y?: number; z?: number }

const caches: Record<ServerId, { at: number; players: OnlinePlayer[] }> = {
  "18": { at: 0, players: [] },
  "26": { at: 0, players: [] },
};

/** Online players on ONE server (cached ~3s). Empty if its endpoint is down. */
export async function getPresenceFor(srv: ServerId): Promise<OnlinePlayer[]> {
  const cache = caches[srv];
  if (Date.now() - cache.at < 3000) return cache.players;
  if (!TOKEN) return [];
  const s = SERVERS[srv];
  try {
    const r = await fetch(`http://${s.host}:${s.presencePort}/presence`, {
      headers: { Authorization: "Bearer " + TOKEN },
      signal: AbortSignal.timeout(2500),
    });
    const j = r.ok ? ((await r.json()) as { players?: Array<Omit<OnlinePlayer, "server">> }) : { players: [] };
    const players = Array.isArray(j.players) ? j.players.map((p) => ({ ...p, server: srv })) : [];
    caches[srv] = { at: Date.now(), players };
  } catch {
    caches[srv] = { at: Date.now(), players: [] };
  }
  return caches[srv].players;
}

/** Online players across every enabled server (each tagged with its server). */
export async function getPresence(): Promise<OnlinePlayer[]> {
  const lists = await Promise.all(enabledServers().map((s) => getPresenceFor(s)));
  return lists.flat();
}

/** Which server a player is on right now (null if offline). */
export async function serverOfPlayer(username: string): Promise<OnlinePlayer | null> {
  const lc = username.toLowerCase();
  return (await getPresence()).find((p) => p.name.toLowerCase() === lc) ?? null;
}

/** Poll loop: record each online player's location so the command center can
 * show + teleport to last-known spots (even after they log off). */
export function startLocationLogger(): void {
  setInterval(async () => {
    try {
      for (const p of await getPresence()) {
        if (typeof p.x === "number" && typeof p.y === "number" && typeof p.z === "number") {
          upsertLocation(p.name, p.server, p.world, p.x, p.y, p.z);
        }
      }
    } catch {}
  }, 6000);
}

/** Poll loop: when a player with a pending hop destination comes online ON THAT
 *  destination's server, teleport them. (Joining the other edition doesn't count.) */
export function startHopAutoRoute(): void {
  setInterval(async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const pendings = db.query("SELECT * FROM pending_destination").all() as Array<{ username: string; target_world: string; server: ServerId; expires_at: number }>;
    if (!pendings.length) return;
    const online = await getPresence();
    for (const pd of pendings) {
      if (pd.expires_at < nowSec) { db.run("DELETE FROM pending_destination WHERE username = ?", [pd.username]); continue; }
      const me = online.find((p) => p.server === pd.server && p.name.toLowerCase() === pd.username.toLowerCase());
      if (!me) continue;                                // not on that server yet — wait
      if (me.world === pd.target_world) { db.run("DELETE FROM pending_destination WHERE username = ?", [pd.username]); continue; } // already there
      await teleportTo(pd.username, pd.target_world, pd.server).catch(() => {});
      db.run("DELETE FROM pending_destination WHERE username = ?", [pd.username]);
    }
  }, 5000);
}
