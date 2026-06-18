#!/usr/bin/env bash
# Stage the two Eaglercraft clients next to the launcher (index.html):
#   wasm/  — EaglercraftX 1.8 WASM-GC (Chrome 137+/Firefox 139+, fastest)
#   js/    — EaglercraftX 1.8 JS/TeaVM build (Safari / iPhone / iPad)
#
# Caddy serves this whole folder as the docroot for minecraft.mncoleman.com,
# gated by forward_auth. Run from the clients/ directory.
set -euo pipefail
cd "$(dirname "$0")"

SRC=".."   # the project root holds the original client assets

# --- WASM-GC client (single self-contained HTML) ---
mkdir -p wasm
if [ -f "$SRC/EaglercraftX_1.8_WASM-GC_Offline_Download.html" ]; then
  cp "$SRC/EaglercraftX_1.8_WASM-GC_Offline_Download.html" wasm/index.html
  echo "staged wasm/index.html"
else
  echo "WARN: WASM-GC client not found at $SRC/EaglercraftX_1.8_WASM-GC_Offline_Download.html"
fi

# --- JS/TeaVM client (Safari/iOS). The eaglerforge build is a working JS
#     EaglercraftX 1.8 client (includes the EaglerForge mod loader). ---
mkdir -p js
if [ -d "$SRC/eaglerforge" ]; then
  cp -R "$SRC/eaglerforge/." js/
  echo "staged js/ from eaglerforge (JS/TeaVM EaglercraftX 1.8)"
else
  echo "WARN: eaglerforge JS client not found at $SRC/eaglerforge"
  echo "      Source a vanilla EaglercraftX 1.8 JS client and drop it in js/ for Safari users."
fi

echo
echo "Staged client tree:"
du -sh wasm js 2>/dev/null || true
echo "Done. Caddy docroot should point at this clients/ folder."
