// 2026-11-18: waterfall basin filled flat; the automatic drain strip added.
// Read live first: lids flush (stone at y 78), pistons at y 76 extended.
//
//   docker exec mc-auth bun run scripts/seed_map_drain_strip.ts
import { addFeature, getFeature, updateFeature, type FeatureInput } from "../src/map.ts";
import { db } from "../src/db.ts";

const SRV = "26" as const, MV = "homeland", BY = "Claude", NOTE = "Drain seed.";
if (getFeature(SRV, MV, "waterfall")) updateFeature(SRV, MV, "waterfall", {
  detail: "Falls from the trough at y 94 (z 240) onto z 239, across x 124-140, into the drain strip. The old basin (z 234-239) is filled in: flat stone at y 78, no pool. Either the Waterfall Hall lever or the right throne armrest lever toggles it.",
}, BY, NOTE);
const F: FeatureInput[] = [
  { slug: "waterfall-drain-strip", kind: "building", name: "Waterfall drain strip", status: "Built", pos: [126, 79, 233], box: { from: [124, 76, 239], to: [140, 78, 239] },
    detail: "17 lids in the floor at x 124-140, z 239 (y 78) on pistons at y 76. They drop within about 2 s when the waterfall comes on, and close flush about 45 s after it goes off. Timer at x 152-168, y 67-71, z 233-241." },
  { slug: "ctl-waterfall-drain", kind: "control", name: "Waterfall drain strip (automatic)", status: "Checked", pos: [132, 78, 239],
    control: { group: "Fortress", type: "auto", verified: true, reach: "The floor under the waterfall, x 124-140, z 239.",
      on: "Follows the waterfall: lids drop within about 2 s of it coming on, then close flush about 45 s after it goes off. No switch of its own: use the Waterfall Hall lever or the right throne armrest lever.",
      drives: "17 sticky pistons at y 76 under the lids", state: { pos: [132, 76, 239], on: "Lids closed", off: "Lids open (draining)" } } },
];
let added = 0;
for (const f of F) { if (!getFeature(SRV, MV, String(f.slug))) { addFeature(SRV, MV, f, BY, NOTE); added++; } }
db.run("DELETE FROM map_updates WHERE server = ? AND world = ? AND what = ?", [SRV, MV, NOTE]);
const g = getFeature(SRV, MV, "waterfall-drain-strip");
db.run("INSERT INTO map_updates (server, world, feature_id, slug, action, title, what, actor, secret, at) VALUES (?,?,?,?,?,?,?,?,0,?)",
  [SRV, MV, g?.id ?? null, "waterfall-drain-strip", "add", "Waterfall drain strip", "The waterfall basin is filled in flat; 17 automatic lids under the fall open while it runs and close about 45 s after.", BY, Math.floor(Date.now() / 1000)]);
console.log(`drain: ${added} added`);
setTimeout(() => process.exit(0), 200);
