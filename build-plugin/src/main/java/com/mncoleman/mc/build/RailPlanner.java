package com.mncoleman.mc.build;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import org.bukkit.Bukkit;
import org.bukkit.ChunkSnapshot;
import org.bukkit.Material;
import org.bukkit.World;

import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Plans a complete minecart line between points: horizontal route (A* over the
 * terrain inside a corridor), a height profile that obeys rail physics (ramps only
 * on straight track, at most one level change per `grade` blocks, flat stations),
 * and every block needed — tunnels with sealed walls and lights, cuts, bridges with
 * supports, beds, powered rails on redstone, and stations with a stop block and a
 * launch button. The output is an ordinary build (same job queue, caps and undo).
 *
 * All world reads happen on chunk snapshots taken on the server thread; the
 * planning itself runs off-thread.
 */
@SuppressWarnings("deprecation")
public final class RailPlanner {

    // Directions: 0=N(-z) 1=E(+x) 2=S(+z) 3=W(-x)
    static final int[] DX = {0, 1, 0, -1}, DZ = {-1, 0, 1, 0};
    static final String[] DIR_NAME = {"north", "east", "south", "west"};

    public static final class Params {
        public String world;
        public List<int[]> points = new ArrayList<>(); // [x, y|MIN, z]; first=from, last=to, middle=waypoints
        public String style = "auto";                   // auto | surface | tunnel | elevated
        public int depth = 12;                          // tunnel: blocks below the (smoothed) surface
        public Integer level = null;                    // tunnel: fixed track y instead of following terrain
        public int grade = 3;                           // blocks per 1-block level change (2..8)
        public int width = 3;                           // tunnel width: 1 or 3
        public int clearance = 4;                       // elevated: track height above ground
        public BlockSpec lining, light, bed;
        public boolean fullLining = false;              // false = only seal hazards/openings
        public boolean shuttle = false;                 // true = ends bounce forever (auto loop)
        public int band = 32;                           // corridor half-width the route may wander in
    }

    public static final class Plan {
        public final String id; public final String world; public final long created = System.currentTimeMillis();
        public int[] xs, ys, zs; public int[] railId; public byte[] railData; public boolean[] mustBePowered;
        public volatile LinkedHashMap<Long, Ops.Placement> ops; // null once built (single-use)
        public JsonObject preview;
        Plan(String id, String world) { this.id = id; this.world = world; }
    }

    private static final AtomicLong SEQ = new AtomicLong(System.currentTimeMillis() / 1000);
    public static final Map<String, Plan> PLANS = new ConcurrentHashMap<>();
    public static final long TTL_MS = 15 * 60_000L; // plans go stale as players build; single-use, 15 min

    // ── terrain ───────────────────────────────────────────────────────────────
    static final class Terrain {
        final Map<Long, ChunkSnapshot> snaps;
        final Map<Long, Integer> groundCache = new HashMap<>();
        Terrain(Map<Long, ChunkSnapshot> s) { snaps = s; }
        static long ck(int cx, int cz) { return (((long) cx) << 32) ^ (cz & 0xFFFFFFFFL); }
        ChunkSnapshot snap(int x, int z) { return snaps.get(ck(x >> 4, z >> 4)); }
        boolean known(int x, int z) { return snap(x, z) != null; }
        int id(int x, int y, int z) { if (y < 0 || y > 255) return 0; ChunkSnapshot s = snap(x, z); return s == null ? 1 : s.getBlockTypeId(x & 15, y, z & 15); }
        Material mat(int x, int y, int z) { Material m = Material.getMaterial(id(x, y, z)); return m == null ? Material.STONE : m; }
        int ground(int x, int z) {
            long k = Ops.key(x, 0, z);
            Integer g = groundCache.get(k);
            if (g != null) return g;
            ChunkSnapshot s = snap(x, z);
            int y = 64;
            if (s != null) {
                y = Math.min(255, s.getHighestBlockYAt(x & 15, z & 15));
                while (y > 0) {
                    Material m = Material.getMaterial(s.getBlockTypeId(x & 15, y, z & 15));
                    if (m != null && !Scanner.NOT_GROUND.contains(m)) break;
                    y--;
                }
            }
            groundCache.put(k, y);
            return y;
        }
        boolean isWater(int x, int y, int z) { Material m = mat(x, y, z); return m == Material.WATER || m == Material.STATIONARY_WATER; }
        /** Top SOLID ground (seabed / lakebed under water). */
        int solid(int x, int z) {
            int y = ground(x, z);
            while (y > 0 && fluid(mat(x, y, z))) y--;
            while (y > 0 && Scanner.NOT_GROUND.contains(mat(x, y, z))) y--;
            return y;
        }
    }

