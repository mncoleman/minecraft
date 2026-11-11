#!/usr/bin/env bash
# Build ClaudeBuild in a throwaway Maven/JDK17 container against the live server's
# patched Paper jar, then drop it into the game's plugins folder. A server restart
# (docker restart mc-eagler) is needed to load a new jar.
set -euo pipefail
cd "$(dirname "$0")"

OUT="../server/data/plugins"
mkdir -p lib
cp ../server/data/cache/patched_1.12.2.jar lib/patched_1.12.2.jar

M2="$HOME/.m2-mc-eagler"
mkdir -p "$M2"
docker run --rm -v "$PWD":/work -w /work -v "$M2":/root/.m2 \
  maven:3.9-eclipse-temurin-17 mvn -q -e -DskipTests clean package

sudo cp target/claude-build.jar "$OUT/claude-build.jar"
sudo chown 1001:1001 "$OUT/claude-build.jar"
echo "Built -> $OUT/claude-build.jar"
