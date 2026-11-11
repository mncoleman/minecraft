package com.mncoleman.mc.build;

import com.google.gson.*;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.entity.Player;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Token-gated JSON API on the internal Docker network (not published to the host).
 * Callers are trusted (mc-auth enforces who may build where); this layer enforces
 * size caps, the server-thread rule, and protected-block safety.
 *
 *   POST /player {name}                       → online, world, x,y,z, yaw, pitch, facing, gamemode
 *   POST /scan   {world, mode, from, to}      → blocks | heightmap
 *   POST /build  {world, actor, label, ops, only_air, wait_ms} → job status
 *   POST /job    {id, wait_ms}                → job status
 *   POST /undo   {id, actor, wait_ms}         → undo job status
 *   POST /say    {message}
 *   POST /cancel {}
 */
public final class ApiServer {
    private static final int MAX_BODY = 8 * 1024 * 1024;
    private final ClaudeBuildPlugin plugin;
    private final String token;
    private final HttpServer server;
    private final Gson gson = new Gson();

    public ApiServer(ClaudeBuildPlugin plugin, int port, String token) throws Exception {
        this.plugin = plugin;
        this.token = token;
        server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/", this::handle);
        server.setExecutor(Executors.newFixedThreadPool(12));
        server.start();
        plugin.getLogger().info("Build API listening on :" + port);
    }

    public void stop() { server.stop(0); }

    private void handle(HttpExchange ex) {
        try {
            String auth = ex.getRequestHeaders().getFirst("Authorization");
            if (token == null || token.isEmpty() || auth == null
                || !MessageDigest.isEqual(auth.getBytes(StandardCharsets.UTF_8), ("Bearer " + token).getBytes(StandardCharsets.UTF_8))) {
                send(ex, 401, err("unauthorized")); return;
            }
            if (!"POST".equals(ex.getRequestMethod())) { send(ex, 405, err("POST only")); return; }
            JsonObject body = readBody(ex);
            JsonObject out;
            switch (ex.getRequestURI().getPath()) {
                case "/player": out = player(body); break;
                case "/scan": out = scan(body); break;
                case "/build": out = build(body); break;
                case "/job": out = job(body); break;
                case "/undo": out = undo(body); break;
                case "/say": out = say(body); break;
                case "/rail_plan": out = railPlan(body); break;
                case "/rail_build": out = railBuild(body); break;
                case "/rail_verify": out = railVerify(body); break;
                case "/cancel": out = sync(() -> { JsonObject o = new JsonObject(); o.addProperty("cancelled", plugin.jobs().cancelCurrent()); return o; }); break;
                default: send(ex, 404, err("not found")); return;
            }
            send(ex, 200, out);
        } catch (IllegalArgumentException e) {
            safeSend(ex, 400, err(e.getMessage()));
        } catch (Throwable t) {
            plugin.getLogger().warning("API error: " + t);
            safeSend(ex, 500, err(t.toString()));
        }
    }

    // ── endpoints ─────────────────────────────────────────────────────────────
    private JsonObject player(JsonObject b) throws Exception {
        String name = reqStr(b, "name");
        return sync(() -> {
            JsonObject o = new JsonObject();
            Player p = Bukkit.getPlayerExact(name);
            o.addProperty("online", p != null);
            if (p == null) return o;
            Location l = p.getLocation();
            o.addProperty("world", l.getWorld().getName());
            o.addProperty("x", Math.round(l.getX() * 10) / 10.0);
            o.addProperty("y", Math.round(l.getY() * 10) / 10.0);
            o.addProperty("z", Math.round(l.getZ() * 10) / 10.0);
            o.addProperty("block_x", l.getBlockX()); o.addProperty("block_y", l.getBlockY()); o.addProperty("block_z", l.getBlockZ());
            float yaw = ((l.getYaw() % 360) + 360) % 360;
            o.addProperty("yaw", Math.round(yaw)); o.addProperty("pitch", Math.round(l.getPitch()));
            String[] dirs = {"south (+z)", "west (-x)", "north (-z)", "east (+x)"};
            o.addProperty("facing", dirs[Math.round(yaw / 90f) & 3]);
            o.addProperty("gamemode", p.getGameMode().name().toLowerCase());
            o.addProperty("standing_on", BlockSpec.name(l.clone().add(0, -0.1, 0).getBlock().getTypeId(), l.clone().add(0, -0.1, 0).getBlock().getData()));
            return o;
        });
    }

