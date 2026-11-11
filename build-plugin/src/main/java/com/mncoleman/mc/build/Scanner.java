package com.mncoleman.mc.build;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;

import java.util.*;

/**
 * Read-only world inspection, run on the server thread. Output is designed to be
 * read by a language model: a palette of single characters plus text grids, with
 * the axis convention spelled out (x → east to the right, z → south downward).
 */
@SuppressWarnings("deprecation")
public final class Scanner {
    private static final String CHARS = "#abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!$%&*+=<>@^~";

    private static final Set<Material> NOT_GROUND = EnumSet.of(
        Material.AIR, Material.LONG_GRASS, Material.DEAD_BUSH, Material.YELLOW_FLOWER, Material.RED_ROSE,
        Material.DOUBLE_PLANT, Material.SNOW, Material.LEAVES, Material.LEAVES_2, Material.LOG, Material.LOG_2,
        Material.BROWN_MUSHROOM, Material.RED_MUSHROOM, Material.SAPLING, Material.VINE, Material.SUGAR_CANE_BLOCK,
        Material.CACTUS, Material.WATER_LILY, Material.TORCH, Material.HUGE_MUSHROOM_1, Material.HUGE_MUSHROOM_2);

    private static boolean loaded(World w, int x, int z) {
        int cx = x >> 4, cz = z >> 4;
        return w.isChunkLoaded(cx, cz) || w.loadChunk(cx, cz, false);
    }

    /** Full block dump of a box: palette + one grid per y layer. */
    public static JsonObject blocks(World w, int x1, int y1, int z1, int x2, int y2, int z2, int cap) {
        int ax = Math.min(x1, x2), bx = Math.max(x1, x2), ay = Math.max(0, Math.min(y1, y2)), by = Math.min(255, Math.max(y1, y2));
        int az = Math.min(z1, z2), bz = Math.max(z1, z2);
        if (ay > by) throw new IllegalArgumentException("y range is outside 0-255");
        long vol = ((long) bx - ax + 1) * ((long) by - ay + 1) * ((long) bz - az + 1);
        if (vol > cap) throw new IllegalArgumentException("scan box is " + vol + " blocks; max " + cap + ". Scan a smaller box or use heightmap mode.");
        Map<String, Character> pal = new LinkedHashMap<>();
        pal.put("air", '.');
        pal.put("(ungenerated)", '?');
        JsonArray layers = new JsonArray();
        for (int y = by; y >= ay; y--) {          // top layer first
            StringBuilder grid = new StringBuilder();
            boolean allAir = true;
            for (int z = az; z <= bz; z++) {
                for (int x = ax; x <= bx; x++) {
                    char c;
                    if (!loaded(w, x, z)) c = '?';
                    else {
                        Block b = w.getBlockAt(x, y, z);
                        if (b.getTypeId() == 0) c = '.';
                        else {
                            allAir = false;
                            String n = BlockSpec.name(b.getTypeId(), b.getData());
                            Character have = pal.get(n);
                            if (have == null) {
                                int idx = pal.size() - 2;
                                have = idx < CHARS.length() ? CHARS.charAt(idx) : '¤';
                                pal.put(n, have);
                            }
                            c = have;
                        }
                    }
                    grid.append(c);
                }
                grid.append('\n');
            }
            JsonObject L = new JsonObject();
            L.addProperty("y", y);
            if (allAir) L.addProperty("all_air", true); else L.addProperty("grid", grid.toString());
            layers.add(L);
        }
        JsonObject palette = new JsonObject();
        for (Map.Entry<String, Character> e : pal.entrySet()) palette.addProperty(String.valueOf(e.getValue()), e.getKey());
        JsonObject out = new JsonObject();
        out.addProperty("mode", "blocks");
        out.addProperty("world", w.getName());
        out.addProperty("x_range", ax + ".." + bx);
        out.addProperty("z_range", az + ".." + bz);
        out.addProperty("y_range", ay + ".." + by);
        out.addProperty("reading", "Each layer's grid: one row per z (first row z=" + az + ", increasing SOUTH downward), one char per x (first char x=" + ax + ", increasing EAST to the right). Layers listed top (y=" + by + ") to bottom.");
        out.add("palette", palette);
        out.add("layers", layers);
        return out;
    }

    /** Ground height per column (skips plants, snow layers, trees) + surface block. */
    public static JsonObject heightmap(World w, int x1, int z1, int x2, int z2, int cap) {
        int ax = Math.min(x1, x2), bx = Math.max(x1, x2), az = Math.min(z1, z2), bz = Math.max(z1, z2);
        long cols = ((long) bx - ax + 1) * ((long) bz - az + 1);
        if (cols > cap) throw new IllegalArgumentException("heightmap area is " + cols + " columns; max " + cap + ".");
        Map<String, Character> pal = new LinkedHashMap<>();
        pal.put("(ungenerated)", '?');
        StringBuilder heights = new StringBuilder(), surface = new StringBuilder();
        int min = 999, max = -1;
        for (int z = az; z <= bz; z++) {
            for (int x = ax; x <= bx; x++) {
                if (x > ax) heights.append(' ');
                if (!loaded(w, x, z)) { heights.append("?"); surface.append('?'); continue; }
                int y = w.getHighestBlockYAt(x, z);
                Block b = w.getBlockAt(x, y, z);
                while (y > 0 && NOT_GROUND.contains(b.getType())) { y--; b = w.getBlockAt(x, y, z); }
                heights.append(y);
                min = Math.min(min, y); max = Math.max(max, y);
                String n = BlockSpec.name(b.getTypeId(), b.getData());
                Character have = pal.get(n);
                if (have == null) { int idx = pal.size() - 1; have = idx < CHARS.length() ? CHARS.charAt(idx) : '¤'; pal.put(n, have); }
                surface.append(have);
            }
            heights.append('\n'); surface.append('\n');
        }
        JsonObject palette = new JsonObject();
        for (Map.Entry<String, Character> e : pal.entrySet()) palette.addProperty(String.valueOf(e.getValue()), e.getKey());
        JsonObject out = new JsonObject();
        out.addProperty("mode", "heightmap");
        out.addProperty("world", w.getName());
        out.addProperty("x_range", ax + ".." + bx);
        out.addProperty("z_range", az + ".." + bz);
        out.addProperty("min_ground_y", min);
        out.addProperty("max_ground_y", max);
        out.addProperty("reading", "ground_y: the y of the top ground block per column (ignoring plants, snow layers, leaves and logs); build ON it at y+1. One row per z (first row z=" + az + ", increasing SOUTH), values per x (first x=" + ax + ", increasing EAST). surface: same layout, palette char of that ground block (water shows as water).");
        out.addProperty("ground_y", heights.toString());
        out.addProperty("surface", surface.toString());
        out.add("palette", palette);
        return out;
    }
}
