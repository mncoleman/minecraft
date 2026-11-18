# Deploy runbook — minecraft.mncoleman.com

Goal: stand up the server **without ever risking the other 21 containers**. Every
step is additive; nothing restarts or reconfigures Supabase / n8n / artifacts /
levoair. Run from your Mac; SSH key: `~/Desktop/SSH Info/ssh-key-2025-06-27.key`.

Box: `ubuntu@161.153.110.196` (`n8n-arm`).

---

## 0. Pre-flight (read-only checks)

```bash
ssh -i "$KEY" ubuntu@161.153.110.196 \
  'ss -tlnp | grep -E ":25565|:25569|:7900" ; echo "--- ports above should be EMPTY ---"'
```
Confirm `25569` (game) and `7900` (auth) are free. If not, pick alternates and
update compose + Caddy snippet.

## 1. DNS (Matthew, Namecheap)

Add an **A record**: host `minecraft` → `161.153.110.196`. No SRV (this is
WebSocket/HTTPS, not raw TCP). TTL low (e.g. 5 min) until verified.

```bash
dig +short minecraft.mncoleman.com   # should return 161.153.110.196
```

## 2. Ship the tree

Stage the clients locally first (`cd clients && bash stage-clients.sh`), then ship
the staged tree and skip the bulky originals (already copied into `clients/`):

```bash
KEY="$HOME/Desktop/SSH Info/ssh-key-2025-06-27.key"
rsync -avz --delete \
  --exclude data --exclude node_modules --exclude .env --exclude .git \
  --exclude target --exclude '.m2*' \
  --exclude 'EaglercraftX_1.8_WASM-GC_Offline_Download.html' \
  --exclude eaglerforge --exclude 'cliff build.epk' --exclude notes.txt \
  -e "ssh -i \"$KEY\"" \
  ./ ubuntu@161.153.110.196:/home/ubuntu/minecraft/
```
Caddy will serve `/home/ubuntu/minecraft/clients/` (launcher + `wasm/` + `js/`).

## 3. Game server (isolated container)

```bash
ssh -i "$KEY" ubuntu@161.153.110.196 'cd /home/ubuntu/minecraft/server && \
  bash scripts/fetch-plugins.sh && \
  docker compose up -d && \
  docker compose logs -f'      # wait for "Done (x.xxs)! For help, type help"
```
First boot generates `data/plugins/EaglerXServer/` configs, then it stops/starts.

## 4. Patch EaglerXServer config (behind-Caddy + auth)

After first run, in `data/plugins/EaglerXServer/listeners.toml` /
`settings.toml` (exact filenames per installed version — verify), set:

- `enable_tls = false`            (Caddy terminates TLS)
- listener bind / `inject_address = "127.0.0.1:25565"`  (belt-and-suspenders;
  Docker already publishes only to loopback)
- `forward_ip = true`
- `forward_ip_header = "X-Forwarded-For"`
- `forward_secret = true` + secret value (matches `MC_FWD_SECRET` in Caddy)
- `enable_authentication_events = true`   (REQUIRED — the JWT plugin is inert otherwise)

Then `docker compose restart minecraft`. Verify the listener is loopback-only:
```bash
ss -tlnp | grep 25569   # 127.0.0.1:25569 ONLY — never 0.0.0.0
```

## 5. Auth plugin (build on the box — needs only Docker)

```bash
ssh -i "$KEY" ubuntu@161.153.110.196 'cd /home/ubuntu/minecraft/plugin && bash build.sh'
# -> writes /home/ubuntu/minecraft/server/data/plugins/mc-eagler-auth.jar
```
The shared `MC_JWT_SECRET` is read from `server/.env` (step 3). Then
`docker compose restart minecraft`.

The plugin also resolves each player's **current** username from mc-auth (so a
rename/deletion takes effect in-game immediately) via the internal endpoint
`GET mc-auth:7900/internal/username?sub=…`, authenticated with `MC_PRESENCE_TOKEN`.
Both `mc-auth-url` (default `http://mc-auth:7900`) and the token are already in
place from steps 3/6, so no extra config is needed; it fails open to the JWT name
if mc-auth is unreachable. Rebuilding the plugin requires re-running `build.sh`
**and** `docker restart mc-eagler` (a config/secret change alone does not).

## 6. Auth service (mc-auth)