    private JsonObject scan(JsonObject b) throws Exception {
        String world = reqStr(b, "world");
        String mode = b.has("mode") ? b.get("mode").getAsString() : "blocks";
        int[] f = vec(b, "from"), t = vec(b, "to");
        int capB = plugin.getConfig().getInt("max-scan-blocks", 32768), capC = plugin.getConfig().getInt("max-scan-columns", 16384);
        return sync(() -> {
            World w = Bukkit.getWorld(world);
            if (w == null) throw new IllegalArgumentException("world not loaded: " + world);
            if ("heightmap".equals(mode)) return Scanner.heightmap(w, f[0], f[2], t[0], t[2], capC);
            if ("blocks".equals(mode)) return Scanner.blocks(w, f[0], f[1], f[2], t[0], t[1], t[2], capB);
            throw new IllegalArgumentException("mode must be blocks or heightmap");
        }, 20);
    }

    private JsonObject build(JsonObject b) throws Exception {
        String world = reqStr(b, "world");
        JsonElement opsE = b.get("ops");
        if (opsE == null || !opsE.isJsonArray() || opsE.getAsJsonArray().size() == 0) throw new IllegalArgumentException("'ops' must be a non-empty array");
        Ops ops = new Ops(plugin.getConfig().getInt("max-blocks-per-build", 200000));
        if (opsE.getAsJsonArray().size() > 2000) throw new IllegalArgumentException("max 2000 ops per build");
        int i = 0;
        for (JsonElement e : opsE.getAsJsonArray()) {
            if (!e.isJsonObject()) throw new IllegalArgumentException("op " + i + " is not an object");
            ops.add(e.getAsJsonObject(), i++);
        }
        if (ops.result().isEmpty()) throw new IllegalArgumentException("ops produced no blocks (all outside y 0-255?)");
        Boolean worldOk = sync(() -> Bukkit.getWorld(world) != null);
        if (!worldOk) throw new IllegalArgumentException("world not loaded: " + world);
        JobManager.Job j = plugin.jobs().submitBuild(world, str(b, "actor"), str(b, "label"), ops.result().values(), b.has("only_air") && b.get("only_air").getAsBoolean());
        return waitFor(j, b);
    }

    private JsonObject job(JsonObject b) throws Exception {
        JobManager.Job j = plugin.jobs().get(reqStr(b, "id"));
        if (j == null) throw new IllegalArgumentException("unknown or expired job id (undo still works for builds)");
        return waitFor(j, b);
    }

    private JsonObject undo(JsonObject b) throws Exception {
        JobManager.Job u = plugin.jobs().submitUndo(reqStr(b, "id"), str(b, "actor"));
        return waitFor(u, b);
    }

    private JsonObject say(JsonObject b) throws Exception {
        String msg = reqStr(b, "message").replaceAll("[\\x00-\\x1F\\u00A7]", "").trim();
        if (msg.isEmpty()) throw new IllegalArgumentException("empty message");
        if (msg.length() > 256) msg = msg.substring(0, 256);
        String m = msg;
        return sync(() -> { plugin.avatar().say(m); JsonObject o = new JsonObject(); o.addProperty("ok", true); return o; });
    }

    // ── rail lines ────────────────────────────────────────────────────────────
    private static final java.util.concurrent.Semaphore PLANNING = new java.util.concurrent.Semaphore(1);

    private JsonObject railPlan(JsonObject b) throws Exception {
        if (!PLANNING.tryAcquire()) throw new IllegalArgumentException("the planner is busy with another route; try again in a few seconds");
        try { return railPlanLocked(b); } finally { PLANNING.release(); }
    }

