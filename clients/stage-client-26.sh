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

# Precompressed sidecars, served by mc-auth with Content-Encoding (78MB -> ~58MB
# with brotli). Regenerated on every stage; mc-auth ignores a sidecar older than
# index.html, so a stale one is never served.
rm -f "$OUT/index.html.br" "$OUT/index.html.gz"
if command -v brotli >/dev/null; then
  brotli -q 9 -f -o "$OUT/index.html.br" "$OUT/index.html"
  touch "$OUT/index.html.br"  # brotli copies the source mtime; mc-auth needs it newer
fi
gzip -9 -c "$OUT/index.html" > "$OUT/index.html.gz"
ls -l "$OUT"
