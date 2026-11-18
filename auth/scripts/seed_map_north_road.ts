// One-off (2026-11-17): the North Road. Heights per vertex from the save; all
// 18 lamp posts checked present.
//
//   docker exec mc-auth bun run scripts/seed_map_north_road.ts
import { addFeature, getFeature, type FeatureInput } from "../src/map.ts";
import { db } from "../src/db.ts";

const SRV = "26" as const, MV = "homeland", BY = "Claude";
const F: FeatureInput[] = [
  { slug: "north-road", kind: "road", name: "North Road", status: "Built", pos: [314, 72, 162],
    points: [[314, 71, 162], [314, 70, 165], [312, 70, 167], [290, 69, 170], [266, 70, 174], [257, 70, 181], [250, 68, 186], [240, 68, 192], [224, 67, 202], [207, 67, 215], [200, 68, 218], [172, 76, 218], [165, 77, 221]],
    detail: "Paved road, 3 wide, from the North Gate path to the fortress plaza (North Road: Gate End to Fortress End). A branch runs south to the Lake Bridge, and a short link to the North Gate stair kiosk. Lamp posts all along come on at night by themselves." },
  { slug: "north-road-lake-branch", kind: "road", name: "North Road: Lake branch", status: "Built", pos: [250, 66, 199],
    points: [[250, 68, 186], [250, 66, 199], [253, 63, 214], [254, 63, 222], [256, 62, 227], [260, 62, 227]],
    detail: "Branch from the North Road down to the Lake Bridge's west end." },
  { slug: "north-road-kiosk-link", kind: "road", name: "North Road: Kiosk link", status: "Built", pos: [306, 73, 154],
    points: [[301, 73, 154], [311, 73, 154]], detail: "Short link (x 301-311, z 153-155) to the North Gate tunnel's stair kiosk." },
  { slug: "wayside-shrine", kind: "place", name: "Wayside shrine", status: "Built", pos: [248, 69, 180], detail: "Small shrine beside the North Road." },
  { slug: "ctl-north-road-lamps", kind: "control", name: "North Road lamp posts (automatic)", status: "Checked", pos: [311, 75, 164],
    control: { group: "North Road", type: "auto", verified: true, reach: "18 lamp posts: 14 along the main road from 311 75 164 to 170 81 216, and 4 on the lake branch.", on: "Lit at night (daylight sensors). Nothing to switch." } },
];
let added = 0;
for (const f of F) { if (!getFeature(SRV, MV, String(f.slug))) { addFeature(SRV, MV, f, BY, "North Road seed."); added++; } }
db.run("DELETE FROM map_updates WHERE server = ? AND world = ? AND what = 'North Road seed.'", [SRV, MV]);
if (added) {
  const g = getFeature(SRV, MV, "north-road");
  db.run("INSERT INTO map_updates (server, world, feature_id, slug, action, title, what, actor, secret, at) VALUES (?,?,?,?,?,?,?,?,0,?)",
    [SRV, MV, g?.id ?? null, "north-road", "add", "North Road", "The road from the North Gate to the fortress plaza, its branch to the Lake Bridge, the kiosk link and the wayside shrine. 18 lamp posts, all automatic.", BY, Math.floor(Date.now() / 1000)]);
}
console.log(`north road: ${added} added`);
setTimeout(() => process.exit(0), 200);
