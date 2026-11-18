// 2026-11-18: Throne Room re-centred. Controls didn't move, but the builder
// confirmed what two of them do: the floor and pillar lights need BOTH the left
// armrest lever (131 82 283) and the west-wall lever (120 80 283) ON.
// Checked live before editing.
//
//   docker exec mc-auth bun run scripts/update_throne_lights.ts
import { getFeature, updateFeature } from "../src/map.ts";
import { plugin } from "../src/buildapi.ts";
import { db } from "../src/db.ts";

const SRV = "26" as const, MV = "homeland", BY = "Claude";
const live = await plugin("/states", { world: MV, positions: [[131, 82, 283], [120, 80, 283], [137, 78, 274], [139, 79, 275], [141, 79, 275]] }, 5000, SRV);
console.log("live:", JSON.stringify(live.states));
const both = "Throne Room floor lamps and the pillar torch-towers: they light only while BOTH this lever and the other one are ON";
if (getFeature(SRV, MV, "ctl-throne-south")) updateFeature(SRV, MV, "ctl-throne-south", {
  name: "Throne Room left armrest lever (lights)", status: "Checked",
  control: { group: "Fortress", type: "lever", verified: true, reach: "On the left armrest of the throne (floor lever).",
    on: "Lights on, if the west-wall lever (120 80 283) is ON too", off: "Floor and pillar lights off", drives: both },
}, BY, "Throne lights.");
if (getFeature(SRV, MV, "ctl-throne-piston")) updateFeature(SRV, MV, "ctl-throne-piston", {
  name: "Throne Room west-wall lever (lights)", status: "Checked",
  control: { group: "Fortress", type: "lever", verified: true, reach: "Throne Room, west wall, under its sign (120 81 283).",
    on: "Lights on, if the left armrest lever (131 82 283) is ON too", off: "Floor and pillar lights off",
    drives: both + ". Works through the sticky piston at 118 80 283 (facing down)." },
}, BY, "Throne lights.");
const fort = getFeature(SRV, MV, "fortress");
if (fort) {
  const lv = Object.entries(fort.labels?.levers || {}).map(([k, n]) => ({ pos: k.split(",").map(Number),
    name: k === "131,82,283" ? "Throne Room left armrest lever (lights)" : k === "120,80,283" ? "Throne Room west-wall lever (lights)" : n }));
  updateFeature(SRV, MV, "fortress", { levers: lv }, BY, "Throne lights.");
}
db.run("DELETE FROM map_updates WHERE server = ? AND world = ? AND what = 'Throne lights.'", [SRV, MV]);
const g = getFeature(SRV, MV, "fortress");
db.run("INSERT INTO map_updates (server, world, feature_id, slug, action, title, what, actor, secret, at) VALUES (?,?,?,?,?,?,?,?,0,?)",
  [SRV, MV, g?.id ?? null, "fortress", "update", "Throne Room re-centred", "East pillars and floor lamps moved 2 west, dais step now x 127-137; floor plans redrawn. The two lighting levers are named.", BY, Math.floor(Date.now() / 1000)]);
console.log("ok");
setTimeout(() => process.exit(0), 200);
