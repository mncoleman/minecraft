# Browser Minecraft, self-hosted

Run your own private, browser-based Minecraft server. Players open a link, sign
in, and play in Chrome, Firefox, or Safari. Nobody needs to own Minecraft or
install anything.

This README is a complete, copy-pasteable walkthrough for standing the whole
stack up on your own Linux server with your own domain. It is written to be
followed by a person or an AI agent end to end. Commands use the placeholder
`play.example.com`; replace it with your domain everywhere.

The game itself is [Eaglercraft](https://eaglercraft.com/), a browser port of
Minecraft 1.8 that runs over WebSockets. This project wraps a real Paper server
with a custom login service so only people you invite can join, and so each
player's in-game name is locked to their account.

---

## What you get

- Browser Minecraft on your own domain, behind HTTPS.
- Invite-only access with email/password login (Google and Telegram optional).
- A web panel for players:
  - **Self-serve worlds** — players create their own worlds (per-user cap), and
    share build access by picking a friend (or any user, for admins) from a
    dropdown. Worlds can be created, registered, or uploaded as a `.zip`.
  - **Friends** — add someone by username (emails them an accept link) or a
    shareable friend link. "Who's online" is limited to your friends and people
    you share a world with, so playtime stays private (admins see everyone). The
    Friends tab shows a dot when you have pending requests.
  - **Command center** — teleport, gamemode, time, weather, difficulty, give, and
    saved locations / teleport history, run over RCON. World owners also get
    op-level slash commands **scoped to their own world** (LuckPerms world
    context, never global `/op`).
  - **Per-world notes**, a seed map link, and a "What's new" feed on the Play page.
  - **Feedback** — a form for general feedback, feature requests, and bug reports.
    Each submission DMs the owner over Telegram and is auto-filed as a labelled
    GitHub issue in the project repo (best-effort; the form still works without
    the GitHub token configured).
- Account management: change username and email (confirm by link), password
  reset, and transactional email via Resend.
- Admin tools: invite links (optionally emailed), role management, user deletion
  (which also revokes access and boots the user in-game), **world-ownership
  reassignment**, and **world deletion** behind a type-to-confirm modal (full
  teardown: live world, files, permissions, and DB).
- Security: a renamed or deleted account takes effect immediately in-game (the
  plugin resolves the current username from the account id and denies deleted
  accounts), not just on the website.
- Hard crash-isolation: the game runs in Docker under strict CPU/memory caps and
  binds only to loopback, so it can never take down anything else on the box.

---

## How it works

```
                     https://play.example.com
                     Reverse proxy (Caddy, auto-TLS :443)
                                |
              +-----------------+------------------+
              | WebSocket upgrade        everything else
              v                                    v
   reverse_proxy 127.0.0.1:25569      reverse_proxy 127.0.0.1:7900
   (game server, loopback only)       (mc-auth service)
              |                                    |
              v                                    v
   +----------------------+            +---------------------------+
   |  mc-eagler (Docker)  |            |  mc-auth (Docker)         |
   |  Paper 1.12.2        |            |  Bun + Hono               |
   |  + EaglerXServer     |  validates |  login + JWT cookie       |
   |  + ViaVersion chain  |<-- JWT  ---|  web panel                |
   |  + EaglerJwtAuth     |  cookie at |  SQLite user/world store  |
   |  + SkinsRestorer     |  handshake |  serves the browser client|
   +----------------------+            |  RCON bridge to the game  |
                                       +---------------------------+
```

Two security layers:

1. **mc-auth** authenticates the user and issues one signed JWT, stored as a
   same-site cookie on your domain. Unauthenticated visitors get the login page.
2. **EaglerJwtAuth** (a Bukkit plugin) is the real boundary. Because the login
   page and the game socket are the same site, the browser sends the JWT cookie
   on the WebSocket handshake. The plugin validates it and locks the in-game
   username to the authenticated identity. No valid cookie means the connection
   is refused, and it fails closed (no secret configured means everything is
   denied). Page-level gating alone is not enough because the socket is dialable
   on its own, so enforcement lives in the plugin.

The join is **transparent — no in-game password or code prompt**. The plugin
validates the cookie and checks that the username you connect with equals your
account name, then admits you with the handshake's `SKIP` response (online-mode
is off, so the offline UUID derives from that name — enforcing it here is what
keeps per-world build permissions tied to the right identity). If the names
don't match you're kicked with *"Set your in-game username to: &lt;name&gt;"* — set it
once under **Edit Profile → Username** and reconnect. (It does not force the
EaglercraftX plaintext-auth prompt, which would otherwise require a manual
confirmation click on every join and breaks click-to-play auto-connect.)

