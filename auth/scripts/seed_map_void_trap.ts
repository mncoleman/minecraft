// One-off (2026-11-18): the Throne Room void trap. Lever, repeaters, torches,
// pistons and the open shaft checked against the save. The old Throne Room
// piston lever at 120 80 283 is no longer in the world, so it leaves the map.
//
//   docker exec mc-auth bun run scripts/seed_map_void_trap.ts
import { addFeature, getFeature, removeFeature, updateFeature, type FeatureInput } from "../src/map.ts";
import { db } from "../src/db.ts";

const SRV = "26" as const, MV = "homeland", BY = "Claude";
if (getFeature(SRV, MV, "ctl-throne-piston")) removeFeature(SRV, MV, "ctl-throne-piston", BY, "Void trap seed.");
const fort = getFeature(SRV, MV, "fortress");
if (fort) {
  const lv = Object.entries(fort.labels?.levers || {}).filter(([k]) => k !== "120,80,283").map(([k, n]) => ({ pos: k.split(",").map(Number), name: n }));
  lv.push({ pos: [130, 82, 284], name: "Throne Room void trap lever" });
  updateFeature(SRV, MV, "fortress", { levers: lv }, BY, "Void trap seed.");
}
const F: FeatureInput[] = [
  { slug: "throne-void-trap", kind: "building", name: "Throne Room void trap", status: "Built", pos: [131, 79, 279], box: { from: [131, -64, 279], to: [132, 78, 279] },
    detail: "A 2 x 1 trap floor (x 131-132, z 279, y 78) at the foot of the throne step. When it opens, the shaft drops straight through the bedrock to the void." },
  { slug: "ctl-throne-void-trap", kind: "control", name: "Throne Room void trap lever", status: "Checked", pos: [130, 82, 284],
    control: { group: "Fortress", type: "lever", verified: true, reach: "Throne Room, on the back wall behind the left red banner beside the throne.",
      on: "The trap floor at the foot of the throne step OPENS (a drop to the void)", off: "The floor closes",
      drives: "Dust behind the wall, repeaters at 131/132 77 283, wall torches at 131/132 77 281, then sticky pistons at 131/132 78 281 under the floor",
      state: { pos: [131, 78, 281], on: "Floor closed", off: "Floor OPEN" } } },
];
let added = 0;
for (const f of F) { if (!getFeature(SRV, MV, String(f.slug))) { addFeature(SRV, MV, f, BY, "Void trap seed."); added++; } }
db.run("DELETE FROM map_updates WHERE server = ? AND world = ? AND what = 'Void trap seed.'", [SRV, MV]);
const g = getFeature(SRV, MV, "throne-void-trap");
if (added) db.run("INSERT INTO map_updates (server, world, feature_id, slug, action, title, what, actor, secret, at) VALUES (?,?,?,?,?,?,?,?,0,?)",
  [SRV, MV, g?.id ?? null, "throne-void-trap", "add", "Throne Room void trap", "A trap floor at the foot of the throne step that drops to the void, worked by the lever behind the left banner.", BY, Math.floor(Date.now() / 1000)]);
console.log(`void trap: ${added} added`);
setTimeout(() => process.exit(0), 200);