    static boolean fluid(Material m) { return m == Material.WATER || m == Material.STATIONARY_WATER || m == Material.LAVA || m == Material.STATIONARY_LAVA; }
    static boolean gravity(Material m) { return m == Material.SAND || m == Material.GRAVEL || m == Material.CONCRETE_POWDER; }

    /** Chunks the planner needs: a corridor `band` wide around each leg (plus margin). */
    static Set<Long> corridorChunks(Params p) {
        Set<Long> out = new HashSet<>();
        int r = p.band + 8;
        for (int i = 0; i + 1 < p.points.size(); i++) {
            int[] a = p.points.get(i), b = p.points.get(i + 1);
            double len = Math.hypot(b[0] - a[0], b[2] - a[2]);
            int steps = Math.max(1, (int) Math.ceil(len / 8));
            for (int s = 0; s <= steps; s++) {
                int x = (int) Math.round(a[0] + (b[0] - a[0]) * (double) s / steps);
                int z = (int) Math.round(a[2] + (b[2] - a[2]) * (double) s / steps);
                for (int cx = (x - r) >> 4; cx <= (x + r) >> 4; cx++)
                    for (int cz = (z - r) >> 4; cz <= (z + r) >> 4; cz++) out.add(Terrain.ck(cx, cz));
            }
        }
        return out;
    }

    /** Snapshot chunks on the server thread, a few per tick (never generates new terrain). */
    static CompletableFuture<Map<Long, ChunkSnapshot>> loadSnapshots(ClaudeBuildPlugin plugin, World w, Set<Long> keys) {
        CompletableFuture<Map<Long, ChunkSnapshot>> f = new CompletableFuture<>();
        // Caller gave up (timeout) → stop loading.
        Iterator<Long> it = new ArrayList<>(keys).iterator();
        Map<Long, ChunkSnapshot> out = new HashMap<>();
        final int[] task = {-1};
        task[0] = Bukkit.getScheduler().runTaskTimer(plugin, () -> {
            try {
                if (f.isDone()) { Bukkit.getScheduler().cancelTask(task[0]); return; }
                long until = System.nanoTime() + 6_000_000L; // ≤6 ms of main-thread time per tick
                while (it.hasNext() && System.nanoTime() < until) {
                    long k = it.next();
                    int cx = (int) (k >> 32), cz = (int) k;
                    if (!w.isChunkLoaded(cx, cz) && !w.loadChunk(cx, cz, false)) continue; // ungenerated: unknown
                    out.put(k, w.getChunkAt(cx, cz).getChunkSnapshot(true, false, false));
                }
                if (!it.hasNext()) { Bukkit.getScheduler().cancelTask(task[0]); f.complete(out); }
            } catch (Throwable t) { Bukkit.getScheduler().cancelTask(task[0]); f.completeExceptionally(t); }
        }, 1L, 1L).getTaskId();
        return f;
    }

