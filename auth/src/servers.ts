// The game servers this panel drives. Two editions run side by side and share
// NOTHING but the login: worlds, places, hop, and the Claude connector are all
// scoped to one server. Friends and "who's online" span both.
//
//   "18" — Paper 1.12.2 for the 1.8 Eaglercraft client (container mc-eagler).
//          Legacy command dialect: Multiverse 2.5, WorldGuard 6, `execute P ~ ~ ~`.
//   "26" — Paper 26.2 for the 26.x Eaglercraft client (container mc-eagler26).
//          Modern dialect: Multiverse 5 (`--seed`, `mv modify`, OTP confirm),
//          `execute as/at`, namespaced block ids, worlds under world/dimensions.
//
// The 26 server is optional: it's only "enabled" when RCON26_PASSWORD is set, so
// the panel can ship before the container exists without showing dead buttons.

export type ServerId = "18" | "26";

export interface GameServer {
  id: ServerId;
  /** Player-facing edition name. */
  label: string;
  /** Docker hostname on server_default (RCON, presence, ClaudeBuild API). */
  host: string;
  rconPort: number;
  rconPassword: string;
  presencePort: number;
  buildPort: number;
  /** The game's /data, bind-mounted into mc-auth (read access + uploads). */
  gamedataDir: string;
  /** Modern (26.x) command dialect + block ids. */
  modern: boolean;
  /** Where its Play button points (served by mc-auth). */
  playPath: string;
  /** Public wss endpoint the client auto-joins (Caddy routes it). */
  wsPath: string;
}

const env = (k: string, d = "") => process.env[k] ?? d;

export const SERVERS: Record<ServerId, GameServer> = {
  "18": {
    id: "18",
    label: "1.8",
    host: env("RCON_HOST", "mc-eagler"),
    rconPort: Number(env("RCON_PORT", "25575")),
    rconPassword: env("RCON_PASSWORD"),
    presencePort: Number(env("PRESENCE_PORT", "25580")),
    buildPort: Number(env("BUILD_API_PORT", "25581")),
    gamedataDir: env("GAMEDATA_DIR", "/gamedata").replace(/\/+$/, ""),
    modern: false,
    playPath: "/",
    wsPath: "/",
  },
  "26": {
    id: "26",
    label: "26",
    host: env("RCON26_HOST", "mc-eagler26"),
    rconPort: Number(env("RCON26_PORT", "25575")),
    rconPassword: env("RCON26_PASSWORD"),
    presencePort: Number(env("PRESENCE26_PORT", "25580")),
    buildPort: Number(env("BUILD26_API_PORT", "25581")),
    gamedataDir: env("GAMEDATA26_DIR", "/gamedata26").replace(/\/+$/, ""),
    modern: true,
    playPath: "/26/",
    wsPath: "/26",
  },
};

/** 1.8 can be retired without deleting it: SERVER18_ENABLED=false hides it
 *  everywhere (Play button, worlds, hop, presence, Claude) while its data and
 *  panel rows stay put for a rollback. See deploy/DEPLOY.md "Retiring 1.8". */
const on18 = env("SERVER18_ENABLED", "true").toLowerCase() !== "false";

/** Servers that are configured: 1.8 unless retired, 26 when its RCON password is set. */
export function enabledServers(): ServerId[] {
  const out: ServerId[] = [];
  if (on18) out.push("18");
  if (SERVERS["26"].rconPassword) out.push("26");
  return out.length ? out : ["18"];
}

/** Fallback server for callers that don't name one: the first one running. */
export const DEFAULT_SERVER: ServerId = enabledServers()[0];
export function isEnabled(id: ServerId): boolean {
  return enabledServers().includes(id);
}

/** Parse untrusted input ("26", "1.8", "18", "edition-26"…) to a ServerId, or null. */
export function parseServer(v: unknown): ServerId | null {
  const s = String(v ?? "").trim().toLowerCase().replace(/^edition-?/, "");
  if (s === "26" || s.startsWith("26.")) return "26";
  if (s === "18" || s === "1.8" || s === "1.12" || s === "1.12.2" || s === "legacy") return "18";
  return null;
}
/** parseServer with a fallback (DEFAULT_SERVER unless given). */
export function serverOr(v: unknown, fallback: ServerId = DEFAULT_SERVER): ServerId {
  return parseServer(v) ?? fallback;
}
export function serverLabel(id: ServerId): string {
  return SERVERS[id].label;
}
