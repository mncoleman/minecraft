#!/usr/bin/env python3
"""Floor plans + redstone/component inventory for one map area, from region files.

Usage: slice.py <region_dir> <spec.json> <out_dir>

spec.json: {"box": {"from": [x,y,z], "to": [x,y,z]},
            "floors": [13, 30, 78] | "auto",
            "masks": [{"from": [x,y,z], "to": [x,y,z]}, ...],   # secret passages
            "components_only": true}                           # optional: inventory only

Writes to out_dir:
  floors.json            box, chosen floor levels, counts, generated_at
  floor_<y>.png          plan cut at head height over the floor at y (1 px per block)
  floor_<y>_pub.png      same with the mask boxes painted over as solid wall
                         (served to players who may not see secret passages)
  components.json        [[x, y, z, "minecraft:block[states]"], ...] every redstone
                         part, light, door, piston, trap, trigger and rail in the box

Memory stays small: blocks are kept per 16^3 section as palette + index list,
never as one dict per block. A chunk caught mid-write is skipped, not fatal.
"""
import sys, os, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from render_lib import region_files, chunks, unpack, full, color, C, png_write, NONSOLID

RS = ('lever', 'redstone_wire', 'repeater', 'comparator', 'redstone_torch', 'redstone_wall_torch', 'redstone_lamp', 'copper_bulb', 'piston', 'sticky_piston',
      'dispenser', 'dropper', 'observer', 'sculk_sensor', 'calibrated_sculk_sensor', 'daylight_detector', 'target', 'tripwire_hook', 'tripwire', 'note_block',
      'redstone_block', 'hopper', 'crafter', 'bell', 'tnt', 'iron_door', 'iron_trapdoor', 'trapped_chest', 'pressure_plate', 'button', 'lightning_rod', 'rail')
AIRS = ('minecraft:air', 'minecraft:cave_air', 'minecraft:void_air')

def is_component(n):
    return any(n == r or n.endswith('_' + r) or n.startswith(r) for r in RS) or 'copper_bulb' in n

def passable(st):
    if st is None: return True
    n = st.split('[')[0].split(':')[-1]
    return (n in NONSOLID or n.endswith(('_carpet', '_button', '_pressure_plate', '_sign', '_banner', 'torch', '_rail', '_door', 'fence_gate'))
            or n in ('water', 'light', 'snow', 'scaffolding'))