    private JsonObject railPlanLocked(JsonObject b) throws Exception {
        RailPlanner.Params p = new RailPlanner.Params();
        p.world = reqStr(b, "world");
        if (!b.has("points") || !b.get("points").isJsonArray()) throw new IllegalArgumentException("'points' must be [[x,z] or [x,y,z], ...] (from, waypoints..., to)");
        for (JsonElement e : b.getAsJsonArray("points")) {
            JsonArray a = e.getAsJsonArray();
            long x, y = Integer.MIN_VALUE, z;
            if (a.size() == 2) { x = a.get(0).getAsLong(); z = a.get(1).getAsLong(); }
            else if (a.size() == 3) { x = a.get(0).getAsLong(); y = a.get(1).getAsLong(); z = a.get(2).getAsLong(); if (y < 6 || y > 250) throw new IllegalArgumentException("point y must be 6-250"); }
            else throw new IllegalArgumentException("each point is [x,z] or [x,y,z]");
            if (Math.abs(x) > 29_999_000 || Math.abs(z) > 29_999_000) throw new IllegalArgumentException("point out of world bounds");
            p.points.add(new int[]{(int) x, (int) y, (int) z});
        }
        if (p.points.size() < 2 || p.points.size() > 12) throw new IllegalArgumentException("give 2-12 points (from, up to 10 waypoints, to)");
        for (int k = 1; k < p.points.size(); k++) {
            int[] a = p.points.get(k - 1), c = p.points.get(k);
            if (Math.abs(a[0] - c[0]) + Math.abs(a[2] - c[2]) > 2500) throw new IllegalArgumentException("a leg is longer than 2500 blocks; add waypoints or build it as separate lines");
        }
        if (b.has("style")) { p.style = b.get("style").getAsString(); if (!p.style.matches("auto|surface|tunnel|elevated")) throw new IllegalArgumentException("style: auto | surface | tunnel | elevated"); }
        if (b.has("depth")) p.depth = Math.max(3, Math.min(60, b.get("depth").getAsInt()));
        if (b.has("level") && !b.get("level").isJsonNull()) p.level = Math.max(6, Math.min(250, b.get("level").getAsInt()));
        if (b.has("grade")) p.grade = Math.max(2, Math.min(8, b.get("grade").getAsInt()));
        if (b.has("width")) p.width = b.get("width").getAsInt() >= 3 ? 3 : 1;
        if (b.has("clearance")) p.clearance = Math.max(2, Math.min(40, b.get("clearance").getAsInt()));
        if (b.has("band")) p.band = Math.max(4, Math.min(64, b.get("band").getAsInt()));
        p.fullLining = b.has("full_lining") && b.get("full_lining").getAsBoolean();
        p.shuttle = b.has("shuttle") && b.get("shuttle").getAsBoolean();
        p.lining = BlockSpec.parse(b.has("lining") ? b.get("lining").getAsString() : "stonebrick");
        p.bed = BlockSpec.parse(b.has("bed") ? b.get("bed").getAsString() : "stonebrick");
        p.light = BlockSpec.parse(b.has("light") ? b.get("light").getAsString() : "glowstone");
        if (!java.util.EnumSet.of(org.bukkit.Material.GLOWSTONE, org.bukkit.Material.SEA_LANTERN, org.bukkit.Material.JACK_O_LANTERN, org.bukkit.Material.REDSTONE_LAMP_ON).contains(p.light.material))
            throw new IllegalArgumentException("light must be glowstone, sea_lantern or lit_pumpkin");
        for (BlockSpec s : new BlockSpec[]{p.lining, p.bed}) if (!s.material.isSolid() || BlockSpec.HEAVY.contains(s.material)) throw new IllegalArgumentException("lining/bed must be a solid, non-falling block");
        World w = sync(() -> Bukkit.getWorld(p.world));
        if (w == null) throw new IllegalArgumentException("world not loaded: " + p.world);
        Set<Long> chunks = RailPlanner.corridorChunks(p);
        if (chunks.size() > 800) throw new IllegalArgumentException("route corridor is too large (" + chunks.size() + " chunks); add waypoints closer together or reduce band");
        Map<Long, org.bukkit.ChunkSnapshot> snaps = RailPlanner.loadSnapshots(plugin, w, chunks).get(90, TimeUnit.SECONDS);
        RailPlanner.Plan plan = RailPlanner.plan(p, snaps);
        int cap = plugin.getConfig().getInt("max-blocks-per-build", 200000);
        if (plan.ops.size() > cap) throw new IllegalArgumentException("this line needs " + plan.ops.size() + " block changes (max " + cap + "); split it with waypoints");
        return plan.preview;
    }