    // ── planning ──────────────────────────────────────────────────────────────
    public static Plan plan(Params p, Map<Long, ChunkSnapshot> snaps) {
        Terrain t = new Terrain(snaps);
        for (int[] pt : p.points) {
            if (!t.known(pt[0], pt[2])) throw new IllegalArgumentException("point " + pt[0] + "," + pt[2] + " is in ungenerated terrain");
        }
        // 1. Horizontal route, leg by leg.
        List<int[]> path = new ArrayList<>(); // [x, z]
        List<Integer> pointIdx = new ArrayList<>();
        for (int i = 0; i + 1 < p.points.size(); i++) {
            int[] a = p.points.get(i), b = p.points.get(i + 1);
            List<int[]> leg = astar(t, p, a, b, path.isEmpty() ? -1 : dirOf(path));
            if (leg == null) throw new IllegalArgumentException("no route found from " + a[0] + "," + a[2] + " to " + b[0] + "," + b[2]
                + " inside the corridor (unexplored terrain, or the corridor is too narrow — try a waypoint or a wider band)");
            if (path.isEmpty()) { pointIdx.add(0); path.addAll(leg); }
            else { path.addAll(leg.subList(1, leg.size())); }
            pointIdx.add(path.size() - 1);
        }
        int n = path.size();
        if (n < 14) throw new IllegalArgumentException("the two ends are too close for a cart line (need at least ~14 blocks of track)");
        if (n > 4000) throw new IllegalArgumentException("route is " + n + " blocks; max 4000 — split it with waypoints into separate lines");

        int[] xs = new int[n], zs = new int[n], g = new int[n], gs = new int[n];
        for (int i = 0; i < n; i++) { xs[i] = path.get(i)[0]; zs[i] = path.get(i)[1]; g[i] = t.ground(xs[i], zs[i]); gs[i] = t.solid(xs[i], zs[i]); }
        int[] din = new int[n], dout = new int[n]; // direction into / out of each cell
        for (int i = 0; i < n; i++) {
            dout[i] = i + 1 < n ? dirBetween(xs[i], zs[i], xs[i + 1], zs[i + 1]) : (i > 0 ? dirBetween(xs[i - 1], zs[i - 1], xs[i], zs[i]) : 0);
            din[i] = i > 0 ? dirBetween(xs[i - 1], zs[i - 1], xs[i], zs[i]) : dout[i];
        }
        boolean[] straight = new boolean[n];
        for (int i = 0; i < n; i++) straight[i] = din[i] == dout[i];

        // 2. Target height per cell, by style.
        double[] target = new double[n];
        int[] smooth = smoothGround(g, 10), smoothSolid = smoothGround(gs, 10);
        for (int i = 0; i < n; i++) {
            switch (p.style) {
                case "surface": target[i] = g[i] + 1; break;
                case "elevated": target[i] = smooth[i] + 1 + p.clearance; break;
                case "tunnel": target[i] = p.level != null ? p.level : smoothSolid[i] + 1 - p.depth; break; // depth below land / seabed
                default: target[i] = smooth[i] + 1; // auto: a smoothed line — tunnels through bumps, bridges dips
            }
            target[i] = Math.max(6, Math.min(250, target[i]));
        }
        // Pins: each given point. Ends default to the surface (stations), waypoints float unless y given.
        Map<Integer, Integer> pins = new TreeMap<>();
        for (int k = 0; k < p.points.size(); k++) {
            int[] pt = p.points.get(k);
            int idx = pointIdx.get(k);
            boolean end = k == 0 || k == p.points.size() - 1;
            if (pt[1] != Integer.MIN_VALUE) pins.put(idx, Math.max(6, Math.min(250, pt[1])));
            else if (end) pins.put(idx, g[idx] + 1);
        }

        // 3. Height profile obeying ramp rules.
        int[] ys = profile(n, straight, target, pins, Math.max(2, Math.min(8, p.grade)));

        // 4. Geometry → blocks.
        Plan plan = new Plan("r" + SEQ.incrementAndGet(), p.world);
        plan.xs = xs; plan.ys = ys; plan.zs = zs;
        geometry(plan, p, t, g, gs, din, dout, straight);
        PLANS.values().removeIf(x -> System.currentTimeMillis() - x.created > TTL_MS);
        while (PLANS.size() >= 5) {
            PLANS.values().stream().min(Comparator.comparingLong(x -> x.created)).ifPresent(x -> PLANS.remove(x.id));
        }
        PLANS.put(plan.id, plan);
        return plan;
    }

    static int dirBetween(int x1, int z1, int x2, int z2) {
        if (x2 > x1) return 1; if (x2 < x1) return 3; if (z2 > z1) return 2; return 0;
    }
    static int dirOf(List<int[]> path) {
        int n = path.size();
        return n < 2 ? -1 : dirBetween(path.get(n - 2)[0], path.get(n - 2)[1], path.get(n - 1)[0], path.get(n - 1)[1]);
    }

    static int[] smoothGround(int[] g, int r) {
        int n = g.length; int[] out = new int[n];
        for (int i = 0; i < n; i++) {
            long s = 0; int c = 0;
            for (int j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) { s += g[j]; c++; }
            out[i] = (int) Math.round((double) s / c);
        }
        return out;
    }