```bash
ssh -i "$KEY" ubuntu@161.153.110.196 'cd /home/ubuntu/minecraft/auth && \
  cp .env.example .env && nano .env && \
  docker build -t mc-auth:latest . && \
  docker run -d --name mc-auth --restart unless-stopped --memory=512m \
    --network server_default \
    -p 127.0.0.1:7900:7900 --env-file .env \
    -e RCON_HOST=mc-eagler -e RCON_PORT=25575 \
    -e CLIENTS_DIR=/clients -e GAMEDATA_DIR=/gamedata -e PRESENCE_PORT=25580 \
    -v mc_auth_data:/data \
    -v /home/ubuntu/minecraft/clients:/clients \
    -v /home/ubuntu/minecraft/server/data:/gamedata \
    -v /home/ubuntu/minecraft/server26/data:/gamedata26 \
    mc-auth:latest'
```
This is the **live** run command — keep it in sync if you change the container.
Key points beyond the basics:
- `--network server_default` puts mc-auth on the same Docker network as the
  `mc-eagler` game container so `RCON_HOST=mc-eagler` resolves (the control plane
  for world access + the Command Center).
- `512m` memory (not 256m): headroom for the Bun runtime + RCON queue.
- Three mounts: `mc_auth_data:/data` (SQLite user store), the read-only client at
  `/clients` (served by mc-auth), and the game's world data at `/gamedata`
  (`GAMEDATA_DIR`) for read access to live world state.
- `PRESENCE_PORT=25580` is where the auth plugin's presence feed is read.

`.env` holds the secrets + config: `MC_JWT_SECRET`, `RCON_PASSWORD`,
`PUBLIC_BASE_URL`, `RESEND_API_KEY`/`RESEND_FROM`, Telegram bot token, Google
client id/secret, `ADMIN_EMAILS`, and the initial `ALLOWLIST`. The `-e` flags
above are also set here in practice; they're shown explicitly so the run command
matches the live container exactly.

**Redeploying** after a code change (rebuild + recreate with the same command):
```bash
ssh -i "$KEY" ubuntu@161.153.110.196 'cd /home/ubuntu/minecraft/auth && \
  docker build -t mc-auth:latest . && \
  docker run --rm mc-auth:latest bun build src/index.ts --target bun --outfile /dev/null && \
  docker rm -f mc-auth && docker run -d --name mc-auth --restart unless-stopped --memory=512m --cpus=1.0 \
    --user 1001:1001 --security-opt no-new-privileges:true --cap-drop ALL \
    --network server_default -p 127.0.0.1:7900:7900 --env-file .env \
    -e RCON_HOST=mc-eagler -e RCON_PORT=25575 \
    -e CLIENTS_DIR=/clients -e GAMEDATA_DIR=/gamedata -e PRESENCE_PORT=25580 \
    -v mc_auth_data:/data -v /home/ubuntu/minecraft/clients:/clients:ro \
    -v /home/ubuntu/minecraft/server/data:/gamedata \
    -v /home/ubuntu/minecraft/server26/data:/gamedata26 mc-auth:latest'
```
The `bun build … /dev/null` step validates the image (catches import/syntax
errors) before the live container is swapped.

## 7. Caddy (the only shared-file edit — done safely)

The site is proxied by Cloudflare (orange cloud). Caddy's global `servers` block
therefore carries `trusted_proxies static <Cloudflare IP ranges>` and
`client_ip_headers CF-Connecting-IP`, so `{client_ip}` in the snippet is the real
visitor. Refresh the ranges from https://api.cloudflare.com/client/v4/ips if they change.
Free-plan Cloudflare caps request bodies at 100MB, so world uploads above that fail.

```bash
# back up first, append our block, validate, then graceful reload
ssh -i "$KEY" ubuntu@161.153.110.196 '
  sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date -u +%Y%m%d%H%M%S) &&
  awk "BEGIN{drop=0} /^minecraft\.mncoleman\.com \{/{drop=1} drop&&/^\}/{drop=0;next} !drop{print}" \
      /etc/caddy/Caddyfile > /tmp/Caddyfile.clean &&
  cat /tmp/Caddyfile.clean /home/ubuntu/minecraft/deploy/Caddyfile.snippet | sudo tee /etc/caddy/Caddyfile >/dev/null &&
  sudo MC_FWD_SECRET="$(cat /home/ubuntu/minecraft/.mc-fwd-secret)" caddy validate --config /etc/caddy/Caddyfile &&
  sudo systemctl reload caddy &&
  echo "RELOADED OK"'
```
`reload` is graceful — existing connections to the other 5 sites are not dropped.
If `caddy validate` fails, we STOP (the live config is untouched).
Note: Caddy must see `MC_FWD_SECRET` at runtime — set it in the caddy systemd
unit's environment (or hardcode the secret in the snippet) before reload.

