// 2026-11-18: put back the Throne Room piston lever (120 80 283). It was removed
// by mistake: the save scan's box started at x 126, so the lever looked missing.
//
//   docker exec mc-auth bun run scripts/restore_throne_piston.ts
import { addFeature, getFeature, updateFeature } from "../src/map.ts";
import { plugin } from "../src/buildapi.ts";
import { db } from "../src/db.ts";

const SRV = "26" as const, MV = "homeland", BY = "Claude";
const live = await plugin("/states", { world: MV, positions: [[120, 80, 283], [118, 80, 283]] }, 5000, SRV).catch((e) => ({ error: String(e) }));
console.log("live:", JSON.stringify(live));
if (!getFeature(SRV, MV, "ctl-throne-piston")) {
  addFeature(SRV, MV, { slug: "ctl-throne-piston", kind: "control", name: "Throne Room lever (piston)", status: "Unverified", pos: [120, 80, 283],
    control: { group: "Fortress", type: "lever", verified: false, reach: "Throne Room, on the wall.", on: "Pushes its sticky piston out", off: "Pulls it back",
      drives: "1 sticky piston at 118 80 283, facing down (traced; what it moves is unverified)" } }, BY, "Restore.");
}
const fort = getFeature(SRV, MV, "fortress");
if (fort && !fort.labels?.levers?.["120,80,283"]) {
  const lv = Object.entries(fort.labels?.levers || {}).map(([k, n]) => ({ pos: k.split(",").map(Number), name: n }));
  lv.push({ pos: [120, 80, 283], name: "Throne Room lever (piston)" });
  updateFeature(SRV, MV, "fortress", { levers: lv }, BY, "Restore.");
}
db.run("DELETE FROM map_updates WHERE server = ? AND world = ? AND what = 'Restore.'", [SRV, MV]);
db.run("DELETE FROM map_updates WHERE server = ? AND world = ? AND slug = 'ctl-throne-piston' AND action = 'remove'", [SRV, MV]);
console.log("restored:", !!getFeature(SRV, MV, "ctl-throne-piston"), !!getFeature(SRV, MV, "fortress")?.labels?.levers?.["120,80,283"]);
setTimeout(() => process.exit(0), 200);
