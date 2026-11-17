package com.mncoleman.mc.build;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.block.data.BlockData;
import org.bukkit.block.data.FaceAttachable;
import org.bukkit.block.data.Directional;
import org.bukkit.block.data.Powerable;

import java.lang.reflect.Method;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;

/**
 * The panel map's live redstone view.
 *
 *  /states reads the current block state at a list of positions (the map's
 *  component inventory). It never loads a chunk: positions in unloaded chunks
 *  come back null and the panel falls back to the last disk snapshot.
 *
 *  /lever flips a lever the way a player's click does. Setting the block data
 *  alone (what `build` does) only notifies the lever's own neighbours, so wire
 *  running off the block the lever is mounted on never hears about it. Vanilla
 *  LeverBlock.pull() also updates the neighbours of that support block and plays
 *  the click, so we call it on the server's own block object. Paper runs with
 *  Mojang's names, so the lookup is by name; if it ever fails we fall back to
 *  setBlockData plus an explicit neighbour update of the support block.
 *
 * mc-auth decides who may flip what (world owner or admin, levers inside a
 * mapped area); this layer only refuses anything that isn't a lever.
 */
final class Levers {
    private Levers() {}
    private static final int MAX_POSITIONS = 6000;

    static JsonObject states(ClaudeBuildPlugin plugin, JsonObject b) throws Exception {
        String world = str(b, "world");
        JsonElement pe = b.get("positions");
        if (pe == null || !pe.isJsonArray()) throw new IllegalArgumentException("'positions' must be an array of [x,y,z]");
        JsonArray arr = pe.getAsJsonArray();
        if (arr.size() > MAX_POSITIONS) throw new IllegalArgumentException("max " + MAX_POSITIONS + " positions");
        int n = arr.size();
        int[] xs = new int[n], ys = new int[n], zs = new int[n];
        for (int i = 0; i < n; i++) {
            JsonArray p = arr.get(i).getAsJsonArray();
            xs[i] = p.get(0).getAsInt(); ys[i] = p.get(1).getAsInt(); zs[i] = p.get(2).getAsInt();
        }
        return sync(plugin, () -> {
            World w = Bukkit.getWorld(world);
            if (w == null) throw new IllegalArgumentException("world not loaded: " + world);
            JsonArray out = new JsonArray();
            int loaded = 0;
            for (int i = 0; i < n; i++) {
                if (ys[i] < w.getMinHeight() || ys[i] >= w.getMaxHeight() || !w.isChunkLoaded(xs[i] >> 4, zs[i] >> 4)) { out.add(JsonNull.INSTANCE); continue; }
                out.add(w.getBlockAt(xs[i], ys[i], zs[i]).getBlockData().getAsString());
                loaded++;
            }
            JsonObject o = new JsonObject();
            o.add("states", out);
            o.addProperty("loaded", loaded);
            return o;
        }, 10);
    }

    static JsonObject flip(ClaudeBuildPlugin plugin, JsonObject b) throws Exception {
        String world = str(b, "world");
        JsonArray p = b.getAsJsonArray("pos");
        if (p == null || p.size() != 3) throw new IllegalArgumentException("'pos' must be [x,y,z]");
        int x = p.get(0).getAsInt(), y = p.get(1).getAsInt(), z = p.get(2).getAsInt();
        Boolean want = b.has("powered") && !b.get("powered").isJsonNull() ? b.get("powered").getAsBoolean() : null;
        return sync(plugin, () -> {
            World w = Bukkit.getWorld(world);
            if (w == null) throw new IllegalArgumentException("world not loaded: " + world);
            if (!w.isChunkLoaded(x >> 4, z >> 4)) w.getChunkAt(x >> 4, z >> 4); // a lever someone asked for by hand: load it
            Block bl = w.getBlockAt(x, y, z);
            if (bl.getType() != Material.LEVER) throw new IllegalArgumentException("no lever at " + x + " " + y + " " + z + " (found " + bl.getBlockData().getAsString() + ")");
            boolean before = ((Powerable) bl.getBlockData()).isPowered();
            JsonObject o = new JsonObject();
            String how = "unchanged";
            if (want == null || want != before) {
                how = pullLikeAPlayer(w, x, y, z);
                if (how == null) how = fallback(w, bl, !before);
            }
            BlockData now = bl.getBlockData();
            o.addProperty("powered", ((Powerable) now).isPowered());
            o.addProperty("was", before);
            o.addProperty("state", now.getAsString());
            o.addProperty("method", how);
            return o;
        }, 10);
    }

