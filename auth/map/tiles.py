#!/usr/bin/env python3
"""Tile a whole world for the panel's deep-zoom map.

Usage: tiles.py <region_dir> <out_dir> [--force] [--budget SECONDS]

One 512x512 tile per region file at 1 px per block (zoom 0), plus a pyramid of
downsampled levels (zoom -1, -2, ...) so the whole world fits a phone screen.
Incremental: only regions whose file changed since the last run are re-rendered,
and only the pyramid tiles above them are rebuilt. Progress is saved after every
region, so a long first render can run in slices (--budget) and pick up again.

out_dir/
  manifest.json            regions (mtime), tile versions, bounds, zoom range
  edges/<rx>_<rz>.json     ground heights along a region's south edge (shading seam)
  tiles/<z>/<x>_<y>.png    the tiles (z = 0 is 1 block per pixel)
"""
import sys, os, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from render_lib import region_files, chunks, chunk_tops, shade_rows, png_write, png_read

T = 512
EMPTY_ROW = b'\x00' * (T * 4)

def load_json(p, d):
    try: return json.load(open(p))
    except Exception: return d

def save_json(p, obj):
    tmp = p + '.tmp'
    with open(tmp, 'w') as f: json.dump(obj, f, separators=(',', ':'))
    os.replace(tmp, p)

def render_region(path, rx, rz, north):
    x0, z0 = rx * T, rz * T
    top = [[None] * T for _ in range(T)]
    errors = []; n = 0
    def put(wx, wz, val): top[wz - z0][wx - x0] = val
    for cx, cz, c in chunks(path, rx, rz, None, errors):
        if chunk_tops(c, put, x0, z0, x0 + T - 1, z0 + T - 1): n += 1
    rows = shade_rows(top, T, T, north)
    south = [v[1] if v else None for v in top[T - 1]]
    return rows, south, n, len(errors)

def downsample(children):
    """children[(i,j)] = rows of a 512 tile or None -> rows of the parent tile (nearest)."""
    out = []
    for j in (0, 1):
        for r in range(0, T, 2):
            left = children.get((0, j)); right = children.get((1, j))
            a = left[r] if left else None; b = right[r] if right else None
            la = b''.join(a[i:i + 4] for i in range(0, T * 4, 8)) if a else EMPTY_ROW[:T * 2]
            lb = b''.join(b[i:i + 4] for i in range(0, T * 4, 8)) if b else EMPTY_ROW[:T * 2]
            out.append(la + lb)
    return out

def main():
    args = sys.argv[1:]
    force = '--force' in args
    budget = None
    if '--budget' in args: budget = float(args[args.index('--budget') + 1])
    pos = [a for i, a in enumerate(args) if not a.startswith('--') and (i == 0 or args[i - 1] != '--budget')]
    rd, out = pos[0], pos[1]
    t0 = time.time()
    for d in ('edges', 'tiles/0'): os.makedirs(os.path.join(out, d), exist_ok=True)
    man = load_json(os.path.join(out, 'manifest.json'), {})
    if force or man.get('format') != 1: man = {'format': 1, 'regions': {}, 'tiles': {}}
    regs = region_files(rd)
    if not regs:
        man.update(rendered_at=int(time.time()), bounds=None, pending=0)
        save_json(os.path.join(out, 'manifest.json'), man); print(json.dumps({'regions': 0})); return
    present = {'%d,%d' % (rx, rz) for rx, rz, _ in regs}
    changed = set()
    # regions that disappeared
    for k in list(man['regions']):
        if k not in present:
            rx, rz = map(int, k.split(','))
            man['regions'].pop(k); man['tiles'].pop('0/%d/%d' % (rx, rz), None)
            try: os.remove(os.path.join(out, 'tiles/0/%d_%d.png' % (rx, rz)))
            except OSError: pass
            changed.add((rx, rz))
    todo = []
    for rx, rz, path in regs:
        try: mt = int(os.stat(path).st_mtime)
        except OSError: continue
        prev = man['regions'].get('%d,%d' % (rx, rz))
        if not prev or prev.get('mtime') != mt: todo.append((rz, rx, path, mt))
    todo.sort()   # north to south, so each region's north edge is already known
    done = errs = 0
    for rz, rx, path, mt in todo:
        if budget is not None and done and time.time() - t0 > budget: break
        north = load_json(os.path.join(out, 'edges/%d_%d.json' % (rx, rz - 1)), None)
        rows, south, n, e = render_region(path, rx, rz, north)
        errs += e
        v = int(time.time() * 1000)
        if n:
            png_write(os.path.join(out, 'tiles/0/%d_%d.png' % (rx, rz)), T, T, rows)
            man['tiles']['0/%d/%d' % (rx, rz)] = v
        else:
            man['tiles'].pop('0/%d/%d' % (rx, rz), None)
        save_json(os.path.join(out, 'edges/%d_%d.json' % (rx, rz)), south)
        man['regions']['%d,%d' % (rx, rz)] = {'mtime': mt, 'chunks': n}
        changed.add((rx, rz)); done += 1
        save_json(os.path.join(out, 'manifest.json'), man)
    # pyramid
    xs = [rx for rx, _, _ in regs]; zs = [rz for _, rz, _ in regs]
    span = max(max(xs) - min(xs) + 1, max(zs) - min(zs) + 1)
    levels = 0
    while (span >> levels) > 2 and levels < 6: levels += 1
    levels = max(levels, 1)
    cur = changed
    for lv in range(1, levels + 1):
        z = -lv; os.makedirs(os.path.join(out, 'tiles/%d' % z), exist_ok=True)
        parents = {(cx >> 1, cy >> 1) for cx, cy in cur}
        nxt = set()
        for px, py in parents:
            kids = {}
            for i in (0, 1):
                for j in (0, 1):
                    k = '%d/%d/%d' % (z + 1, px * 2 + i, py * 2 + j)
                    if k in man['tiles']:
                        try: kids[(i, j)] = png_read(os.path.join(out, 'tiles/%d/%d_%d.png' % (z + 1, px * 2 + i, py * 2 + j)))[2]
                        except Exception: pass
            key = '%d/%d/%d' % (z, px, py); p = os.path.join(out, 'tiles/%d/%d_%d.png' % (z, px, py))
            if kids:
                png_write(p, T, T, downsample(kids)); man['tiles'][key] = int(time.time() * 1000)
            else:
                man['tiles'].pop(key, None)
                try: os.remove(p)
                except OSError: pass
            nxt.add((px, py))
        cur = nxt
    man['min_zoom'] = -levels
    man['bounds'] = {'x0': min(xs) * T, 'z0': min(zs) * T, 'x1': max(xs) * T + T - 1, 'z1': max(zs) * T + T - 1}
    man['pending'] = len(todo) - done
    man['rendered_at'] = int(time.time())
    save_json(os.path.join(out, 'manifest.json'), man)
    print(json.dumps({'regions': len(regs), 'rendered': done, 'pending': len(todo) - done, 'chunk_errors': errs, 'seconds': round(time.time() - t0, 1)}))

if __name__ == '__main__':
    main()
