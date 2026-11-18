// 2026-11-18: stable removed, plateau levelled for a village, Stable Stores,
// the north courtyard village, and the waterfall's two levers. Every block
// read live (and from a flushed save) before this ran.
//
//   docker exec mc-auth bun run scripts/seed_map_village.ts
import { addFeature, getFeature, removeFeature, updateFeature, type FeatureInput } from "../src/map.ts";
import { db } from "../src/db.ts";

const SRV = "26" as const, MV = "homeland", BY = "Claude", NOTE = "Village seed.";
for (const id of ["happy-ghast-stable", "ctl-ghast-lamps"]) if (getFeature(SRV, MV, id)) removeFeature(SRV, MV, id, BY, NOTE);
const F: FeatureInput[] = [
  { slug: "upper-plateau", kind: "planned", name: "Upper Plateau (village site)", status: "Planned", pos: [129, 79, 198], box: { from: [116, 78, 179], to: [154, 78, 213] },
    detail: "The old stone mound (x 116-154, z 179-213), levelled to a flat plateau at y 78. A village goes here next. The former stable pad (x 154-163, z 199-208) is now Village: Stable Square." },
  { slug: "stable-stores", kind: "building", name: "Stable Stores", status: "Built", pos: [131, 79, 212], box: { from: [130, 78, 212], to: [133, 82, 213] },
    detail: "Lean-to storehouse with a double chest (131-132 79 213) and a barrel (133 79 213)." },
  { slug: "courtyard-village", kind: "building", name: "North courtyard village", status: "Built", pos: [145, 80, 222], box: { from: [125, 77, 212], to: [163, 90, 231] },
    detail: "Market stalls, a farm, four cottages (x 127-134) and a fountain with the village bell. Lamp posts come on at night by themselves." },
  { slug: "village-fountain", kind: "place", name: "Fountain and village bell", status: "Built", pos: [145, 80, 221], detail: "The courtyard fountain, with the village bell at 145 81 220." },
  { slug: "waterfall", kind: "building", name: "Waterfall", status: "Built", pos: [132, 79, 238], box: { from: [124, 78, 239], to: [140, 94, 240] },
    detail: "Falls from the trough at y 94 (z 240) onto z 239, across x 124-140. Either the Waterfall Hall lever or the right throne armrest lever toggles it." },
  { slug: "ctl-courtyard-lamps", kind: "control", name: "Courtyard lamp posts (automatic)", status: "Checked", pos: [139, 81, 218],
    control: { group: "North courtyard village", type: "auto", verified: true, reach: "11 lamp posts around the market, fountain and cottages (139-162 x, 212-230 z).", on: "Lit at night (daylight sensors). Nothing to switch." } },
];
let added = 0;
for (const f of F) { if (!getFeature(SRV, MV, String(f.slug))) { addFeature(SRV, MV, f, BY, NOTE); added++; } }
// the waterfall's two levers
const wf = "Either lever toggles the waterfall (each flip switches it).";
if (getFeature(SRV, MV, "ctl-waterfall")) updateFeature(SRV, MV, "ctl-waterfall", { name: "Waterfall Hall lever (waterfall)", status: "Checked",
  control: { group: "Fortress", type: "lever", verified: true, reach: "Waterfall Hall, east wall.", on: wf, drives: "The waterfall from the trough at y 94 (x 124-140). The right throne armrest lever (133 82 283) toggles it too." } }, BY, NOTE);
if (getFeature(SRV, MV, "ctl-throne-south-2")) updateFeature(SRV, MV, "ctl-throne-south-2", { name: "Throne Room right armrest lever (waterfall)", status: "Checked",
  control: { group: "Fortress", type: "lever", verified: true, reach: "On the right armrest of the throne (floor lever).", on: wf, drives: "The waterfall from the trough at y 94 (x 124-140). The Waterfall Hall lever (124 80 245) toggles it too." } }, BY, NOTE);
const fort = getFeature(SRV, MV, "fortress");
if (fort) {
  const lv = Object.entries(fort.labels?.levers || {}).map(([k, n]) => ({ pos: k.split(",").map(Number),
    name: k === "124,80,245" ? "Waterfall Hall lever (waterfall)" : k === "133,82,283" ? "Throne Room right armrest lever (waterfall)" : n }));
  updateFeature(SRV, MV, "fortress", { levers: lv }, BY, NOTE);
}
db.run("DELETE FROM map_updates WHERE server = ? AND world = ? AND what = ?", [SRV, MV, NOTE]);
const g = getFeature(SRV, MV, "courtyard-village");
db.run("INSERT INTO map_updates (server, world, feature_id, slug, action, title, what, actor, secret, at) VALUES (?,?,?,?,?,?,?,?,0,?)",
  [SRV, MV, g?.id ?? null, "courtyard-village", "add", "Village and plateau", "The Happy Ghast Stable is gone; its hill is now a flat plateau for the next village. New: the north courtyard village, Stable Stores, and the waterfall's two levers named.", BY, Math.floor(Date.now() / 1000)]);
console.log(`village: ${added} added`);
setTimeout(() => process.exit(0), 200);