    // ── A* (cardinal moves, turn penalty, terrain-aware) ──────────────────────
    private static final class Node implements Comparable<Node> {
        final int x, z, dir; final double g, f; final Node parent;
        Node(int x, int z, int dir, double g, double f, Node parent) { this.x = x; this.z = z; this.dir = dir; this.g = g; this.f = f; this.parent = parent; }
        public int compareTo(Node o) { return Double.compare(f, o.f); }
    }

    static List<int[]> astar(Terrain t, Params p, int[] a, int[] b, int startDir) {
        int sx = a[0], sz = a[2], gx = b[0], gz = b[2];
        PriorityQueue<Node> open = new PriorityQueue<>();
        Map<Long, Double> best = new HashMap<>();
        open.add(new Node(sx, sz, startDir, 0, Math.abs(gx - sx) + Math.abs(gz - sz), null));
        best.put(Ops.key(sx, startDir < 0 ? 4 : startDir, sz), 0.0);
        int expanded = 0;
        double segLen = Math.hypot(gx - sx, gz - sz);
        while (!open.isEmpty()) {
            Node cur = open.poll();
            if (cur.x == gx && cur.z == gz) {
                LinkedList<int[]> out = new LinkedList<>();
                for (Node q = cur; q != null; q = q.parent) out.addFirst(new int[]{q.x, q.z});
                return out;
            }
            Double bestG = best.get(Ops.key(cur.x, cur.dir < 0 ? 4 : cur.dir, cur.z));
            if (bestG != null && cur.g > bestG) continue;             // superseded entry
            if (++expanded > 600_000) return null;
            for (int d = 0; d < 4; d++) {
                if (cur.dir >= 0 && d == (cur.dir + 2) % 4) continue; // no U-turns
                int nx = cur.x + DX[d], nz = cur.z + DZ[d];
                if (!t.known(nx, nz)) continue;
                if (distToSegment(nx, nz, sx, sz, gx, gz, segLen) > p.band) continue;
                double step = 1 + terrainCost(t, p, cur.x, cur.z, nx, nz);
                if (cur.dir >= 0 && d != cur.dir) step += 3; // prefer long straights (ramps + powered rails need them)
                double ng = cur.g + step;
                long key = Ops.key(nx, d, nz); // y field carries the direction
                Double prev = best.get(key);
                if (prev != null && prev <= ng) continue;
                best.put(key, ng);
                open.add(new Node(nx, nz, d, ng, ng + Math.abs(gx - nx) + Math.abs(gz - nz), cur));
            }
        }
        return null;
    }

    static double distToSegment(int px, int pz, int ax, int az, int bx, int bz, double len) {
        if (len < 1e-6) return Math.hypot(px - ax, pz - az);
        double u = ((px - ax) * (double) (bx - ax) + (pz - az) * (double) (bz - az)) / (len * len);
        u = Math.max(0, Math.min(1, u));
        return Math.hypot(px - (ax + u * (bx - ax)), pz - (az + u * (bz - az)));
    }

    static double terrainCost(Terrain t, Params p, int x1, int z1, int x2, int z2) {
        int dg = Math.abs(t.ground(x2, z2) - t.ground(x1, z1));
        boolean water = t.isWater(x2, t.ground(x2, z2), z2);
        switch (p.style) {
            case "surface": return 0.8 * dg + (water ? 0.6 : 0);
            case "elevated": return 0.15 * dg;
            case "tunnel": return water ? 0.4 : 0; // prefer running under land over under lakes
            default: return 0.3 * dg + (water ? 0.2 : 0);
        }
    }

