// The ClaudeBuild plugin's JSON API, one per game server (build-plugin/ on 1.8,
// build-plugin-26/ on 26), reached over the internal Docker network. Shared by the
// MCP endpoint (builds, scans, the avatar) and the Map tab (live redstone, levers).
import { readFileSync } from "node:fs";
import { SERVERS, isEnabled, serverLabel, type ServerId } from "./servers.ts";

// Each server runs its own ClaudeBuild plugin (build-plugin/ on 1.8, build-plugin-26/
// on 26), which generates its token into its own config.yml on that server's
// game-data mount; read it lazily (and re-read on 401, in case it regenerated).
const buildTokens: Record<ServerId, string | null> = { "18": null, "26": null };
function readBuildToken(srv: ServerId): string | null {
  try {
    const y = readFileSync(`${SERVERS[srv].gamedataDir}/plugins/ClaudeBuild/config.yml`, "utf8");
    const m = y.match(/^api-token:\s*['"]?([0-9a-f]{32,})['"]?\s*$/m);
    return m ? m[1] : null;
  } catch { return null; }
}
export async function plugin(path: string, body: unknown, timeoutMs = 30000, srv: ServerId = "18"): Promise<any> {
  if (!isEnabled(srv)) throw new Error(`The ${serverLabel(srv)} server isn't set up.`);
  if (!buildTokens[srv]) buildTokens[srv] = readBuildToken(srv);
  if (!buildTokens[srv]) throw new Error(`ClaudeBuild isn't installed on the ${serverLabel(srv)} server or hasn't started yet.`);
  const url = `http://${SERVERS[srv].host}:${SERVERS[srv].buildPort}`;
  const call = () => fetch(url + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + buildTokens[srv], "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let r = await call();
  if (r.status === 401) { buildTokens[srv] = readBuildToken(srv); r = await call(); }
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
  return j;
}

