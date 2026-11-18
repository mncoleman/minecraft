// 2026-11-18: village stage 2 on the levelled plateau. Doors, lamp posts, the
// underpass floor and its bulbs read from a flushed save first.
//
//   docker exec mc-auth bun run scripts/seed_map_village2.ts
import { addFeature, getFeature, removeFeature, type FeatureInput } from "../src/map.ts";
import { db } from "../src/db.ts";

const SRV = "26" as const, MV = "homeland", BY = "Claude", NOTE = "Village 2 seed.";
// the plateau was a planned village site: now built, the zones below replace it
if (getFeature(SRV, MV, "upper-plateau")) removeFeature(SRV, MV, "upper-plateau", BY, NOTE);
const zone = (slug: string, name: string, pos: [number, number, number], from: [number, number], to: [number, number], detail: string): FeatureInput =>
  ({ slug, kind: "place", name, status: "Built", pos, box: { from: [from[0], 78, from[1]], to: [to[0], 78, to[1]] }, detail });
const bld = (slug: string, name: string, door: [number, number, number], from: [number, number], to: [number, number], detail: string, floors = false): FeatureInput =>
  ({ slug, kind: "building", name, status: "Built", pos: door, box: { from: [from[0], 77, from[1]], to: [to[0], 92, to[1]] }, ...(floors ? { floors: "auto" as const } : {}), detail });
const F: FeatureInput[] = [
  zone("village-harbour-overlook", "Harbour Overlook", [154, 79, 184], [150, 179], [159, 190], "Village lookout over the harbour, around the Docks Lift landing."),
  zone("village-main-street", "Main Street", [151, 79, 200], [149, 179], [153, 219], "The village's main street, from the Harbour Overlook south to the courtyard plaza path (z 219)."),
  zone("village-stable-square", "Stable Square", [156, 78, 202], [154, 199], [163, 208], "Square on the old stable pad, with a roofed well (157-159, 203-205) and the smithy (x 160-163, z 199-202)."),
  zone("village-upper-town", "Upper Town", [133, 79, 200], [123, 186], [142, 213], "The upper part of the village: the inn, scriptorium, chapel and bowyer."),
  zone("village-west-meadow", "West Lane and Meadow", [110, 80, 210], [99, 196], [122, 230], "Lane and meadow west of town: farmhouse, weaver, mason, tannery, crop fields (x 100-106 and 108-114, z 211-218) and an orchard (x 100-115, z 229)."),
  bld("village-inn", "Inn", [129, 79, 196], [126, 190], [133, 196], "The village inn. Door on the south side at 129 196.", true),
  bld("village-scriptorium", "Scriptorium", [126, 79, 203], [124, 203], [129, 208], "Scribes' house. Door at 126 203.", true),
  bld("village-chapel", "Chapel", [136, 79, 208], [136, 204], [140, 212], "The chapel, where the cleric works now (brewing stand at 138 79 205). Door at 136 208.", true),
  bld("village-bowyer", "Bowyer's Hut", [137, 79, 194], [137, 193], [140, 196], "Fletcher's workshop. Door at 137 194."),
  bld("village-fisher", "Fisher's Cottage", [155, 79, 194], [155, 192], [160, 197], "Fisher's cottage by the overlook. Door at 155 194."),
  bld("village-mason", "Mason's House", [119, 79, 203], [117, 203], [121, 208], "Stonemason's house. Door at 119 203."),
  bld("village-farmhouse", "Farmhouse", [103, 80, 203], [100, 203], [106, 208], "Farmhouse by the crop fields. Door at 103 203."),
  bld("village-weaver", "Weaver's Cottage", [111, 80, 203], [109, 203], [114, 208], "Shepherd and weaver's cottage. Door at 111 203."),
  bld("village-tannery", "Tannery", [104, 80, 223], [100, 221], [104, 226], "Leatherworker's tannery. Door at 104 223."),
  { slug: "village-underpass", kind: "passage", name: "Village underpass", status: "Built", pos: [147, 75, 200], points: [[138, 74, 200], [156, 74, 200]],
    detail: "Passage under the walkway at z 199-201 from x 138 to 156, floor y 74, lit by copper bulbs on both walls." },
  { slug: "ctl-village-lamps", kind: "control", name: "Village lamp posts (automatic)", status: "Checked", pos: [148, 81, 202],
    control: { group: "Village", type: "auto", verified: true, reach: "13 lamp posts along Main Street, Stable Square, Upper Town, West Lane and the meadow.", on: "Lit at night (daylight sensors). Nothing to switch." } },
];
let added = 0;
for (const f of F) { if (!getFeature(SRV, MV, String(f.slug))) { addFeature(SRV, MV, f, BY, NOTE); added++; } }
db.run("DELETE FROM map_updates WHERE server = ? AND world = ? AND what = ?", [SRV, MV, NOTE]);
const g = getFeature(SRV, MV, "village-main-street");
db.run("INSERT INTO map_updates (server, world, feature_id, slug, action, title, what, actor, secret, at) VALUES (?,?,?,?,?,?,?,?,0,?)",
  [SRV, MV, g?.id ?? null, "village-main-street", "add", "Village, stage 2", "Harbour Overlook, Main Street, Stable Square, Upper Town and the West Lane and Meadow, with the inn, scriptorium, chapel, bowyer, fisher, mason, farmhouse, weaver and tannery, and the underpass.", BY, Math.floor(Date.now() / 1000)]);
console.log(`village 2: ${added} added`);
setTimeout(() => process.exit(0), 200);
