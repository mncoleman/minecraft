# Minecraft (browser, private)

A private, browser-based Minecraft platform. Players open a link in Chrome,
Firefox, or Safari and play. Nobody needs to own Minecraft or install anything.
Access is invite-only and every account is gated by a custom authentication
layer.

Live at https://minecraft.mncoleman.com.

## What it is

The game is [Eaglercraft](https://eaglercraft.com/), a browser port of Minecraft
1.8 that runs over WebSockets. It is backed by a real Paper server, wrapped in a
custom login system so that only authorized people can join, and so that each
player's in-game username is locked to their account.

The whole thing runs in Docker on a single ARM host, behind a Caddy reverse
proxy that terminates TLS. It is isolated by hard resource caps so it cannot
disturb the other services on the same box.

## How access works

Eaglercraft has no Mojang authentication, so usernames are self-chosen and would
otherwise be spoofable. Admission is controlled in two layers:

1. A login service (mc-auth) authenticates the user (email and password, with
   optional Google and Telegram providers) and mints a single signed JWT, stored
   as a same-site cookie on the minecraft domain. Unauthenticated visitors are
   bounced to the login page and cannot even load the client.
2. A server plugin (EaglerJwtAuth) is the real security boundary. Because the
   login page and the game socket are the same site, the browser automatically
   sends the JWT cookie on the WebSocket handshake. The plugin validates the
   signature, issuer, audience, and expiry, then locks the in-game username to
   the authenticated identity. No valid cookie means the connection is denied.
   The plugin fails closed: if no secret is configured, every connection is
   refused.

Page-level gating alone is not sufficient, because the game socket can be dialed
independently, so enforcement lives in the plugin.

## Architecture

```
                 https://minecraft.mncoleman.com
                        Caddy (auto-TLS :443)
                                |
              +-----------------+------------------+
              | WebSocket upgrade        everything else
              v                                    v
   reverse_proxy 127.0.0.1:25569      reverse_proxy 127.0.0.1:7900
   (game server, loopback only)       (mc-auth service)
              |                                    |
              v                                    v
   +----------------------+            +---------------------------+
   |  mc-eagler           |            |  mc-auth (Bun + Hono)     |
   |  Paper 1.12.2        |            |  login + JWT minting      |
   |  + EaglerXServer     |  validates |  web panel                |
   |  + ViaVersion chain  |<-- JWT  ---|  SQLite user/world store  |
   |  + EaglerJwtAuth     |  cookie at |  RCON bridge to game      |
   |  + SkinsRestorer     |  handshake |  serves the gated client  |
   +----------------------+            +---------------------------+
```

The game listener is published to 127.0.0.1 only, so it is never directly
reachable from the public internet. Only Caddy can reach it, over the wss reverse
proxy. The host firewall stays at ports 22, 80, and 443.

Paper runs version 1.12.2 because that is the maintained Eaglercraft backend
target. The Via chain (ViaVersion, ViaBackwards, ViaRewind, Legacy-Support)
downgrades it so the 1.8 Eaglercraft client connects, and EaglerXServer adds the
browser WebSocket protocol on top.

## Repository layout

```
clients/   Staged Eaglercraft browser clients and the play page.
           A WASM-GC build for Chrome and Firefox, and a JS/TeaVM build for
           Safari and iOS. stage-clients.sh assembles the tree.

auth/      mc-auth, the login and panel service (Bun + Hono, TypeScript).
           Authentication providers, JWT sessions, the web panel, the SQLite
           user and world store, and the RCON bridge to the game server.

plugin/    EaglerJwtAuth, the Bukkit plugin (Java 17, Maven) that validates the
           session JWT at the WebSocket handshake and locks the username.

server/    The Dockerized Paper 1.12.2 game server: compose file with hard
           resource caps, and the plugin fetch script.

deploy/    Caddy reverse-proxy snippet and the deploy runbook (DEPLOY.md).
```

## Web panel

After logging in, players and admins get a small web panel served by mc-auth:

- Play: launches the gated client.
- Worlds: create a new world, import a world from a .zip upload, share and
  unshare worlds with other users, hop between worlds, and use a per-world
  console, notes, and saved locations.
- Admin: create invite links (email is optional, so an open link lets the
  invitee choose their own email, username, and password), manage user roles,
  and view every world on the server.
- Profile: change password.
- Guide: in-app help.

## Tech stack

- Game server: Paper 1.12.2, EaglerXServer, the ViaVersion downgrade chain,
  SkinsRestorer, on the itzg/minecraft-server image (Java 17).
- Auth service: Bun, Hono, SQLite (bun:sqlite), jose for JWT, argon2id for
  password hashing.
- Plugin: Java 17, Maven, EaglercraftXServer api-bukkit.
- Edge and runtime: Caddy (automatic TLS, reverse proxy) and Docker.
- Host: a single ARM64 server.

## Configuration and secrets

No secrets are committed. Each service reads its configuration from a runtime
.env file, which is gitignored. See auth/.env.example and server/.env.example
for the required keys. The most important is MC_JWT_SECRET, a shared HS256 secret
that must be byte-for-byte identical between mc-auth and the game container, since
both sign and validate the same session tokens.

## Deploy

The full step-by-step runbook is in deploy/DEPLOY.md. In short: sync the tree to
the host, bring up the capped game container, build and drop in the auth plugin
jar, build and run the mc-auth container, then append the site block to the Caddy
config and reload it gracefully.

## Status

This is a personal project for a private group, not a general-purpose product.
It is shared publicly as a reference for running Eaglercraft behind real
authentication.
