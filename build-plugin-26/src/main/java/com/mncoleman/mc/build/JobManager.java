package com.mncoleman.mc.build;

import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.Tag;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.data.BlockData;
import org.bukkit.block.data.MultipleFacing;
import org.bukkit.block.data.Rail;
import org.bukkit.block.data.type.Fence;
import org.bukkit.block.data.type.RedstoneWire;
import org.bukkit.block.data.type.Stairs;
import org.bukkit.block.data.type.Wall;

import java.io.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicLong;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

/**
 * Runs build and undo jobs on the server thread, a capped number of blocks per
 * tick, one job at a time (FIFO). Every build writes an undo journal (previous
 * full block state per position) to disk. Containers are NOT protected: replacing
 * one (or undoing over one) discards its contents, exactly like the 1.12 plugin.
 * Undo only reverts positions still holding the block type this job placed, so
 * later edits by players are never clobbered.
 */
public final class JobManager {

    public static final class Job {
        public final String id;
        public final String kind;   // build | undo
        public final String world, actor, label, undoOf;
        public final int[] xs, ys, zs;
        public final BlockData[] datas;      // what this job sets
        public final BlockData[] prevDatas;  // build: what was there before; undo: what we expect to find
        public final boolean[] applied;
        final boolean[] changed;            // this run actually wrote the block (not journaled)
        public final boolean onlyAir;
        public volatile String state = "queued"; // queued | running | done | failed | cancelled
        public volatile int cursor = 0, placed = 0, skippedProtected = 0, skippedUngenerated = 0, skippedOccupied = 0, unchanged = 0;
        public volatile String error;
        public final long createdAt = System.currentTimeMillis();
        public volatile long finishedAt;
        Job(String id, String kind, String world, String actor, String label, String undoOf, int n, boolean onlyAir) {
            this.id = id; this.kind = kind; this.world = world; this.actor = actor; this.label = label; this.undoOf = undoOf;
            xs = new int[n]; ys = new int[n]; zs = new int[n]; datas = new BlockData[n];
            prevDatas = new BlockData[n]; applied = new boolean[n]; changed = new boolean[n]; this.onlyAir = onlyAir;
        }
        public int size() { return xs.length; }
    }

    // Redstone-sensitive / physics blocks: neighbours are notified after the job so
    // powered rails / wire pick up power (placement itself runs without updates).
    private static boolean physicsAfter(Material m) {
        if (Tag.RAILS.isTagged(m) || Tag.BUTTONS.isTagged(m) || BlockSpec.heavy(m)) return true;
        switch (m) {
            case REDSTONE_WIRE: case REDSTONE_TORCH: case REDSTONE_WALL_TORCH: case REDSTONE_BLOCK: case LEVER:
            case REPEATER: case COMPARATOR: case REDSTONE_LAMP: case PISTON: case STICKY_PISTON: case OBSERVER:
            case TARGET: case DAYLIGHT_DETECTOR: case NOTE_BLOCK: case DISPENSER: case DROPPER: case HOPPER:
                return true;
            default: return false;
        }
    }

    private final ClaudeBuildPlugin plugin;
    private final File journalDir;
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();
    private final Queue<Job> queue = new ConcurrentLinkedQueue<>();
    private final AtomicLong seq = new AtomicLong(System.currentTimeMillis() / 1000);
    private volatile Job current;

    public JobManager(ClaudeBuildPlugin plugin) {
        this.plugin = plugin;
        this.journalDir = new File(plugin.getDataFolder(), "undo");
        journalDir.mkdirs();
        Bukkit.getScheduler().runTaskTimer(plugin, this::tick, 1L, 1L);
    }

    public Job get(String id) { return jobs.get(id); }
    public Job current() { return current; }
    public int queued() { return queue.size(); }

    private void checkCapacity(int adding) {
        int queued = queue.size();
        long pending = adding;
        for (Job q : queue) pending += q.size() - q.cursor;
        Job c = current; if (c != null) pending += c.size() - c.cursor;
        if (queued >= 3 || pending > 600_000) throw new IllegalArgumentException("build queue is full (" + queued + " jobs waiting); try again when the current build finishes");
    }

