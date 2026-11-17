"""Shared helpers for the panel's map renderers (render.py, tiles.py, slice.py).

Reads Minecraft region files straight off disk, no server involved:
  * NBT parsing for both chunk formats: modern (26.x: sections/block_states, palette
    entries as {'Name':..} / {'': name} / {'id':..,'properties':..}) and legacy 1.12
    (Level/Sections/Blocks with numeric ids, the 1.8 server's worlds).
  * Vanilla map colours (MapColor base RGB) per block.
  * The top-down column walk an in-game map does, and a tiny PNG writer/reader.
"""
import os, zlib, gzip, struct, io

def nbt(buf):
    f = io.BytesIO(buf); rd = f.read
    def s(): n = struct.unpack('>H', rd(2))[0]; return rd(n).decode('utf-8', 'replace')
    def p(t):
        if t == 1: return struct.unpack('>b', rd(1))[0]
        if t == 2: return struct.unpack('>h', rd(2))[0]
        if t == 3: return struct.unpack('>i', rd(4))[0]
        if t == 4: return struct.unpack('>q', rd(8))[0]
        if t == 5: return struct.unpack('>f', rd(4))[0]
        if t == 6: return struct.unpack('>d', rd(8))[0]
        if t == 7: n = struct.unpack('>i', rd(4))[0]; return rd(n)
        if t == 8: return s()
        if t == 9:
            et = rd(1)[0]; n = struct.unpack('>i', rd(4))[0]; return [p(et) for _ in range(n)]
        if t == 10:
            d = {}
            while True:
                tt = rd(1)[0]
                if tt == 0: return d
                k = s(); d[k] = p(tt)
        if t == 11: n = struct.unpack('>i', rd(4))[0]; return list(struct.unpack('>%di' % n, rd(4 * n)))
        if t == 12: n = struct.unpack('>i', rd(4))[0]; return list(struct.unpack('>%dq' % n, rd(8 * n)))
        raise ValueError(t)
    t = rd(1)[0]; s(); return p(t)

# --- vanilla map colours (MapColor base RGB) ---
C = dict(GRASS=(127,178,56), SAND=(247,233,163), WOOL=(199,199,199), FIRE=(255,0,0), ICE=(160,160,255), METAL=(167,167,167),
 PLANT=(0,124,0), SNOW=(255,255,255), CLAY=(164,168,184), DIRT=(151,109,77), STONE=(112,112,112), WATER=(64,64,255), WOOD=(143,119,72),
 QUARTZ=(255,252,245), ORANGE=(216,127,51), WHITE=(255,255,255), LBLUE=(102,153,216), YELLOW=(229,229,51), LGREEN=(127,204,25),
 PINK=(242,127,165), GRAY=(76,76,76), LGRAY=(153,153,153), CYAN=(76,127,153), PURPLE=(127,63,178), BLUE=(51,76,178), BROWN=(102,76,51),
 GREEN=(102,127,51), RED=(153,51,51), BLACK=(25,25,25), GOLD=(250,238,77), DIAMOND=(92,219,213), EMERALD=(0,217,58), PODZOL=(129,86,49),
 NETHER=(112,2,0), T_WHITE=(209,177,161), T_LGRAY=(135,107,98), T_GRAY=(57,41,35), T_CYAN=(87,92,92), DEEPSLATE=(100,100,100),
 W_STEM=(58,142,140), W_NYL=(22,126,134), RAW_IRON=(216,175,147), LICHEN=(127,167,150))
