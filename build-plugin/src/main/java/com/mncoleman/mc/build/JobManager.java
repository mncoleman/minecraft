package com.mncoleman.mc.build;

import net.minecraft.server.v1_12_R1.BlockPosition;
import net.minecraft.server.v1_12_R1.WorldServer;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.craftbukkit.v1_12_R1.CraftWorld;

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
 * id+data per position) to disk. Positions holding a tile entity (chests, signs,
 * spawners, banners...) are never overwritten — their contents can't be restored.
 * Undo only reverts positions still holding what this job placed, so later edits
 * by players are never clobbered. Containers are NOT protected: replacing one
 * (or undoing over one) discards its contents.
 */
@SuppressWarnings("deprecation")
public final class JobManager {

    public static final class Job {
        public final String id;
        public final String kind;   // build | undo
        public final String world, actor, label, undoOf;
        public final int[] xs, ys, zs, ids; public final byte[] datas;
        public final int[] prevIds; public final byte[] prevDatas;
        public final boolean[] applied;
        public final boolean onlyAir;
        public volatile String state = "queued"; // queued | running | done | failed | cancelled
        public volatile int cursor = 0, placed = 0, skippedProtected = 0, skippedUngenerated = 0, skippedOccupied = 0, unchanged = 0;
        public volatile String error;
        public final long createdAt = System.currentTimeMillis();
        public volatile long finishedAt;
        Job(String id, String kind, String world, String actor, String label, String undoOf, int n, boolean onlyAir) {
            this.id = id; this.kind = kind; this.world = world; this.actor = actor; this.label = label; this.undoOf = undoOf;
            xs = new int[n]; ys = new int[n]; zs = new int[n]; ids = new int[n]; datas = new byte[n];
            prevIds = new int[n]; prevDatas = new byte[n]; applied = new boolean[n]; this.onlyAir = onlyAir;
        }
        public int size() { return xs.length; }
    }