    private static final int MAX_CHUNKS_PER_JOB = 1024;
    private static void checkChunks(Collection<Ops.Placement> ps) {
        Set<Long> chunks = new HashSet<>();
        for (Ops.Placement p : ps) {
            chunks.add((((long) (p.x >> 4)) << 32) ^ ((p.z >> 4) & 0xFFFFFFFFL));
            if (chunks.size() > MAX_CHUNKS_PER_JOB) throw new IllegalArgumentException("build touches more than " + MAX_CHUNKS_PER_JOB + " chunks; split it into smaller builds");
        }
    }

    public synchronized Job submitBuild(String world, String actor, String label, Collection<Ops.Placement> ps, boolean onlyAir) {
        checkCapacity(ps.size());
        checkChunks(ps);
        String id = "b" + seq.incrementAndGet();
        Job j = new Job(id, "build", world, actor, label, null, ps.size(), onlyAir);
        int i = 0;
        for (Ops.Placement p : ps) { j.xs[i] = p.x; j.ys[i] = p.y; j.zs[i] = p.z; j.datas[i] = p.b.data; i++; }
        jobs.put(id, j); queue.add(j);
        return j;
    }

    /** Builds an undo job from a finished build's journal (memory or disk). */
    public synchronized Job submitUndo(String buildId, String actor) throws IOException {
        checkCapacity(0);
        Job b = jobs.get(buildId);
        if (b == null) b = readJournal(buildId);
        if (b == null) throw new IllegalArgumentException("no undo journal for job " + buildId);
        if (!"build".equals(b.kind)) throw new IllegalArgumentException("job " + buildId + " is not a build");
        if (!"done".equals(b.state) && !"cancelled".equals(b.state) && !"failed".equals(b.state))
            throw new IllegalArgumentException("job " + buildId + " is still " + b.state);
        int n = 0; for (int i = 0; i < b.size(); i++) if (b.applied[i] && b.prevDatas[i] != null && b.datas[i] != null) n++;
        String id = "u" + seq.incrementAndGet();
        Job u = new Job(id, "undo", b.world, actor, "undo " + buildId, buildId, n, false);
        int k = 0;
        for (int i = b.size() - 1; i >= 0; i--) {       // reverse order
            if (!b.applied[i] || b.prevDatas[i] == null || b.datas[i] == null) continue;
            u.xs[k] = b.xs[i]; u.ys[k] = b.ys[i]; u.zs[k] = b.zs[i];
            u.datas[k] = b.prevDatas[i];
            u.prevDatas[k] = b.datas[i];   // expected current content
            k++;
        }
        jobs.put(id, u); queue.add(u);
        return u;
    }

    public boolean cancelCurrent() {
        Job j = current;
        if (j == null) return false;
        j.state = "cancelled";
        return true;
    }

    private void tick() {
        Job j = current;
        if (j == null) {
            j = queue.poll();
            if (j == null) return;
            current = j;
            if ("cancelled".equals(j.state)) { finish(j); return; }
            j.state = "running";
            plugin.avatar().jobStarted(j);
        }
        if ("cancelled".equals(j.state)) { finish(j); return; }
        World w = Bukkit.getWorld(j.world);
        if (w == null) { j.error = "world not loaded: " + j.world; j.state = "failed"; finish(j); return; }
        int budget = plugin.getConfig().getInt("blocks-per-tick", 1000);
        int minY = w.getMinHeight(), maxY = w.getMaxHeight() - 1;
        int lastX = 0, lastY = 0, lastZ = 0; boolean any = false;
        try {
            while (budget-- > 0 && j.cursor < j.size()) {
                int i = j.cursor++;
                int x = j.xs[i], y = j.ys[i], z = j.zs[i];
                if (y < minY || y > maxY) { j.skippedOccupied++; continue; }
                int cx = x >> 4, cz = z >> 4;
                if (!Scanner.ensureChunk(w, cx, cz)) { j.skippedUngenerated++; continue; }
                Block b = w.getBlockAt(x, y, z);
                BlockData cur = b.getBlockData();
                if ("undo".equals(j.kind)) {
                    // Only revert what we placed; anything changed since stays.
                    if (!sameAsPlaced(cur, j.prevDatas[i])) { j.skippedOccupied++; continue; }
                } else {
                    // No container protection (owner's call, 2026-11-12): chests, dispensers,
                    // signs etc. are replaced like any block; their contents are lost.
                    if (j.onlyAir && !cur.getMaterial().isAir()) { j.skippedOccupied++; continue; }
                    j.prevDatas[i] = cur;
                }
                if (cur.equals(j.datas[i])) { j.unchanged++; j.applied[i] = "build".equals(j.kind); continue; }
                b.setBlockData(j.datas[i], false);
                j.applied[i] = true; j.changed[i] = true; j.placed++;
                lastX = x; lastY = y; lastZ = z; any = true;
            }
        } catch (Throwable t) {
            j.error = t.toString(); j.state = "failed";
        }
        if (any) plugin.avatar().progress(j, w, lastX, lastY, lastZ);
        if (j.cursor >= j.size() || "failed".equals(j.state)) {
            if (!"failed".equals(j.state)) { applyPhysics(w, j); j.state = "done"; }
            finish(j);
        }
    }

