"""Render QualityArmory item icons (inventory/GUI view) from the resource pack.

usage: python3 -I server26/scripts/render-qa-icons.py <pack_dir> <yml_dir> <out_dir>
Maps each item yml (material + id) to its model through
assets/minecraft/items/<material>.json, then rasterises the model's cuboids
with the model's own "gui" display rotation (painter's algorithm, orthographic).
"""
import json, math, os, re, sys
from PIL import Image

PACK, YML, OUT = sys.argv[1:4]
A = os.path.join(PACK, "assets")
SIZE, SS = 128, 4  # output px, supersample
SHADE = {"up": 1.0, "down": 0.5, "north": 0.8, "south": 0.8, "east": 0.6, "west": 0.6}


def path_of(ref, kind):
    ns, p = (ref.split(":", 1) if ":" in ref else ("minecraft", ref))
    return os.path.join(A, ns, kind, p + (".json" if kind == "models" else ".png"))


_tex = {}
def texture(ref):
    if ref not in _tex:
        p = path_of(ref, "textures")
        im = None
        if os.path.exists(p):
            im = Image.open(p).convert("RGBA")
            if os.path.exists(p + ".mcmeta") and im.height > im.width:  # animated: frame 0
                im = im.crop((0, 0, im.width, im.width))
        _tex[ref] = im
    return _tex[ref]


def load_model(ref):
    p = path_of(ref, "models")
    if not os.path.exists(p):
        return None
    m = json.load(open(p))
    if "parent" in m:
        par = m["parent"]
        base = {} if re.search(r"item/(generated|handheld)$", par) else (load_model(par) or {})
        if re.search(r"item/(generated|handheld)$", par):
            base = {"generated": True}
        merged = dict(base)
        merged["textures"] = {**base.get("textures", {}), **m.get("textures", {})}
        merged["display"] = {**base.get("display", {}), **m.get("display", {})}
        for k in ("elements",):
            if k in m:
                merged[k] = m[k]
        return merged
    return m


def resolve_tex(m, key):
    t = m.get("textures", {})
    seen = 0
    while key.startswith("#") and seen < 10:
        key = t.get(key[1:], "")
        seen += 1
    return key or None


def rot(v, axis, deg):
    a = math.radians(deg); c, s = math.cos(a), math.sin(a)
    x, y, z = v
    if axis == "x": return (x, y * c - z * s, y * s + z * c)
    if axis == "y": return (x * c + z * s, y, -x * s + z * c)
    return (x * c - y * s, x * s + y * c, z)


def corners(fr, to, d):
    x0, y0, z0 = fr; x1, y1, z1 = to
    # order: (u0,v0) (u1,v0) (u1,v1) (u0,v1) as Minecraft maps face UVs
    return {
        "north": [(x1, y1, z0), (x0, y1, z0), (x0, y0, z0), (x1, y0, z0)],
        "south": [(x0, y1, z1), (x1, y1, z1), (x1, y0, z1), (x0, y0, z1)],
        "west":  [(x0, y1, z0), (x0, y1, z1), (x0, y0, z1), (x0, y0, z0)],
        "east":  [(x1, y1, z1), (x1, y1, z0), (x1, y0, z0), (x1, y0, z1)],
        "up":    [(x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)],
        "down":  [(x0, y0, z1), (x1, y0, z1), (x1, y0, z0), (x0, y0, z0)],
    }[d]


def default_uv(fr, to, d):
    x0, y0, z0 = fr; x1, y1, z1 = to
    return {"north": (16 - x1, 16 - y1, 16 - x0, 16 - y0), "south": (x0, 16 - y1, x1, 16 - y0),
            "west": (z0, 16 - y1, z1, 16 - y0), "east": (16 - z1, 16 - y1, 16 - z0, 16 - y0),
            "up": (x0, z0, x1, z1), "down": (x0, 16 - z1, x1, 16 - z0)}[d]