    private JsonObject railBuild(JsonObject b) throws Exception {
        RailPlanner.Plan plan = RailPlanner.PLANS.get(reqStr(b, "plan_id"));
        if (plan == null || System.currentTimeMillis() - plan.created > RailPlanner.TTL_MS) throw new IllegalArgumentException("unknown or expired plan (plans last 15 minutes, since the terrain changes as people build) — plan it again");
        java.util.LinkedHashMap<Long, Ops.Placement> ops;
        synchronized (plan) { ops = plan.ops; plan.ops = null; }
        if (ops == null) throw new IllegalArgumentException("this plan was already built — plan again for another copy");
        JobManager.Job j;
        try { j = plugin.jobs().submitBuild(plan.world, str(b, "actor"), "rail line " + plan.id, ops.values(), false); }
        catch (RuntimeException e) { plan.ops = ops; throw e; }   // queue full etc.: plan stays usable
        JsonObject st = waitFor(j, b);
        st.addProperty("plan_id", plan.id);
        if ("done".equals(j.state)) {
            Thread.sleep(300); // let redstone settle a few ticks
            st.add("verification", railVerify(b));
        }
        return st;
    }

    /** Walk the planned track: every rail present with the planned shape, every boost rail powered. */
    private JsonObject railVerify(JsonObject b) throws Exception {
        RailPlanner.Plan plan = RailPlanner.PLANS.get(reqStr(b, "plan_id"));
        if (plan == null) throw new IllegalArgumentException("unknown or expired plan");
        return sync(() -> {
            World w = Bukkit.getWorld(plan.world);
            if (w == null) throw new IllegalArgumentException("world not loaded: " + plan.world);
            int missing = 0, wrongShape = 0, unpowered = 0, noBed = 0;
            JsonArray problems = new JsonArray();
            for (int i = 0; i < plan.xs.length; i++) {
                org.bukkit.block.Block bl = w.getBlockAt(plan.xs[i], plan.ys[i], plan.zs[i]);
                String where = plan.xs[i] + " " + plan.ys[i] + " " + plan.zs[i];
                if (bl.getTypeId() != plan.railId[i]) { missing++; if (problems.size() < 12) problems.add(new JsonPrimitive("no/odd rail at " + where + " (found " + BlockSpec.name(bl.getTypeId(), bl.getData()) + ")")); continue; }
                int mask = plan.railId[i] == org.bukkit.Material.RAILS.getId() ? 0xF : 0x7;
                if ((bl.getData() & mask) != (plan.railData[i] & mask)) { wrongShape++; if (problems.size() < 12) problems.add(new JsonPrimitive("rail shape differs at " + where)); }
                if (plan.mustBePowered[i] && (bl.getData() & 8) == 0) { unpowered++; if (problems.size() < 12) problems.add(new JsonPrimitive("boost rail unpowered at " + where)); }
                if (!bl.getRelative(0, -1, 0).getType().isSolid()) { noBed++; if (problems.size() < 12) problems.add(new JsonPrimitive("no solid block under rail at " + where)); }
            }
            JsonObject o = new JsonObject();
            o.addProperty("track_blocks", plan.xs.length);
            o.addProperty("missing_rails", missing); o.addProperty("wrong_shape", wrongShape);
            o.addProperty("unpowered_boost_rails", unpowered); o.addProperty("unsupported_rails", noBed);
            o.addProperty("ok", missing + wrongShape + unpowered + noBed == 0);
            o.add("problems", problems);
            return o;
        }, 10);
    }

    // ── helpers ───────────────────────────────────────────────────────────────
    private JsonObject waitFor(JobManager.Job j, JsonObject b) throws InterruptedException {
        long waitMs = b.has("wait_ms") ? Math.max(0, Math.min(25000, b.get("wait_ms").getAsLong())) : 0;
        long until = System.currentTimeMillis() + waitMs;
        while (System.currentTimeMillis() < until && (j.state.equals("queued") || j.state.equals("running"))) Thread.sleep(100);
        return status(j);
    }

