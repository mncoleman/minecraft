// One-off (2026-11-17): the fortress passages and secrets, plus their controls.
// Control and door positions checked against the save (slice.py inventory +
// block reads). Secrets are shown to everyone (owner: "nothing to hide"), only
// flagged secret so the map labels them.
//
//   docker exec mc-auth bun run scripts/seed_map_passages.ts
import { addFeature, getFeature, type FeatureInput } from "../src/map.ts";
import { db } from "../src/db.ts";

const SRV = "26" as const, MV = "homeland", BY = "Claude";
const toggle = "Each flip toggles the door: the lever's position doesn't mean open or shut.";
const door = (pos: [number, number, number]) => ({ pos, on: "Door open", off: "Door shut" });
const F: FeatureInput[] = [
  // ── routes ──
  { slug: "undercroft-hub", kind: "building", name: "East Undercroft Hub", status: "Built", pos: [159, 79, 273], box: { from: [155, 77, 266], to: [163, 90, 280] },
    detail: "Vaulted hall under the fortress (floor y 78), reached from the Throne Room's east doorway. The library wall hides the bookshelf door; the passages south, west, to the courtyard and to the North Gate start here." },
  { slug: "passage-throne-hub", kind: "passage", name: "Throne Room to the Undercroft", status: "Built", pos: [145, 79, 273], points: [[145, 79, 273], [153, 79, 273], [159, 78, 273]],
    detail: "Doorway in the Throne Room's east wall (x 145, z 272-274), then a vestibule to the hub." },
  { slug: "passage-south", kind: "passage", name: "South covered way (red)", status: "Built", pos: [157, 79, 294], points: [[159, 78, 280], [157, 79, 294], [157, 79, 298], [157, 94, 317], [157, 95, 322], [157, 95, 327]],
    detail: "Hub to the junction at 157 79 294, then climbing to y 94 between z 298 and 317, through an iron door at 157 95 322 into the South Wall reference tower." },
  { slug: "passage-west", kind: "passage", name: "West gallery (blue)", status: "Built", pos: [88, 79, 264], points: [[157, 79, 294], [88, 79, 294], [88, 79, 264], [88, 86, 252], [88, 86, 235], [92, 86, 235]],
    detail: "From the junction west along z 294, then north along x 88 to West Wall Tower 3." },
  { slug: "passage-courtyard", kind: "passage", name: "Courtyard way (pink)", status: "Built", pos: [173, 71, 273], points: [[163, 78, 273], [168, 74, 273], [173, 71, 273], [175, 71, 273]],
    detail: "From the hub east and down to y 70, through the iron door at 173 71 273 to the courtyard portal." },
  { slug: "passage-north-gate", kind: "passage", name: "North Gate tunnel (yellow)", status: "Built", pos: [226, 55, 240], points: [[167, 78, 280], [167, 55, 286], [226, 55, 286], [226, 55, 180], [300, 55, 180], [300, 63, 168], [300, 63, 165], [301, 74, 155]],
    detail: "Branches at x 167 and drops to y 54, along z 286 to x 226, north to z 180, east to x 300, up through the iron door at 300 63 165 and the stair kiosk (x 298-302, z 156-160) to the exit at 301 74 155." },
  // ── secrets ──
  { slug: "secret-throne-escape", kind: "passage", name: "Throne Escape", status: "Built", secret: true, pos: [147, 79, 271], points: [[147, 79, 271], [152, 79, 268], [150, 62, 276]],
    detail: "Hidden wall panel at 147 79-80 271 beside the Throne Room doorway. Buttons at 152 79 272 and 152 79 268 toggle it. A spiral leads down to the escape tunnel at y 62." },
  { slug: "secret-escape-tunnel", kind: "passage", name: "Escape tunnel", status: "Built", secret: true, pos: [70, 62, 270], points: [[150, 62, 276], [150, 62, 296], [70, 62, 296], [70, 62, 244], [55, 63, 244]],
    detail: "Runs from under the Throne Escape and the War Room hatch, west to x 70, then north to z 244 and out through the sally port into the water-curtain cave." },
  { slug: "secret-library-door", kind: "passage", name: "Library bookshelf door", status: "Built", secret: true, pos: [156, 79, 265], points: [[156, 79, 265], [159, 79, 263], [157, 71, 275]],
    detail: "Bookshelf door at 156 79-80 265 in the hub's library wall. Put a book on the lectern at 159 79 267 to open it; a lever inside holds it open. Leads down to the War Room." },
  { slug: "secret-war-room", kind: "building", name: "War Room", status: "Built", secret: true, pos: [157, 71, 275], box: { from: [154, 70, 272], to: [161, 75, 279] },
    detail: "Secret room under the hub (x 154-161, z 272-279, floor y 70) with a map table. A hatch at 155 70 276 drops by ladder to the escape tunnel." },
  { slug: "secret-water-cave", kind: "place", name: "Water-curtain cave", status: "Built", secret: true, pos: [57, 64, 244],
    detail: "Cave mouth at x 55 behind a waterfall: the outer end of the escape tunnel, with the sally-port iron door at 59 63 244." },
  // ── controls ──
  { slug: "ctl-throne-escape-1", kind: "control", name: "Throne Escape button (vestibule)", status: "Checked", pos: [152, 79, 272],
    control: { group: "Throne Escape", type: "button", verified: true, reach: "From the Throne Room's east doorway (145 80 273) walk 7 east along the vestibule: the stone button low on the north wall, last before the hub.",
      on: "Each press toggles the hidden wall. The latch bulb at 152 79 270 is lit while it's open.", drives: "2 sticky pistons at 149 79-80 271 slide the wall panel (147 79-80 271)", state: { pos: [152, 79, 270], on: "Wall open", off: "Wall shut" } } },
  { slug: "ctl-throne-escape-2", kind: "control", name: "Throne Escape button (secret side)", status: "Checked", pos: [152, 79, 268],
    control: { group: "Throne Escape", type: "button", verified: true, reach: "Inside the secret passage behind the wall, at the east end before the spiral.", on: "Each press toggles the hidden wall.", drives: "The same latch and pistons", state: { pos: [152, 79, 270], on: "Wall open", off: "Wall shut" } } },
  { slug: "ctl-library-lectern", kind: "control", name: "Library lectern (bookshelf door)", status: "Checked", pos: [159, 79, 267],
    control: { group: "Library and War Room", type: "lectern", verified: true, reach: "East Undercroft Hub, centre of the north (library) wall.", on: "Book on the lectern: the bookshelf door opens", off: "Book taken off: it shuts",
      drives: "Comparator, then 2 sticky pistons at 158 79-80 265 slide the door panel (156 79-80 265) behind the bookcase" } },
  { slug: "ctl-library-lever", kind: "control", name: "Library door lever (inside)", status: "Checked", pos: [159, 79, 263],
    control: { group: "Library and War Room", type: "lever", verified: true, reach: "In the secret passage behind the bookshelf door, on the wall 3 east of the door.", on: "Holds the door open", off: "Door shuts (unless a book is on the lectern)", drives: "The bookshelf door pistons" } },
  { slug: "ctl-war-hatch-1", kind: "control", name: "War Room hatch button (map table)", status: "Checked", pos: [157, 72, 276],
    control: { group: "Library and War Room", type: "button", verified: true, reach: "In the War Room, on top of the map table.", on: "Each press toggles the hatch.", drives: "Latch bulb at 157 70 276, then the iron trapdoor at 155 70 276 over the ladder to the escape tunnel", state: { pos: [155, 70, 276], on: "Hatch open", off: "Hatch shut" } } },
  { slug: "ctl-war-hatch-2", kind: "control", name: "War Room hatch button (ladder niche)", status: "Checked", pos: [157, 68, 276],
    control: { group: "Library and War Room", type: "button", verified: true, reach: "Climb down the ladder below the hatch to the small side niche (floor y 66): the button is in its ceiling.", on: "Each press toggles the hatch.", drives: "The same latch and trapdoor", state: { pos: [155, 70, 276], on: "Hatch open", off: "Hatch shut" } } },
  { slug: "ctl-sally-cave", kind: "control", name: "Sally-port lever (cave side)", status: "Checked", pos: [57, 64, 245],
    control: { group: "Escape tunnel", type: "lever", verified: true, reach: "2 blocks inside the water-curtain cave mouth (55 64 244), south wall.", on: toggle, drives: "Observer, latch bulb, then the iron door at 59 63-64 244", state: door([59, 63, 244]) } },
  { slug: "ctl-sally-tunnel", kind: "control", name: "Sally-port lever (tunnel side)", status: "Checked", pos: [61, 64, 245],
    control: { group: "Escape tunnel", type: "lever", verified: true, reach: "In the escape tunnel, 2 blocks east of the iron door, south wall.", on: toggle, drives: "The same latch and iron door", state: door([59, 63, 244]) } },
  { slug: "ctl-south-way-hub", kind: "control", name: "South way door lever (hub side)", status: "Checked", pos: [158, 96, 320],
    control: { group: "South covered way", type: "lever", verified: true, reach: "Top of the south covered way, 2 blocks before the iron door, east wall.", on: toggle, drives: "Observer, latch bulb, then the iron door at 157 95-96 322", state: door([157, 95, 322]) } },
  { slug: "ctl-south-way-tower", kind: "control", name: "South way door lever (tower side)", status: "Checked", pos: [158, 96, 324],
    control: { group: "South covered way", type: "lever", verified: true, reach: "Between the iron door and the South Wall tower doorway, east wall.", on: toggle, drives: "The same latch and iron door", state: door([157, 95, 322]) } },
  { slug: "ctl-courtyard-inside", kind: "control", name: "Courtyard portal door lever (inside)", status: "Checked", pos: [171, 72, 274],
    control: { group: "Courtyard way", type: "lever", verified: true, reach: "Courtyard gallery, at the foot of the stair down from the hub, south wall.", on: toggle, drives: "Observer, latch bulb, then the iron door at 173 71-72 273", state: door([173, 71, 273]) } },
  { slug: "ctl-courtyard-outside", kind: "control", name: "Courtyard portal door lever (courtyard side)", status: "Checked", pos: [175, 72, 274],
    control: { group: "Courtyard way", type: "lever", verified: true, reach: "Just inside the courtyard portal (175 71 273), south side.", on: toggle, drives: "The same latch and iron door", state: door([173, 71, 273]) } },
  { slug: "ctl-ng-tunnel-south", kind: "control", name: "North Gate tunnel door lever (south)", status: "Checked", pos: [301, 64, 167],
    control: { group: "North Gate tunnel", type: "lever", verified: true, reach: "North Gate tunnel, top of the long stair, east wall.", on: toggle, drives: "Observer, latch bulb, then the iron door at 300 63-64 165", state: door([300, 63, 165]) } },
  { slug: "ctl-ng-tunnel-north", kind: "control", name: "North Gate tunnel door lever (north)", status: "Checked", pos: [301, 64, 163],
    control: { group: "North Gate tunnel", type: "lever", verified: true, reach: "Between the iron door and the stair kiosk, east wall.", on: toggle, drives: "The same latch and iron door", state: door([300, 63, 165]) } },
  { slug: "ctl-passage-motion", kind: "control", name: "Passage motion lights (automatic)", status: "Checked", pos: [159, 85, 269],
    control: { group: "Passages: automatic", type: "auto", verified: true, reach: "Ceiling lamps every 12 blocks along every passage and in the hub (49 in all).",
      on: "Light up while someone walks nearby: a sculk sensor is sealed above each lamp. Nothing to switch." } },
  { slug: "ctl-passage-night", kind: "control", name: "Portal and kiosk night lamps (automatic)", status: "Checked", pos: [175, 76, 271],
    control: { group: "Passages: automatic", type: "auto", verified: true, reach: "On the courtyard portal roof (175 76 271, 175 76 275) and the North Gate kiosk roof (298 78 156, 298 78 160, 302 78 160).",
      on: "On at dusk, off at dawn (inverted daylight sensors). Nothing to switch." } },
];
let added = 0;
for (const f of F) { if (!getFeature(SRV, MV, String(f.slug))) { addFeature(SRV, MV, f, BY, "Passages seed."); added++; } }
db.run("DELETE FROM map_updates WHERE server = ? AND world = ? AND what = 'Passages seed.'", [SRV, MV]);
if (added) {
  const g = getFeature(SRV, MV, "undercroft-hub");
  db.run("INSERT INTO map_updates (server, world, feature_id, slug, action, title, what, actor, secret, at) VALUES (?,?,?,?,?,?,?,?,0,?)",
    [SRV, MV, g?.id ?? null, "undercroft-hub", "add", "Passages and secrets", "The East Undercroft Hub and its four ways (south, west, courtyard, North Gate), the Throne Escape, bookshelf door, War Room and escape tunnel, with every door lever and button in Controls.", BY, Math.floor(Date.now() / 1000)]);
}
console.log(`passages: ${added} added`);
setTimeout(() => process.exit(0), 200);
