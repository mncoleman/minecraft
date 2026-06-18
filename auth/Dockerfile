# mc-auth — Bun + Hono. oven/bun is multi-arch (arm64 ok for the Oracle box).
FROM oven/bun:1-slim

# unzip + find: needed for world-zip uploads (extract + locate level.dat).
RUN apt-get update && apt-get install -y --no-install-recommends unzip findutils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching.
COPY package.json ./
RUN bun install

COPY . .

ENV NODE_ENV=production
ENV PORT=7900
ENV DB_PATH=/data/mc-auth.sqlite

# SQLite user store lives on a volume so accounts survive redeploys.
VOLUME ["/data"]

EXPOSE 7900

CMD ["bun", "run", "src/index.ts"]
