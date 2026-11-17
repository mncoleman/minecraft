// One-off: seed the Map tab's features for homeland on 26 from what was built
// before the map existed (the approved mockup + the fortress-harbour job log).
// After this, Claude keeps the map current through the MCP `map` tool.
//
//   docker exec mc-auth bun run scripts/seed_map_homeland.ts
//
// Idempotent: features whose id (slug) already exists are left alone.
import { addFeature, getFeature, type FeatureInput } from "../src/map.ts";
import { db } from "../src/db.ts";

const SRV = "26" as const, MV = "homeland";
const BY = process.env.SEED_ACTOR || "Claude";

const F: FeatureInput[] = [
  // ── the land wall (vertices from the fortress-harbour plan) ──
  { slug: "land-wall", kind: "wall", name: "Homeland land wall", status: "Built", pos: [314, 87, 146],
    detail: "Deepslate curtain wall around the homeland: over the mountain on the west, along the south, round the lake on the east and back to the coast on the north. Night lamps on daylight sensors along the top.",
    points: [[110, 190], [90, 192], [90, 226], [74, 238], [56, 248], [40, 258], [34, 300], [84, 332], [300, 332], [372, 312], [372, 200], [366, 190], [366, 150], [222, 140], [196, 128], [190, 118], [186, 112]] },
  // ── gates (each with floor plans) ──
  { slug: "north-gate", kind: "gate", name: "North Gate", status: "Built", pos: [314, 87, 146], box: { from: [300, 60, 134], to: [328, 115, 158] }, floors: "auto",
    detail: "The main gate, facing the settlement. Twin towers, a 6-wide vaulted passage, iron gate leaves on an enclosed lever, motion lights, a chime and a lamp that shows when it is closed." },
  { slug: "south-gate", kind: "gate", name: "South Gate", status: "Built", pos: [250, 95, 332], box: { from: [238, 70, 322], to: [262, 120, 342] }, floors: "auto",
    detail: "Arched gate through the south wall. Five-wide iron portcullis worked from the winch room above the vault." },
  { slug: "east-gate", kind: "gate", name: "East Gate", status: "Built", pos: [372, 76, 244], box: { from: [362, 55, 232], to: [382, 105, 256] }, floors: "auto",
    detail: "Gate through the east wall, placed north of the lake so the outside path is dry." },
  { slug: "west-postern", kind: "gate", name: "West Postern", status: "Built", pos: [49, 78, 307], box: { from: [40, 60, 298], to: [58, 105, 316] }, floors: "auto",
    detail: "Small side gate on the west wall. Iron doors on buttons, with motion lights over the passage." },
  // ── towers ──
  { slug: "tower-ref", kind: "tower", name: "South Wall Reference Tower", status: "Built", pos: [154, 93, 332], box: { from: [146, 70, 324], to: [162, 125, 340] }, floors: "auto",
    detail: "The first tower built: the template every other tower copies." },
  { slug: "tower-coast-e", kind: "tower", name: "Coastal Tower", status: "Built", pos: [189, 74, 112], box: { from: [181, 55, 104], to: [197, 120, 120] }, floors: "auto",
    detail: "Coastal tower at the end of the north wall, with a lighthouse cage on the roof. Its west door waits for the east harbour arm." },
  { slug: "tower-n-c150", kind: "tower", name: "North Wall Corner Tower", status: "Built", pos: [366, 83, 150], detail: "Corner tower where the north wall turns toward the gate." },
  { slug: "tower-n-262", kind: "tower", name: "North Wall Tower (262)", status: "Built", pos: [262, 80, 143], detail: "Wall tower on the north wall." },
  { slug: "tower-n-222", kind: "tower", name: "North Wall Tower (222)", status: "Built", pos: [222, 78, 140], detail: "Wall tower on the north wall." },
  { slug: "tower-coast-w", kind: "tower", name: "West Wall Coastal Tower", status: "Built", pos: [110, 81, 190], detail: "Corner tower on the coast. Its north door waits for the west harbour arm." },
  { slug: "tower-w2", kind: "tower", name: "West Wall Tower 2", status: "Built", pos: [89, 89, 192], detail: "Wall tower with night beacon lamps on its crown." },
  { slug: "tower-w3", kind: "tower", name: "West Wall Tower 3", status: "Built", pos: [89, 84, 230], detail: "Wall tower on the coast road. Its two rooms have their own light levers." },
  { slug: "tower-w4", kind: "tower", name: "West Wall Tower 4", status: "Built", pos: [40, 90, 256], detail: "Wall tower on the mountain." },
  { slug: "tower-w5", kind: "tower", name: "West Wall Tower 5", status: "Built", pos: [34, 90, 300], detail: "South-west corner tower." },
  { slug: "tower-w6", kind: "tower", name: "West Wall Tower 6", status: "Built", pos: [84, 89, 332], detail: "Tower where the west wall meets the south wall." },
  { slug: "tower-s1", kind: "tower", name: "South Wall Tower 1", status: "Built", pos: [216, 92, 332], detail: "Wall tower on the south wall." },
  { slug: "tower-s2", kind: "tower", name: "South Wall Tower 2", status: "Built", pos: [300, 81, 332], detail: "South-east corner where the wall turns toward the lake." },
  { slug: "tower-se", kind: "tower", name: "SE Corner Tower", status: "Built", pos: [372, 76, 312], detail: "Corner tower beside the pond. The wall here doubles as a dam." },
  { slug: "tower-ne", kind: "tower", name: "NE Corner Tower", status: "Built", pos: [369, 77, 200], detail: "Corner tower joining the east and north walls." },
  // ── the fortress (drill-down with every floor) ──
  { slug: "fortress", kind: "area", name: "The Fortress", status: "Built", pos: [134, 79, 260], box: { from: [86, 10, 222], to: [206, 125, 302] },
    detail: "The original fortress: throne room, Waterfall Hall and the tower top, built into the mountain, with the Under-Station and the Sculk Vault below.",
    floors: [{ y: 13, name: "Sculk Vault" }, { y: 30, name: "Under-Station" }, { y: 66, name: "Courtyard level" }, { y: 78, name: "Main level" }, { y: 98, name: "Upper level" }, { y: 114, name: "Tower top" }],
    rooms: [
      { name: "Sculk wing", x: 151, z: 273, y: 14 }, { name: "Ancient hall", x: 151, z: 283, y: 14 }, { name: "Trial chamber", x: 151, z: 293, y: 14 },
      { name: "Under-Station", x: 130, z: 256, y: 31 }, { name: "Line to the Sea Domes", x: 99, z: 232, y: 31 }, { name: "Vault stairs", x: 135, z: 268, y: 31 },
      { name: "Courtyard pond", x: 205, z: 245, y: 67 }, { name: "Tea house", x: 206, z: 259, y: 67 },
      { name: "Waterfall Hall", x: 122, z: 238, y: 79 }, { name: "Throne Room", x: 132, z: 268, y: 79 }, { name: "Copper Golem Hall", x: 103, z: 277, y: 79 }, { name: "Cherry Courtyard", x: 196, z: 262, y: 79 },
      { name: "Tower rooms", x: 145, z: 255, y: 99 }, { name: "Tower top", x: 145, z: 255, y: 115 },
    ],
    levers: [
      { pos: [127, 32, 256], name: "Under-Station lever" }, { pos: [120, 68, 283], name: "Lever below the Throne Room" },
      { pos: [124, 80, 245], name: "Waterfall Hall lever" }, { pos: [104, 80, 250], name: "Lever west of Waterfall Hall" },
      { pos: [124, 80, 263], name: "Throne Room lever (north)" }, { pos: [120, 80, 283], name: "Throne Room lever (piston)" },
      { pos: [102, 80, 284], name: "Copper bulb clock pause" }, { pos: [131, 82, 283], name: "Throne Room lever (south)" },
      { pos: [133, 82, 283], name: "Throne Room lever (south, 2)" }, { pos: [92, 86, 227], name: "West Tower 3 room lights" },
      { pos: [92, 94, 230], name: "West Tower 3 upper room lights" },
    ] },
  { slug: "courtyard", kind: "building", name: "Cherry Blossom Courtyard", status: "Built", pos: [195, 66, 262], box: { from: [168, 60, 225], to: [223, 95, 301] },
    detail: "Cherry trees, a pale oak, a koi pond with a bridge, a tea house and a reading nook." },
  { slug: "copper-hall", kind: "building", name: "Copper Golem Hall", status: "Built", pos: [103, 79, 277], box: { from: [94, 74, 268], to: [118, 92, 286] },
    detail: "Copper golems sort items from the copper chest into eight labelled chests. Bulbs on a clock, a crafter demo." },
  // ── underground ──
  { slug: "under-station", kind: "building", name: "Fortress Under-Station", status: "Built", pos: [133, 31, 256], underground: true,
    detail: "Minecart station under the fortress, with lines to the Sea Domes and Deep Landing. Floor plan: The Fortress, Under-Station level." },
  { slug: "sculk-vault", kind: "building", name: "Sculk Vault", status: "Built", pos: [151, 14, 283], underground: true,
    detail: "Deep-dark trial chamber below the station: sculk sensors, a calibrated sensor, a trial chamber and an ancient-city hall. Floor plan: The Fortress, Sculk Vault level." },
  { slug: "sea-dome-1", kind: "building", name: "Sea Dome (farm–fortress line)", status: "Built", pos: [97, 30, 100], underground: true, detail: "Glass dome on the sea floor, a stop on the line to the fortress." },
  { slug: "sea-dome-2", kind: "building", name: "Sea Dome (landing–farm line)", status: "Built", pos: [140, 45, 42], underground: true, detail: "Glass dome on the sea floor, a stop on the line to Deep Landing." },
  { slug: "deep-landing", kind: "building", name: "Deep Landing", status: "Built", pos: [321, 31, 12], underground: true, detail: "Underground station below the settlement." },
  { slug: "rail-domes-fortress", kind: "rail", name: "Rail: Sea Domes to the fortress", status: "Built", underground: true, points: [[99, 31, 100], [99, 31, 251], [133, 31, 256]], detail: "Tunnel line along x 99 from the Sea Dome to the Under-Station." },
  { slug: "rail-fortress-landing", kind: "rail", name: "Rail: fortress to Deep Landing", status: "Built", underground: true, points: [[138, 31, 257], [324, 31, 257], [324, 31, 19]], detail: "Tunnel line east along z 257, then north along x 324 to Deep Landing." },
  { slug: "rail-landing-domes", kind: "rail", name: "Rail: Deep Landing to the Sea Domes", status: "Built", underground: true, points: [[318, 31, 40], [142, 40, 40], [99, 31, 40], [99, 31, 100]], detail: "Tunnel line west along z 40, past the second Sea Dome." },
  // ── planned ──
  { slug: "harbour-mouth", kind: "planned", name: "Harbour mouth", status: "Planned", pos: [139, 62, 128], points: [[126, 132], [152, 124]],
    detail: "A gate between two lighthouse towers that opens and closes from a lever, closing the north cove into a harbour." },
  { slug: "harbour-east-arm", kind: "planned", name: "Harbour east arm", status: "Planned", points: [[186, 112], [164, 104], [152, 124]], detail: "Sea wall from the Coastal Tower out to the east gate tower of the harbour mouth." },
  { slug: "harbour-west-arm", kind: "planned", name: "Harbour west arm", status: "Planned", points: [[126, 132], [112, 150], [110, 172], [110, 190]], detail: "Sea wall from the west gate tower of the harbour mouth back to the West Wall Coastal Tower." },
  // ── keep clear ──
  { slug: "settlement", kind: "keepclear", name: "The settlement", status: "Protected", pos: [357, 70, -2], box: { from: [297, 40, -58], to: [417, 140, 53] },
    detail: "Walled village above Deep Landing. Nothing is built on or near it." },
  { slug: "xp-farm", kind: "keepclear", name: "XP Farm", status: "Protected", pos: [98, 181, 33], box: { from: [86, 170, 22], to: [106, 192, 42] },
    detail: "Sky platform at y 181. Kept clear of the wall and harbour." },
];