    // ── height profile ────────────────────────────────────────────────────────
    /**
     * One level change at most per `k` blocks, only between two straight cells,
     * never within 6 blocks of either end (stations are flat). Pinned cells hit
     * their exact height; between pins the profile tracks `target` as closely as
     * the rules allow while staying able to reach the next pin.
     */
    static int[] profile(int n, boolean[] straight, double[] target, Map<Integer, Integer> pins, int k) {
        boolean[] elig = new boolean[n]; // change allowed between i and i+1
        for (int i = 0; i + 1 < n; i++) elig[i] = straight[i] && straight[i + 1] && i >= 6 && i + 1 <= n - 7;
        int[] y = new int[n];
        List<Integer> pinIdx = new ArrayList<>(pins.keySet());
        for (int s = 0; s + 1 < pinIdx.size(); s++) {
            int a = pinIdx.get(s), b = pinIdx.get(s + 1);
            int ya = pins.get(a), yb = pins.get(b);
            // cap[i]: max level changes possible in [i, b) with spacing k.
            int[] cap = new int[b - a + k + 2];
            for (int i = b - 1; i >= a; i--) {
                int r = i - a;
                int skip = cap[r + 1];
                int take = elig[i] ? 1 + (r + k < cap.length ? cap[Math.min(cap.length - 1, r + k)] : 0) : 0;
                cap[r] = Math.max(skip, take);
            }
            if (Math.abs(yb - ya) > cap[0]) {
                throw new IllegalArgumentException("can't change height by " + Math.abs(yb - ya) + " blocks between blocks " + a + " and " + b
                    + " of the route at grade 1-in-" + k + " (room for " + cap[0] + "). Use a steeper grade, a longer route, or a closer height.");
            }
            int cur = ya, last = -1_000_000;
            y[a] = ya;
            for (int i = a; i < b; i++) {
                int r = i - a;
                int need = yb - cur;
                int capAfterSkip = cap[r + 1];
                boolean canChange = elig[i] && i - last >= k;
                int step = 0;
                if (canChange) {
                    int capAfterTake = r + k < cap.length ? cap[Math.min(cap.length - 1, r + k)] : 0;
                    if (Math.abs(need) > capAfterSkip) {
                        step = Integer.signum(need);                       // must move now
                    } else {
                        double want = target[Math.min(n - 1, i + 1)] - cur;
                        int s2 = want >= 1 ? 1 : (want <= -1 ? -1 : 0);
                        if (s2 != 0 && Math.abs(yb - (cur + s2)) <= capAfterTake) step = s2;
                    }
                }
                if (step != 0) { cur += step; last = i; }
                y[i + 1] = cur;
            }
            if (cur != yb) throw new IllegalArgumentException("height profile couldn't land on the target height near block " + b + " — try a steeper grade");
        }
        return y;
    }

    // ── geometry ──────────────────────────────────────────────────────────────
    private static final class Out {
        final LinkedHashMap<Long, Ops.Placement> m = new LinkedHashMap<>();
        void put(int x, int y, int z, BlockSpec b) {
            if (y < 0 || y > 255) return;
            long k = Ops.key(x, y, z);
            m.remove(k);                       // re-insert at the end: later phases run later
            m.put(k, new Ops.Placement(x, y, z, b));
        }
    }

