#!/usr/bin/env bash
# Download all server plugins into ./data/plugins/.
#
# Two groups:
#   (1) The Eaglercraft transport set from the official Eaglercraft-Server-Paper
#       template (versions verified to work together with EaglerXServer 1.1.0).
#   (2) The multi-world platform plugins (Phase A), pinned by exact URL + SHA-256
#       (verified curl-able for Paper 1.12.2 / Java 17).
#
# We deliberately DO NOT fetch AuthMe (our JWT plugin replaces it) or EaglerXRewind
# (1.5.2-only; it errored on enable and we don't support 1.5 clients).
#
# Run from the server/ directory:  bash scripts/fetch-plugins.sh
set -euo pipefail

DEST="$(cd "$(dirname "$0")/.." && pwd)/data/plugins"
mkdir -p "$DEST"

# --- (1) Eaglercraft transport set (from the tested-together template) --------
REF="main"
BASE="https://github.com/Eaglercraft-Templates/Eaglercraft-Server-Paper/raw/${REF}/plugins"
TEMPLATE_JARS=(
  "ViaVersion.jar"
  "ViaBackwards.jar"
  "ViaRewind.jar"
  "ViaRewind-Legacy-Support.jar"
  "SkinsRestorer.jar"
)
echo "Downloading Eaglercraft transport set -> $DEST"
for jar in "${TEMPLATE_JARS[@]}"; do
  echo "  - $jar"
  curl -fsSL "$BASE/$jar" -o "$DEST/$jar"
done
# EaglerXServer pinned to the official v1.1.0 release (NOT the template's 1.0.7).
echo "  - EaglerXServer.jar (v1.1.0 official release)"
curl -fsSL "https://github.com/lax1dude/eaglerxserver/releases/download/v1.1.0/EaglerXServer.jar" -o "$DEST/EaglerXServer.jar"

# --- (2) Multi-world platform plugins (pinned URL + SHA-256) ------------------
# Format: "<sha256>  <filename>  <url>"
# Sources: forgecdn = CurseForge CDN (dev.bukkit.org files; curl-able, unlike the
# Cloudflare-protected /download links). LuckPerms from luckperms.net CDN.
# QualityArmory (guns) from the Modrinth CDN; v2.1.3 supports 1.12.2 and is fully
# server-side (works through the Via chain to the 1.8 Eaglercraft client).
PINNED=(
  "f43b8aa54870d157463fe46902a284f4e386200a58773d21f9a4734fde336b35  Multiverse-Core-2.5.0.jar  https://mediafilez.forgecdn.net/files/2428/161/Multiverse-Core-2.5.0.jar"
  "5a7b88f6f75b4a0b6efd47ae03e9c26a2036ecd122b03a45ca635dde386d6186  worldedit-bukkit-6.1.9.jar  https://mediafilez.forgecdn.net/files/2597/538/worldedit-bukkit-6.1.9.jar"
  "013655a9573d0d26bc884aa07f0d543206041ec044dfe513a894c607ff354c98  worldguard-bukkit-6.2.2.jar  https://mediafilez.forgecdn.net/files/2610/618/worldguard-bukkit-6.2.2.jar"
  "a99792c87b521a1490863ab06ec4e91485a61996650109e457b946a628fc8eba  LuckPerms-Bukkit-5.5.55.jar  https://download.luckperms.net/1643/bukkit/loader/LuckPerms-Bukkit-5.5.55.jar"
  "efe573af2d16b10c7b8e9640615a52915ba6dd0340d326833f11fc9375467c4e  QualityArmory.jar  https://cdn.modrinth.com/data/flkUwsSr/versions/fdVKuHYp/QualityArmory.jar"
)
echo "Downloading multi-world platform plugins (with SHA-256 verification) -> $DEST"
for entry in "${PINNED[@]}"; do
  read -r sha name url <<<"$entry"
  echo "  - $name"
  curl -fsSL "$url" -o "$DEST/$name"
  got="$(shasum -a 256 "$DEST/$name" | awk '{print $1}')"
  if [ "$got" != "$sha" ]; then
    echo "    !! SHA-256 MISMATCH for $name" >&2
    echo "       expected $sha" >&2
    echo "       got      $got" >&2
    exit 1
  fi
  echo "    sha256 ok"
done

echo
echo "Recording checksums to data/plugins/SHA256SUMS:"
( cd "$DEST" && shasum -a 256 *.jar | tee SHA256SUMS )

echo
echo "Done. The custom auth plugin (mc-eagler-auth.jar) is built separately by"
echo "plugin/build.sh. EaglerXServer.jar is upgraded to v1.1.0 during deploy."
