package com.mncoleman.mc.build;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.Tag;
import org.bukkit.World;
import org.bukkit.block.Block;

import java.util.*;

/**
 * Read-only world inspection, run on the server thread. Output is designed to be
 * read by a language model: a palette of single characters plus text grids, with
 * the axis convention spelled out (x → east to the right, z → south downward).
 * Palette entries are full block-state strings (BlockData#getAsString), which can
 * be pasted straight back into a build.
 */
public final class Scanner {
    // '.' = air and '?' = ungenerated are reserved; everything else is assigned in order.
    private static final String CHARS = "#abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!$%&*+=<>@^~"
        + "¡¢£¥§©®±µ¶¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞß"
        + "ΑΒΓΔΘΛΞΠΣΦΨΩαβγδεζηθλμξπρσφψω"
        + "ДЖИЛФЦШЭЮЯбджилфцшэюя";

    private static final Set<Material> NOT_GROUND_EXTRA = EnumSet.noneOf(Material.class);
    private static final List<Tag<Material>> NOT_GROUND_TAGS = new ArrayList<>();
    static {
        for (String n : new String[]{"air", "cave_air", "void_air", "short_grass", "tall_grass", "fern", "large_fern", "dead_bush",
                "snow", "vine", "sugar_cane", "cactus", "lily_pad", "torch", "wall_torch", "soul_torch", "soul_wall_torch",
                "brown_mushroom", "red_mushroom", "brown_mushroom_block", "red_mushroom_block", "mushroom_stem", "bamboo",
                "sweet_berry_bush", "glow_lichen", "moss_carpet", "pink_petals", "leaf_litter", "wildflowers", "bush",
                "firefly_bush", "short_dry_grass", "tall_dry_grass", "cocoa", "pumpkin", "melon", "bee_nest", "pale_moss_carpet",
                "pale_hanging_moss", "hanging_roots", "spore_blossom", "big_dripleaf", "small_dripleaf", "azalea", "flowering_azalea"}) {
            Material m = Material.matchMaterial(n);
            if (m != null) NOT_GROUND_EXTRA.add(m);
        }
        for (String t : new String[]{"leaves", "logs", "flowers", "small_flowers", "saplings", "wool_carpets"}) {
            Tag<Material> tag = Bukkit.getTag(Tag.REGISTRY_BLOCKS, NamespacedKey.minecraft(t), Material.class);
            if (tag != null) NOT_GROUND_TAGS.add(tag);
        }
    }

    /** Plants, snow layers, trees, torches: things standing ON the ground, not the ground. */
    static boolean notGround(Material m) {
        if (m == null) return false;
        if (NOT_GROUND_EXTRA.contains(m) || m.isAir()) return true;
        for (Tag<Material> t : NOT_GROUND_TAGS) if (t.isTagged(m)) return true;
        return false;
    }

    private static boolean loaded(World w, int x, int z) {
        int cx = x >> 4, cz = z >> 4;
        return w.isChunkLoaded(cx, cz) || w.loadChunk(cx, cz, false);
    }

    private static char assign(Map<String, Character> pal, String n, int reserved) {
        Character have = pal.get(n);
        if (have != null) return have;
        int idx = pal.size() - reserved;
        if (idx >= CHARS.length()) throw new IllegalArgumentException("scan box has more than " + CHARS.length() + " distinct block states; scan a smaller box");
        have = CHARS.charAt(idx);
        pal.put(n, have);
        return have;
    }

    /** Full block dump of a box: palette + one grid per y layer. */
    public static JsonObject blocks(World w, int x1, int y1, int z1, int x2, int y2, int z2, int cap) {
        int minY = w.getMinHeight(), maxY = w.getMaxHeight() - 1;
        int ax = Math.min(x1, x2), bx = Math.max(x1, x2), ay = Math.max(minY, Math.min(y1, y2)), by = Math.min(maxY, Math.max(y1, y2));
        int az = Math.min(z1, z2), bz = Math.max(z1, z2);
        if (ay > by) throw new IllegalArgumentException("y range is outside " + minY + ".." + maxY);
        long vol = ((long) bx - ax + 1) * ((long) by - ay + 1) * ((long) bz - az + 1);
        if (vol > cap) throw new IllegalArgumentException("scan box is " + vol + " blocks; max " + cap + ". Scan a smaller box or use heightmap mode.");
        Map<String, Character> pal = new LinkedHashMap<>();
        pal.put("minecraft:air", '.');
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
                        if (b.getType().isAir()) c = '.';
                        else {
                            allAir = false;
                            c = assign(pal, BlockSpec.name(b.getBlockData()), 2);
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
        out.addProperty("reading", "Each layer's grid: one row per z (first row z=" + az + ", increasing SOUTH downward), one char per x (first char x=" + ax + ", increasing EAST to the right). Layers listed top (y=" + by + ") to bottom. Palette values are full block states; paste them back into build as-is.");
        out.add("palette", palette);
        out.add("layers", layers);
        return out;
    }

    /** Ground height per column (skips plants, snow layers, trees) + surface block. */
    public static JsonObject heightmap(World w, int x1, int z1, int x2, int z2, int cap) {
        int ax = Math.min(x1, x2), bx = Math.max(x1, x2), az = Math.min(z1, z2), bz = Math.max(z1, z2);
        long cols = ((long) bx - ax + 1) * ((long) bz - az + 1);
        if (cols > cap) throw new IllegalArgumentException("heightmap area is " + cols + " columns; max " + cap + ".");
        int minY = w.getMinHeight();
        Map<String, Character> pal = new LinkedHashMap<>();
        pal.put("(ungenerated)", '?');
        StringBuilder heights = new StringBuilder(), surface = new StringBuilder();
        int min = Integer.MAX_VALUE, max = Integer.MIN_VALUE;
        for (int z = az; z <= bz; z++) {
            for (int x = ax; x <= bx; x++) {
                if (x > ax) heights.append(' ');
                if (!loaded(w, x, z)) { heights.append("?"); surface.append('?'); continue; }
                int y = w.getHighestBlockYAt(x, z);
                Block b = w.getBlockAt(x, y, z);
                while (y > minY && notGround(b.getType())) { y--; b = w.getBlockAt(x, y, z); }
                heights.append(y);
                min = Math.min(min, y); max = Math.max(max, y);
                surface.append(assign(pal, BlockSpec.name(b.getBlockData()), 1));
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
        if (min != Integer.MAX_VALUE) { out.addProperty("min_ground_y", min); out.addProperty("max_ground_y", max); }
        else { out.add("min_ground_y", com.google.gson.JsonNull.INSTANCE); out.add("max_ground_y", com.google.gson.JsonNull.INSTANCE); }
        out.addProperty("world_y_limits", w.getMinHeight() + ".." + (w.getMaxHeight() - 1));
        out.addProperty("reading", "ground_y: the y of the top ground block per column (ignoring plants, snow layers, leaves and logs); build ON it at y+1. Heights can be negative (the world spans y " + w.getMinHeight() + ".." + (w.getMaxHeight() - 1) + "). One row per z (first row z=" + az + ", increasing SOUTH), values per x (first x=" + ax + ", increasing EAST). surface: same layout, palette char of that ground block (water shows as water).");
        out.addProperty("ground_y", heights.toString());
        out.addProperty("surface", surface.toString());
        out.add("palette", palette);
        return out;
    }
}