    /** LeverBlock.pull(state, level, pos[, player]) via reflection. Returns the method used, or null. */
    private static String pullLikeAPlayer(World w, int x, int y, int z) {
        try {
            Object level = w.getClass().getMethod("getHandle").invoke(w);
            ClassLoader cl = level.getClass().getClassLoader();
            Class<?> bpC = Class.forName("net.minecraft.core.BlockPos", true, cl);
            Object pos = bpC.getConstructor(int.class, int.class, int.class).newInstance(x, y, z);
            Method getState = findMethod(level.getClass(), "getBlockState", 1);
            Object state = getState.invoke(level, pos);
            Object block = findMethod(state.getClass(), "getBlock", 0).invoke(state);
            for (Class<?> k = block.getClass(); k != null; k = k.getSuperclass()) {
                for (Method m : k.getDeclaredMethods()) {
                    if (!m.getName().equals("pull")) continue;
                    m.setAccessible(true);
                    Object[] args = new Object[m.getParameterCount()];
                    args[0] = state; args[1] = level; args[2] = pos;  // (BlockState, Level, BlockPos[, Player])
                    m.invoke(block, args);
                    return "pull";
                }
            }
        } catch (Throwable t) {
            Bukkit.getLogger().warning("[ClaudeBuild] lever pull via server block failed, using fallback: " + t);
        }
        return null;
    }

    /** setBlockData with physics, then wake the neighbours of the block the lever hangs on. */
    private static String fallback(World w, Block bl, boolean powered) {
        BlockData d = bl.getBlockData();
        ((Powerable) d).setPowered(powered);
        bl.setBlockData(d, true);
        Block support = bl.getRelative(supportFace(d));
        try {
            Object level = w.getClass().getMethod("getHandle").invoke(w);
            ClassLoader cl = level.getClass().getClassLoader();
            Class<?> bpC = Class.forName("net.minecraft.core.BlockPos", true, cl);
            Object pos = bpC.getConstructor(int.class, int.class, int.class).newInstance(support.getX(), support.getY(), support.getZ());
            Object state = findMethod(level.getClass(), "getBlockState", 1).invoke(level, bpC.getConstructor(int.class, int.class, int.class).newInstance(bl.getX(), bl.getY(), bl.getZ()));
            Object block = findMethod(state.getClass(), "getBlock", 0).invoke(state);
            findMethod(level.getClass(), "updateNeighborsAt", 2).invoke(level, pos, block);
            return "setblock+neighbours";
        } catch (Throwable t) {
            return "setblock";
        }
    }

    private static BlockFace supportFace(BlockData d) {
        if (d instanceof FaceAttachable fa) {
            switch (fa.getAttachedFace()) {
                case FLOOR: return BlockFace.DOWN;
                case CEILING: return BlockFace.UP;
                default: break;
            }
        }
        if (d instanceof Directional dir) return dir.getFacing().getOppositeFace();
        return BlockFace.DOWN;
    }

    private static Method findMethod(Class<?> c, String name, int params) throws NoSuchMethodException {
        for (Class<?> k = c; k != null; k = k.getSuperclass()) {
            for (Method m : k.getDeclaredMethods()) {
                if (m.getName().equals(name) && m.getParameterCount() == params) { m.setAccessible(true); return m; }
            }
        }
        for (Method m : c.getMethods()) if (m.getName().equals(name) && m.getParameterCount() == params) return m;
        throw new NoSuchMethodException(c.getName() + "." + name + "/" + params);
    }

    private static String str(JsonObject b, String k) {
        if (!b.has(k) || b.get(k).isJsonNull()) throw new IllegalArgumentException("missing '" + k + "'");
        return b.get(k).getAsString();
    }

    private static <T> T sync(ClaudeBuildPlugin plugin, Callable<T> c, int seconds) throws Exception {
        try {
            return Bukkit.getScheduler().callSyncMethod(plugin, c).get(seconds, TimeUnit.SECONDS);
        } catch (ExecutionException e) {
            if (e.getCause() instanceof IllegalArgumentException) throw (IllegalArgumentException) e.getCause();
            throw e;
        }
    }
}