    private void finish(Job j) {
        j.finishedAt = System.currentTimeMillis();
        current = null;
        plugin.avatar().jobFinished(j);
        if ("build".equals(j.kind)) {
            try { writeJournal(j); } catch (IOException e) { plugin.getLogger().warning("undo journal write failed for " + j.id + ": " + e); }
        }
        // Keep memory bounded: drop old finished jobs (journals stay on disk).
        if (jobs.size() > 200) {
            jobs.values().stream().filter(x -> x.finishedAt > 0).sorted(Comparator.comparingLong(x -> x.finishedAt))
                .limit(jobs.size() - 150).map(x -> x.id).forEach(jobs::remove);
        }
    }

    /**
     * Does the current block still look like what the build placed? Modern blocks
     * keep power, rail shape, fence/wall/pane connections, stair shape, lit, level
     * etc. in their block state and the game rewrites those on its own, so undo
     * matches by block TYPE (the 1.12 "same family, data may drift" rule, applied
     * to every block).
     */
    private static boolean sameAsPlaced(BlockData cur, BlockData placed) {
        return placed != null && cur.getMaterial() == placed.getMaterial();
    }

    /**
     * Blocks whose state depends on neighbours (fence/wall/pane connections, stair
     * corners, wire). Placement runs without updates, so these are re-placed with
     * updates afterwards. Doors, beds, tall plants and chests are deliberately NOT
     * here: a shape update can delete a lone door/bed half, and chests only pair
     * via explicit type=left/right.
     */
    private static boolean connecting(BlockData d) {
        return d instanceof Fence || d instanceof Wall || d instanceof Stairs || d instanceof RedstoneWire
            || (d instanceof MultipleFacing && !(d instanceof org.bukkit.block.data.Bisected))
            || Tag.FENCES.isTagged(d.getMaterial()) || Tag.WALLS.isTagged(d.getMaterial());
    }

    private void applyPhysics(World w, Job j) {
        restoreRailShapes(w, j);
        // Re-place redstone-sensitive / falling / fluid / connecting blocks WITH updates
        // (via air, since re-setting an identical state is a no-op). This powers rails
        // sitting on redstone, connects fences/panes/walls, shapes stairs, lets sand
        // fall and water flow. Rails themselves are skipped: placing a rail with
        // updates re-runs its auto-shaping; they get power from the neighbour update.
        // Only positions this job actually wrote are touched (never a pre-existing
        // container that happened to match).
        // Undo also re-places (with updates) where it REMOVED such a block, so e.g.
        // water that flowed from a removed source dries up and neighbouring fences
        // disconnect. Builds don't: clearing a lake with air must not let it flow back.
        boolean undo = "undo".equals(j.kind);
        for (int i = 0; i < j.size(); i++) {
            BlockData d = j.datas[i];
            if (!j.changed[i] || d == null || Tag.RAILS.isTagged(d.getMaterial())) continue;
            BlockData removed = undo ? j.prevDatas[i] : null;
            boolean need = physicsAfter(d.getMaterial()) || connecting(d)
                || (removed != null && (physicsAfter(removed.getMaterial()) || connecting(removed)));
            if (!need) continue;
            Block b = w.getBlockAt(j.xs[i], j.ys[i], j.zs[i]);
            if (b.getType() != d.getMaterial()) continue;
            try {
                BlockData now = b.getBlockData();
                b.setType(now.getMaterial().isAir() ? Material.STONE : Material.AIR, false);
                b.setBlockData(now, true);
            } catch (Throwable ignored) {}
        }
        restoreRailShapes(w, j);
    }