def color(name):
    n = name.split(':')[-1]
    if n in ('water', 'bubble_column') or 'seagrass' in n or n in ('kelp', 'kelp_plant'): return 'WATER'
    if n == 'lava' or 'magma' in n: return 'FIRE'
    if n == 'cherry_leaves': return 'PINK'
    if n == 'pale_oak_leaves': return 'LGRAY'
    if n.endswith('_leaves') or n in ('vine', 'lily_pad', 'cactus', 'sugar_cane', 'bamboo'): return 'PLANT'
    if n in ('grass_block',): return 'GRASS'
    if n in ('snow', 'snow_block', 'powder_snow'): return 'SNOW'
    if n in ('ice', 'packed_ice', 'blue_ice', 'frosted_ice'): return 'ICE'
    if 'copper' in n or n.startswith('lightning_rod') or 'waxed' in n:
        if 'oxidized' in n: return 'W_NYL'
        if 'weathered' in n: return 'W_STEM'
        if 'exposed' in n: return 'T_LGRAY'
        return 'ORANGE'
    if 'deepslate' in n or 'reinforced' in n: return 'DEEPSLATE'
    if 'tuff' in n: return 'T_GRAY'
    if 'mud_brick' in n: return 'T_LGRAY'
    if n in ('mud',): return 'T_CYAN'
    if n == 'packed_mud': return 'DIRT'
    if 'pale_moss' in n: return 'LGRAY'
    if 'moss' in n or 'azalea' in n: return 'GREEN'
    if 'sandstone' in n or n in ('sand', 'birch_planks', 'birch_log', 'birch_stairs', 'birch_slab', 'end_stone', 'glowstone'): return 'SAND'
    if n in ('red_sand',) or 'acacia' in n: return 'ORANGE'
    if 'diorite' in n or 'quartz' in n: return 'QUARTZ'
    if 'granite' in n or n in ('dirt', 'coarse_dirt', 'farmland', 'dirt_path', 'rooted_dirt'): return 'DIRT'
    if n == 'podzol' or 'spruce' in n: return 'PODZOL'
    if 'dark_oak' in n: return 'BROWN'
    if 'cherry' in n: return 'T_WHITE'
    if 'pale_oak' in n: return 'QUARTZ'
    if 'mangrove' in n or 'crimson' in n: return 'RED'
    if 'jungle' in n: return 'DIRT'
    if 'oak' in n or 'planks' in n or n in ('bookshelf', 'chest', 'barrel', 'crafting_table', 'lectern', 'composter', 'note_block'): return 'WOOD'
    if 'bamboo' in n: return 'YELLOW'
    if n == 'clay': return 'CLAY'
    if 'gold' in n: return 'GOLD'
    if 'diamond' in n: return 'DIAMOND'
    if 'emerald' in n: return 'EMERALD'
    if 'iron' in n or 'anvil' in n or n in ('lantern', 'soul_lantern', 'chain', 'hopper', 'cauldron', 'heavy_core'): return 'METAL'
    if 'redstone' in n or n in ('tnt',) or 'nether_wart' in n: return 'FIRE' if n == 'redstone_block' else 'ORANGE'
    if 'shroomlight' in n or n.startswith('pumpkin') or n.startswith('carved'): return 'ORANGE'
    if 'froglight' in n or 'sea_lantern' in n: return 'QUARTZ'
    if 'nether' in n: return 'NETHER'
    if 'obsidian' in n or 'blackstone' in n or 'coal_block' in n: return 'BLACK'
    if 'sculk' in n: return 'CYAN'
    if 'prismarine' in n: return 'DIAMOND'
    if 'resin' in n: return 'ORANGE'
    for col in ('white','orange','magenta','light_blue','yellow','lime','pink','gray','light_gray','cyan','purple','blue','brown','green','red','black'):
        if n.startswith(col + '_'):
            return {'white':'WHITE','orange':'ORANGE','magenta':'PURPLE','light_blue':'LBLUE','yellow':'YELLOW','lime':'LGREEN','pink':'PINK',
                    'gray':'GRAY','light_gray':'LGRAY','cyan':'CYAN','purple':'PURPLE','blue':'BLUE','brown':'BROWN','green':'GREEN','red':'RED','black':'BLACK'}[col]
    if 'glass' in n: return None   # see-through
    return 'STONE'