def main():
    rd, spec_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
    spec = json.load(open(spec_path))
    (ax, ay, az), (bx, by, bz) = spec['box']['from'], spec['box']['to']
    X0, X1 = min(ax, bx), max(ax, bx); Y0, Y1 = min(ay, by), max(ay, by); Z0, Z1 = min(az, bz), max(az, bz)
    os.makedirs(out, exist_ok=True)
    secs = {}   # (cx, sy, cz) -> [palette(full states), idx list | None, packed | None]
    errors = []
    for rx, rz, path in region_files(rd):
        if rx * 512 + 511 < X0 or rx * 512 > X1 or rz * 512 + 511 < Z0 or rz * 512 > Z1: continue
        for cx, cz, c in chunks(path, rx, rz, (X0, Z0, X1, Z1), errors):
            for s in c.get('sections', []):
                bs = s.get('block_states'); sy = s.get('Y')
                if not bs or sy is None or sy * 16 + 15 < Y0 - 12 or sy * 16 > Y1 + 2: continue
                pal = [full(e) for e in bs['palette']]
                if len(pal) == 1 and pal[0].split('[')[0] in AIRS: continue
                secs[(cx, sy, cz)] = [pal, None, bs.get('data') if len(pal) > 1 else None]

    def get(x, y, z):
        e = secs.get((x >> 4, y >> 4, z >> 4))
        if e is None: return None
        if e[1] is None:
            if e[2] is None: st = e[0][0]
            else:
                e[1] = unpack(e[2], max(4, (len(e[0]) - 1).bit_length()), 4096); e[2] = None
                st = e[0][e[1][((y & 15) * 16 + (z & 15)) * 16 + (x & 15)]]
        else: st = e[0][e[1][((y & 15) * 16 + (z & 15)) * 16 + (x & 15)]]
        return None if st.split('[')[0] in AIRS else st

    # components
    comps = []
    for (cx, sy, cz), e in list(secs.items()):
        pal = e[0]
        hits = [i for i, st in enumerate(pal) if is_component(st.split('[')[0].split(':')[-1])]
        if not hits: continue
        for ly in range(16):
            y = sy * 16 + ly
            if y < Y0 or y > Y1: continue
            for lz in range(16):
                z = cz * 16 + lz
                if z < Z0 or z > Z1: continue
                for lx in range(16):
                    x = cx * 16 + lx
                    if x < X0 or x > X1: continue
                    st = get(x, y, z)
                    if st and is_component(st.split('[')[0].split(':')[-1]): comps.append([x, y, z, st])
    comps.sort(key=lambda r: (r[1], r[2], r[0]))
    with open(os.path.join(out, 'components.json.tmp'), 'w') as f: json.dump(comps, f, separators=(',', ':'))
    os.replace(os.path.join(out, 'components.json.tmp'), os.path.join(out, 'components.json'))

    W, H = X1 - X0 + 1, Z1 - Z0 + 1
    if spec.get('components_only'):   # control inventory: no floor plans
        print(json.dumps({'components': len(comps), 'chunk_errors': len(errors)}))
        return
    # floors: given, or the levels with the most walkable cells
    floors = spec.get('floors')
    auto = not isinstance(floors, list) or not floors
    if auto:
        counts = []
        for y in range(Y0, Y1 - 1):
            n = 0
            for z in range(Z0, Z1 + 1):
                for x in range(X0, X1 + 1):
                    f = get(x, y, z)
                    if f and not passable(f) and passable(get(x, y + 1, z)) and passable(get(x, y + 2, z)): n += 1
            counts.append((n, y))
        need = max(10, int(W * H * 0.03))
        floors = []
        for n, y in sorted(counts, reverse=True):
            if n < need or len(floors) >= 8: break
            if all(abs(y - f) > 3 for f in floors): floors.append(y)
        floors.sort()
    floors = [int(f) for f in floors][:12]

    masks = []
    for m in spec.get('masks') or []:
        (mx0, my0, mz0), (mx1, my1, mz1) = m['from'], m['to']
        masks.append((min(mx0, mx1), min(my0, my1), min(mz0, mz1), max(mx0, mx1), max(my0, my1), max(mz0, mz1)))

    def col(st, shade):
        n = st.split('[')[0].split(':')[-1]; k = color(n) or 'LBLUE'
        r, g, b = C[k]; return bytes((int(r * shade), int(g * shade), int(b * shade), 255))
    WALL = col('minecraft:stone', 0.62)
    for fy in floors:
        rows = []; prow = []
        fm = [m for m in masks if m[1] <= fy + 2 and m[4] >= fy]
        for z in range(Z0, Z1 + 1):
            row = bytearray(); pr = bytearray()
            for x in range(X0, X1 + 1):
                wall = get(x, fy + 1, z); head = get(x, fy + 2, z); floor = get(x, fy, z)
                if wall and head: px = col(wall, 0.62)                   # wall / solid rock: darker
                elif wall: px = col(wall, 0.85)                           # furniture, half-height
                elif floor: px = col(floor, 1.0)                          # walkable floor
                else:
                    below = None
                    for yy in range(fy - 1, max(Y0 - 12, fy - 12), -1):
                        below = get(x, yy, z)
                        if below: break
                    px = col(below, 0.38) if below else b'\x0c\x0e\x12\xff'  # open drop / void
                row += px
                pr += WALL if any(m[0] <= x <= m[3] and m[2] <= z <= m[5] for m in fm) else px
            rows.append(bytes(row)); prow.append(bytes(pr))
        png_write(os.path.join(out, 'floor_%d.png' % fy), W, H, rows)
        png_write(os.path.join(out, 'floor_%d_pub.png' % fy), W, H, prow)
    meta = {'x0': X0, 'z0': Z0, 'x1': X1, 'z1': Z1, 'y0': Y0, 'y1': Y1, 'w': W, 'h': H, 'floors': floors, 'auto': auto,
            'components': len(comps), 'masked': len(masks), 'chunk_errors': len(errors), 'generated_at': int(time.time())}
    with open(os.path.join(out, 'floors.json.tmp'), 'w') as f: json.dump(meta, f)
    os.replace(os.path.join(out, 'floors.json.tmp'), os.path.join(out, 'floors.json'))
    print(json.dumps(meta))

if __name__ == '__main__':
    main()
