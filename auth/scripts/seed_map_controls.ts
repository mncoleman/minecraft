// One-off: every lever and button in homeland (26) as Map-tab controls.
// Each position was checked against the save on 2026-11-17 (slice.py inventory
// of the whole walled area), and "drives" comes from tracing the redstone from
// that block. Where the purpose isn't certain, verified is false.
//
//   docker exec mc-auth bun run scripts/seed_map_controls.ts
//
// Idempotent: controls whose id already exists are left alone.
import { addFeature, getFeature, type FeatureInput } from "../src/map.ts";
import { db } from "../src/db.ts";

const SRV = "26" as const, MV = "homeland";
type C = { id: string; name: string; group: string; pos: [number, number, number]; type?: string; reach?: string; on?: string; off?: string; drives?: string; verified?: boolean };
const room = (lamps: number) => `${lamps} redstone lamps in the room`;
const tower = (id: string, name: string, group: string, pos: [number, number, number], floor: string, lamps: number): C =>
  ({ id, name, group, pos, reach: `Inside the tower, ${floor}`, on: "Room lamps lit", off: "Room lamps off", drives: room(lamps), verified: true });

const L: C[] = [
  // ── gates ──
  { id: "ctl-south-gate", name: "South Gate portcullis lever", group: "South Gate", pos: [247, 91, 328], reach: "Enclosed winch room above the vault: take the ladder hatch from the gatehouse first floor.", on: "Opens the 5-wide iron portcullis", off: "Closes it; the status lamp beside the lever lights while it is closed", drives: "5 iron gate leaves and the closed-lamp at 249 90 328", verified: true },
  { id: "ctl-east-gate", name: "East Gate portcullis lever", group: "East Gate", pos: [368, 70, 241], reach: "In the East Gate's winch room.", on: "Opens the iron portcullis", off: "Closes it; the status lamp at 368 69 243 lights while it is closed", drives: "5 iron gate leaves and the closed-lamp", verified: true },
  { id: "ctl-north-gate", name: "North Gate lever (red)", group: "North Gate", pos: [310, 78, 146], reach: "Guard-room panel, the red lever. The panel is colour-coded: red = gate, orange = closed-lamp, blue = floodlights.", on: "Opens the 6 iron gate leaves; the observer beside it rings the chime", off: "Closes the gate; the orange closed-lamp at 311 78 148 lights", drives: "6 iron gate leaves, the closed-lamps and the chime (note block)", verified: true },
  { id: "ctl-north-flood", name: "North Gate floodlights (blue)", group: "North Gate", pos: [310, 77, 149], reach: "Guard-room panel, the blue lever under the gate lever.", on: "Flood lamps lit", off: "Flood lamps off", drives: "2 flood lamps", verified: true },
  { id: "ctl-west-postern", name: "West Postern door button", group: "West Postern", pos: [49, 81, 306], type: "button", reach: "Inside the wall, next to the iron doors (there is no outside button).", on: "Press: the iron doors open for a few seconds, then close", drives: "The postern's iron doors (x 48-50, z 307)", verified: true },
  // ── wall towers: room lights ──
  tower("ctl-w-t1-f1", "Coastal tower, first floor lights", "West wall towers", [113, 83, 190], "first-floor room", 3),
  tower("ctl-w-t1-f2", "Coastal tower, second floor lights", "West wall towers", [113, 91, 193], "second-floor room", 3),
  tower("ctl-w-t2-f1", "West Tower 2, first floor lights", "West wall towers", [86, 91, 193], "first-floor room", 3),
  tower("ctl-w-t2-f2", "West Tower 2, second floor lights", "West wall towers", [92, 99, 189], "second-floor room", 3),
  tower("ctl-w-t3-f1", "West Tower 3, first floor lights", "West wall towers", [92, 86, 230], "first-floor room", 3),
  tower("ctl-w-t3-f2", "West Tower 3, second floor lights", "West wall towers", [92, 94, 233], "second-floor room", 3),
  tower("ctl-w-t4-f1", "West Tower 4, first floor lights", "West wall towers", [37, 92, 257], "first-floor room", 3),
  tower("ctl-w-t4-f2", "West Tower 4, second floor lights", "West wall towers", [43, 100, 253], "second-floor room", 3),
  tower("ctl-w-t5-f1", "West Tower 5, first floor lights", "West wall towers", [34, 92, 303], "first-floor room", 3),
  tower("ctl-w-t5-f2", "West Tower 5, second floor lights", "West wall towers", [31, 100, 303], "second-floor room", 3),
  tower("ctl-w-t6-f1", "West Tower 6, first floor lights", "West wall towers", [84, 91, 336], "first-floor room", 3),
  tower("ctl-w-t6-f2", "West Tower 6, second floor lights", "West wall towers", [87, 99, 329], "second-floor room", 3),
  tower("ctl-s-t1", "South Wall Tower 1 lights", "South and east wall towers", [216, 94, 336], "tower room", 3),
  tower("ctl-s-gate", "South Gate tower lights", "South and east wall towers", [250, 97, 336], "tower room", 3),
  tower("ctl-s-t2", "South Wall Tower 2 lights", "South and east wall towers", [300, 83, 336], "tower room", 3),
  tower("ctl-se", "SE Corner Tower lights", "South and east wall towers", [375, 78, 313], "tower room", 3),
  tower("ctl-e-gate", "East Gate tower lights", "South and east wall towers", [376, 78, 244], "tower room", 3),
  tower("ctl-ne", "NE Corner Tower lights", "South and east wall towers", [373, 79, 200], "tower room", 3),
  tower("ctl-n-gt1", "North Gate west tower lights", "North wall towers", [307, 88, 145], "floor lever in the tower room", 2),
  tower("ctl-n-gt2", "North Gate east tower lights", "North wall towers", [322, 88, 145], "floor lever in the tower room", 2),
  tower("ctl-n-262", "North Wall Tower (262) lights", "North wall towers", [262, 82, 142], "floor lever in the tower room", 2),
  tower("ctl-n-222", "North Wall Tower (222) lights", "North wall towers", [222, 82, 139], "floor lever in the tower room", 2),
  tower("ctl-n-coast", "Coastal Tower lights", "North wall towers", [188, 75, 112], "floor lever in the tower room", 2),
  tower("ctl-n-corner", "North Wall Corner Tower lights", "North wall towers", [366, 84, 151], "floor lever in the tower room", 2),
  // ── copper golem hall ──
  { id: "ctl-copper-clock", name: "Copper bulb clock pause", group: "Copper Golem Hall", pos: [102, 80, 284], reach: "On the wall of the Copper Golem Hall.", on: "Pauses the copper-bulb clock", off: "The bulbs cycle", drives: "The bulb clock: 8 copper bulbs", verified: true },
  { id: "ctl-copper-crafter", name: "Crafter button", group: "Copper Golem Hall", pos: [115, 79, 278], type: "button", reach: "Beside the crafter in the Copper Golem Hall.", on: "Press after the hopper has loaded 9 copper ingots: crafts a copper block", drives: "The crafter at 116 79 278", verified: true },
  // ── fortress ──
  { id: "ctl-under-station", name: "Under-Station lights", group: "Fortress", pos: [127, 32, 256], reach: "Under-Station platform, on the wall.", on: "Station lamps lit", off: "Station lamps off", drives: "13 lamps around the Under-Station (traced)", verified: false },
  { id: "ctl-throne-piston", name: "Throne Room lever (piston)", group: "Fortress", pos: [120, 80, 283], reach: "Throne Room, on the wall.", on: "Pushes its sticky piston out", off: "Pulls it back", drives: "1 sticky piston (traced; what it moves is unverified)", verified: false },
  { id: "ctl-throne-north", name: "Throne Room lever (north)", group: "Fortress", pos: [124, 80, 263], reach: "Throne Room, north wall.", on: "Pushes its sticky piston out", off: "Pulls it back", drives: "1 sticky piston (traced; what it moves is unverified)", verified: false },
  { id: "ctl-waterfall-west", name: "Lever west of Waterfall Hall", group: "Fortress", pos: [104, 80, 250], reach: "West of Waterfall Hall, on the wall.", on: "Pushes its sticky piston out", off: "Pulls it back", drives: "1 sticky piston (traced; what it moves is unverified)", verified: false },
  { id: "ctl-below-throne", name: "Lever below the Throne Room", group: "Fortress", pos: [120, 68, 283], reach: "One level below the Throne Room.", on: "Pushes its sticky piston out", off: "Pulls it back", drives: "1 sticky piston (traced; what it moves is unverified)", verified: false },
  { id: "ctl-waterfall", name: "Waterfall Hall lever", group: "Fortress", pos: [124, 80, 245], reach: "Waterfall Hall, east wall.", drives: "Wired into the fortress's big lamp and piston network; exact effect unverified", verified: false },
  { id: "ctl-throne-south", name: "Throne Room floor lever (south)", group: "Fortress", pos: [131, 82, 283], reach: "Throne Room, on the floor at the south end.", drives: "Wired into the fortress's big lamp and piston network; exact effect unverified", verified: false },
  { id: "ctl-throne-south-2", name: "Throne Room floor lever (south, 2)", group: "Fortress", pos: [133, 82, 283], reach: "Throne Room, on the floor at the south end.", drives: "Wired into the fortress's big lamp and piston network; exact effect unverified", verified: false },
  // ── stations ──
  { id: "ctl-station-1", name: "Under-Station button (north)", group: "Under-Station and rail stops", pos: [131, 32, 252], type: "button", reach: "Under-Station platform.", on: "Press to send the cart (unverified)", verified: false },
  { id: "ctl-station-2", name: "Under-Station button (east)", group: "Under-Station and rail stops", pos: [137, 32, 257], type: "button", reach: "Under-Station platform.", on: "Press to send the cart (unverified)", verified: false },
  { id: "ctl-dome-1", name: "Sea Dome stop button (north)", group: "Under-Station and rail stops", pos: [99, 31, 99], type: "button", reach: "Sea Dome stop on the farm–fortress line.", on: "Press to send the cart (unverified)", verified: false },
  { id: "ctl-dome-2", name: "Sea Dome stop button (south)", group: "Under-Station and rail stops", pos: [99, 31, 101], type: "button", reach: "Sea Dome stop on the farm–fortress line.", on: "Press to send the cart (unverified)", verified: false },
  // ── sculk vault ──
  { id: "ctl-vault-sensor", name: "Calibrated sculk sensor", group: "Sculk Vault", pos: [151, 14, 273], type: "sensor", reach: "Sculk wing of the Sculk Vault.", on: "Automatic: fires when a projectile (an arrow or a snowball) lands near it. Footsteps don't set it off.", drives: "The sculk wing's lamps (unverified)", verified: true },
];

