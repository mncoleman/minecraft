package com.mncoleman.mc.build;

import org.bukkit.Bukkit;
import org.bukkit.Material;

import java.util.Locale;

/** A 1.12 block: numeric id + data value (0-15). Parsed from "name[:data]". */
@SuppressWarnings("deprecation")
public final class BlockSpec {
    public final int id;
    public final byte data;
    public final Material material;

    /** Blocks Claude may never place: griefing, lag, or admin-only. */
    private static final java.util.Set<Material> DENIED = java.util.EnumSet.of(
        Material.TNT, Material.FIRE, Material.COMMAND, Material.COMMAND_REPEATING, Material.COMMAND_CHAIN,
        Material.STRUCTURE_BLOCK, Material.STRUCTURE_VOID, Material.BARRIER, Material.PORTAL, Material.ENDER_PORTAL,
        Material.ENDER_PORTAL_FRAME, Material.END_GATEWAY, Material.MOB_SPAWNER, Material.BEDROCK);
    /** Fluids and falling blocks: capped per build (lag / entity storms). */
    public static final java.util.Set<Material> HEAVY = java.util.EnumSet.of(
        Material.WATER, Material.STATIONARY_WATER, Material.LAVA, Material.STATIONARY_LAVA,
        Material.SAND, Material.GRAVEL, Material.CONCRETE_POWDER, Material.ANVIL, Material.DRAGON_EGG);

    private BlockSpec(Material m, int data) {
        this.material = m;
        this.id = m.getId();
        this.data = (byte) data;
    }

    /**
     * Accepts vanilla ids ("oak_stairs:1", "minecraft:golden_rail"), Bukkit 1.12
     * Material names ("wood_stairs:1", "powered_rail"), or numeric ids ("53:1").
     * Throws IllegalArgumentException with a readable reason.
     */
    public static BlockSpec parse(String raw) {
        if (raw == null) throw new IllegalArgumentException("missing block");
        String s = raw.trim().toLowerCase(Locale.ROOT);
        if (s.startsWith("minecraft:")) s = s.substring("minecraft:".length());
        int data = 0;
        int c = s.lastIndexOf(':');
        if (c > 0) {
            String tail = s.substring(c + 1);
            try { data = Integer.parseInt(tail); } catch (NumberFormatException e) { throw new IllegalArgumentException("bad data value in '" + raw + "'"); }
            s = s.substring(0, c);
        }
        if (data < 0 || data > 15) throw new IllegalArgumentException("data value must be 0-15 in '" + raw + "'");
        Material m = null;
        if (s.matches("\\d+")) {
            m = Material.getMaterial(Integer.parseInt(s));
        } else {
            if (s.equals("air")) m = Material.AIR;
            if (m == null) {
                Material v = Bukkit.getUnsafe().getMaterialFromInternalName(s); // vanilla registry name
                if (v != null && v != Material.AIR) m = v;
            }
            if (m == null) m = Material.matchMaterial(s); // Bukkit enum name
        }
        if (m == null) throw new IllegalArgumentException("unknown block '" + raw + "'");
        if (!m.isBlock()) throw new IllegalArgumentException("'" + raw + "' is an item, not a placeable block");
        if (DENIED.contains(m)) throw new IllegalArgumentException("'" + raw + "' isn't allowed (explosive, fire, command, portal or admin block)");
        return new BlockSpec(m, data);
    }

    /** Canonical name used in scans: Bukkit Material name, lowercased, ":data" when non-zero. */
    public static String name(int id, int data) {
        Material m = Material.getMaterial(id);
        String n = m == null ? String.valueOf(id) : m.name().toLowerCase(Locale.ROOT);
        return data == 0 ? n : n + ":" + data;
    }
}