## 8. Smoke test

- `https://minecraft.mncoleman.com` → bounces to `/login` (forward_auth working).
- Log in (Telegram/Google/email) → client loads → it auto-targets
  `wss://minecraft.mncoleman.com` → join the world; username is the one bound by
  the JWT (try changing it client-side — the plugin should overwrite/deny).
- From another network + a fresh browser, confirm an un-logged-in person cannot
  reach the world even with the wss URL (plugin denies: no/invalid cookie).

## Rollback

```bash
# Caddy: restore backup + reload
sudo cp /etc/caddy/Caddyfile.bak.<stamp> /etc/caddy/Caddyfile && sudo systemctl reload caddy
# Services: remove just our containers (nothing else touched)
docker rm -f mc-eagler mc-auth
```

---

## Second server: Minecraft 26 (`server26/` → `mc-eagler26`)

A separate Paper 26.2 server (Java 25) for the 26.x Eaglercraft client. It shares
only the login with the 1.8 stack: own compose project, own `server26/data`,
loopback `127.0.0.1:25570`, reached at `wss://minecraft.mncoleman.com/26`.
Nothing here touches `mc-eagler`.

1. **Ship** `server26/`, `plugin/`, `build-plugin-26/`, `auth/`, `clients/` (add
   `server26/data` to the rsync excludes alongside `data`).
2. **Stage the client** (78 MB, not in git):
   `bash clients/stage-client-26.sh ~/Downloads/eaglercraft-26.3-fe8f1237.html`
   (injects `joinServer: wss://minecraft.mncoleman.com/26`), then rsync `clients/26/`.
3. **Env**: `server26/.env` = same `MC_JWT_SECRET` + `MC_PRESENCE_TOKEN` as
   `server/.env`, plus its own `RCON_PASSWORD`. In `auth/.env` add
   `RCON26_PASSWORD=<that value>`. The 26 server is hidden in the panel until
   `RCON26_PASSWORD` is set.
4. **Start**: `cd server26 && bash scripts/fetch-plugins.sh && docker compose up -d`
   (joins the external `server_default` network so mc-auth reaches `mc-eagler26`).
