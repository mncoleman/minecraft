#!/usr/bin/env bash
# Build ClaudeBuild for Paper 26.2 (Java 25) in a throwaway Maven container against
# paper-api from repo.papermc.io, then drop it into the 26 server's plugins folder.
# A server restart is needed to load a new jar.
set -euo pipefail
cd "$(dirname "$0")"

OUT="../server26/data/plugins"

M2="$HOME/.m2-mc26"
mkdir -p "$M2"
docker run --rm -v "$PWD":/work -w /work -v "$M2":/root/.m2 \
  maven:3.9-eclipse-temurin-25 mvn -q -e -DskipTests clean package

sudo mkdir -p "$OUT"
sudo cp target/claude-build.jar "$OUT/claude-build.jar"
sudo chown 1001:1001 "$OUT/claude-build.jar"
echo "Built -> $OUT/claude-build.jar"