let added = 0, kept = 0;
for (const f of F) {
  if (getFeature(SRV, MV, String(f.slug))) { kept++; continue; }
  addFeature(SRV, MV, f, BY, "Added to the map (built before the Map tab existed).");
  added++;
}
// The per-feature "added" lines would bury the feed; keep the real build history instead
// (times from the fortress-harbour job log, 17 Nov 2026, Mountain time).
db.run("DELETE FROM map_updates WHERE server = ? AND world = ? AND what = ?", [SRV, MV, "Added to the map (built before the Map tab existed)."]);
const HIST: Array<[string, string, number, string]> = [
  ["sculk-vault", "Sculk Vault", 1794927300, "Deep-dark trial chamber below the Under-Station."],
  ["courtyard", "Cherry Blossom Courtyard", 1794928800, "Cherry trees, koi pond, tea house and reading nook."],
  ["harbour-mouth", "Harbour mouth", 1794939600, "Gate line set across the north cove. Planned, not built."],
  ["tower-w4", "West wall", 1794951060, "6 towers over the mountain, the West Postern, 56 night lamps."],
  ["tower-se", "South-east and east wall", 1794952680, "4 towers, South Gate and East Gate, night lamps on daylight sensors."],
  ["north-gate", "North wall and North Gate", 1794956700, "NE corner to the coast: 2 towers, 2 turrets, the coastal lighthouse tower and the twin-tower North Gate."],
];
if (!(db.query("SELECT COUNT(*) AS n FROM map_updates WHERE server = ? AND world = ?").get(SRV, MV) as { n: number }).n) {
  for (const [slug, title, at, what] of HIST) {
    const f = getFeature(SRV, MV, slug);
    db.run("INSERT INTO map_updates (server, world, feature_id, slug, action, title, what, actor, secret, at) VALUES (?,?,?,?,?,?,?,?,0,?)", [SRV, MV, f?.id ?? null, slug, "add", title, what, BY, at]);
  }
}
console.log(`homeland map seed: ${added} added, ${kept} already there`);
setTimeout(() => process.exit(0), 100);