    static void geometry(Plan plan, Params p, Terrain t, int[] g, int[] gs, int[] din, int[] dout, boolean[] straight) {
        int n = plan.xs.length;
        int[] xs = plan.xs, ys = plan.ys, zs = plan.zs;
        BlockSpec air = BlockSpec.parse("air"), rail = BlockSpec.parse("rail"), redstone = BlockSpec.parse("redstone_block");
        BlockSpec button = BlockSpec.parse("stone_button:5");

        // Classify each cell.
        String[] kind = new String[n];
        int cTunnel = 0, cCut = 0, cBridge = 0, cSurface = 0;
        for (int i = 0; i < n; i++) {
            if (gs[i] >= ys[i] + 3) { kind[i] = "tunnel"; cTunnel++; }
            else if (gs[i] >= ys[i]) { kind[i] = "cut"; cCut++; }
            else if (g[i] < ys[i] - 1) { kind[i] = "bridge"; cBridge++; }
            else { kind[i] = "surface"; cSurface++; }
        }

        // Station braking zones: up to 3 straight cells at each end (powered rails,
        // unpowered → they brake an arriving cart; the button launches it).
        int brakeStart = 1; while (brakeStart < 3 && brakeStart < n && straight[brakeStart] && ys[brakeStart] == ys[0]) brakeStart++;
        int brakeEnd = 1; while (brakeEnd < 3 && n - 1 - brakeEnd >= 0 && straight[n - 1 - brakeEnd] && ys[n - 1 - brakeEnd] == ys[n - 1]) brakeEnd++;
        boolean[] braking = new boolean[n];
        for (int i = 0; i < brakeStart; i++) braking[i] = true;
        for (int i = n - brakeEnd; i < n; i++) braking[i] = true;

        // Powered rails: every ramp, the flats between close ramps, and one every 24
        // on long flats. Each gets a redstone block underneath (always on).
        boolean[] powered = new boolean[n];
        boolean[] ramp = new boolean[n];
        for (int i = 0; i + 1 < n; i++) {
            if (ys[i + 1] > ys[i]) ramp[i] = true;
            if (ys[i + 1] < ys[i]) ramp[i + 1] = true;
        }
        int lastRamp = -100;
        for (int i = 0; i < n; i++) {
            if (!ramp[i]) continue;
            powered[i] = true;
            if (i - lastRamp <= 8) for (int j = lastRamp + 1; j < i; j++) if (straight[j]) powered[j] = true;
            lastRamp = i;
        }
        int sinceBoost = 0;
        for (int i = 0; i < n; i++) {
            if (powered[i]) { sinceBoost = 0; continue; }
            sinceBoost++;
            boolean awayFromEnds = i >= brakeStart + 3 && i <= n - brakeEnd - 4;
            if (sinceBoost >= 24 && straight[i] && awayFromEnds) { powered[i] = true; sinceBoost = 0; }
        }
        // First boost right after the departure brake zone so a launched cart keeps going.
        for (int i = brakeStart + 3; i < Math.min(n - brakeEnd - 4, brakeStart + 10); i++) if (straight[i]) { powered[i] = true; break; }
        for (int i = n - brakeEnd - 4; i > Math.max(brakeStart + 3, n - brakeEnd - 11); i--) if (straight[i]) { powered[i] = true; break; }
        for (int i = 0; i < n; i++) if (braking[i]) powered[i] = false;

        // Rail id/data per cell.
        plan.railId = new int[n]; plan.railData = new byte[n]; plan.mustBePowered = new boolean[n];
        int poweredCount = 0, ramps = 0;
        for (int i = 0; i < n; i++) {
            int data;
            boolean up = i + 1 < n && ys[i + 1] > ys[i];
            boolean upBack = i > 0 && ys[i - 1] > ys[i];
            if (up) { data = ascending(dout[i]); ramps++; }
            else if (upBack) { data = ascending((din[i] + 2) % 4); ramps++; }
            else if (straight[i]) data = (dout[i] == 0 || dout[i] == 2) ? 0 : 1;
            else data = curve((din[i] + 2) % 4, dout[i]);
            boolean pw = (powered[i] || braking[i]) && data <= 5;
            plan.railId[i] = pw ? Material.POWERED_RAIL.getId() : Material.RAILS.getId();
            plan.railData[i] = (byte) data;
            plan.mustBePowered[i] = pw && (powered[i] || p.shuttle);
            if (pw && !braking[i]) poweredCount++;
        }

        // Positions that will be air / rail / bed (excluded from shells).
        Set<Long> carved = new HashSet<>(), beds = new HashSet<>(), rails = new HashSet<>();
        int half = p.width >= 3 ? 1 : 0;
        for (int i = 0; i < n; i++) {
            int h = "tunnel".equals(kind[i]) ? half : 0;
            for (int ox = -h; ox <= h; ox++) for (int oz = -h; oz <= h; oz++) for (int dy = 0; dy <= 2; dy++)
                carved.add(Ops.key(xs[i] + ox, ys[i] + dy, zs[i] + oz));
            beds.add(Ops.key(xs[i], ys[i] - 1, zs[i]));
            rails.add(Ops.key(xs[i], ys[i], zs[i]));
        }
        // Stop blocks beyond each end.
        int[] stopA = {xs[0] - DX[dout[0]], ys[0], zs[0] - DZ[dout[0]]};
        int[] stopB = {xs[n - 1] + DX[din[n - 1]], ys[n - 1], zs[n - 1] + DZ[din[n - 1]]};

        Out out = new Out();
        int sealedWater = 0, sealedLava = 0, sealedGravity = 0, sealedOpen = 0;

        // Phase 1: shell — seal hazards next to anything we hollow out; in tunnels
        // also close cave openings (and with full lining, face every wall).
        Set<Long> shellDone = new HashSet<>();
        int[][] nb = {{1, 0, 0}, {-1, 0, 0}, {0, 0, 1}, {0, 0, -1}, {0, 1, 0}};
        for (int i = 0; i < n; i++) {
            boolean tunnel = "tunnel".equals(kind[i]);
            int h = tunnel ? half : 0;
            for (int ox = -h; ox <= h; ox++) for (int oz = -h; oz <= h; oz++) for (int dy = 0; dy <= 2; dy++) {
                int cx = xs[i] + ox, cy = ys[i] + dy, cz = zs[i] + oz;
                for (int[] d : nb) {
                    int x = cx + d[0], y = cy + d[1], z = cz + d[2];
                    long k = Ops.key(x, y, z);
                    if (carved.contains(k) || beds.contains(k) || rails.contains(k) || !shellDone.add(k)) continue;
                    Material m = t.mat(x, y, z);
                    boolean place = false;
                    if (m == Material.WATER || m == Material.STATIONARY_WATER) { place = true; sealedWater++; }
                    else if (m == Material.LAVA || m == Material.STATIONARY_LAVA) { place = true; sealedLava++; }
                    else if (gravity(m)) { place = true; sealedGravity++; }
                    else if (tunnel && (m == Material.AIR || !m.isSolid())) { place = true; sealedOpen++; }
                    else if (tunnel && p.fullLining) place = true;
                    if (place) out.put(x, y, z, p.lining);
                }
            }
            // Tunnel floor beside the track: walkable.
            if (tunnel) for (int ox = -h; ox <= h; ox++) for (int oz = -h; oz <= h; oz++) {
                if (ox == 0 && oz == 0) continue;
                int x = xs[i] + ox, y = ys[i] - 1, z = zs[i] + oz;
                long k = Ops.key(x, y, z);
                if (carved.contains(k) || beds.contains(k)) continue;
                Material m = t.mat(x, y, z);
                if (!m.isSolid() || fluid(m) || gravity(m) || p.fullLining) out.put(x, y, z, p.lining);
            }
            // Lights in tunnel ceilings.
            if (tunnel && i % 8 == 4) out.put(xs[i], ys[i] + 3, zs[i], p.light);
            // Bridge supports down to the ground every 6 blocks.
            if ("bridge".equals(kind[i]) && i % 6 == 0) {
                for (int y = ys[i] - 2; y > gs[i] && y > ys[i] - 66; y--) out.put(xs[i], y, zs[i], p.lining); // down to the real bottom
            }
        }
        // Phase 2: hollow out.
        for (long k : carved) {
            if (rails.contains(k)) continue;
            int x = (int) (k >> 38), z = (int) ((k >> 12) & 0x3FFFFFF), y = (int) (k & 0xFFF);
            x = (x << 6) >> 6; z = (z << 6) >> 6; // sign-extend 26-bit
            if (t.id(x, y, z) != 0) out.put(x, y, z, air);
        }
        // Phase 3: beds (solid), redstone under powered rails.
        for (int i = 0; i < n; i++) {
            int x = xs[i], y = ys[i] - 1, z = zs[i];
            if (plan.mustBePowered[i] && !braking[i]) { out.put(x, y, z, redstone); continue; }
            if (braking[i] && p.shuttle) { out.put(x, y, z, redstone); continue; }
            Material m = t.mat(x, y, z);
            boolean replaced = carved.contains(Ops.key(x, y, z));
            if (replaced || !m.isSolid() || fluid(m) || gravity(m) || m == Material.LEAVES || m == Material.LEAVES_2 || m == Material.ICE)
                out.put(x, y, z, p.bed);
        }
        // Phase 4: rails.
        for (int i = 0; i < n; i++) out.put(xs[i], ys[i], zs[i], specOf(plan.railId[i], plan.railData[i]));
        // Phase 5: stations — stop block (+ support) and a launch button on top.
        for (int[] s : new int[][]{stopA, stopB}) {
            out.put(s[0], s[1] - 1, s[2], p.bed);
            out.put(s[0], s[1], s[2], p.lining);
            out.put(s[0], s[1] + 1, s[2], p.shuttle ? air : button);
            out.put(s[0], s[1] + 2, s[2], air);
        }
        out.m.values().removeIf(pl -> !t.known(pl.x, pl.z)); // never force terrain generation
        plan.ops = out.m;

        // Preview.
        int ymin = Integer.MAX_VALUE, ymax = Integer.MIN_VALUE, climb = 0, descent = 0, turns = 0;
        for (int i = 0; i < n; i++) {
            ymin = Math.min(ymin, ys[i]); ymax = Math.max(ymax, ys[i]);
            if (i > 0) { if (ys[i] > ys[i - 1]) climb += ys[i] - ys[i - 1]; else descent += ys[i - 1] - ys[i]; }
            if (!straight[i]) turns++;
        }
        JsonObject pv = new JsonObject();
        pv.addProperty("plan_id", plan.id);
        pv.addProperty("world", plan.world);
        pv.addProperty("style", p.style);
        pv.addProperty("track_length", n);
        pv.addProperty("ride_seconds_approx", Math.round(n / 8.0 + 2));
        pv.addProperty("turns", turns);
        pv.addProperty("ramps", ramps);
        pv.addProperty("y_min", ymin); pv.addProperty("y_max", ymax);
        pv.addProperty("total_climb", climb); pv.addProperty("total_descent", descent);
        JsonObject seg = new JsonObject();
        seg.addProperty("surface", cSurface); seg.addProperty("cutting", cCut); seg.addProperty("tunnel", cTunnel); seg.addProperty("bridge", cBridge);
        pv.add("blocks_by_terrain", seg);
        JsonObject hz = new JsonObject();
        hz.addProperty("water_sealed", sealedWater); hz.addProperty("lava_sealed", sealedLava);
        hz.addProperty("sand_gravel_shored", sealedGravity); hz.addProperty("cave_openings_closed", sealedOpen);
        pv.add("hazards", hz);
        pv.addProperty("boost_rails", poweredCount);
        pv.addProperty("blocks_to_change", plan.ops.size());
        pv.add("start_station", station(xs[0], ys[0], zs[0], stopA, dout[0]));
        pv.add("end_station", station(xs[n - 1], ys[n - 1], zs[n - 1], stopB, (din[n - 1] + 2) % 4));
        JsonArray corners = new JsonArray();
        for (int i = 0; i < n; i++) if (i == 0 || i == n - 1 || !straight[i] || (i > 0 && ys[i] != ys[i - 1] && (i + 1 >= n || ys[i + 1] == ys[i]))) corners.add(triple(xs[i], ys[i], zs[i]));
        pv.add("route_points", corners);
        StringBuilder prof = new StringBuilder();
        int stepS = Math.max(1, n / 40);
        for (int i = 0; i < n; i += stepS) prof.append(i).append(':').append(ys[i]).append('(').append(kind[i].charAt(0)).append(") ");
        pv.addProperty("height_profile", prof.toString().trim() + "   [block index:track y(kind s/c/t/b)]");
        pv.addProperty("ends", p.shuttle ? "shuttle — carts bounce between the ends forever" : "stations — arriving carts brake at the stop block; press the button on top of the stop block to launch");
        plan.preview = pv;
    }

