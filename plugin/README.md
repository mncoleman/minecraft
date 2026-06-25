# EaglerJwtAuth plugin

EaglercraftXServer (Bukkit) plugin that turns the mc-auth session into the
in-game identity. On the Eaglercraft WebSocket handshake the browser sends its
same-site `mc_session` cookie (the JWT minted by mc-auth) as the HTTP `Cookie`
header. This plugin reads it via `getWebSocketHeader(HEADER_COOKIE)`, validates
the HS256 signature + `iss`/`aud`/`exp`, then **locks the in-game username** to
the authenticated identity (`setProfileUsername`) and allows the login. No valid
cookie → connection denied. This is the real security boundary (the Caddy page
gate is only UX).

The locked name is the account's **current** username, resolved from the JWT's
stable account id (`sub`) by calling mc-auth's internal endpoint, **not** the
name baked into the (possibly stale) token. So a rename takes effect in-game
immediately, the old name stops working, and a **deleted** account is denied
(mc-auth returns 404 for an unknown id → deny). The lookup fails **open** to the
JWT name only on a transient error, so an mc-auth hiccup never locks players out.
Disable it by leaving `mc-auth-url` blank (the plugin then trusts the JWT name).

## Requirements / config

- EaglercraftXServer **v1.1.0** installed, with `enable_authentication_events = true`
  in its `settings.cfg` (default is false — the plugin is inert without it).
- `MC_JWT_SECRET` env var on the game container = mc-auth's secret (preferred),
  or set `jwt-secret` in `config.yml`.
- `MC_PRESENCE_TOKEN` env var (shared with mc-auth) — bearer for the current-
  username lookup against mc-auth. Without it, the resolver is disabled and the
  plugin trusts the JWT name.
- Fails **closed**: if no JWT secret is configured, every connection is denied.

`config.yml` keys: `cookie-name` (mc_session), `issuer` (mc-auth),
`audience` (minecraft.mncoleman.com), `leeway-seconds`, `kick-message`,
`mc-auth-url` (e.g. `http://mc-auth:7900`, over the internal Docker network —
for resolving the current username / denying deleted accounts; blank disables it),
`presence-port` / `presence-token` (the who's-online feed mc-auth reads).

## Build

No local Maven/JDK needed — builds in a container and drops the jar into the
game server's plugins folder:

```bash
bash build.sh   # -> ../server/data/plugins/mc-eagler-auth.jar
```

Compiles against `net.lax1dude.eaglercraft.backend:api-bukkit:1.1.0` (Java 17).
The JWT verifier uses the JDK for HMAC/Base64 and a shaded+relocated Gson for
JSON, so the jar is self-contained.

## Verified

Interop-tested against spec-correct HS256 tokens (what mc-auth's `jose` emits):
valid → accepted with locked username; expired / wrong-audience / tampered-sig →
all rejected.
