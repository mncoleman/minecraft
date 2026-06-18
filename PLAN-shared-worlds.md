# V-PRD: Multi-World Shared-Building Platform on `minecraft.mncoleman.com`

**Status:** Architecture locked, ready to build in phases.
**Date:** 2026-06-17
**Owner:** Matthew Coleman (mncoleman003@gmail.com) — server owner + sole bootstrap admin.
**Target stack (ground truth, design FOR this):** Oracle Cloud Ampere A1 (ARM64) · Ubuntu 24.04 · Docker · Paper 1.12.2 (Java 17) · EaglercraftXServer v1.1.0 · Via* chain · SkinsRestorer · Caddy (auto-TLS) · `mc-auth` (Bun + Hono + SQLite).

> This document synthesizes five verified component designs (multiworld, userlock, permissions, panel, presence, worldconv) and folds in every adversarial-verification correction. Where verifiers **REFUTED** or flagged **UNCERTAIN** a claim, the plan adopts the corrected position and calls it out inline (look for **[CORRECTION]** and **[UNVERIFIED]** tags).

---

## 1. Overview & Goals

We are turning the single-world private Eaglercraft server into a **multi-world shared-building platform**: several persistent, always-on worlds on one Paper backend, with a web panel (extension of `mc-auth`) that manages who can build where.

**Functional goals**

1. **Multiple persistent, always-on worlds** on the one server — worlds keep ticking/saving even when the owner is offline, so people can build at any time.
2. **Per-world access == can build.** There is exactly one role per world: if you can enter it, you can build in it. No view-only tier.
3. **Two-tier sharing rights:**
   - Only the **owner** (mncoleman003@gmail.com) and **admins** he designates can **INVITE new users** onto the server.
   - **Any existing user** can **SHARE their own worlds** with other **existing** users. Sharing can never pull a new person onto the server.
4. **Username is bound (locked) to the account.** Per-world permissions are keyed on the in-game username, so the username MUST be unspoofable. This is the security keystone of the whole platform.
5. **Web panel** (extend `mc-auth`): roster of users + their Minecraft usernames; invites (sent / accepted); bidirectional shares ("worlds I shared out" / "worlds shared with me"); who is online right now + which world they are in; one-click "hop into a world" (optionally next to a specific person).
6. **Seed the first world from the existing `cliff build.epk`** and support future world uploads.

**Non-goals / explicitly out of scope**

- No Velocity/Bungee proxy. EaglercraftXServer is installed **directly on Paper** — there is one game JVM, so "join a world" is a **teleport**, never a server-transfer.
- No replacement of any deployed component. We extend, we do not rip-and-replace.
- No public exposure of RCON or any new control-plane port. The crash-isolation + loopback-only contract is preserved.

---

## 2. Architecture

### 2.1 Component map

```
                          Internet (browser, Eaglercraft WASM/JS client)
                                         │  https / wss
                                         ▼
                         ┌───────────────────────────────┐
                         │   Caddy  (host, auto-TLS)       │
                         │   minecraft.mncoleman.com       │
                         └───────────────┬───────────────┘
              WS-Upgrade (game)           │            everything else (login, panel)
        + X-Forwarded-For + X-Eagler-Secret│
                          ▼                ▼
        127.0.0.1:25569 (game listener)   127.0.0.1:7900 (mc-auth HTTP)
                          │                            │
        ┌─────────────────┴──────────┐      ┌──────────┴───────────────────────────┐
        │ Container: mc-eagler        │      │ Container: mc-auth (Bun+Hono, 256MB)  │
        │ Paper 1.12.2 / Java 17      │      │  • email/pw login, issues mc_session  │
        │ 4G RAM / 2 CPU (hard caps)  │      │    JWT (HS256, cookie)                │
        │                             │      │  • serves /wasm /js clients           │
        │ Plugins:                    │      │  • SQLite: users, allowlist,          │
        │  • EaglercraftXServer 1.1.0 │      │    + NEW worlds / world_shares /      │
        │  • Via* chain               │      │    invites / pending_destination      │
        │  • SkinsRestorer            │      │  • Admin UI (/admin) + User UI (/panel)│
        │  • EaglerJwtAuth (custom)   │      │  • rcon.ts client + presence client   │
        │     └ locks username (JWT)  │      └──────────┬───────────────────────────┘
        │     └ join-routing teleport │                 │  RCON (Source proto, TCP)
        │  • Multiverse-Core 2.5.x    │◄────────────────┘  + presence HTTP (Bearer)
        │  • WorldGuard 6.2.2         │      over PRIVATE docker net "mc-internal"
        │  • WorldEdit 6.1.x (dep)    │      (NEVER published to host/internet)
        │  • LuckPerms 5.5.x          │
        │                             │
        │  RCON :25575 (in-container, │
        │   UNpublished)              │
        │  Presence HTTP :25580       │
        │   (in-container, UNpublished│
        │    — Phase C only)          │
        └─────────────────────────────┘
```

