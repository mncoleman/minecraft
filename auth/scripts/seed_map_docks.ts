// One-off (2026-11-17): the harbour docks and ships, plus their controls.
// Control positions checked against the save (slice.py inventory + block read).
//
//   docker exec mc-auth bun run scripts/seed_map_docks.ts
import { addFeature, getFeature, type FeatureInput } from "../src/map.ts";
import { db } from "../src/db.ts";

const SRV = "26" as const, MV = "homeland", BY = "Claude";
const F: FeatureInput[] = [
  { slug: "south-quay", kind: "building", name: "South Quay", status: "Built", pos: [145, 65, 175], box: { from: [132, 60, 172], to: [156, 70, 177] },
    detail: "Main quay along the south of the harbour, deck at y 64. The Boat Station is on its front under the canopy." },
  { slug: "east-quay", kind: "building", name: "East Quay", status: "Built", pos: [159, 65, 160], box: { from: [157, 60, 137], to: [161, 72, 177] },
    detail: "Quay along the east side, with a timber crane at x 160, z 145." },
  { slug: "cargo-hall", kind: "building", name: "Cargo Hall", status: "Built", pos: [136, 65, 179], box: { from: [132, 62, 178], to: [141, 78, 186] }, floors: "auto",
    detail: "Warehouse behind the South Quay (door at x 135-138, z 178), with a crafter." },
  { slug: "harbour-master", kind: "building", name: "Harbour-master's office", status: "Built", pos: [160, 65, 140], box: { from: [157, 62, 137], to: [163, 82, 143] }, floors: "auto",
    detail: "Office at the north end of the East Quay, looking out over the harbour gate. Ridge light on top." },
  { slug: "galleon", kind: "building", name: "Galleon", status: "Built", pos: [127, 67, 160], box: { from: [123, 55, 137], to: [131, 110, 178] }, floors: "auto",
    detail: "Three-masted galleon: captain's cabin, hold and gun deck." },
  { slug: "merchant-cog", kind: "building", name: "Merchant cog", status: "Built", pos: [152, 66, 155], box: { from: [149, 55, 138], to: [155, 95, 164] }, floors: "auto",
    detail: "Merchant ship moored at the East Quay." },
  { slug: "fishing-sloop", kind: "building", name: "Fishing sloop", status: "Built", pos: [149, 66, 168], box: { from: [142, 58, 166], to: [156, 80, 170] },
    detail: "Small fishing boat by the South Quay." },
  { slug: "slipway", kind: "building", name: "Slipway and boathouse", status: "Built", pos: [118, 65, 181], box: { from: [115, 58, 175], to: [122, 80, 188] },
    detail: "Boathouse over a slipway, with a hull under construction." },
  { slug: "west-pier", kind: "building", name: "West pier", status: "Built", pos: [120, 65, 171], box: { from: [119, 60, 168], to: [122, 68, 175] },
    detail: "Short pier on the west side of the docks." },
  { slug: "dock-road", kind: "passage", name: "Dock road", status: "Built", pos: [145, 65, 178], points: [[145, 65, 178], [145, 78, 213]],
    detail: "Portal at 145 65 178, then a stair tunnel up to the plaza at z 213 (floor y 78)." },
  // ── controls ──
  { slug: "ctl-boat-station", kind: "control", name: "Boat Station button", status: "Checked", pos: [138, 65, 172],
    control: { group: "Docks", type: "button", verified: true, reach: "South Quay front, under the canopy.",
      on: "Press once (there is no off): the dispenser at 138 63 172 puts a boat on the water at 138 62 171. The copper bulb at 137 64 172 changes on every press.",
      drives: "The boat dispenser, refilled by a hopper from the barrel in the deck at 139 64 172, and the copper bulb" } },
  { slug: "ctl-cargo-crafter", kind: "control", name: "Cargo Hall crafter button", status: "Checked", pos: [140, 66, 181],
    control: { group: "Docks", type: "button", verified: true, reach: "Inside the Cargo Hall (door at x 135-138, z 178).",
      on: "Press once: crafts one item from whatever is in the crafter grid at 140 65 181.", drives: "The crafter" } },
  { slug: "ctl-docks-lights", kind: "control", name: "Dock night lamps (automatic)", status: "Checked", pos: [134, 67, 176],
    control: { group: "Docks", type: "auto", verified: true,
      reach: "Quay lamps at 134 67 176, 150 67 174, 158 67 151, 158 67 161 and 158 67 170; the office ridge light at 160 79 140; dock road lamps at 143 81 211 and 147 81 211.",
      on: "Lit at night (daylight sensors): nothing to switch" } },
];
let added = 0;
for (const f of F) { if (!getFeature(SRV, MV, String(f.slug))) { addFeature(SRV, MV, f, BY, "Docks seed."); added++; } }
// one line in the feed for the lot
db.run("DELETE FROM map_updates WHERE server = ? AND world = ? AND what = 'Docks seed.'", [SRV, MV]);
if (added) {
  const g = getFeature(SRV, MV, "galleon");
  db.run("INSERT INTO map_updates (server, world, feature_id, slug, action, title, what, actor, secret, at) VALUES (?,?,?,?,?,?,?,?,0,?)",
    [SRV, MV, g?.id ?? null, "galleon", "add", "Docks and ships", "South and East Quays, Cargo Hall, harbour-master's office, the galleon, merchant cog, fishing sloop, slipway, west pier and dock road, plus the Boat Station and crafter buttons.", BY, Math.floor(Date.now() / 1000)]);
}
console.log(`docks: ${added} added`);
setTimeout(() => process.exit(0), 200);
