# EaglerJwtAuth plugin

EaglercraftXServer (Bukkit) plugin that turns the mc-auth session into the
in-game identity. On the Eaglercraft WebSocket handshake the browser sends its
same-site `mc_session` cookie (the JWT minted by mc-auth) as the HTTP `Cookie`
header. This plugin reads it via `getWebSocketHeader(HEADER_COOKIE)`, validates
the HS256 signature + `iss`/`aud`/`exp`, then **locks the in-game username** to
the authenticated identity (`setProfileUsername`) and allows the login. No valid
cookie → connection denied. This is the real security boundary (the Caddy page
gate is only UX).

## Requirements / config

- EaglercraftXServer **v1.1.0** installed, with `enable_authentication_events = true`
  in its `settings.cfg` (default is false — the plugin is inert without it).
- `MC_JWT_SECRET` env var on the game container = mc-auth's secret (preferred),
  or set `jwt-secret` in `config.yml`.
- Fails **closed**: if no secret is configured, every connection is denied.

`config.yml` keys: `cookie-name` (mc_session), `issuer` (mc-auth),
`audience` (minecraft.mncoleman.com), `leeway-seconds`, `kick-message`.

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