    /** Rails auto-shape against neighbours; put back the planned shape (shape only — power is the game's). */
    private static void restoreRailShapes(World w, Job j) {
        for (int i = 0; i < j.size(); i++) {
            if (!j.changed[i] || !(j.datas[i] instanceof Rail want)) continue;
            Block b = w.getBlockAt(j.xs[i], j.ys[i], j.zs[i]);
            if (b.getType() != want.getMaterial() || !(b.getBlockData() instanceof Rail have)) continue;
            if (have.getShape() != want.getShape()) { have.setShape(want.getShape()); b.setBlockData(have, false); }
        }
    }

    // ── undo journals ─────────────────────────────────────────────────────────
    // Format "CB26" v1 (gzip): header, then a palette of full block-state strings,
    // then per position x,y,z, placed-index, previous-index (-1 = none), applied.
    private static final int MAGIC = 0x43423236; // "CB26"

    private void writeJournal(Job j) throws IOException {
        File f = new File(journalDir, j.id + ".gz");
        Map<String, Integer> pal = new LinkedHashMap<>();
        int[] cur = new int[j.size()], prev = new int[j.size()];
        for (int i = 0; i < j.size(); i++) {
            cur[i] = j.datas[i] == null ? -1 : pal.computeIfAbsent(j.datas[i].getAsString(), k -> pal.size());
            prev[i] = j.prevDatas[i] == null ? -1 : pal.computeIfAbsent(j.prevDatas[i].getAsString(), k -> pal.size());
        }
        try (DataOutputStream o = new DataOutputStream(new BufferedOutputStream(new GZIPOutputStream(new FileOutputStream(f))))) {
            o.writeInt(MAGIC); o.writeByte(1);
            o.writeUTF(j.world); o.writeUTF(j.actor == null ? "" : j.actor); o.writeUTF(j.label == null ? "" : j.label);
            o.writeUTF(j.state);
            o.writeInt(pal.size());
            for (String s : pal.keySet()) o.writeUTF(s);
            o.writeInt(j.size());
            for (int i = 0; i < j.size(); i++) {
                o.writeInt(j.xs[i]); o.writeShort(j.ys[i]); o.writeInt(j.zs[i]);
                o.writeInt(cur[i]); o.writeInt(prev[i]);
                o.writeBoolean(j.applied[i]);
            }
        }
        File[] all = journalDir.listFiles((d, n) -> n.endsWith(".gz"));
        int keep = plugin.getConfig().getInt("keep-undo-jobs", 100);
        if (all != null && all.length > keep) {
            Arrays.sort(all, Comparator.comparingLong(File::lastModified));
            for (int k = 0; k < all.length - keep; k++) all[k].delete();
        }
    }

    private Job readJournal(String id) throws IOException {
        if (!id.matches("b\\d+")) return null;
        File f = new File(journalDir, id + ".gz");
        if (!f.isFile()) return null;
        try (DataInputStream in = new DataInputStream(new BufferedInputStream(new GZIPInputStream(new FileInputStream(f))))) {
            if (in.readInt() != MAGIC) throw new IllegalArgumentException("undo journal for " + id + " has an unknown format");
            int ver = in.readByte();
            if (ver != 1) throw new IllegalArgumentException("undo journal for " + id + " has unknown version " + ver);
            String world = in.readUTF(), actor = in.readUTF(), label = in.readUTF(), state = in.readUTF();
            int np = in.readInt();
            BlockData[] pal = new BlockData[np];
            for (int k = 0; k < np; k++) {
                String s = in.readUTF();
                try { pal[k] = Bukkit.createBlockData(s); } catch (IllegalArgumentException e) { pal[k] = null; } // block no longer exists
            }
            int n = in.readInt();
            Job j = new Job(id, "build", world, actor, label, null, n, false);
            for (int i = 0; i < n; i++) {
                j.xs[i] = in.readInt(); j.ys[i] = in.readShort(); j.zs[i] = in.readInt();
                int c = in.readInt(), p = in.readInt();
                j.datas[i] = c < 0 ? null : pal[c];
                j.prevDatas[i] = p < 0 ? null : pal[p];
                j.applied[i] = in.readBoolean();
            }
            j.state = state;
            j.cursor = n;
            return j;
        }
    }
}
