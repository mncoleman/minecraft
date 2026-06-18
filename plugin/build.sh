#!/usr/bin/env bash
# Build the plugin in a throwaway Maven/JDK17 container (no local maven needed)
# and drop the jar into the game server's plugins folder.
set -euo pipefail
cd "$(dirname "$0")"

OUT="../server/data/plugins"
mkdir -p "$OUT"

# Cache the maven repo on the host so rebuilds are fast.
M2="$HOME/.m2-mc-eagler"
mkdir -p "$M2"

docker run --rm \
  -v "$PWD":/work -w /work \
  -v "$M2":/root/.m2 \
  maven:3.9-eclipse-temurin-17 \
  mvn -q -e -DskipTests clean package

# data/plugins is owned by the game's runtime user (uid 1001 / ubuntu on this
# box), so a plain cp silently fails with EACCES and leaves a STALE jar. Use
# sudo + chown to the matching uid so the server can read it.
sudo cp target/mc-eagler-auth.jar "$OUT/mc-eagler-auth.jar"
sudo chown 1001:1001 "$OUT/mc-eagler-auth.jar"
echo "Built -> $OUT/mc-eagler-auth.jar"
sudo ls -la "$OUT/mc-eagler-auth.jar"
