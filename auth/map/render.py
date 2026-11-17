#!/usr/bin/env python3
"""Top-down Minecraft-map render of a box of a world, straight from its region files.
Usage: render.py <region_dir> x0 z0 x1 z1 out_prefix   -> out_prefix.png (1px/block) + out_prefix.json (stats)
Handles modern chunks (sections/block_states + Heightmaps) and legacy 1.12 chunks (Level/Sections/Blocks).
The panel's tiled map uses the same walk through tiles.py; this is the one-shot version."""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from render_lib import region_files, chunks, chunk_tops, shade_rows, png_write

def main():
    RD, X0, Z0, X1, Z1, OUT = sys.argv[1], *map(int, sys.argv[2:6]), sys.argv[6]
    W, H = X1 - X0 + 1, Z1 - Z0 + 1
    top = [[None] * W for _ in range(H)]
    stats = {'modern': 0, 'legacy': 0, 'missing': 0}
    errors = []
    def put(wx, wz, val): top[wz - Z0][wx - X0] = val
    for rx, rz, path in region_files(RD):
        if rx * 512 + 511 < X0 or rx * 512 > X1 or rz * 512 + 511 < Z0 or rz * 512 > Z1: continue
        for cx, cz, c in chunks(path, rx, rz, (X0, Z0, X1, Z1), errors):
            kind = chunk_tops(c, put, X0, Z0, X1, Z1)
            if kind: stats[kind] += 1
    stats['missing'] = sum(1 for r in top for v in r if v is None)
    if errors: stats['errcount'] = len(errors); stats['errors'] = errors[:5]
    png_write(OUT + '.png', W, H, shade_rows(top, W, H), 9)
    json.dump({'x0': X0, 'z0': Z0, 'w': W, 'h': H, 'stats': stats}, open(OUT + '.json', 'w'))
    print(json.dumps(stats))

if __name__ == '__main__':
    main()