let added = 0, kept = 0;
for (const c of L) {
  if (getFeature(SRV, MV, c.id)) { kept++; continue; }
  const f: FeatureInput = {
    slug: c.id, kind: "control", name: c.name, status: c.verified ? "Checked" : "Unverified", pos: c.pos, underground: c.pos[1] < 50,
    control: { group: c.group, type: c.type || "lever", reach: c.reach, on: c.on, off: c.off, drives: c.drives, verified: c.verified !== false },
  };
  addFeature(SRV, MV, f, "Claude", "Added to the Controls list.");
  added++;
}
// One line in the feed instead of one per lever.
if (added) {
  db.run("DELETE FROM map_updates WHERE server = ? AND world = ? AND what = ?", [SRV, MV, "Added to the Controls list."]);
  db.run("INSERT INTO map_updates (server, world, feature_id, slug, action, title, what, actor, secret, at) VALUES (?,?,?,?,?,?,?,?,0,?)",
    [SRV, MV, getFeature(SRV, MV, "ctl-north-gate")?.id ?? null, "ctl-north-gate", "add", "Controls on the map", `${added} levers, buttons and sensors, with how to reach them and what they do.`, "Claude", Math.floor(Date.now() / 1000)]);
}
console.log(`homeland controls: ${added} added, ${kept} already there`);
setTimeout(() => process.exit(0), 200);
