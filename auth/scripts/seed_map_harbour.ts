// One-off (2026-11-17): the harbour was built. Its planned lines become built
// features, and its gate lever and status lamps join the Controls list. Every
// position below was checked against the save (slice.py inventory).
//
//   docker exec mc-auth bun run scripts/seed_map_harbour.ts
import { addFeature, getFeature, removeFeature, type FeatureInput } from "../src/map.ts";
import { db } from "../src/db.ts";

const SRV = "26" as const, MV = "homeland", BY = "Claude";
for (const id of ["harbour-mouth", "harbour-east-arm", "harbour-west-arm"]) {
  if (getFeature(SRV, MV, id)) removeFeature(SRV, MV, id, BY, "Built: replaced by the harbour's lighthouses, gate and sea arms.");
}
const ctl = (c: any) => ({ group: "Harbour", type: "lever", verified: true, ...c });
const F: FeatureInput[] = [
  { slug: "west-lighthouse", kind: "tower", name: "West Lighthouse", status: "Built", pos: [129, 75, 127], box: { from: [116, 55, 119], to: [134, 120, 137] }, floors: "auto",
    detail: "West tower of the harbour mouth. The gate control room is below its hall. Spiral stair to the watch room at y 104, then the ladder at 127 105 123 up to the terrace at y 109." },
  { slug: "east-lighthouse", kind: "tower", name: "East Lighthouse", status: "Built", pos: [149, 75, 129], box: { from: [144, 55, 119], to: [162, 120, 137] }, floors: "auto",
    detail: "East tower of the harbour mouth. A floor lamp at 148 74 128 shows the gate: lit = closed. Spiral stair to the watch room at y 104." },
  { slug: "harbour-gate", kind: "gate", name: "Harbour Gate", status: "Built", pos: [139, 75, 128], points: [[132, 128], [146, 128]], box: { from: [130, 58, 124], to: [148, 80, 132] }, floors: "auto",
    detail: "Sea gate across the harbour mouth (x 132-146, z 128) under the bridge. Closed: piston jaws rise to y 62 and copper grates drop to y 64. Worked from the lever in Harbour Gate Control." },
  { slug: "harbour-west-arm", kind: "wall", name: "Harbour west arm", status: "Built", points: [[126, 132], [112, 150], [110, 172], [110, 190]], detail: "Sea wall from the West Lighthouse, past the turret at 112 150, to the West Wall Coastal Tower." },
  { slug: "harbour-east-arm", kind: "wall", name: "Harbour east arm", status: "Built", points: [[186, 112], [164, 104], [152, 124]], detail: "Sea wall from the Coastal Tower, past the turret at 164 104, to the East Lighthouse." },
  { slug: "west-arm-turret", kind: "tower", name: "West arm turret", status: "Built", pos: [112, 70, 150], detail: "Corner turret on the west sea arm, with night merlons." },
  { slug: "east-arm-turret", kind: "tower", name: "East arm turret", status: "Built", pos: [164, 70, 104], detail: "Corner turret on the east sea arm, with night merlons." },
  { slug: "harbour-gate-control", kind: "place", name: "Harbour Gate Control", status: "Built", pos: [125, 68, 127], detail: "The closed room with the gate lever, under the West Lighthouse hall." },
  { slug: "harbour-bridge", kind: "place", name: "Harbour Bridge", status: "Built", pos: [139, 75, 128], detail: "Bridge over the gate. Red signal band lit = closed, green = open." },
  // ── controls ──
  { slug: "ctl-harbour-gate", kind: "control", name: "Harbour Gate lever (ON = closed)", status: "Checked", pos: [127, 69, 128],
    control: ctl({ reach: "From the West Lighthouse hall (bridge door at x 131, y 75), take the railed opening in the hall floor on the south side, go down the stair heading west, then north into the closed room. The lever is on the east wall above a red concrete desk.",
      on: "Gate CLOSED. Yes, ON means closed: the jaws rise to y 62 and the copper grates drop to y 64 across x 132-146.",
      off: "Gate OPEN: boats can pass.",
      drives: "Both piston rows (30 sticky pistons), the closed and open lamps, the bridge signal bands, both chimes and the East Lighthouse lamp" }) },
  { slug: "ctl-harbour-closed-lamp", kind: "control", name: "Gate closed lamp (red glass)", status: "Checked", pos: [128, 70, 128],
    control: ctl({ type: "status", reach: "Harbour Gate Control, beside the lever.", on: "Lit while the gate is closed", drives: "Nothing: it shows the gate. The chime beside it (note block 128 70 126, observer 128 70 127) rings on every change." }) },
  { slug: "ctl-harbour-open-lamp", kind: "control", name: "Gate open lamp (lime glass)", status: "Checked", pos: [128, 71, 128],
    control: ctl({ type: "status", reach: "Harbour Gate Control, above the closed lamp.", on: "Lit while the gate is open", drives: "Nothing: it shows the gate." }) },
  { slug: "ctl-harbour-east-lamp", kind: "control", name: "East Lighthouse gate lamp", status: "Checked", pos: [148, 74, 128],
    control: ctl({ type: "status", reach: "In the floor of the East Lighthouse.", on: "Lit = gate closed", off: "Dark = gate open", drives: "Nothing: it shows the gate. Its chime is at 148 74 126." }) },
  { slug: "ctl-harbour-bands", kind: "control", name: "Bridge signal bands", status: "Checked", pos: [138, 69, 128],
    control: ctl({ type: "status", reach: "Along the bridge, x 132-146.", on: "Red band (y 69) lit = gate closed; green band (y 71) lit = gate open", drives: "Nothing: they show the gate from the water." }) },
  { slug: "ctl-harbour-lights", kind: "control", name: "Lighthouse lights (automatic)", status: "Checked", pos: [125, 115, 124],
    control: ctl({ type: "auto", reach: "Lantern-roof rings at y 115 (32 lamps per tower), watch-room balcony beacons at y 106, night merlons along the bridge, both sea arms and the turrets.", on: "Lit at night (daylight sensors): nothing to switch", drives: "The lantern-room lens is always lit and has no circuit." }) },
];
let added = 0;
for (const f of F) { if (!getFeature(SRV, MV, String(f.slug))) { addFeature(SRV, MV, f, BY, f.kind === "control" ? "Added to the Controls list." : "Built."); added++; } }
db.run("DELETE FROM map_updates WHERE server = ? AND world = ? AND slug LIKE 'ctl-harbour-%' AND what = 'Added to the Controls list.'", [SRV, MV]);
const g = getFeature(SRV, MV, "ctl-harbour-gate");
if (g) db.run("INSERT INTO map_updates (server, world, feature_id, slug, action, title, what, actor, secret, at) VALUES (?,?,?,?,?,?,?,?,0,?)",
  [SRV, MV, g.id, g.slug, "add", "Harbour gate controls", "The gate lever (ON = closed), its status lamps, the bridge signal bands and the automatic lighthouse lights.", BY, Math.floor(Date.now() / 1000)]);
console.log(`harbour: ${added} added`);
setTimeout(() => process.exit(0), 200);
