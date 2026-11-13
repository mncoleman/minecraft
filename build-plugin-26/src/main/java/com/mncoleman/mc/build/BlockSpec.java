package com.mncoleman.mc.build;

import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.block.data.BlockData;
import org.bukkit.block.data.Waterlogged;

import java.util.*;

/**
 * A modern block state, parsed from a vanilla id with optional states:
 * "oak_planks", "minecraft:repeater[facing=north,delay=2]". Legacy numeric ids and
 * ":data" values are rejected with a hint toward the modern form.
 */
public final class BlockSpec {
    public final BlockData data;
    public final Material material;
    /** Full state string (journals, verification). */
    public final String str;

    /** Blocks Claude may never place: griefing, lag, or admin-only. Resolved by name so a renamed constant can't break the build. */
    private static final Set<Material> DENIED = materials(
        "tnt", "fire", "soul_fire", "command_block", "chain_command_block", "repeating_command_block",
        "structure_block", "structure_void", "jigsaw", "barrier", "light", "nether_portal", "end_portal",
        "end_portal_frame", "end_gateway", "spawner", "trial_spawner", "vault", "bedrock", "reinforced_deepslate",
        "test_block", "test_instance_block");

    private static Set<Material> materials(String... names) {
        Set<Material> s = EnumSet.noneOf(Material.class);
        for (String n : names) { Material m = Material.matchMaterial(n); if (m != null) s.add(m); }
        return s;
    }

    /** Fluids and falling blocks: capped per build (lag / entity storms). */
    public static boolean heavy(BlockData d) {
        Material m = d.getMaterial();
        if (m == Material.WATER || m == Material.LAVA || m == Material.BUBBLE_COLUMN || m.hasGravity()) return true;
        return d instanceof Waterlogged w && w.isWaterlogged();
    }
    public static boolean heavy(Material m) { return m == Material.WATER || m == Material.LAVA || m == Material.BUBBLE_COLUMN || m.hasGravity(); }

    /** Common 1.12 names → modern ids, used only to make the error message helpful. */
    private static final Map<String, String> LEGACY_HINT = new HashMap<>();
    static {
        String[] p = {
            "stonebrick", "stone_bricks", "planks", "oak_planks", "wood", "oak_planks", "log", "oak_log", "log2", "acacia_log",
            "wood_stairs", "oak_stairs", "golden_rail", "powered_rail", "rails", "rail", "lit_pumpkin", "jack_o_lantern",
            "wool", "white_wool", "stained_glass", "white_stained_glass", "stained_hardened_clay", "white_terracotta",
            "hardened_clay", "terracotta", "concrete", "white_concrete", "carpet", "white_carpet", "grass", "grass_block",
            "tallgrass", "short_grass", "leaves", "oak_leaves", "sapling", "oak_sapling", "stone_slab", "smooth_stone_slab",
            "wooden_slab", "oak_slab", "double_stone_slab", "smooth_stone", "fence", "oak_fence", "fence_gate", "oak_fence_gate",
            "wooden_door", "oak_door", "trapdoor", "oak_trapdoor", "unpowered_repeater", "repeater", "powered_repeater", "repeater",
            "unpowered_comparator", "comparator", "redstone_torch", "redstone_torch", "unlit_redstone_torch", "redstone_torch",
            "lit_redstone_lamp", "redstone_lamp[lit=true]", "red_flower", "poppy", "yellow_flower", "dandelion",
            "brick_block", "bricks", "nether_brick", "nether_bricks", "quartz_ore", "nether_quartz_ore", "snow_layer", "snow",
            "snow", "snow_block", "web", "cobweb", "mob_spawner", "spawner", "noteblock", "note_block", "melon_block", "melon",
            "stone_stairs", "cobblestone_stairs", "standing_sign", "oak_sign", "wall_sign", "oak_wall_sign", "bed", "red_bed",
            "torch", "torch / wall_torch[facing=...]", "skull", "skeleton_skull", "monster_egg", "infested_stone",
            "mossy_cobblestone", "mossy_cobblestone", "stone_button", "stone_button[face=floor]", "wooden_button", "oak_button",
            "wooden_pressure_plate", "oak_pressure_plate", "magma", "magma_block", "silver_glazed_terracotta", "light_gray_glazed_terracotta",
            "red_nether_brick", "red_nether_bricks", "end_bricks", "end_stone_bricks", "purpur_slab", "purpur_slab",
            "double_plant", "tall_grass / sunflower / ...", "waterlily", "lily_pad", "reeds", "sugar_cane", "vine", "vine"};
        for (int i = 0; i + 1 < p.length; i += 2) LEGACY_HINT.putIfAbsent(p[i], p[i + 1]);
    }

    private BlockSpec(BlockData d) {
        this.data = d;
        this.material = d.getMaterial();
        this.str = d.getAsString();
    }

    /** Wrap internally built block data (rail planner); skips the deny list. */
    public static BlockSpec of(BlockData d) { return new BlockSpec(d.clone()); }

    private static final String EXAMPLES = "Use modern ids with optional states, e.g. 'oak_planks', 'oak_stairs[facing=east,half=bottom]', 'minecraft:repeater[facing=north,delay=2]'.";

    /** Throws IllegalArgumentException with a readable reason. */
    public static BlockSpec parse(String raw) {
        if (raw == null) throw new IllegalArgumentException("missing block");
        String s = raw.trim().toLowerCase(Locale.ROOT);
        if (s.isEmpty()) throw new IllegalArgumentException("missing block");
        String id = s.contains("[") ? s.substring(0, s.indexOf('[')) : s;
        String bare = id.startsWith("minecraft:") ? id.substring(10) : id;
        // Legacy forms: numeric id ("53", "53:1") or ":data" suffix ("oak_stairs:1", "wool:14").
        if (bare.matches("\\d+(:\\d+)?")) throw new IllegalArgumentException("'" + raw + "' is a 1.12 numeric id; this server uses modern block ids. " + EXAMPLES);
        int c = bare.lastIndexOf(':');
        if (c > 0 && bare.substring(c + 1).matches("\\d+")) {
            String base = bare.substring(0, c);
            String hint = LEGACY_HINT.get(base);
            throw new IllegalArgumentException("'" + raw + "' uses a 1.12 data value; give block states instead, e.g. '"
                + (hint != null && hint.contains("[") ? hint : (hint != null ? hint : base) + "[facing=north]") + "' (stairs: facing/half/shape; rails: shape; wool/glass/concrete: colour in the id like 'red_wool'). " + EXAMPLES);
        }
        BlockData d;
        try {
            d = Bukkit.createBlockData(s);
        } catch (IllegalArgumentException e) {
            String hint = LEGACY_HINT.get(bare);
            if (hint != null) throw new IllegalArgumentException("unknown block '" + raw + "' (1.12 name); the modern id is '" + hint + "'. " + EXAMPLES);
            throw new IllegalArgumentException("unknown block or bad state in '" + raw + "'. " + EXAMPLES);
        }
        Material m = d.getMaterial();
        if (!m.isBlock()) throw new IllegalArgumentException("'" + raw + "' is an item, not a placeable block");
        if (DENIED.contains(m)) throw new IllegalArgumentException("'" + raw + "' isn't allowed (explosive, fire, command, portal, spawner or admin block)");
        return new BlockSpec(d);
    }

    /** Canonical name used in scans: the full block state string. */
    public static String name(BlockData d) { return d.getAsString(); }
}
