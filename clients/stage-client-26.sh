#!/usr/bin/env bash
# Stage the Minecraft 26 Eaglercraft client into clients/26/index.html.
#
# The client is one ~78MB HTML file (WASM + assets inlined). It is NOT committed
# (too big for git; see .gitignore) — keep the original and re-run this after a
# fresh checkout or a client upgrade, then ship clients/26/ with the rsync step.
#
# Injects joinServer + a pre-listed server so Play 26 auto-connects to the 26
# server through Caddy (wss://<host>/26 → mc-eagler26), like the 1.8 clients do,
# and gives it its own localStorage namespace + IndexedDB names (see below).
#
# NOTE: joinServer alone makes the client treat a wss URL with a path as a TCP
# relay. The Play 26 button therefore opens 26/?server=<wss>&transport=eaglerx
# (the client's startup-link format); joinServer is the fallback.
#
# Usage: bash clients/stage-client-26.sh /path/to/eaglercraft-26.3-xxxx.html [wss://minecraft.mncoleman.com/26]
set -euo pipefail
SRC="${1:?path to the 26 client .html}"
WS="${2:-wss://minecraft.mncoleman.com/26}"
OUT="$(cd "$(dirname "$0")" && pwd)/26"
mkdir -p "$OUT"
python3 -I - "$SRC" "$OUT/index.html" "$WS" <<'EOF'
import sys
src, dst, ws = sys.argv[1], sys.argv[2], sys.argv[3]
d = open(src, "rb").read()
anchor = b'window.eaglercraftXOpts = {\n\t\t\tcontainer: "game_frame",'
if d.count(anchor) != 1:
    sys.exit("anchor not found exactly once; the client layout changed, update this script")
# No pre-listed `servers` entry: the in-game list would save it in relay mode.
inject = ('\n\t\t\tjoinServer: "%s",'
          '\n\t\t\tlocalStorageNamespace: "_eaglercraft26",' % ws).encode()
d = d.replace(anchor, anchor + inject)
# Same origin as the 1.8 clients => same localStorage + IndexedDB. Give 26 its
# own namespace and DB names so the two editions never read each other's
# profile, server list, or singleplayer worlds.
for old, new in ((b'worldsDB: "worlds",', b'worldsDB: "worlds26",'),
                 (b'resourcePacksDB: "resourcePacks",', b'resourcePacksDB: "resourcePacks26",')):
    if d.count(old) != 1:
        sys.exit("expected exactly one %r in the client opts" % old)
    d = d.replace(old, new)
open(dst, "wb").write(d)
print("staged", dst, "joinServer =", ws)
EOF

# Precompressed sidecar for the page, served by mc-auth with Content-Encoding
# (brotli/gzip). Regenerated on every stage; mc-auth ignores a sidecar older than
# index.html, so a stale one is never served.
# Split the single-file client into separately served files. Inline, the page
# carries the game engine (108MB WASM) and assets as base64 text the browser
# unpacks in JavaScript on every launch, and one 58MB response is often too big
# for the browser cache to keep. As files, the engine streams + compiles
# natively (and its compiled code is cached), the asset packs are cached
# individually, and the singleplayer server (43MB) is only fetched if used.
# The .wasm payloads are already brotli streams, so they ship as .br sidecars.
command -v brotli >/dev/null || { echo "brotli is required (brew install brotli)"; exit 1; }
rm -f "$OUT"/*.wasm "$OUT"/*.wasm.br "$OUT"/*.epk "$OUT/index.html.br" "$OUT/index.html.gz"
python3 -I - "$OUT" <<'EOF'
import sys, re, base64, os, subprocess
out = sys.argv[1]
page = os.path.join(out, "index.html")
d = open(page, "rb").read()
payloads = {  # inline element id -> (file name, payload is a brotli-compressed wasm)
    "eag-inline-wasm-br": ("classes.wasm", True),
    "eag-inline-mesh-wasm-br": ("mesh-worker.wasm", True),
    "eag-inline-server-wasm-br": ("server-worker.wasm", True),
    "eag-inline-terrain-wasm-br": ("terrain.wasm", True),
    "eag-inline-assets": ("assets.epk", False),
    "eag-inline-sounds": ("sounds.epk", False),
}
for pid, (name, br) in payloads.items():
    m = re.search(rb'<script type="application/octet-stream" id="' + pid.encode() + rb'"[^>]*>(.*?)</script>\s*', d, re.S)
    if not m: sys.exit("inline payload %s not found; the client layout changed, update this script" % pid)
    raw = base64.b64decode(re.sub(rb"\s+", b"", m.group(1)))
    if len(raw) != int(re.search(rb'data-size="(\d+)"', m.group(0)).group(1)): sys.exit("size mismatch in " + pid)
    p = os.path.join(out, name)
    if br:
        open(p + ".br", "wb").write(raw)
        subprocess.run(["brotli", "-d", "-f", "-o", p, p + ".br"], check=True)
        os.utime(p + ".br")  # mc-auth ignores a sidecar older than its file
    else:
        open(p, "wb").write(raw)
    d = d[:m.start()] + d[m.end():]
# The page's fetch shim decodes these names from the inline payloads; with the
# payloads gone, let them fetch the real files, and leave the .epk URLs alone.
for old, new in (
    (b'var clean = url.split("?")[0].split("#")[0].split("/").pop();\n',
     b'var clean = url.split("?")[0].split("#")[0].split("/").pop();\n'
     b'    if (clean === "classes.wasm" || clean === "mesh-worker.wasm" || clean === "server-worker.wasm" || clean === "terrain.wasm") return originalFetch(input, init);\n'),
    (b'      var id = payloadIds[name];\n      if (!id) continue;\n',
     b'      var id = payloadIds[name];\n      if (!id || !document.getElementById(id)) continue;\n'),
):
    if d.count(old) != 1: sys.exit("fetch shim changed; update this script")
    d = d.replace(old, new)
open(page, "wb").write(d)
print("split: index.html is now", len(d), "bytes")
EOF

if command -v brotli >/dev/null; then
  brotli -q 9 -f -o "$OUT/index.html.br" "$OUT/index.html"
  touch "$OUT/index.html.br"  # brotli copies the source mtime; mc-auth needs it newer
fi
gzip -9 -c "$OUT/index.html" > "$OUT/index.html.gz"
ls -l "$OUT"