### 2.2 How a player reaches a world (request path)

1. Browser loads the client from `mc-auth` (`/wasm`, `/js`) after email/password login → holds `mc_session` JWT cookie.
2. Browser opens `wss://minecraft.mncoleman.com`. Caddy forwards the WS upgrade to `127.0.0.1:25569` with `X-Forwarded-For` + `X-Eagler-Secret`.
3. EaglercraftXServer fires the auth handshake. **EaglerJwtAuth** reads the `Cookie` header, validates the HS256 JWT, and **locks the in-game username to the JWT username** (Phase A change — today it only SKIP-admits).
4. After login the plugin (on a deferred main-thread tick) **teleports the player into their home / permitted world**.
5. Build permission inside that world is enforced by **WorldGuard `__global__` passthrough=deny** + per-world membership, with **Multiverse `enforceaccess`** gating entry. Both are driven by `mc-auth` over RCON.

### 2.3 Source of truth & reconciliation

- **`mc-auth` SQLite is authoritative** for users, worlds, shares, invites.
- The game server is a **projection** of that state. Every grant/revoke/create/delete is pushed over RCON.
- A **reconciler** runs on `mc-auth` boot (and on a timer) to re-push all `world_shares` grants and verify each world exists, so the live server self-heals from drift or a missed RCON command.

---

## 3. Plugin + Version List (verified for Paper 1.12.2 / Java 17 / EaglercraftXServer 1.1.0)

| Plugin | Version to pin | Role | Verification notes |
|---|---|---|---|
| **EaglercraftXServer** | **v1.1.0** (deployed) | WS transport + auth-event API | CONFIRMED: native API target is Paper 1.12.2, Java 17+. Already installed. |
| **ViaVersion + ViaBackwards + ViaRewind (+ Legacy)** | as in `fetch-plugins.sh` template set | 1.8 clients ↔ 1.12.2 server | CONFIRMED compatible; already installed. Keep the template's tested-together set. |
| **SkinsRestorer** | template build (current line supports 1.8–26.x) | skins | CONFIRMED covers 1.12.2. Already installed. |
| **EaglerJwtAuth (custom)** | bump **1.0.0 → 1.1.0** | locks username to JWT, join-routing teleport, (Phase C) presence + hop-in | Source at `/Users/matthewcoleman/Desktop/minecraft/plugin/`. **Currently does NOT lock the username (SKIP path)** — Phase A rewrite required (see §7). |
| **Multiverse-Core** | **2.5.x** (the legacy 1.9–1.12 line; SpigotMC resource 23327 / CurseForge file 2428161) | create/load/persist always-on worlds; `enforceaccess` entry gate | **[CORRECTION — RESOLVES A CROSS-COMPONENT CONFLICT]** Several component designs said "4.3.x". Multiple verifiers **REFUTED** 4.3.x: the MV 4.x line requires **MC 1.13+** and will not load 1.12.2 worlds. The **only** 1.12.2-compatible line is **2.x**. **Pin 2.5.x.** Do NOT use 4.x / 5.x / Hangar 26.x. |
| **WorldGuard** | **6.2.2** (Bukkit file 2610618) | the real build guard (`__global__` passthrough=deny + per-world membership) | CONFIRMED: WG 6.2.2 is the 1.12.2 build; WG 7.x is 1.13+. |
| **WorldEdit** | **6.1.9** (the 1.12.2 build) | **hard dependency of WorldGuard 6.2.2** | **[CORRECTION]** CONFIRMED hard dependency. WG 6.x refuses to load without it → the entire build guard silently fails to load if omitted. Must be added to `fetch-plugins.sh`. |
| **LuckPerms** | **5.5.x** Bukkit jar (NOT 5.4.x as some designs said) | permission backend; holds `multiverse.access.<world>` nodes | CONFIRMED supports 1.8.8–1.21.x, runs on Java 8+. **[CORRECTION]** pin current 5.5.x, not stale 5.4.x. |

**Build-guard model decision (resolved):** `access == build` is enforced by **two layers that the bridge always sets together** — Multiverse `enforceaccess` gates *entry*, WorldGuard `__global__` membership gates *building*. Multiverse access **alone is not a build guard** (it only blocks teleport/entry); and as deployed it is *inert* until a permissions plugin + `enforceaccess:true` + per-world grants exist. So WorldGuard + LuckPerms are not optional add-ons — they are part of the access==build mechanism. **[CORRECTION]** the `panel`/`multiworld` "Multiverse access node = build" shorthand is insufficient on its own.

**Pin everything** into `fetch-plugins.sh` with recorded SHA-256 sums, matching the existing convention. **[CORRECTION]** the `b734` Multiverse build suffix from one design is fabricated — read the real filename/hash off the downloaded jar and pin that.

---

## 4. SQLite Data Model (extends existing `mc-auth` store)