    static JsonObject station(int x, int y, int z, int[] stop, int facing) {
        JsonObject o = new JsonObject();
        o.add("track_end", triple(x, y, z));
        o.add("stop_block", triple(stop[0], stop[1], stop[2]));
        o.add("button", triple(stop[0], stop[1] + 1, stop[2]));
        o.addProperty("departs_toward", DIR_NAME[facing]);
        return o;
    }

    static JsonArray triple(int a, int b, int c) { JsonArray x = new JsonArray(); x.add(new JsonPrimitive(a)); x.add(new JsonPrimitive(b)); x.add(new JsonPrimitive(c)); return x; }

    /** Rail data for a ramp rising toward direction d. */
    static int ascending(int d) { switch (d) { case 1: return 2; case 3: return 3; case 0: return 4; default: return 5; } }

    /** Curve connecting directions a and b (each the side the neighbour is on). */
    static int curve(int a, int b) {
        boolean n = a == 0 || b == 0, e = a == 1 || b == 1, s = a == 2 || b == 2, w = a == 3 || b == 3;
        if (s && e) return 6; if (s && w) return 7; if (n && w) return 8; if (n && e) return 9;
        return (a == 0 || a == 2) ? 0 : 1;
    }

    static BlockSpec specOf(int id, byte data) {
        return BlockSpec.parse(id + ":" + data);
    }
}