    private JsonObject status(JobManager.Job j) {
        JsonObject o = new JsonObject();
        o.addProperty("id", j.id); o.addProperty("kind", j.kind); o.addProperty("state", j.state);
        o.addProperty("world", j.world);
        if (j.label != null) o.addProperty("label", j.label);
        if (j.undoOf != null) o.addProperty("undo_of", j.undoOf);
        o.addProperty("total", j.size()); o.addProperty("processed", j.cursor);
        o.addProperty("placed", j.placed); o.addProperty("unchanged", j.unchanged);
        o.addProperty("skipped_protected_tile_entities", j.skippedProtected);
        o.addProperty("skipped_ungenerated_chunks", j.skippedUngenerated);
        o.addProperty(j.kind.equals("undo") ? "skipped_changed_since" : "skipped_not_air", j.skippedOccupied);
        if (j.error != null) o.addProperty("error", j.error);
        if (j.size() > 0) {
            int ax = Integer.MAX_VALUE, ay = ax, az = ax, bx = Integer.MIN_VALUE, by = bx, bz = bx;
            for (int i = 0; i < j.size(); i++) {
                ax = Math.min(ax, j.xs[i]); ay = Math.min(ay, j.ys[i]); az = Math.min(az, j.zs[i]);
                bx = Math.max(bx, j.xs[i]); by = Math.max(by, j.ys[i]); bz = Math.max(bz, j.zs[i]);
            }
            JsonArray from = new JsonArray(); from.add(new JsonPrimitive(ax)); from.add(new JsonPrimitive(ay)); from.add(new JsonPrimitive(az));
            JsonArray to = new JsonArray(); to.add(new JsonPrimitive(bx)); to.add(new JsonPrimitive(by)); to.add(new JsonPrimitive(bz));
            o.add("bbox_from", from); o.add("bbox_to", to);
        }
        return o;
    }

    private <T> T sync(Callable<T> c) throws Exception { return sync(c, 5); }
    private <T> T sync(Callable<T> c, int seconds) throws Exception {
        try {
            return Bukkit.getScheduler().callSyncMethod(plugin, c).get(seconds, TimeUnit.SECONDS);
        } catch (java.util.concurrent.ExecutionException e) {
            if (e.getCause() instanceof IllegalArgumentException) throw (IllegalArgumentException) e.getCause();
            throw e;
        }
    }

    private JsonObject readBody(HttpExchange ex) throws Exception {
        try (InputStream in = ex.getRequestBody()) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[8192]; int n, total = 0;
            while ((n = in.read(buf)) > 0) { total += n; if (total > MAX_BODY) throw new IllegalArgumentException("request too large"); bo.write(buf, 0, n); }
            String s = bo.toString("UTF-8");
            if (s.isEmpty()) return new JsonObject();
            JsonElement e = new JsonParser().parse(s);
            if (!e.isJsonObject()) throw new IllegalArgumentException("body must be a JSON object");
            return e.getAsJsonObject();
        } catch (JsonParseException e) {
            throw new IllegalArgumentException("invalid JSON: " + e.getMessage());
        }
    }

    private static String reqStr(JsonObject b, String k) {
        if (!b.has(k) || b.get(k).isJsonNull()) throw new IllegalArgumentException("missing '" + k + "'");
        return b.get(k).getAsString();
    }
    private static String str(JsonObject b, String k) { return b.has(k) && !b.get(k).isJsonNull() ? b.get(k).getAsString() : null; }
    private static int[] vec(JsonObject b, String k) {
        if (!b.has(k) || !b.get(k).isJsonArray() || b.getAsJsonArray(k).size() != 3) throw new IllegalArgumentException("'" + k + "' must be [x,y,z]");
        JsonArray a = b.getAsJsonArray(k);
        long x = a.get(0).getAsLong(), y = a.get(1).getAsLong(), z = a.get(2).getAsLong();
        if (Math.abs(x) > 29_999_000 || Math.abs(z) > 29_999_000 || y < -64 || y > 320) throw new IllegalArgumentException("'" + k + "' out of world bounds");
        return new int[]{(int) x, (int) y, (int) z};
    }
    private static JsonObject err(String m) { JsonObject o = new JsonObject(); o.addProperty("error", m == null ? "error" : m); return o; }

    private void send(HttpExchange ex, int code, JsonObject o) throws Exception {
        byte[] body = gson.toJson(o).getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json");
        ex.sendResponseHeaders(code, body.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(body); }
    }
    private void safeSend(HttpExchange ex, int code, JsonObject o) { try { send(ex, code, o); } catch (Exception ignored) { ex.close(); } }
}