Existing tables `users` and `allowlist` are kept **unchanged** so `resolveEmailLogin` etc. keep working. All new tables created with `CREATE TABLE IF NOT EXISTS`; `foreign_keys` pragma already ON.

### `users` (existing — no schema change required)
`id` · `username` (locked MC name, UNIQUE — **make immutable once set**) · `display_name` · `email` · `password_hash` · `telegram_id` · `google_sub` · `google_email` · `is_admin` (0/1; 1 = owner-designated admin) · `created_at` · `last_login_at`. Optional add later: `last_seen_at`.
- **Owner** is derived from the fixed constant email `mncoleman003@gmail.com` (NOT `ADMIN_EMAILS[0]` array index — **[CORRECTION]**, brittle to reorder). Owner is immutable and cannot be demoted.

### `worlds` (new)
| col | type | notes |
|---|---|---|
| `id` | TEXT PK | |
| `name` | TEXT NOT NULL | display name |
| `mv_world_name` | TEXT UNIQUE NOT NULL | canonical Bukkit **folder** name == `W` in all RCON commands; sanitized `^[a-z0-9_-]{1,32}$`. **Never use a Multiverse alias for permission-bearing worlds.** |
| `owner_user_id` | TEXT NOT NULL → users(id) | |
| `world_type` | TEXT NOT NULL DEFAULT 'normal' | normal/flat/nether/end |
| `seed` | TEXT | |
| `source` | TEXT | 'created' / 'upload-zip' / 'upload-epk' |
| `status` | TEXT NOT NULL DEFAULT 'active' | active/archived |
| `created_at` | INTEGER NOT NULL | |
| | | UNIQUE(`owner_user_id`,`name`) |

### `world_shares` (new) — drives GRANT/REVOKE
| col | type | notes |
|---|---|---|
| `id` | TEXT PK | |
| `world_id` | TEXT NOT NULL → worlds(id) ON DELETE CASCADE | |
| `grantee_user_id` | TEXT NOT NULL → users(id) ON DELETE CASCADE | |
| `granted_by` | TEXT NOT NULL → users(id) | |
| `created_at` | INTEGER NOT NULL | |
| | | UNIQUE(`world_id`,`grantee_user_id`) |

One row = "this user can build in this world". Insert → GRANT RCON; delete → REVOKE RCON. Owner is implicitly granted (not stored here).

### `invites` (new) — layers on top of `allowlist`
| col | type | notes |
|---|---|---|
| `id` | TEXT PK | |
| `code` | TEXT UNIQUE NOT NULL | url-safe random (`randomBytes(16).hex`) |
| `email` | TEXT | target identity, lowercased; NULL = open-link |
| `suggested_username` | TEXT | |
| `role` | TEXT NOT NULL DEFAULT 'user' CHECK in ('user','admin') | `'admin'` only if creator is owner |
| `invited_by` | TEXT NOT NULL → users(id) | |
| `status` | TEXT NOT NULL DEFAULT 'pending' CHECK in ('pending','accepted','revoked') | |
| `accepted_user_id` | TEXT → users(id) | |
| `created_at` / `accepted_at` / `expires_at` | INTEGER | |

On accept: write an `allowlist` row (`kind='email'`, value, username) so the unchanged `resolveEmailLogin` admits them, create the user, set `status='accepted'`.

### `pending_destination` (new — Phase C hop-in cold-start)
`username` TEXT PK · `target_world` TEXT · `target_username` TEXT · `created_at` INTEGER · `expires_at` INTEGER. One row per user, last-write-wins, short TTL (~120s), cleared on teleport.

### Indexes
`idx_world_shares_grantee(grantee_user_id)` · `idx_worlds_owner(owner_user_id)` · `idx_invites_code(code)` · `idx_invites_status(status)`.

### Derived identity
`offlineUUID = UUID.nameUUIDFromBytes(("OfflinePlayer:" + username).getBytes(US_ASCII))` — computed identically in `mc-auth` and on the server. UUID is **not** stored; it is deterministic from the (immutable, locked) username. CONFIRMED: Bukkit cannot set UUID via Eaglercraft login events, so the username binding is the whole game.

---

## 5. mc-auth API + UI Surface

Reuse the existing Hono app, `currentSession()`, `jwt.ts`, `db.ts`, and the inline dark-CSS templating from `admin.ts`. Add `authz.ts` helpers: `requireSession`, `requireAdmin` (owner||is_admin), `requireOwner` (fixed owner email only).

### 5.1 Pages (server-rendered HTML)
- **`/admin`** (owner + admin) — extend existing page: Users roster (username + MC name + email + role + last_login + online dot), promote/demote (owner-only), Invites section (create with email+role, list sent/accepted/revoked + copyable link, revoke), Worlds section (all worlds, owner column, create/rename/archive, force-share/unshare).
- **`/panel`** (any authenticated user) — My Worlds (owned: create/rename/archive + manage shares; shared-with-me: list + Hop), Share dialog (pick existing user by username/email → grant/revoke), Who's online + their world, one-click Hop.
- **`/invite/:code`** — signup form for a valid pending invite; POST writes allowlist row + creates user + marks accepted + sets session + redirects to `/panel`.