    // Redstone-sensitive blocks: neighbours are notified after the job so powered
    // rails / wire pick up power (placement itself runs without neighbour updates).
    private static final Set<Material> PHYSICS_AFTER = EnumSet.of(
        Material.RAILS, Material.POWERED_RAIL, Material.DETECTOR_RAIL, Material.ACTIVATOR_RAIL,
        Material.REDSTONE_WIRE, Material.REDSTONE_TORCH_ON, Material.REDSTONE_TORCH_OFF, Material.REDSTONE_BLOCK,
        Material.LEVER, Material.DIODE_BLOCK_OFF, Material.DIODE_BLOCK_ON, Material.REDSTONE_COMPARATOR_OFF,
        Material.REDSTONE_COMPARATOR_ON, Material.STONE_BUTTON, Material.WOOD_BUTTON, Material.REDSTONE_LAMP_OFF,
        Material.PISTON_BASE, Material.PISTON_STICKY_BASE, Material.WATER, Material.STATIONARY_WATER,
        Material.LAVA, Material.STATIONARY_LAVA, Material.SAND, Material.GRAVEL);

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
        for (Ops.Placement p : ps) { j.xs[i] = p.x; j.ys[i] = p.y; j.zs[i] = p.z; j.ids[i] = p.b.id; j.datas[i] = p.b.data; i++; }
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
        int n = 0; for (boolean a : b.applied) if (a) n++;
        String id = "u" + seq.incrementAndGet();
        Job u = new Job(id, "undo", b.world, actor, "undo " + buildId, buildId, n, false);
        int k = 0;
        for (int i = b.size() - 1; i >= 0; i--) {       // reverse order
            if (!b.applied[i]) continue;
            u.xs[k] = b.xs[i]; u.ys[k] = b.ys[i]; u.zs[k] = b.zs[i];
            u.ids[k] = b.prevIds[i]; u.datas[k] = b.prevDatas[i];
            u.prevIds[k] = b.ids[i]; u.prevDatas[k] = b.datas[i];   // expected current content
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
        int lastX = 0, lastY = 0, lastZ = 0; boolean any = false;
        try {
            while (budget-- > 0 && j.cursor < j.size()) {
                int i = j.cursor++;
                int x = j.xs[i], y = j.ys[i], z = j.zs[i];
                int cx = x >> 4, cz = z >> 4;
                if (!w.isChunkLoaded(cx, cz) && !w.loadChunk(cx, cz, false)) { j.skippedUngenerated++; continue; }
                Block b = w.getBlockAt(x, y, z);
                int curId = b.getTypeId(); byte curData = b.getData();
                if ("undo".equals(j.kind)) {
                    // Only revert what we placed; anything changed since stays.
                    if (!sameAsPlaced(curId, curData, j.prevIds[i], j.prevDatas[i])) { j.skippedOccupied++; continue; }
                } else {
                    // No container protection (owner's call, 2026-11-12): chests, dispensers,
                    // signs etc. are replaced like any block; their contents are lost.
                    if (j.onlyAir && curId != 0) { j.skippedOccupied++; continue; }
                    j.prevIds[i] = curId; j.prevDatas[i] = curData;
                }
                if (curId == j.ids[i] && curData == j.datas[i]) { j.unchanged++; j.applied[i] = "build".equals(j.kind); continue; }
                b.setTypeIdAndData(j.ids[i], j.datas[i], false);
                j.applied[i] = true; j.placed++;
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

    // Blocks whose id/data the game changes on its own after placement (power
    // state, rail shape, torch on/off, flowing vs still). Undo matches these by
    // block FAMILY and ignores data, so a powered rail still counts as "ours".
    private static int family(int id) {
        Material m = Material.getMaterial(id);
        if (m == null) return id;
        switch (m) {
            case REDSTONE_TORCH_OFF: return Material.REDSTONE_TORCH_ON.getId();
            case DIODE_BLOCK_ON: return Material.DIODE_BLOCK_OFF.getId();
            case REDSTONE_COMPARATOR_ON: return Material.REDSTONE_COMPARATOR_OFF.getId();
            case REDSTONE_LAMP_ON: return Material.REDSTONE_LAMP_OFF.getId();
            case STATIONARY_WATER: return Material.WATER.getId();
            case STATIONARY_LAVA: return Material.LAVA.getId();
            case BURNING_FURNACE: return Material.FURNACE.getId();
            default: return id;
        }
    }
    private static final Set<Material> DATA_MUTABLE = EnumSet.of(
        Material.RAILS, Material.POWERED_RAIL, Material.DETECTOR_RAIL, Material.ACTIVATOR_RAIL, Material.REDSTONE_WIRE,
        Material.REDSTONE_TORCH_ON, Material.REDSTONE_TORCH_OFF, Material.DIODE_BLOCK_OFF, Material.DIODE_BLOCK_ON,
        Material.REDSTONE_COMPARATOR_OFF, Material.REDSTONE_COMPARATOR_ON, Material.REDSTONE_LAMP_OFF, Material.REDSTONE_LAMP_ON,
        Material.LEVER, Material.STONE_BUTTON, Material.WOOD_BUTTON, Material.WATER, Material.STATIONARY_WATER, Material.LAVA,
        Material.STATIONARY_LAVA, Material.WOODEN_DOOR, Material.IRON_DOOR_BLOCK, Material.SPRUCE_DOOR, Material.BIRCH_DOOR,
        Material.JUNGLE_DOOR, Material.ACACIA_DOOR, Material.DARK_OAK_DOOR, Material.TRAP_DOOR, Material.IRON_TRAPDOOR,
        Material.FENCE_GATE, Material.SPRUCE_FENCE_GATE, Material.BIRCH_FENCE_GATE, Material.JUNGLE_FENCE_GATE,
        Material.ACACIA_FENCE_GATE, Material.DARK_OAK_FENCE_GATE, Material.PISTON_BASE, Material.PISTON_STICKY_BASE,
        Material.DISPENSER, Material.DROPPER, Material.HOPPER, Material.FURNACE, Material.BURNING_FURNACE, Material.TRIPWIRE,
        Material.TRIPWIRE_HOOK, Material.DAYLIGHT_DETECTOR, Material.DAYLIGHT_DETECTOR_INVERTED, Material.NOTE_BLOCK,
        Material.LEAVES, Material.LEAVES_2, Material.GRASS, Material.SOIL, Material.CROPS, Material.VINE,
        Material.CHEST, Material.TRAPPED_CHEST, Material.ENDER_CHEST, Material.BREWING_STAND, Material.JUKEBOX,
        Material.BED_BLOCK, Material.SIGN_POST, Material.WALL_SIGN, Material.SKULL, Material.STANDING_BANNER, Material.WALL_BANNER,
        Material.FLOWER_POT, Material.CAULDRON, Material.ANVIL);

    /** Does the current block still look like what the build placed? */
    private static boolean sameAsPlaced(int curId, byte curData, int placedId, byte placedData) {
        if (curId == placedId && curData == placedData) return true;
        if (family(curId) != family(placedId)) return false;
        Material m = Material.getMaterial(placedId);
        return m != null && DATA_MUTABLE.contains(m);
    }

    private static boolean hasTileEntity(World w, int x, int y, int z) {
        WorldServer ws = ((CraftWorld) w).getHandle();
        return ws.getTileEntity(new BlockPosition(x, y, z)) != null;
    }

    private void applyPhysics(World w, Job j) {
        WorldServer ws = ((CraftWorld) w).getHandle();
        // Rails auto-shape against whatever neighbours exist when each is placed;
        // once the whole track exists, put back the shape we planned (shape bits
        // only — the power bit is the game's to set).
        if ("build".equals(j.kind)) for (int i = 0; i < j.size(); i++) {
            if (!j.applied[i]) continue;
            Material m = Material.getMaterial(j.ids[i]);
            if (m != Material.RAILS && m != Material.POWERED_RAIL && m != Material.DETECTOR_RAIL && m != Material.ACTIVATOR_RAIL) continue;
            Block b = w.getBlockAt(j.xs[i], j.ys[i], j.zs[i]);
            if (b.getTypeId() != j.ids[i]) continue;
            int mask = m == Material.RAILS ? 0xF : 0x7;
            if ((b.getData() & mask) != (j.datas[i] & mask)) b.setTypeIdAndData(j.ids[i], (byte) ((b.getData() & ~mask) | (j.datas[i] & mask)), false);
        }
        for (int i = 0; i < j.size(); i++) {
            if (!j.applied[i]) continue;
            Material m = Material.getMaterial(j.ids[i]);
            if (m == null || !PHYSICS_AFTER.contains(m)) continue;
            BlockPosition bp = new BlockPosition(j.xs[i], j.ys[i], j.zs[i]);
            try { ws.applyPhysics(bp, ws.getType(bp).getBlock(), false); } catch (Throwable ignored) {}
        }
    }

    // ── undo journals ─────────────────────────────────────────────────────────
    private void writeJournal(Job j) throws IOException {
        File f = new File(journalDir, j.id + ".gz");
        try (DataOutputStream o = new DataOutputStream(new BufferedOutputStream(new GZIPOutputStream(new FileOutputStream(f))))) {
            o.writeUTF(j.world); o.writeUTF(j.actor == null ? "" : j.actor); o.writeUTF(j.label == null ? "" : j.label);
            o.writeUTF(j.state);
            o.writeInt(j.size());
            for (int i = 0; i < j.size(); i++) {
                o.writeInt(j.xs[i]); o.writeShort(j.ys[i]); o.writeInt(j.zs[i]);
                o.writeShort(j.ids[i]); o.writeByte(j.datas[i]);
                o.writeShort(j.prevIds[i]); o.writeByte(j.prevDatas[i]);
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
            String world = in.readUTF(), actor = in.readUTF(), label = in.readUTF(), state = in.readUTF();
            int n = in.readInt();
            Job j = new Job(id, "build", world, actor, label, null, n, false);
            for (int i = 0; i < n; i++) {
                j.xs[i] = in.readInt(); j.ys[i] = in.readShort(); j.zs[i] = in.readInt();
                j.ids[i] = in.readShort(); j.datas[i] = in.readByte();
                j.prevIds[i] = in.readShort(); j.prevDatas[i] = in.readByte();
                j.applied[i] = in.readBoolean();
            }
            j.state = state;
            j.cursor = n;
            return j;
        }
    }
}