SEE_THROUGH = ('air', 'cave_air', 'void_air', 'light', 'barrier', 'structure_void')
NONSOLID = ('short_grass','tall_grass','fern','large_fern','dead_bush','torch','wall_torch','soul_torch','redstone_torch','dandelion','poppy',
  'blue_orchid','allium','azure_bluet','red_tulip','orange_tulip','white_tulip','pink_tulip','oxeye_daisy','cornflower','lily_of_the_valley',
  'sunflower','lilac','rose_bush','peony','brown_mushroom','red_mushroom','sweet_berry_bush','button','lever','rail','powered_rail',
  'detector_rail','activator_rail','tripwire','redstone_wire','pink_petals','wildflowers','leaf_litter','firefly_bush','bush','glow_lichen',
  'short_dry_grass','tall_dry_grass','cobweb','ladder','string' )
# legacy 1.12 ids -> map colour (only what generates or is common)
LEG = {1:'STONE',2:'GRASS',3:'DIRT',4:'STONE',5:'WOOD',7:'STONE',8:'WATER',9:'WATER',10:'FIRE',11:'FIRE',12:'SAND',13:'STONE',14:'STONE',15:'STONE',
 16:'STONE',17:'WOOD',18:'PLANT',24:'SAND',35:'WOOL',43:'STONE',44:'STONE',45:'RED',48:'STONE',49:'BLACK',53:'WOOD',60:'DIRT',67:'STONE',
 78:'SNOW',79:'ICE',80:'SNOW',81:'PLANT',82:'CLAY',83:'PLANT',85:'WOOD',86:'ORANGE',98:'STONE',99:'DIRT',100:'RED',106:'PLANT',109:'STONE',
 110:'PURPLE',111:'PLANT',159:'T_WHITE',161:'PLANT',162:'WOOD',172:'ORANGE',174:'ICE',179:'ORANGE',20:'NONE',102:'NONE'}
LEG_SKIP = {0,6,31,32,37,38,39,40,50,51,55,59,63,64,65,66,68,69,70,71,72,75,76,77,83,90,93,94,104,105,106,111,115,127,131,132,141,142,143,147,148,149,150,157,171,175,175,176,177,193,194,195,196,197,27,28,30,20,102,160,95}

def classify(short):
    """Map-colour key for a block seen from above, or None if the map looks through it."""
    if short in SEE_THROUGH or short in NONSOLID or short.endswith('_button'): return None
    return color(short)

def unpack(longs, bits, count):
    out = []; per = 64 // bits; mask = (1 << bits) - 1
    for L in longs:
        L &= 0xFFFFFFFFFFFFFFFF
        for i in range(per):
            out.append((L >> (i * bits)) & mask)
            if len(out) == count: return out
    return out

def pname(e):
    """Block id of a palette entry, any of the shapes 26 writes."""
    if isinstance(e, str): return e.split('[')[0]
    if isinstance(e, dict):
        for k in ('Name', 'name', 'id', ''):
            if k in e: return pname(e[k])
        return 'minecraft:' + str(next(iter(e.values()), 'stone'))
    return 'minecraft:stone'

def full(e):
    """Block id plus its block states, as 'minecraft:lever[face=wall,facing=north,powered=true]'."""
    if isinstance(e, str): return e if ':' in e else 'minecraft:' + e
    if isinstance(e, dict):
        n = e.get('Name') or e.get('name') or e.get('id') or e.get('') or 'minecraft:stone'
        if ':' not in n: n = 'minecraft:' + n
        p = e.get('Properties') or e.get('properties') or {}
        return n + ('[' + ','.join('%s=%s' % kv for kv in sorted(p.items())) + ']' if p else '')
    return 'minecraft:stone'

def region_files(rd):
    """(rx, rz, path) for every r.X.Z.mca in a region dir."""
    out = []
    for fn in os.listdir(rd):
        parts = fn.split('.')
        if len(parts) == 4 and parts[0] == 'r' and parts[3] == 'mca':
            try: out.append((int(parts[1]), int(parts[2]), os.path.join(rd, fn)))
            except ValueError: pass
    return out