5. **EaglerX config** (after first boot), same as step 4 above:
   `cp ../server/data/eagler_forwarding.secret data/` (same secret as Caddy), then in
   `data/plugins/EaglercraftXServer/`: `listener.yml` → `forward_ip: true`,
   `forward_ip_header: 'X-Forwarded-For'`, `forward_secret: true`,
   `require_tls: false`; `settings.yml` → `enable_authentication_events: true` and
   `voice_service.enable_voice_service: true` (in-game voice, as on 1.8; `ice_servers.yml` is the same file as 1.8's).
   Multiverse: in `data/plugins/Multiverse-Core/config.yml` set
   `enforce-gamemode: false` (as on 1.8), then `mv reload`. Otherwise every world
   change forces the world's gamemode (all 26 worlds are survival).
   Extras (Matthew, 2026-11-18): `pause_menu.yml` → `enable_custom_pause_menu: true`,
   the Server Info button becomes "Panel" (`button_mode_open_new_tab: true`,
   `button_mode_embed_file: false`, URL `https://minecraft.mncoleman.com/`), the
   Discord button becomes "Map" (`https://minecraft.mncoleman.com/map`), and both
   `icon_background_*` entries are blanked (they default to `test_image.png`).
   Server icon: `auth/public/email-logo.png` resized to 64×64, copied to
   `data/server-icon.png` and `data/plugins/EaglercraftXServer/server-icon.png`.
   Gamerules in every world (`execute in minecraft:<world> run gamerule …`):
   `keep_inventory true`, `players_sleeping_percentage 1`. New worlds need them too.
6. **Plugins**: `cd plugin && bash build.sh 26` (same EaglerJwtAuth jar as 1.8) and
   `cd build-plugin-26 && bash build.sh`; then `docker restart mc-eagler26`.
7. **mc-auth**: add `-v /home/ubuntu/minecraft/server26/data:/gamedata26` to the run
   command (GAMEDATA26_DIR defaults to `/gamedata26`; `RCON26_HOST` defaults to
   `mc-eagler26`). The first boot migrates the DB (worlds get a `server` column) —
   **back up `mc_auth_data` first** (`VACUUM INTO` a copy).
8. **Caddy**: add the `@ws26` block from `Caddyfile.snippet` *above* `@ws`,
   validate, reload.

9. **Pregenerate** each new world once (no generation lag while exploring):
   `docker exec mc-eagler26 rcon-cli -- chunky world <world>` → `chunky center <x> <z>`
   → `chunky radius 512` → `chunky start` (~2 min per world at ~30 chunks/s).
10. **Client**: re-run `stage-client-26.sh` after any client change; it also writes
   `index.html.br`/`.gz` sidecars that mc-auth serves precompressed (78 → 58 MB).

Rollback: `docker compose -f server26/docker-compose.yml down` (keeps
`server26/data`), remove `RCON26_PASSWORD` from `auth/.env` and recreate mc-auth
(panel hides 26), drop the `@ws26` block from Caddy.

Command dialect differences the panel handles for 26: Multiverse 5
(`mv create … --seed`, `mv modify <w> set difficulty`, `mv delete` → `mv confirm <otp>`,
`mvtp … --unsafe`), `execute as <p> at @s run …`, console `tp <p> x y z` wrapped in
`execute in minecraft:<world> run` (a bare console tp lands in the lobby's dimension), and extra worlds live under
`world/dimensions/minecraft/<name>`. Upload/Register stay 1.8-only.

## BlueMap (3D map behind the Map tab, 26 only)

- Jar: pinned in `server26/scripts/fetch-plugins.sh` (BlueMap 5.29, paper).
- Configs: **copy before the first start** (so BlueMap never generates default
  maps for every world, and never runs with live player markers):
  `sudo mkdir -p server26/data/plugins/BlueMap/maps && sudo cp server26/bluemap/*.conf server26/data/plugins/BlueMap/ && sudo chown -R 1001:1001 server26/data/plugins/BlueMap`
  then check `live-player-markers: false` in `data/plugins/BlueMap/plugin.conf`.
- `maps/<world>.conf` is written by mc-auth (`auth/src/bluemap.ts`) for each 26
  world whose Map is on; don't hand-edit it. `accept-download: true` in core.conf
  was accepted by the owner on 2026-11-17.
- Port 8100 is never published; mc-auth proxies it at `/map/3d/` (signed-in only,
  `live/players*` always refused). One render thread at priority 1: watch
  `rcon-cli tps` during a full render. `rcon-cli bluemap` shows progress.


## Retiring 1.8 (done 2026-11-18) and rolling it back

1.8 is **stopped, not deleted**. That freed about 3.8 GB of RAM.

**What was done**
1. `save-all flush` on 1.8, which had 0 players online. Then `cd server && docker compose stop`. The `mc-eagler` container stays in place, Exited.
   - Use `stop`, not `down`. This compose project owns the shared `server_default` network that mc-auth and mc-eagler26 join.
2. Backups, both root-only:
   - `/home/ubuntu/backups/mc18-server-20261118014534.tar.gz` holds the whole `server/` folder: data, worlds, plugins, `.env`. The sha256 is in the `.sha256` file next to it.
   - The panel DB is at `mc_auth_data:/backup-pre-retire18-20261118.sqlite`.
3. The panel hides 1.8 everywhere because `auth/.env` has `SERVER18_ENABLED=false`, read in `auth/src/servers.ts`. Its worlds, places and notes stay in the DB.

**Roll back**
1. Start the server: `cd /home/ubuntu/minecraft/server && docker compose start`, then wait for "Done".
   - If the container was ever removed, use `docker compose up -d` instead.
   - If `server/data` is gone, first restore it: `sudo tar xzf /home/ubuntu/backups/mc18-server-20261118014534.tar.gz -C /home/ubuntu/minecraft`.
2. Re-enable it in the panel: set `SERVER18_ENABLED=true` in `auth/.env` (or delete the line), then redeploy mc-auth (§6).
3. Check that the home page shows Play 1.8 again and that a 1.8 join works.