UI splits enforce role rules at the page level (invite UI only on `/admin`) **in addition to** API-level checks (defense in depth).

### 5.2 JSON API
| Method + path | Auth | Purpose |
|---|---|---|
| `GET /api/me` | session | `{user_id, username, email, role, is_owner}` |
| `GET /api/me/worlds` | session | `{owned:[…], shared_with_me:[{world, owner_username}]}` (both directions from the single `world_shares` table) |
| `POST /api/worlds` | session | create world (owner=caller); RCON create + grant owner; respects per-user/global world cap |
| `PATCH /api/worlds/:id` | owner/admin | rename display name (`mv_world_name` immutable) |
| `DELETE /api/worlds/:id?confirm=1` | owner/admin | **default = archive** (status=archived + `mvremove` = unregister, keeps folder), not destructive `mvdelete`; CASCADE deletes shares + unsets nodes |
| `GET /api/worlds/:id/shares` | owner/admin | grantee list |
| `POST /api/worlds/:id/shares` `{username\|email}` | owner/admin | **404 if grantee is not an existing user** (this is what stops share from becoming a backdoor invite); insert row (idempotent via UNIQUE) → GRANT RCON |
| `DELETE /api/worlds/:id/shares/:granteeUserId` | owner/admin | delete row → REVOKE RCON; if grantee online & in that world, teleport them to lobby |
| `POST /api/worlds/:id/hop` | owner/grantee/admin | teleports **the caller only**; 409 if caller not online in-game |
| `GET /api/presence` | session | cached (~2–3s TTL) `{online:[{username, world, isEagler}], count, fetchedAt}` |
| `POST /api/admin/invites` `{email?, suggested_username?, role?}` | owner+admin | `{code, link}`; `role='admin'` only if requester is owner |
| `GET /api/admin/invites` | owner+admin | list with status |
| `POST /api/admin/invites/:code/revoke` | owner+admin | mark revoked |
| `POST /api/admin/users/:id/role` `{is_admin:0\|1}` | **owner only** | promote/demote; refuses to demote owner |

**Authorization is always re-checked server-side before any RCON command.** Because RCON runs as console (op), Multiverse's own perm check is bypassed — so `mc-auth` is the sole authority on who may hop/build where. **[CORRECTION]** in-game `/mv tp`, `/mvtp`, `multiverse.teleport.*`, and portal nodes must be **denied to normal players** via LuckPerms so nobody can self-teleport past the ACL.

---

## 6. Server Bridge Design (apply access + read presence, non-public)

### 6.1 Transport
- Add a user-defined Docker bridge network **`mc-internal`** containing **only** `mc-eagler` + `mc-auth` (not the other ~20 containers).
- `mc-eagler` keeps its game listener on `127.0.0.1:25569`. **RCON (25575) stays UNpublished** — reachable only as `mc-eagler:25575` from `mc-auth` on `mc-internal`.
- `mc-auth` holds `RCON_PASSWORD` (new shared secret, like `MC_JWT_SECRET`) and uses a small `rcon.ts` Source-RCON client over `Bun.connect` (no new npm dep). Commands are **serialized** through an in-process queue and the response string is checked.

**[CORRECTION — bridge premise was false-as-deployed]** Verifiers found the deployed compose has **no** `ENABLE_RCON`/`RCON_PASSWORD`, no `mc-internal` network, and `mc-auth` runs via standalone `docker run` (not on a shared network). itzg also defaults RCON **on with the well-known password `minecraft`** if unset. So Phase A/B must: (a) add `ENABLE_RCON=true` + a strong `RCON_PASSWORD=$(openssl rand -hex 48)` to `mc-eagler`; (b) define `mc-internal`; (c) attach `mc-eagler`; (d) migrate `mc-auth` from `docker run` into a compose service on `mc-internal`. Never add 25575 to the host/Oracle security-list/ufw (stay 22/80/443).

**Why RCON, not alternatives:** `docker-exec` would need the Docker socket = host root → breaks crash isolation (REJECTED). Direct DB writes race LuckPerms/WorldGuard in-memory caches and need a reload anyway (REJECTED). A companion HTTP plugin adds attack surface with no capability RCON lacks for grants. RCON gives atomic, immediately-effective, console-level commands.

