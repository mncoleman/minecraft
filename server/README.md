# minecraft.mncoleman.com — private Eaglercraft server

Browser-based Minecraft (Eaglercraft) for a private group, hosted free on the
Oracle ARM box (`n8n-arm`, `161.153.110.196`), behind the existing Caddy reverse
proxy, with custom Telegram / Google / email auth controlling who gets in.

Nobody needs to own Minecraft or install anything — friends open a link in Chrome
/ Firefox / Safari and play.

---

## Architecture

```
                          minecraft.mncoleman.com  (Caddy, auto-TLS :443)
                                      │
            ┌─────────────────────────┴───────────────────────────┐
            │ (WebSocket upgrade?)                  (everything else)
            ▼                                                       ▼
   reverse_proxy 127.0.0.1:25569                        reverse_proxy 127.0.0.1:7900
   + X-Forwarded-For + X-Eagler-Secret                  (mc-auth service)
            │                                                       │
            ▼                                          ┌────────────┴───────────┐
   ┌──────────────────┐                                │  Telegram / Google /   │
   │  mc-eagler        │  Docker, capped 4G/2cpu        │  email login           │
   │  Paper 1.12.2     │  127.0.0.1:25569 only          │  → signs JWT cookie    │
   │  + EaglerXServer  │                                │  (SameSite=Lax) on     │
   │  + Via* chain     │◄──── validates JWT cookie ─────│  minecraft domain      │
   │  + auth plugin    │      at WS handshake,          │  → serves gated client │
   │  + SkinsRestorer  │      locks username            │  (WASM-GC + JS builds) │
   └──────────────────┘                                │  SQLite allowlist      │
                                                        └────────────────────────┘
```

### Why each piece

- **Paper 1.12.2 + Via\* chain** — the maintained, officially-templated Eaglercraft
  backend. The Via chain (ViaVersion → ViaBackwards → ViaRewind → Legacy-Support)
  downgrades 1.12.2 so the **1.8 Eaglercraft client** connects. EaglerXServer adds
  the browser WebSocket protocol and protocol-detects WS vs raw TCP on one port.
- **Docker with hard caps** — crash isolation. A JVM leak or runaway farm is
  contained to 4G/2cpu; the 21 other production containers are unaffected. The
  listener is published to `127.0.0.1` only, so it is never publicly reachable.
- **Custom auth (mc-auth)** — Eaglercraft has **no Mojang authentication**, so
  usernames are self-chosen and spoofable. We gate access with our own identity:
  - Telegram (reuses the artifacts.mncoleman.com pattern),
  - Google OAuth,
  - email + password,
  all minting **one signed JWT** stored as a `SameSite=Lax` cookie on the
  `minecraft.mncoleman.com` domain.
- **JWT-validation plugin** — the real security boundary. Because the login page
  and the game socket are the same site, the browser **auto-sends the JWT cookie
  on the WebSocket handshake**. The plugin validates it (signature, expiry,
  allowlist) and **locks the in-game username** to the authenticated identity via
  EaglerXServer's auth-event API (`enable_authentication_events: true`). Page-level
  auth alone is NOT enough (the socket is separately dialable), so enforcement
  lives here.
- **Self-contained SQLite user store** — deliberately NOT Supabase, even though
  Supabase runs on the box. Keeping the user/allowlist store inside the mc-auth
  container means the Minecraft stack has zero runtime coupling to core infra.

### Decisions locked in (validated against current sources, June 2026)

- ❌ **NOT** EaglerXVelocity / EaglerXBungee — deprecated by lax1dude. Use the
  unified **EaglerXServer** plugin directly on Paper (no separate proxy for a
  small server).
- ✅ Client stays **1.8.8**; backend **1.12.2** + Via chain.
- ✅ Serve **both** clients: WASM-GC (Chrome 137+/Firefox 139+, fastest) **and**
  a JS/TeaVM build (Safari / iPhone / iPad — WASM-GC needs JSPI, only in Safari 27
  beta).
- ✅ Caddy terminates TLS; EaglerXServer `enable_tls=false` (its default).
- ✅ `forward_ip=true` + `forward_secret=true` so nobody can bypass Caddy and
  spoof their IP / hit the backend directly.
- ❌ **NOT** AuthMe — replaced by the JWT plugin. (Modern AuthMe dropped 1.8 anyway.)

---

## Repo layout

```
server/
  docker-compose.yml        # isolated, capped game server (this dir)
  scripts/fetch-plugins.sh  # pulls the tested-together plugin jars
  data/                     # (created at runtime) world + plugins + configs
  README.md                 # this file
auth/                       # mc-auth service (Bun + Hono): login, panel, worlds,
                            #   friends, admin tools, RCON control plane
plugin/                     # EaglerXServer JWT plugin (Java/Maven): the in-game
                            #   auth boundary (resolves current username, denies
                            #   renamed-away / deleted accounts)
clients/                    # staged WASM-GC + JS clients + launcher page
deploy/                     # Caddy snippet + DEPLOY.md runbook
```

---

## Inputs needed from Matthew (for the deploy phase)

1. **DNS** — a Namecheap A record: `minecraft` → `161.153.110.196`.
2. **Telegram** — the bot token + allowed user ID(s) to authorize (same pattern as
   the artifacts Worker).
3. **Google OAuth** — a Google Cloud OAuth 2.0 Client ID + Secret, with redirect
   URI `https://minecraft.mncoleman.com/auth/google/callback`.
4. The initial **allowlist** — which emails / Telegram IDs / usernames are allowed.

Secrets are runtime env only; none are committed.

---

## Deploy (careful, staged — nothing touches the other containers)

> Full step-by-step runbook lives in `deploy/DEPLOY.md` (being written). Summary:

1. `rsync` this tree to `/home/ubuntu/minecraft/` on the box (SSH key).
2. `bash scripts/fetch-plugins.sh` → game plugins.
3. `docker compose up -d` the game server; **first run generates configs**, then
   apply the EaglerXServer config patch (tls off, `127.0.0.1` bind, forward_ip +
   forward_secret, `enable_authentication_events: true`).
4. Build + drop in the auth plugin jar; restart the game container only.
5. `docker compose up -d` the mc-auth service.
6. Append the `minecraft.mncoleman.com` block to `/etc/caddy/Caddyfile`,
   `sudo caddy validate`, `sudo systemctl reload caddy` — graceful, never drops
   the other 5 sites.
7. Verify: `ss -tlnp` shows the game port on `127.0.0.1` only; firewall unchanged
   (22/80/443); smoke-test the full wss path from a fresh browser on another
   network.

Sources that informed this design:
- [EaglercraftXServer (lax1dude)](https://github.com/lax1dude/eaglerxserver) · [CONFIG.md](https://github.com/lax1dude/eaglerxserver/blob/master/CONFIG.md)
- [Eaglercraft-Server-Paper template](https://github.com/Eaglercraft-Templates/Eaglercraft-Server-Paper)
- [ViaRewind](https://github.com/ViaVersion/ViaRewind) · [ViaBackwards](https://hangar.papermc.io/ViaVersion/ViaBackwards)
- [itzg/minecraft-server](https://github.com/itzg/docker-minecraft-server)