def chunks(path, rx, rz, bbox=None, errors=None):
    """Yield (cx, cz, nbt) for each stored chunk in a region file. bbox=(x0,z0,x1,z1)
    skips chunks outside it BEFORE decompressing. A chunk caught mid-write (the
    server saves while we read) is skipped and counted, never fatal."""
    try: data = open(path, 'rb').read()
    except OSError: return
    for i in range(1024):
        if i * 4 + 4 > len(data): break
        off = int.from_bytes(data[i*4:i*4+3], 'big'); cnt = data[i*4+3]
        if off == 0 or cnt == 0: continue
        cx = rx * 32 + (i % 32); cz = rz * 32 + (i // 32)
        if bbox and (cx * 16 + 15 < bbox[0] or cx * 16 > bbox[2] or cz * 16 + 15 < bbox[1] or cz * 16 > bbox[3]): continue
        try:
            pos = off * 4096; ln = struct.unpack('>I', data[pos:pos+4])[0]; comp = data[pos+4] & 0x7f; raw = data[pos+5:pos+4+ln]
            buf = zlib.decompress(raw) if comp == 2 else gzip.decompress(raw) if comp == 1 else raw if comp == 3 else None
            if buf is None: continue
            yield cx, cz, nbt(buf)
        except Exception as e:
            if errors is not None: errors.append(repr(e)[:120])

# ── top-down column walk ─────────────────────────────────────────────────────
def _heightmap(c, ymin):
    """WORLD_SURFACE heightmap -> list of 256 start-y values (or None). Modern
    heightmaps pack entries without spanning longs; value = top block y + 1 - ymin."""
    hm = (c.get('Heightmaps') or {}).get('WORLD_SURFACE')
    if not hm: return None
    bits = None
    for b in range(1, 33):
        if -(-256 // (64 // b)) == len(hm): bits = b
    if bits is None: return None
    vals = unpack(hm, bits, 256)
    if len(vals) < 256: return None
    return [v - 1 + ymin for v in vals]

def modern_tops(c, put, x0, z0, x1, z1):
    """Call put(wx, wz, (key, y, waterDepth)) for each column of a modern chunk in bounds."""
    cx, cz = c['xPos'], c['zPos']
    secs = {}
    for s in c.get('sections', []):
        bs = s.get('block_states')
        if not bs: continue
        ks = [classify(pname(e).split(':')[-1]) for e in bs['palette']]
        if len(ks) == 1 or 'data' not in bs:
            if ks[0] is None: continue          # all see-through: same as absent
            secs[s['Y']] = [ks, None, None]
        else:
            secs[s['Y']] = [ks, None, bs['data']]
    if not secs: return
    ys = sorted(secs)
    ymin = ys[0] << 4; ymax = (ys[-1] << 4) + 15
    def key(x, y, z):
        e = secs.get(y >> 4)
        if e is None: return None
        if e[1] is None:
            if e[2] is None: return e[0][0]
            e[1] = unpack(e[2], max(4, (len(e[0]) - 1).bit_length()), 4096); e[2] = None
        return e[0][e[1][((y & 15) * 16 + z) * 16 + x]]
    hm = _heightmap(c, min(ymin, -64)) if 'Heightmaps' in c else None
    for z in range(16):
        wz = cz * 16 + z
        if wz < z0 or wz > z1: continue
        for x in range(16):
            wx = cx * 16 + x
            if wx < x0 or wx > x1: continue
            y = ymax
            if hm is not None:
                h = hm[z * 16 + x]
                if ymin - 1 <= h <= ymax: y = h
            val = None
            while y >= ymin:
                sy = y >> 4
                if sy not in secs:
                    y = (sy << 4) - 1; continue      # skip an empty section in one step
                k = key(x, y, z)
                if k is None: y -= 1; continue
                if k == 'WATER':
                    d = 0; yy = y
                    while yy >= ymin and key(x, yy, z) == 'WATER': d += 1; yy -= 1
                    val = ('WATER', y, d)
                else: val = (k, y, 0)
                break
            put(wx, wz, val)

def legacy_tops(lv, put, x0, z0, x1, z1):
    cx, cz = lv['xPos'], lv['zPos']
    secs = {s['Y']: s['Blocks'] for s in lv.get('Sections', []) if s.get('Blocks')}
    if not secs: return
    ys = sorted(secs, reverse=True)
    for z in range(16):
        for x in range(16):
            wx, wz = cx * 16 + x, cz * 16 + z
            if not (x0 <= wx <= x1 and z0 <= wz <= z1): continue
            val = None
            for sy in ys:
                b = secs[sy]
                for ly in range(15, -1, -1):
                    bid = b[(ly * 16 + z) * 16 + x]
                    if bid in LEG_SKIP: continue
                    k = LEG.get(bid, 'STONE'); y = sy * 16 + ly
                    if k == 'NONE': continue
                    if k == 'WATER':
                        d = 0; yy = y
                        while yy >= 0:
                            s2 = secs.get(yy >> 4)
                            if s2 is None or s2[((yy & 15) * 16 + z) * 16 + x] not in (8, 9): break
                            d += 1; yy -= 1
                        val = ('WATER', y, d)
                    else: val = (k, y, 0)
                    break
                if val: break
            put(wx, wz, val)

def chunk_tops(c, put, x0, z0, x1, z1):
    """Dispatch on chunk format. Returns 'modern' | 'legacy' | None."""
    if 'Level' in c and 'Sections' in c['Level'] and any('Blocks' in s for s in c['Level']['Sections']):
        legacy_tops(c['Level'], put, x0, z0, x1, z1); return 'legacy'
    if 'sections' in c:
        modern_tops(c, put, x0, z0, x1, z1); return 'modern'
    return None

SH = (180/255, 220/255, 1.0)
def shade_rows(top, W, H, north=None):
    """In-game-map shading (lighter where higher than the block to the north).
    top[z][x] = (key, y, depth) | None. north = list of W heights for the row
    just north of the image (from the neighbouring region), or None.
    Returns raw RGBA rows for png_write."""
    rows = []
    for z in range(H):
        row = bytearray()
        prev = top[z - 1] if z > 0 else None
        for x in range(W):
            v = top[z][x]
            if v is None: row += b'\x00\x00\x00\x00'; continue
            k, y, d = v; base = C[k]
            if k == 'WATER':
                t = d * 0.1 + ((x + z) & 1) * 0.2
                sh = SH[2] if t < 0.5 else SH[0] if t > 0.9 else SH[1]
            else:
                if prev is not None:
                    n = prev[x]; ny = n[1] if n else y
                elif north is not None and north[x] is not None:
                    ny = north[x]
                else: ny = y
                sh = SH[2] if y > ny else SH[0] if y < ny else SH[1]
            row += bytes((int(base[0]*sh), int(base[1]*sh), int(base[2]*sh), 255))
        rows.append(bytes(row))
    return rows

# ── PNG (RGBA8, filter 0 only: enough to write ours and read ours back) ──────
def png_write(path, W, H, rows, level=6):
    def ch(t, b): return struct.pack('>I', len(b)) + t + b + struct.pack('>I', zlib.crc32(t + b) & 0xffffffff)
    raw = b''.join(b'\x00' + r for r in rows)
    data = b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 6, 0, 0, 0)) + ch(b'IDAT', zlib.compress(raw, level)) + ch(b'IEND', b'')
    tmp = path + '.tmp'
    with open(tmp, 'wb') as f: f.write(data)
    os.replace(tmp, path)

def png_read(path):
    """Read a PNG this module wrote -> (W, H, rows of RGBA bytes)."""
    data = open(path, 'rb').read()
    pos = 8; W = H = 0; idat = b''
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos+4])[0]; t = data[pos+4:pos+8]; body = data[pos+8:pos+8+ln]
        if t == b'IHDR': W, H = struct.unpack('>II', body[:8])
        elif t == b'IDAT': idat += body
        pos += 12 + ln
    raw = zlib.decompress(idat); stride = W * 4 + 1
    return W, H, [raw[i*stride+1:(i+1)*stride] for i in range(H)]