### 6.2 GRANT / REVOKE / create commands (run by `mc-auth`)
- **One-time per-world setup** (at create/import): `mv import <W> normal` (or `mv create`), then `rg flag __global__ passthrough deny -w W`, then `rg addowner __global__ <ownerUser> -w W`, then `lp user <ownerUser> permission set multiverse.access.W true`.
- **GRANT build to U in W:** `lp user U permission set multiverse.access.W true` (entry) **+** `rg addmember __global__ U -w W` (build). Both required; idempotent.
- **REVOKE:** `rg removemember __global__ U -w W` (build) **+** `lp user U permission unset multiverse.access.W` (entry — use `unset`, not `set false`, so it can't shadow a future grant). If U is currently in W, teleport them to the lobby.
- **[CORRECTION]** add **individual players** as `__global__` members (`rg addmember __global__ U`), not `g:<group>` references — the per-player path is deterministic and version-safe. (The original "g:group is flaky/Vault-dependent" rationale is **not** supported by current docs, but the per-player choice stands regardless.)
- `rg addmember/removemember` on WG 6.2 keys on **player names** (offline mode) → reinforces that the username MUST be locked first.

### 6.3 Hop-in
- Console-issued `mvtp <player> <W>` (the explicit-player form; the self-only `/mv tp` does not work from console). **[CORRECTION]** smoke-test the exact 2.5.x console verb before wiring the panel.
- Authorization (ownership/share) is checked in `mc-auth` before the command, because console bypasses Multiverse's perm check.

### 6.4 Presence (Phase C)
- **[RESOLVED — companion HTTP over RCON for presence]** RCON `list` returns only names (no world); only the Bukkit API exposes `player.getWorld().getName()`. So extend **EaglerJwtAuth** with an embedded `com.sun.net.httpserver.HttpServer` bound in-container to a **non-published** port (e.g. `:25580`), gated by a constant-time Bearer check of `MC_PRESENCE_TOKEN`, reachable from `mc-auth` over `mc-internal`. Iterate **`Bukkit.getOnlinePlayers()`** (authoritative for world/location; **[CORRECTION]** not `getAllEaglerPlayers()`, which omits any non-browser player) and enrich with the Eagler API's `isEaglerPlayerByName`/brand. `mc-auth` polls on demand with a ~2–3s in-memory cache. Not published to host; not routed through Caddy.

---

## 7. Username-Locking Change to EaglerJwtAuth

**This is the security keystone and a hard prerequisite for Phases B/C.** It is also the single biggest correction to the as-deployed system.

**[CORRECTION — the deployed plugin provably cannot lock the username.]** `AuthListener.onAuthCheck` calls `event.setAuthRequired(EnumAuthResponse.SKIP)` for valid-JWT holders. Verified against EaglercraftXServer source: `SKIP` takes the **client-chosen** username verbatim and never reaches the `setProfileUsername` handlers. So today **any client can pick any username** and inherit that user's world grants. This is not merely "unverified" — it is the wrong code path.

### 7.1 Required code changes (all in `plugin/src/main/java/com/mncoleman/mc/auth/AuthListener.java`)
1. **`onAuthCheck`:** stop calling `SKIP`. For a valid JWT:
   - read the **typed** name via `getAuthUsername()` and compare **case-sensitively** to `jwt.username`; on mismatch → `kickUser("Log in with your account username: " + jwt.username)`.
   - `event.setNicknameSelectionEnabled(false)` (never enable nickname selection).
   - `event.setUseAuthType(EnumAuthType.PLAINTEXT)` (raw 255 — mandatory on REQUIRE or the connection internal-errors with "did not provide auth type"; we ignore any typed password).
   - `event.setEnableCookieAuth(true)`.
   - `event.setAuthRequired(EnumAuthResponse.REQUIRE)`.
   - On null/invalid JWT → `kickUser` (fail closed).
2. **`onAuthCookie`** (primary) and **`onAuthPassword`** (fallback): keep `setProfileUsername(jwt.username) + setLoginAllowed()`; re-validate the cookie in each. The username comparison that secures identity must key on the **CHECK event's `getAuthUsername()`** (the INIT-packet name that feeds the UUID), **[CORRECTION]** not `getRequestedNickname()` (the login-packet name, which does not feed the offline UUID).
3. Add a **config flag `lock-mode: require|skip`** (default `require`) so we can instantly revert to SKIP-admit if the live handshake regresses.
4. Bump `plugin.yml` + `pom.xml` to **1.1.0**, rebuild with `build.sh`. No new dependencies.

### 7.2 Why typed == jwt is enforced (UUID stability)
The offline UUID is derived **once** from the handshake (typed) username, and on Bukkit it is **never** re-derived from `setProfileUsername` (platform-guarded; `setProfileUUID` throws on Bukkit). If the typed name differs from the JWT name, world data + permissions attach to an unstable/wrong identity (and the server logs a UUID-mismatch warning). Forcing typed == jwt collapses both to one deterministic value. **Best UX:** have `mc-auth` prefill the client login field with the account username so typed == jwt automatically; otherwise kick on mismatch.

### 7.3 Cross-cutting risk to test alongside the cutover
**[UNVERIFIED]** The prior "Handshake timed out" is *believed* fixed by setting `http_websocket_compression_level=0`, but a verifier notes **Caddy does NOT apply permessage-deflate to proxied WS frames**, so level 0 likely leaves game traffic **uncompressed end-to-end** (a plausible original cause of timeouts/lag, independent of the auth path). **Action:** when testing the REQUIRE cutover, also re-test with `http_websocket_compression_level` at a low non-zero value (1–3) and confirm Caddy is purely tunneling the Upgrade. Do not enable per-world sharing until a live test confirms: a client that requests name "X" but holds a JWT for "Y" actually joins as "Y".

### 7.4 Whitelist interaction
**[CORRECTION — unaddressed integration point that can block logins.]** Compose has `ENABLE_WHITELIST=TRUE` + `ENFORCE_WHITELIST=TRUE`. Paper's whitelist runs **after** the username is locked and keys on the (now-locked) name. Pick one explicitly: **(a)** add `whitelist add U` on invite-accept and `whitelist remove U` on de-invite (RCON), or **(b)** disable the Paper whitelist and rely solely on the fail-closed JWT plugin for admission. Otherwise legitimate users get kicked despite a valid JWT.

---

## 8. .epk → Server World Path (with honest caveats)

**Good news (verified against EaglercraftX 1.8 source):** the conversion is the **low-risk** path.

### 8.1 Recommended flow for the cliff build
1. In the Eaglercraft client, open the world's Backup/Edit menu and click **"Convert to Vanilla"** → downloads `<world>.zip`. **[CORRECTION]** the menu label is **"Convert to Vanilla"**, NOT "Export as vanilla world". The `.epk` button is "Export EPK File" — do not pick that one.
   - **[UNVERIFIED at string level]** the deployed clients are an EaglerForge fork + a WASM build; the *function* (keys `singleplayer.backup.vanilla`, `$worldVanilla`) is present, but the exact on-screen label should be confirmed by opening the menu in our actual client before writing user instructions/screenshots.
2. Upload that ZIP to `mc-auth` (`POST /worlds/upload`).
3. `mc-auth` unzips, validates it contains `level.dat` + `region/*.mca`, **rewrites paths** (never trusts the ZIP's own top-level dir), sanitizes the folder name, streams to `/home/ubuntu/minecraft/server/data/<W>/` (the bind mount — stream, never buffer in the 256MB container; enforce size + entry-count caps as a zip-bomb guard).
4. `mv import <W> normal` over RCON → Paper loads and **lazily upgrades** 1.8 chunks to 1.12.2 on read.

### 8.2 Caveats (corrected)
- **[CORRECTION] Internal storage is NOT Anvil.** EaglercraftX stores each chunk as a separate gzip-NBT `.dat`; the **export** repacks them into `region/*.mca`. The practical result (the ZIP output *is* a valid Anvil world) is unchanged, but the rationale "Eaglercraft stores worlds as Anvil internally" is false.
- **[CORRECTION] `--forceUpgrade` does NOT exist on 1.12.2.** It is a 1.13+ flag and a 1.12.2 jar rejects it. There is **no pre-upgrade pass** — only lazy on-load upgrade. To pre-warm, use a chunk pre-generator (WorldBorder fill / Chunky on a 1.12-compatible build) to force-load every chunk once. **Back up `data/<W>` first** (lazy upgrade still rewrites chunk NBT in place).
- **Nether/End layout remap:** Eaglercraft exports `DIM-1/region` + `DIM1/region` inside the single world folder; Bukkit wants sibling folders `<W>_nether/DIM-1/region` and `<W>_the_end/DIM1/region`. On extract, remap them — or, if the cliff build is overworld-only (almost certainly), drop the dimension folders. Verify with `mv list`.
- **Known data loss (cosmetic for a singleplayer build):** LAN-player inventories are dropped and tamed pets may forget owners (UUID change). The exporting player's own build/terrain exports perfectly.
- **Fallback for raw `.epk`:** the `mc-auth` endpoint can also accept `.epk` and decode it server-side (EAGPKG$$ format is simple, fully documented in `EPKDecompiler.java`; a Bun/JS port is straightforward), yielding the same `level.dat` + `region/*.mca`.

---

## 9. Phased Build Plan

### Phase A — Foundation: username-lock + Multiverse + cliff build live
*Goal: one shared world, secure identity, players land in it. No sharing yet.*

- [ ] **Infra/bridge prep:** add `ENABLE_RCON=true` + `RCON_PASSWORD=$(openssl rand -hex 48)` to `mc-eagler`; define `mc-internal` Docker network; attach `mc-eagler`; migrate `mc-auth` from `docker run` into a compose service on `mc-internal`. Add `RCON_PASSWORD` to both `.env` files. Confirm 25575 is NOT host-published.
- [ ] **Plugins:** add to `fetch-plugins.sh` (pinned + SHA-256): **Multiverse-Core 2.5.x**, **WorldGuard 6.2.2**, **WorldEdit 6.1.9**, **LuckPerms 5.5.x**. Set Multiverse `config.yml` `enforceaccess: true`. Restart `mc-eagler`; confirm **all four** log "enabled" (especially WorldEdit, or WorldGuard won't load).
- [ ] **Smoke-test Multiverse on the box:** `mv create test normal`, `mv tp`, console `mvtp <player> test`, full restart → confirm 2.5.x loads with no Java 17 reflective failure and persists. Measure idle RAM with `docker stats`/`spark` after 2–3 worlds before committing to a world-count ceiling.
- [ ] **Username lock (§7):** rewrite `AuthListener` to REQUIRE+cookie-auth+`setProfileUsername`; enforce typed==jwt (kick on mismatch); add `lock-mode` flag; bump to 1.1.0; rebuild + deploy.
- [ ] **Live identity test:** log in; attempt to override the client username while holding a JWT for a different name; confirm `Player.getName()` == JWT username. Re-test WS with `http_websocket_compression_level` at 0 vs 1–3.
- [ ] **Whitelist decision (§7.4):** choose RCON-managed whitelist vs disable-whitelist; implement.
- [ ] **Cliff build import (§8):** "Convert to Vanilla" → upload/place under `data/cliff/` → `mv import cliff normal`; remap/drop nether/end; back up before first load; pre-warm chunks if desired. Set per-world spawn.
- [ ] **Lobby + join-routing:** keep `world` as a neutral lobby; in EaglerJwtAuth, on a deferred main-thread tick after login, teleport the player to their home/permitted world (read from `mc-auth`). Lock the lobby's `__global__` (deny build) so unshared users can't grief spawn.

### Phase B — Per-world sharing + minimal admin grant/revoke
*Goal: owner/admins can create worlds and grant/revoke build access; access==build enforced.*

- [ ] **Data model:** create `worlds` + `world_shares` tables + indexes in `db.ts`.
- [ ] **`rcon.ts` + queue:** Source-RCON client over `Bun.connect`, serialized command queue, response-string check.
- [ ] **Per-world setup on create/import:** owner-as-`__global__`-owner + `passthrough deny` + owner access node (§6.2).
- [ ] **GRANT/REVOKE bridge:** `world_shares` insert → `lp set` + `rg addmember`; delete → `rg removemember` + `lp unset` (+ teleport-out if present).
- [ ] **Lock down in-game teleport:** deny `multiverse.teleport.*` / `/mv tp` / `/mvtp` / portal nodes to normal players via LuckPerms so the ACL can't be bypassed.
- [ ] **Minimal admin UI:** in `/admin`, Worlds section (create/rename/archive) + force-share/unshare; `authz.ts` helpers (`requireOwner`/`requireAdmin`).
- [ ] **Reconciler v1:** on `mc-auth` boot, re-push all `world_shares` grants + verify each `mv_world_name` exists.
- [ ] **World caps:** per-user + global world cap config to protect the 4G/2CPU box.
- [ ] **Verify access==build:** a non-member cannot enter (enforceaccess) and cannot build (WG passthrough); a member can do both; revoke takes effect live.

### Phase C — Full panel: invites/accept, MC names, bidirectional shares, presence, hop-in
*Goal: complete self-serve web platform.*

- [ ] **Invites:** `invites` table; `POST/GET /api/admin/invites` (+ revoke); `/invite/:code` signup → writes `allowlist` row + creates user + accepts. `role='admin'` only if creator is owner. Owner-only `POST /api/admin/users/:id/role` (refuse to demote owner).
- [ ] **Self-serve sharing:** `POST/DELETE /api/worlds/:id/shares` with **grantee-must-exist (404)** guard; `GET /api/me/worlds` for bidirectional views.
- [ ] **User UI `/panel`:** My Worlds (owned + shared-with-me), Share dialog (existing-user picker), Online list, Hop buttons.
- [ ] **Presence (§6.4):** add embedded HTTP server + Bearer to EaglerJwtAuth (1.1.x), `MC_PRESENCE_TOKEN` in both `.env`s; `mc-auth` presence client with 2–3s cache iterating `Bukkit.getOnlinePlayers()` enriched with Eagler brand.
- [ ] **Hop-in:** `pending_destination` table; `POST /api/worlds/:id/hop` (warm path = immediate `mvtp` for online caller; cold path = write pending row, teleport on `EaglercraftInitializePlayerEvent` **deferred one tick** to the main thread — **[CORRECTION]** never teleport synchronously in the async init/join event). 409 + "launch the client first" when caller offline. Authorization re-checked against ownership/shares before every teleport.
- [ ] **Admin roster:** Users list with MC name + role + online dot + current world.
- [ ] **Reconciler v2:** add a periodic timer in addition to boot.
- [ ] **World uploads:** `POST /worlds/upload` accepting `.zip` (and optionally `.epk` decode) with sanitization/zip-bomb/path-traversal guards (§8).

---

## 10. Risks & Open Questions (every REFUTED / UNCERTAIN verdict folded in)

### Blocking / high severity
1. **[REFUTED → fixed in Phase A]** Deployed EaglerJwtAuth uses `SKIP` and **cannot lock the username** — per-world perms are currently spoofable. Phase A §7 rewrite is mandatory before any sharing.
2. **[REFUTED → fixed in Phase A]** "RCON already up + bridge wired" is false: no `RCON_PASSWORD`, no `mc-internal` network, `mc-auth` not on a shared net; itzg defaults RCON to password `minecraft`. Must add RCON env + network + compose migration.
3. **[REFUTED → resolved in §3]** **Multiverse 4.3.x does not run on 1.12.2** (4.x requires 1.13+). Cross-component conflict resolved: **pin Multiverse-Core 2.5.x.** Do not use 4.x/5.x.
4. **[REFUTED → fixed in §3/Phase A]** **WorldGuard 6.2.2 needs WorldEdit 6.1.9** as a hard dependency — omit it and the entire build guard silently fails to load.
5. **[REFUTED → corrected]** Multiverse `multiverse.access.<world>` is **NOT** a usable build backstop as deployed (`enforceaccess` defaults false + no perms plugin). Build is enforced by **WorldGuard `__global__` passthrough=deny + membership**; in-game `/mv tp`/`multiverse.teleport.*` must be denied to normal players or the ACL is bypassable.

### Medium
6. **[UNVERIFIED]** REQUIRE+cookie handshake success on the live client (prior "Handshake timed out"). Test before cutover; keep `lock-mode: skip` fallback.
7. **[UNCERTAIN]** `http_websocket_compression_level=0` likely leaves WS traffic uncompressed (Caddy doesn't deflate proxied WS frames). Re-test at 1–3.
8. **[CORRECTION]** Paper whitelist (`ENFORCE_WHITELIST=TRUE`) runs after username-lock and can kick valid users — pick RCON-managed whitelist or disable it (§7.4).
9. **[UNCERTAIN]** Exact Multiverse 2.5.x console verb for `mvtp` and whether per-world `keep-spawn-loaded:false` actually takes effect (known MV2 quirk where keep-spawn is forced on) — verify before relying on it for the RAM budget.
10. **RAM budget is an estimate, not measured.** ~40–80MB/idle world is a rule-of-thumb. Measure with `spark`/`docker stats` after 2–3 worlds; plan ~4–6 always-on worlds, ~8 ceiling on the 4G/2CPU box; avoid auto-loading per-world nether/end.
11. **World name vs alias / path traversal:** always use the canonical Bukkit folder name; sanitize uploads to `^[a-z0-9_-]{1,32}$`, per-owner namespace, reject existing folders, rewrite ZIP paths.

### Low / handled
12. **[REFUTED → corrected in §8]** `--forceUpgrade` doesn't exist on 1.12.2; EaglercraftX doesn't store Anvil internally (export repacks). Use a chunk pre-generator to pre-warm; back up first.
13. **[UNVERIFIED string]** Exact "Convert to Vanilla" label in our specific client builds — confirm by opening the menu.
14. **Destructive delete:** default world delete to **archive** (`mvremove`, keeps folder); require `?confirm=1`; rsync `data/<W>` before any true `mvdelete` (per file-safety rules).
15. **Presence per-world mapping** requires the Bukkit-API plugin endpoint; RCON `list` alone can't say which world each player is in.
16. **Shared-secret sprawl** (`MC_JWT_SECRET`, `RCON_PASSWORD`, `MC_PRESENCE_TOKEN`, forward secret) must stay in sync across both `.env` files; fail closed on mismatch.

---

## 11. What's Needed From Matthew

1. **The cliff build as a vanilla ZIP.** In the client, open the world → Backup/Edit → **"Convert to Vanilla"** (download `<world>.zip`), and confirm the exact button label you see (so the upload UI/instructions match). Alternatively hand over `cliff build.epk` and we'll decode server-side.
2. **Admin list.** Confirm the owner is `mncoleman003@gmail.com` (immutable) and name anyone you want as an initial **admin** (can invite + manage worlds globally). Everyone else starts as a plain user (can share their own worlds only).
3. **Whitelist policy (§7.4):** OK to **disable Paper's whitelist** and let the JWT plugin be the sole admission gate, or do you want `mc-auth` to RCON-manage the whitelist on invite-accept? (Default recommendation: disable Paper whitelist, JWT plugin is fail-closed.)
4. **World limits.** A per-user world cap and total world cap (RAM budget). Default suggestion: cap ~6 always-on worlds total to start; raise after measuring.
5. **Delete policy.** Confirm world "delete" should default to **archive** (reversible) and require explicit confirmation for true deletion. (Aligns with your file-safety rules.)
6. **Lobby/landing policy.** Keep `world` as a neutral, build-locked lobby everyone lands in, then route to their home world — vs. teleport straight to a home world on join.
7. **Green light to schedule a short maintenance window** for the EaglerJwtAuth cutover + first plugin restart (low-risk, but the handshake change is UNVERIFIED until tested live).
