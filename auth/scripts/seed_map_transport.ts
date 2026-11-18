// One-off (2026-11-17): transport build. The Ice Road replaces the fortress to
// Deep Landing minecart line; new boat buttons, Happy Ghast Stable, Docks Lift,
// Lake Bridge and the horse barn. Positions checked against the save.
//
//   docker exec mc-auth bun run scripts/seed_map_transport.ts
import { addFeature, getFeature, removeFeature, updateFeature, type FeatureInput } from "../src/map.ts";
import { db } from "../src/db.ts";

const SRV = "26" as const, MV = "homeland", BY = "Claude";
for (const id of ["rail-fortress-landing", "ctl-station-2"]) {
  if (getFeature(SRV, MV, id)) removeFeature(SRV, MV, id, BY, "Transport seed.");
}
if (getFeature(SRV, MV, "under-station")) updateFeature(SRV, MV, "under-station", {
  detail: "Station under the fortress: the glass-tube line to the Sea Domes, and the Ice Road boat lane to Deep Landing. Floor plan: The Fortress, Under-Station level.",
}, BY, "Transport seed.");
const F: FeatureInput[] = [
  { slug: "ice-road", kind: "passage", name: "Ice Road", status: "Built", underground: true, pos: [139, 31, 256],
    points: [[141, 31, 257], [316, 31, 257], [324, 31, 250], [324, 31, 18]],
    detail: "Blue-ice boat lane at y 31 from the Fortress Dock (x 141, z 257) east to x 316, round the corner and north along x 324-325 to Deep Landing (z 18). A tuff footpath runs on the inner side. Replaces the old minecart tunnel." },
  { slug: "happy-ghast-stable", kind: "building", name: "Happy Ghast Stable", status: "Built", pos: [157, 78, 206], box: { from: [150, 76, 198], to: [164, 90, 208] },
    detail: "11 x 11 pad at y 77 with a tack shed. Lamp posts come on at night by themselves." },
  { slug: "docks-lift", kind: "building", name: "Docks Lift", status: "Built", pos: [158, 65, 177], box: { from: [157, 65, 178], to: [159, 78, 178] },
    detail: "Bubble-column tubes from the quay (y 65) up to y 78: the west tube goes up, the east one comes down. No controls." },
  { slug: "lake-bridge", kind: "building", name: "Lake Bridge", status: "Built", pos: [291, 70, 227], box: { from: [261, 62, 225], to: [322, 78, 229] },
    detail: "Bridge across the lake (z 225-229, x 261-322) with a gazebo at midspan (x 288-295) and a road on to the East Gate. Its lamps come on at night by themselves." },
  { slug: "horse-barn", kind: "building", name: "Player's Horse Barn", status: "Built", pos: [363, 64, 2], box: { from: [359, 62, 3], to: [368, 78, 15] },
    detail: "Horse barn by the settlement (x 359-368, z 3-15)." },
  { slug: "ctl-ice-fortress-boat", kind: "control", name: "Fortress Dock boat button", status: "Checked", pos: [140, 31, 259],
    control: { group: "Ice Road", type: "button", verified: true, reach: "Ice Road: Fortress Dock, beside the lane at the fortress end.",
      on: "Press: the dispenser at 141 31 259 drops a boat onto the ice.", drives: "The boat dispenser" } },
  { slug: "ctl-ice-landing-boat", kind: "control", name: "Deep Landing boat button", status: "Checked", pos: [326, 31, 18],
    control: { group: "Ice Road", type: "button", verified: true, reach: "Ice Road: Deep Landing Dock, at the north end of the lane.",
      on: "Press: the dispenser at 326 31 19 drops a boat onto the ice.", drives: "The boat dispenser" } },
  { slug: "ctl-ghast-lamps", kind: "control", name: "Stable lamp posts (automatic)", status: "Checked", pos: [154, 80, 198],
    control: { group: "Happy Ghast Stable", type: "auto", verified: true, reach: "Lamp posts at 154 80 198, 164 80 198 and 164 80 208.", on: "Lit at night (daylight sensors). Nothing to switch." } },
];
let added = 0;
for (const f of F) { if (!getFeature(SRV, MV, String(f.slug))) { addFeature(SRV, MV, f, BY, "Transport seed."); added++; } }
db.run("DELETE FROM map_updates WHERE server = ? AND world = ? AND what = 'Transport seed.'", [SRV, MV]);
const g = getFeature(SRV, MV, "ice-road");
db.run("INSERT INTO map_updates (server, world, feature_id, slug, action, title, what, actor, secret, at) VALUES (?,?,?,?,?,?,?,?,0,?)",
  [SRV, MV, g?.id ?? null, "ice-road", "add", "Ice Road and new transport", "The Ice Road boat lane replaces the minecart line to Deep Landing (boat buttons at both docks), plus the Happy Ghast Stable, Docks Lift, Lake Bridge and the horse barn.", BY, Math.floor(Date.now() / 1000)]);
console.log(`transport: ${added} added`);
setTimeout(() => process.exit(0), 200);