Paper runs 1.12.2 because that is the maintained Eaglercraft backend target. The
Via chain (ViaVersion, ViaBackwards, ViaRewind, Legacy-Support) downgrades it so
the 1.8 Eaglercraft client connects, and EaglerXServer adds the browser
WebSocket protocol on top.

---

## Prerequisites

- A Linux server (x86_64 or ARM64) with about 5 GB RAM free for the game.
- **Docker** and the **Docker Compose plugin**.
- A **domain name** you control, with DNS pointing an A record at the server.
- Ports **80 and 443** open to the internet. The game port stays on loopback and
  is never exposed.
- A **reverse proxy that terminates TLS**. This guide uses
  [Caddy](https://caddyserver.com/) (automatic Let's Encrypt). nginx or Traefik
  work too; replicate the routing in the Caddy step.

You do NOT need Bun, Java, or Maven installed on the host. The auth service runs
in a Bun container and the plugin builds inside a throwaway Maven container.

---

## Repository layout

```
server/    Dockerized Paper 1.12.2 game server.
           docker-compose.yml (hard CPU/mem caps, loopback bind),
           scripts/fetch-plugins.sh (pulls pinned, checksum-verified plugins),
           .env.example, data/ (created at runtime: worlds + plugins + configs).

auth/      mc-auth: the login + panel service (Bun + Hono, TypeScript).
           Dockerfile, src/, public/, .env.example.

plugin/    EaglerJwtAuth: the Bukkit plugin (Java 17, Maven) that validates the
           session JWT at the WebSocket handshake. build.sh builds it in Docker.

clients/   The staged Eaglercraft browser clients, already committed:
           wasm/ (WASM-GC build for Chrome/Firefox) and js/ (JS/TeaVM build for
           Safari/iOS), plus the launcher page index.html. mc-auth serves these.

deploy/    Caddyfile.snippet (the reverse-proxy block) and DEPLOY.md (the
           original opinionated runbook this README generalizes).
```

---

## Setup walkthrough

### 1. DNS

Point your domain at the server:

```
A   play.example.com   ->   YOUR.SERVER.IP
```

Verify before continuing:

```bash
dig +short play.example.com   # should print your server IP
```

### 2. Clone onto the server

```bash
git clone https://github.com/mncoleman/minecraft.git
cd minecraft
```

The browser clients are already committed under `clients/`, so you do not need to
source them separately. (To refresh them from upstream originals later, see
`clients/stage-clients.sh`.)

### 3. Generate secrets

You need four secrets. Generate them once and keep them safe:

```bash
openssl rand -hex 48   # MC_JWT_SECRET     (shared: auth service + game plugin)
openssl rand -hex 24   # RCON_PASSWORD     (shared: game server + auth service)
openssl rand -hex 24   # MC_PRESENCE_TOKEN (shared: game plugin + auth service)
openssl rand -hex 24   # MC_FWD_SECRET     (shared: reverse proxy + EaglerXServer)
```

`MC_JWT_SECRET` must be byte-for-byte identical in the game container and the
auth service, because both sign and validate the same session token. Likewise
`RCON_PASSWORD` and `MC_PRESENCE_TOKEN` must match across the two services.

### 4. Configure and start the game server

```bash
cd server
cp .env.example .env
```

Edit `server/.env` so it contains the shared secrets:

```
MC_JWT_SECRET=<the hex from step 3>
RCON_PASSWORD=<the hex from step 3>
MC_PRESENCE_TOKEN=<the hex from step 3>
```

Review `server/docker-compose.yml`. It already:
- runs `itzg/minecraft-server:java17` as `mc-eagler`,
- caps memory and CPU and binds the game port to `127.0.0.1:25569` only,
- enables RCON on the in-container port 25575 (never published),
- runs as uid/gid 1001 so files in `./data` are owned by your shell user.

Fetch the plugins (pinned versions, SHA-256 verified) and start it:

```bash
bash scripts/fetch-plugins.sh
docker compose up -d
docker compose logs -f      # wait for "Done (x.xxs)! For help, type help"
```

The first boot generates `data/plugins/EaglercraftXServer/` configs and the
world. Stop tailing once it is up.

### 5. Patch the EaglerXServer config

After the first boot, edit the EaglerXServer config under
`server/data/plugins/EaglercraftXServer/` (exact filenames vary by version, for
example `settings.yml` / `listener.yml`; verify what your version wrote) and set:

- `enable_tls = false`            (the reverse proxy terminates TLS)
- listener bind / inject address  = `127.0.0.1:25565`
- `forward_ip = true`
- `forward_ip_header = "X-Forwarded-For"`
- `forward_secret = true` and set the secret value to your `MC_FWD_SECRET`
  (this is also written to `data/eagler_forwarding.secret` depending on version)
- `enable_authentication_events = true`   (REQUIRED; the JWT plugin is inert
  without it)

Then restart the game container:

```bash
docker compose restart mc-eagler
ss -tlnp | grep 25569     # must show 127.0.0.1:25569 only, never 0.0.0.0
```

### 6. Build the auth plugin

This compiles `EaglerJwtAuth` in a throwaway Maven container and drops the jar
into the game server's plugins folder:

```bash
cd ../plugin
bash build.sh             # -> ../server/data/plugins/mc-eagler-auth.jar
cd ../server && docker compose restart mc-eagler && cd ..
```

The plugin reads `MC_JWT_SECRET` and `MC_PRESENCE_TOKEN` from the game
container's environment (set in `server/.env`). See `plugin/src/.../config.yml`
for the defaults (cookie name `mc_session`, issuer `mc-auth`, audience =
your domain).

### 7. Configure and run the auth service

```bash
cd auth
cp .env.example .env
```

Edit `auth/.env`. The important keys:

```
PUBLIC_BASE_URL=https://play.example.com
JWT_AUDIENCE=play.example.com
MC_JWT_SECRET=<same as server/.env>
RCON_PASSWORD=<same as server/.env>
MC_PRESENCE_TOKEN=<same as server/.env>
ADMIN_EMAILS=you@example.com           # gets the /admin panel + is_admin
ALLOWLIST=email:you@example.com:YourName   # seeds the first allowed account
# Optional providers and email (see Customizing below):
# GOOGLE_CLIENT_ID= / GOOGLE_CLIENT_SECRET=
# TELEGRAM_BOT_TOKEN= / TELEGRAM_BOT_USERNAME=
# RESEND_API_KEY= / RESEND_FROM=
```

Build the image:

```bash
docker build -t mc-auth:latest .
```

The auth container must share a Docker network with the game container so it can
reach RCON at `mc-eagler:25575`. The compose project created one named
`server_default`:

```bash
docker network ls | grep server     # confirm the network name
```

Named Docker volumes are created root-owned; since the container runs as uid 1001
(hardened, non-root), initialize the data volume's ownership once:

```bash
docker run --rm -v mc_auth_data:/data alpine chown -R 1001:1001 /data
```

Now run it (this is the full hardened command; adjust absolute paths to your
clone location):

```bash
docker run -d --name mc-auth --restart unless-stopped \
  --memory=512m --cpus=1.0 \
  --user 1001:1001 --security-opt no-new-privileges:true --cap-drop ALL \
  --network server_default -p 127.0.0.1:7900:7900 \
  --env-file "$PWD/.env" \
  -e CLIENTS_DIR=/clients -e GAMEDATA_DIR=/gamedata -e PRESENCE_PORT=25580 \
  -v "$PWD/../clients:/clients:ro" \
  -v "$PWD/../server/data:/gamedata" \
  -v mc_auth_data:/data \
  mc-auth:latest

docker logs -f mc-auth     # expect: "mc-auth listening on :7900"
```

What the mounts do: `/clients` (read-only) is the browser client mc-auth serves;
`/gamedata` is the game's `server/data` so world uploads and RCON-driven features
work; `mc_auth_data` holds the SQLite user store so accounts survive redeploys.

### 8. Put it behind the reverse proxy

The proxy routes by request type: WebSocket upgrades go to the game listener,
everything else goes to mc-auth (which serves both the login/panel and the static
client). Use `deploy/Caddyfile.snippet` as the template. Append a block like this
to your Caddyfile, replacing the domain and the secret:

```
play.example.com {
	encode zstd gzip

	@ws {
		header Connection *Upgrade*
		header Upgrade    websocket
	}
	handle @ws {
		reverse_proxy 127.0.0.1:25569 {
			header_up X-Forwarded-For {remote_host}
			header_up X-Eagler-Secret "<your MC_FWD_SECRET>"
		}
	}

	handle {
		reverse_proxy 127.0.0.1:7900
	}
}
```

The `X-Eagler-Secret` value must equal the EaglerXServer `forward_secret` from
step 5, so nobody can bypass the proxy and spoof their forwarded IP. Validate and
reload:

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

### 9. First sign-in

`ALLOWLIST` from step 7 seeded your account on first boot. Open
`https://play.example.com`, you will be sent to the login page. Sign in with the
allowlisted email; the first email sign-in sets that account's password. Because
`ADMIN_EMAILS` includes you, the Admin tab appears.

### 10. Verify end to end

- `https://play.example.com` redirects to the login page.
- After signing in, the client loads and auto-connects to the world.
- Set your in-game username to match (the client prompts you); the plugin locks
  it to your account.
- From a fresh browser with no session, confirm you cannot reach the world even
  with the `wss://` URL (the plugin denies it).

You now invite others from the Admin tab: it generates an invite link (optionally
emailed) and they pick their own username and password.

---

## Updating and redeploying

- **Browser client** (`clients/`): served from the read-only mount, so a `git
  pull` (or rsync of the files) is enough; no restart needed.
- **Auth service** (`auth/`): the source is baked into the image, so rebuild and
  recreate the container with the same run command from step 7:
  ```bash
  cd auth && docker build -t mc-auth:latest . && \
  docker rm -f mc-auth && docker run -d ...   # the full command from step 7
  ```
  Bun runs the TypeScript directly. To catch import/syntax errors before swapping
  the live container, validate the freshly built image first:
  ```bash
  docker run --rm mc-auth:latest bun build src/index.ts --target bun --outfile /dev/null
  ```
- **Plugin** (`plugin/`): `bash plugin/build.sh` then
  `docker compose restart mc-eagler`.

---

## Customizing

- **Branding**: the panel brand lives in `auth/src/layout.ts`, the login page in
  `auth/public/login.html`, and the launcher in `clients/index.html`. Email
  templates and the logo (`auth/public/email-logo.png`, served at
  `/email-logo.png`) are in `auth/src/mailer.ts`.
- **Email (Resend)**: set `RESEND_API_KEY` and `RESEND_FROM` in `auth/.env`.
  Sending requires a domain verified in Resend (DKIM); until then the mailer
  no-ops and logs what it would have sent, and the app still runs. Used for email
  confirmation, password reset, and invite-by-email.
- **Google login**: create an OAuth web client, set the redirect URI to
  `https://play.example.com/auth/google/callback`, and set `GOOGLE_CLIENT_ID` /
  `GOOGLE_CLIENT_SECRET`.
- **Telegram login**: create a bot with @BotFather, set its domain, and set
  `TELEGRAM_BOT_TOKEN` / `TELEGRAM_BOT_USERNAME`.
- **Game settings**: tune `server/docker-compose.yml` (gamemode, max players,
  view distance, memory) and `server/data/server.properties` after first run.

---

## Configuration and secrets reference

No secrets are committed. Each service reads its config from a runtime `.env`
that is gitignored. See `server/.env.example` and `auth/.env.example`.

| Secret | Where it lives | Must match across |
|--------|----------------|-------------------|
| `MC_JWT_SECRET` | `server/.env`, `auth/.env` | game plugin + auth service |
| `RCON_PASSWORD` | `server/.env`, `auth/.env` | game server + auth service |
| `MC_PRESENCE_TOKEN` | `server/.env`, `auth/.env` | game plugin + auth service |
| `MC_FWD_SECRET` | reverse proxy block + EaglerXServer config | proxy + game |

---

## Troubleshooting

- **Login works but the world will not connect**: confirm
  `enable_authentication_events = true` and that the `mc-eagler-auth.jar` is the
  current build (a stale jar is the classic cause). Check `docker compose logs
  mc-eagler` for the plugin loading.
- **Connection times out through the proxy**: disable WebSocket compression on
  the game listener (set the EaglerXServer websocket compression level to 0);
  some proxies mangle compressed WASM client frames.
- **auth container cannot reach RCON**: it must be on the same Docker network as
  `mc-eagler` (`--network server_default`) and share the exact `RCON_PASSWORD`.
- **auth container restarts or cannot write**: the `mc_auth_data` volume and
  `server/data` must be writable by uid 1001 (see the chown in step 7).
- **Everyone gets kicked even with a valid login**: keep the Paper whitelist OFF
  (`ENABLE_WHITELIST=FALSE`); the JWT plugin is the sole admission gate.
- **Game port is reachable publicly**: it must bind `127.0.0.1` only. Re-check
  the compose `ports` mapping and your firewall (keep 22/80/443 only).

---

## Credits

Built on these projects:

- [EaglercraftXServer](https://github.com/lax1dude/eaglerxserver) and the
  [Eaglercraft-Server-Paper](https://github.com/Eaglercraft-Templates/Eaglercraft-Server-Paper) template
- [ViaVersion / ViaBackwards / ViaRewind](https://github.com/ViaVersion)
- [itzg/docker-minecraft-server](https://github.com/itzg/docker-minecraft-server)
- [PaperMC](https://papermc.io/), [Multiverse](https://github.com/Multiverse),
  [WorldGuard / WorldEdit](https://enginehub.org/),
  [LuckPerms](https://luckperms.net/), [Caddy](https://caddyserver.com/),
  [Bun](https://bun.sh/), [Hono](https://hono.dev/)

This is a personal project shared as a reference for running Eaglercraft behind
real authentication. Use it at your own risk and review the security model before
exposing anything to the internet.
