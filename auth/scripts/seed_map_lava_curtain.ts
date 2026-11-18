// 2026-11-18: the Lava Curtain between the banquet hall and the Throne Room.
// Every block below is read live first; nothing is added unless the controls are there.
//
//   docker exec mc-auth bun run scripts/seed_map_lava_curtain.ts
import { addFeature, getFeature, type FeatureInput } from "../src/map.ts";
import { plugin } from "../src/buildapi.ts";
import { db } from "../src/db.ts";

const SRV = "26" as const, MV = "homeland", BY = "Claude";
const P: Array<[string, [number, number, number]]> = [
  ["throne button", [121, 79, 268]], ["banquet button", [124, 79, 265]], ["lamp 1", [125, 85, 266]], ["lamp 2", [125, 86, 267]],
  ["latch bulb", [119, 75, 264]], ["curtain top x129", [129, 86, 266]], ["curtain top x135", [135, 86, 266]], ["drain x132", [132, 78, 266]],
  ["pillar x124", [124, 80, 262]], ["pillar x140", [140, 80, 262]],
];
const live = await plugin("/states", { world: MV, positions: P.map((p) => p[1]) }, 5000, SRV);
P.forEach((p, i) => console.log(p[0].padEnd(18), p[1].join(" "), live.states[i]));
const ok = (i: number, re: RegExp) => re.test(live.states[i] || "");
// A null means the chunk isn't loaded; then the flushed save is the current state.
// Run with FROM_SAVE=1 once those blocks were read from the save (save-all flush).
const unloaded = live.states.every((s: string | null) => s === null);
if (!(unloaded && process.env.FROM_SAVE === "1") && (!ok(0, /_button/) || !ok(1, /_button/) || !ok(4, /copper_bulb/))) { console.log("controls not where expected: nothing added"); process.exit(1); }
const curtain = { pos: [119, 75, 264] as [number, number, number], on: "Curtain ON", off: "Curtain off" };
const F: FeatureInput[] = [
  { slug: "lava-curtain", kind: "building", name: "Lava Curtain", status: "Built", pos: [132, 79, 267], box: { from: [129, 78, 266], to: [135, 86, 266] },
    detail: "Trap across the doorway between the banquet hall and the Throne Room (x 129-135, z 266). When ON, lava falls from y 86 to y 78 into a flush drain floor that opens under it. Fireproofed: the carpet by the doorway is red concrete and the pillars at x 124 and 140 are deepslate." },
  { slug: "ctl-lava-throne", kind: "control", name: "Lava Curtain: throne button", status: "Checked", pos: [121, 79, 268],
    control: { group: "Fortress", type: "button", verified: true, reach: "Throne Room side of the banquet-hall doorway.", on: "Each press toggles the lava curtain on or off. The lamps above the door (125 85 266, 125 86 267) are lit while it's ON.",
      drives: "Latch bulb at 119 75 264, then the lava curtain over x 129-135, z 266 and its drain floor", state: curtain } },
  { slug: "ctl-lava-banquet", kind: "control", name: "Lava Curtain: banquet button", status: "Checked", pos: [124, 79, 265],
    control: { group: "Fortress", type: "button", verified: true, reach: "Banquet hall side of the doorway.", on: "Each press toggles the lava curtain on or off.", drives: "The same latch and curtain", state: curtain } },
  { slug: "ctl-lava-drain", kind: "control", name: "Lava Curtain drain hold (automatic)", status: "Checked", pos: [132, 78, 266],
    control: { group: "Fortress", type: "auto", verified: true, reach: "Under the curtain, in the doorway floor.", on: "Opens under the falling lava and stays open about 40 seconds after the curtain is switched off, so the lava drains. Nothing to switch." } },
];
let added = 0;
for (const f of F) { if (!getFeature(SRV, MV, String(f.slug))) { addFeature(SRV, MV, f, BY, "Lava seed."); added++; } }
db.run("DELETE FROM map_updates WHERE server = ? AND world = ? AND what = 'Lava seed.'", [SRV, MV]);
const g = getFeature(SRV, MV, "lava-curtain");
if (added) db.run("INSERT INTO map_updates (server, world, feature_id, slug, action, title, what, actor, secret, at) VALUES (?,?,?,?,?,?,?,?,0,?)",
  [SRV, MV, g?.id ?? null, "lava-curtain", "add", "Lava Curtain", "A lava curtain across the banquet-hall doorway, toggled from a button on either side; the map shows whether it's ON.", BY, Math.floor(Date.now() / 1000)]);
console.log(`lava curtain: ${added} added`);
setTimeout(() => process.exit(0), 200);