def render(m):
    if m.get("generated") or not m.get("elements"):
        ref = resolve_tex(m, "#layer0")
        im = texture(ref) if ref else None
        return im.resize((SIZE, SIZE), Image.NEAREST) if im else None
    gui = m.get("display", {}).get("gui", {})
    rx, ry, rz = gui.get("rotation", [30, 225, 0])
    faces = []
    for el in m["elements"]:
        fr, to = el["from"], el["to"]
        r = el.get("rotation")
        for d, f in el.get("faces", {}).items():
            ref = resolve_tex(m, f.get("texture", ""))
            im = texture(ref) if ref else None
            if im is None:
                continue
            pts = []
            for p in corners(fr, to, d):
                if r and r.get("angle"):
                    o = r.get("origin", [8, 8, 8])
                    p = rot(tuple(p[i] - o[i] for i in range(3)), r["axis"], r["angle"])
                    p = tuple(p[i] + o[i] for i in range(3))
                p = tuple(c - 8 for c in p)
                # display rotation: rotationXYZ => v' = Rx(Ry(Rz v))
                p = rot(rot(rot(p, "z", rz), "y", ry), "x", rx)
                pts.append(p)
            uv = f.get("uv") or default_uv(fr, to, d)
            faces.append((sum(p[2] for p in pts) / 4, pts, im, uv, f.get("rotation", 0), SHADE[d]))
    if not faces:
        return None
    xs = [p[0] for f in faces for p in f[1]]; ys = [p[1] for f in faces for p in f[1]]
    span = max(max(xs) - min(xs), max(ys) - min(ys)) or 1
    W = SIZE * SS; pad = W * 0.06; k = (W - 2 * pad) / span
    cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    canvas = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    for _, pts, im, uv, frot, sh in sorted(faces, key=lambda f: f[0]):
        sp = [(W / 2 + (p[0] - cx) * k, W / 2 - (p[1] - cy) * k) for p in pts]
        tw, th = im.size
        u0, v0, u1, v1 = [c * tw / 16 if i % 2 == 0 else c * th / 16 for i, c in enumerate(uv)]
        tc = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
        n = (frot // 90) % 4
        tc = tc[n:] + tc[:n]
        # affine screen->texture from 3 corners
        (X0, Y0), (X1, Y1), (X3, Y3) = sp[0], sp[1], sp[3]
        det = (X1 - X0) * (Y3 - Y0) - (X3 - X0) * (Y1 - Y0)
        if abs(det) < 1e-6:
            continue
        def solve(t0, t1, t3):
            a = ((t1 - t0) * (Y3 - Y0) - (t3 - t0) * (Y1 - Y0)) / det
            b = ((t3 - t0) * (X1 - X0) - (t1 - t0) * (X3 - X0)) / det
            return a, b, t0 - a * X0 - b * Y0
        au = solve(tc[0][0], tc[1][0], tc[3][0]); av = solve(tc[0][1], tc[1][1], tc[3][1])
        layer = im.transform((W, W), Image.AFFINE, au + av, resample=Image.NEAREST)
        # mask to the projected quad (texture outside the uv rect must not leak)
        from PIL import ImageDraw
        mask = Image.new("L", (W, W), 0); ImageDraw.Draw(mask).polygon(sp, fill=255)
        r_, g_, b_, a_ = layer.split()
        r_, g_, b_ = (c.point(lambda x: int(x * sh)) for c in (r_, g_, b_))
        a_ = Image.composite(a_, Image.new("L", (W, W), 0), mask)
        canvas.alpha_composite(Image.merge("RGBA", (r_, g_, b_, a_)))
    return canvas.resize((SIZE, SIZE), Image.LANCZOS)


def scalar(text, key):
    m = re.search(rf"^{key}:\s*'?\"?([^'\"\n]*)", text, re.M)
    return m.group(1).strip() if m else None


def model_for(material, cmd):
    p = os.path.join(A, "minecraft", "items", material.lower() + ".json")
    if not os.path.exists(p):
        return None
    root = json.load(open(p))["model"]
    for e in root.get("entries", []):
        if float(e["threshold"]) == float(cmd):
            return e["model"].get("model")
    return None


os.makedirs(OUT, exist_ok=True)
ok = miss = 0
for sub in ("newGuns", "ammo", "misc", "armor"):
    d = os.path.join(YML, sub)
    for fn in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        t = open(os.path.join(d, fn)).read()
        name, mat, cmd = scalar(t, "name"), scalar(t, "material"), scalar(t, "id")
        if not (name and mat and cmd and cmd.lstrip("-").isdigit()):
            continue
        ref = model_for(mat, cmd)
        img = render(load_model(ref)) if ref and load_model(ref) else None
        if img is None:
            miss += 1; print("no icon:", name, mat, cmd, ref); continue
        img.save(os.path.join(OUT, name + ".png"), optimize=True); ok += 1
print(f"rendered {ok}, missing {miss}")
