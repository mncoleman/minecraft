#!/usr/bin/env bash
# Download the 26.x server's plugins into ./data/plugins/, pinned by URL + SHA-256.
#
#   EaglerXPaper   EaglerXServer fork for Paper up to 26.x (plugin name stays
#                  "EaglercraftXServer", same API, so EaglerJwtAuth works as-is).
#   ViaVersion/ViaBackwards  required by EaglerXPaper; bridge client protocol.
#   Multiverse-Core 5, WorldEdit 7, WorldGuard 7, LuckPerms  the world platform
#                  the panel drives over RCON (modern-command dialect).
#   Chunky         chunk pregeneration (run once per world, see DEPLOY.md).
#   BlueMap        3D world map behind the panel's Map tab (configs: server26/bluemap/,
#                  web server reachable only on the Docker network, proxied by mc-auth).
#   QualityArmory  guns (models + per-type sounds come from its own resource pack).
#   BlockShips (+ Mechanism, DefCoreLib)  block-built ships/airships.
#   Windfarer      player-built moving crafts (planes, airships).
#   packetevents   packet library; installed with the above as boot-tested.
#
# EaglerJwtAuth (plugin/build.sh) and ClaudeBuild-26 (build-plugin-26/build.sh)
# are built separately.
#
# Run from the server26/ directory:  bash scripts/fetch-plugins.sh
set -euo pipefail

DEST="$(cd "$(dirname "$0")/.." && pwd)/data/plugins"
mkdir -p "$DEST"

# Format: "<sha256>  <filename>  <url>"
PINNED=(
  "56079cac8e7b393a0394227a77e73dd55fb6f8a952cad1529ad7faf7054e6f57  EaglerXPaper.jar  https://github.com/PlanetDogeCodes/EaglerXPaper/releases/download/v1.1.1-S2/EaglerXPaper-v1.1.1-Stable2.jar"
  "c0b63badcb0f7d38f4443e06820f2b8142dd4f0d3b0511f9330ff1050430e6b2  ViaVersion.jar  https://cdn.modrinth.com/data/P1OZGk5p/versions/Fkfcr89K/ViaVersion-5.12.2.jar"
  "e989440e0aad7e12d4685d7a57df854691b67660966a95ec0450e20ce98e87ab  ViaBackwards.jar  https://cdn.modrinth.com/data/NpvuJQoq/versions/WFO37e8T/ViaBackwards-5.12.2.jar"
  "792252b6bbcf17c94ab8385e595281c830d7a40c946aea1832d8a010702bb630  multiverse-core-5.8.2.jar  https://cdn.modrinth.com/data/3wmN97b8/versions/de7TbcZG/multiverse-core-5.8.2.jar"
  "e0ce67d870ad1fef8a40dd9d7926360caf3bb44722438545d6b20b55f82a0c91  worldedit-bukkit-7.4.6.jar  https://cdn.modrinth.com/data/1u6JkXh5/versions/YFnqiUlL/worldedit-bukkit-7.4.6.jar"
  "070223c535629f3f5d15f002388c1e3ae615a5f4ba051e7ccfb5d716540547a9  worldguard-bukkit-7.0.21.jar  https://cdn.modrinth.com/data/DKY9btbd/versions/fiHLM6oY/worldguard-bukkit-7.0.21.jar"
  "a2c7877eaacf52605f5d2b08000656fbc43f7bec1eaf6ef9e71b6b9103a9c14f  Chunky-Paper-1.5.66.jar  https://cdn.modrinth.com/data/fALzjamp/versions/RBuKjN4k/Chunky-Paper-1.5.66.jar"
  "49cecb66fa1fd22a133039a490e9c1e5095a238e7cd66eb9d2a16fe6c897550d  LuckPerms-Bukkit-5.5.71.jar  https://cdn.modrinth.com/data/Vebnzrzj/versions/b0mk8uS6/LuckPerms-Bukkit-5.5.71.jar"
  "7bf475936c26107d476c63151c76d5b49e865eebeada12c9e7d92155de877b9f  bluemap-5.29-paper.jar  https://github.com/BlueMap-Minecraft/BlueMap/releases/download/v5.29/bluemap-5.29-paper.jar"
  # Guns + vehicles (2026-11-20; boot-tested together on Paper 26.3 build 249).
  "e3d872b720cb57c59842e72ee8f9770a16c87c1504528c42b128e698388e7733  QualityArmory-2.2.0.jar  https://cdn.modrinth.com/data/flkUwsSr/versions/8VkdT70f/QualityArmory.jar"
  "a3eed44326c6b9cc375e2a399d5f2e484174d90167376f4f1f124906062e1ce3  BlockShips-0.0.19.jar  https://cdn.modrinth.com/data/18sjyZwv/versions/c2z7kAVU/BlockShips-0.0.19.jar"
  "b5097f86e8a1fbd96645282edf6765947f76852316ba1fe1787e8290ad10a00a  Mechanism-0.5.0.jar  https://cdn.modrinth.com/data/bgtIsXbt/versions/JET5cGzX/Mechanism-0.5.0.jar"
  "e84d9fab0301ed29917b0e85dc9af745b19dc9f5aa6b6b8bf3ae3798c22ece66  defCoreLib-0.5.0.jar  https://cdn.modrinth.com/data/4DETv3sR/versions/1dTGzsnn/defCoreLib-0.5.0.jar"
  "35220ea164b44e99b25c80a37220b94d425460d89bf080e1cf020181948e9d4f  Windfarer-8.14.0-TTE.jar  https://cdn.modrinth.com/data/FDPk3UZI/versions/QVsioDhu/Windfarer-8.14.0-TTE.jar"
  "060087c58ec268eae7dd0eb1f17ac3bea1eaadda1693414141ff64e506091bd7  packetevents-spigot-2.14.0.jar  https://cdn.modrinth.com/data/HYKaKraK/versions/m78nFxYg/packetevents-spigot-2.14.0.jar"
)

echo "Downloading 26.x plugins (SHA-256 verified) -> $DEST"
for entry in "${PINNED[@]}"; do
  read -r sha name url <<<"$entry"
  echo "  - $name"
  curl -fsSL "$url" -o "$DEST/$name"
  got="$(shasum -a 256 "$DEST/$name" | awk '{print $1}')"
  if [ "$got" != "$sha" ]; then
    echo "    !! SHA-256 MISMATCH for $name (expected $sha, got $got)" >&2
    exit 1
  fi
  echo "    sha256 ok"
done

( cd "$DEST" && shasum -a 256 *.jar | tee SHA256SUMS )
echo "Done. Next: plugin/build.sh 26 and build-plugin-26/build.sh."
