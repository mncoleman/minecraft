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
  docker rm -f mc-auth && docker run -d --name mc-auth --restart unless-stopped --memory=512m \
    --network server_default -p 127.0.0.1:7900:7900 --env-file .env \
    -e RCON_HOST=mc-eagler -e RCON_PORT=25575 \
    -e CLIENTS_DIR=/clients -e GAMEDATA_DIR=/gamedata -e PRESENCE_PORT=25580 \
    -v mc_auth_data:/data -v /home/ubuntu/minecraft/clients:/clients \
    -v /home/ubuntu/minecraft/server/data:/gamedata mc-auth:latest'
```
The `bun build … /dev/null` step validates the image (catches import/syntax
errors) before the live container is swapped.

## 7. Caddy (the only shared-file edit — done safely)

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
