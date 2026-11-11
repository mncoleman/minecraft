package com.mncoleman.mc.build;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Expands JSON build ops into concrete block positions (last op wins per position).
 * All coordinates are ABSOLUTE world coordinates unless an op says otherwise; no
 * player-relative origins (the WorldEdit origin-drift problem).
 */
public final class Ops {
    public static final class Placement { public final int x, y, z; public final BlockSpec b;
        Placement(int x, int y, int z, BlockSpec b) { this.x = x; this.y = y; this.z = z; this.b = b; } }

    private final Map<Long, Placement> out = new LinkedHashMap<>();
    private final int cap;
    private long iterations = 0;            // work budget across all ops (DoS guard)
    private static final long MAX_ITER = 20_000_000L;
    private int heavy = 0;                  // fluids + falling blocks
    private static final int MAX_HEAVY = 2000;

    public Ops(int cap) { this.cap = cap; }

    public Map<Long, Placement> result() { return out; }

    static long key(int x, int y, int z) {
        return (((long) (x & 0x3FFFFFF)) << 38) | (((long) (z & 0x3FFFFFF)) << 12) | (y & 0xFFF);
    }

    private void put(int x, int y, int z, BlockSpec b) {
        if (++iterations > MAX_ITER) throw new IllegalArgumentException("build is too much work; split it into smaller builds");
        if (y < 0 || y > 255) return; // outside the world: silently clipped
        if (x > 29_999_000 || x < -29_999_000 || z > 29_999_000 || z < -29_999_000) throw new IllegalArgumentException("coordinates out of world bounds");
        if (BlockSpec.HEAVY.contains(b.material) && ++heavy > MAX_HEAVY) throw new IllegalArgumentException("max " + MAX_HEAVY + " water/lava/sand/gravel blocks per build");
        out.put(key(x, y, z), new Placement(x, y, z, b));
        if (out.size() > cap) throw new IllegalArgumentException("build exceeds " + cap + " blocks; split it into smaller builds");
    }

    private static int[] vec(JsonObject o, String k) {
        JsonElement e = o.get(k);
        if (e == null || !e.isJsonArray() || e.getAsJsonArray().size() != 3) throw new IllegalArgumentException("'" + k + "' must be [x,y,z]");
        JsonArray a = e.getAsJsonArray();
        long x = a.get(0).getAsLong(), y = a.get(1).getAsLong(), z = a.get(2).getAsLong();
        if (Math.abs(x) > 29_999_000 || Math.abs(z) > 29_999_000 || y < -64 || y > 320) throw new IllegalArgumentException("'" + k + "' out of world bounds");
        return new int[]{(int) x, (int) y, (int) z};
    }
    private static String str(JsonObject o, String k, String def) { JsonElement e = o.get(k); return e == null || e.isJsonNull() ? def : e.getAsString(); }
    private static int num(JsonObject o, String k) { JsonElement e = o.get(k); if (e == null) throw new IllegalArgumentException("missing '" + k + "'"); return e.getAsInt(); }
    private static boolean bool(JsonObject o, String k) { JsonElement e = o.get(k); return e != null && e.getAsBoolean(); }

    public void add(JsonObject op, int index) {
        String type = str(op, "type", "");
        try {
            switch (type) {
                case "set": { int[] p = vec(op, "pos"); put(p[0], p[1], p[2], BlockSpec.parse(str(op, "block", null))); break; }
                case "fill": fill(op); break;
                case "line": line(op); break;
                case "cylinder": cylinder(op); break;
                case "sphere": sphere(op); break;
                case "blocks": blocks(op); break;
                default: throw new IllegalArgumentException("unknown op type '" + type + "' (set, fill, line, cylinder, sphere, blocks)");
            }
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("op " + index + " (" + type + "): " + e.getMessage());
        } catch (RuntimeException e) {
            throw new IllegalArgumentException("op " + index + " (" + type + "): malformed (" + e.getClass().getSimpleName() + ")");
        }
    }

    /** mode: solid (default) | shell (all 6 faces) | walls (4 sides, no top/bottom) | floor_walls (no top) */
    private void fill(JsonObject op) {
        int[] a = vec(op, "from"), b = vec(op, "to");
        BlockSpec s = BlockSpec.parse(str(op, "block", null));
        String mode = str(op, "mode", "solid");
        int x1 = Math.min(a[0], b[0]), x2 = Math.max(a[0], b[0]);
        int y1 = Math.max(0, Math.min(a[1], b[1])), y2 = Math.min(255, Math.max(a[1], b[1]));
        int z1 = Math.min(a[2], b[2]), z2 = Math.max(a[2], b[2]);
        if (y1 > y2) return;
        long vol = ((long) x2 - x1 + 1) * ((long) y2 - y1 + 1) * ((long) z2 - z1 + 1);
        if (vol > cap * 4L) throw new IllegalArgumentException("fill region too large");
        for (int x = x1; x <= x2; x++) for (int y = y1; y <= y2; y++) for (int z = z1; z <= z2; z++) {
            boolean side = x == x1 || x == x2 || z == z1 || z == z2;
            boolean top = y == y2, bottom = y == y1;
            boolean keep;
            switch (mode) {
                case "solid": keep = true; break;
                case "shell": keep = side || top || bottom; break;
                case "walls": keep = side; break;
                case "floor_walls": keep = side || bottom; break;
                default: throw new IllegalArgumentException("fill mode must be solid|shell|walls|floor_walls");
            }
            if (keep) put(x, y, z, s);
        }
    }

    private void line(JsonObject op) {
        int[] a = vec(op, "from"), b = vec(op, "to");
        BlockSpec s = BlockSpec.parse(str(op, "block", null));
        long dx = (long) b[0] - a[0], dy = (long) b[1] - a[1], dz = (long) b[2] - a[2];
        long nl = Math.max(Math.abs(dx), Math.max(Math.abs(dy), Math.abs(dz)));
        if (nl > cap) throw new IllegalArgumentException("line too long");
        int n = (int) nl;
        for (int i = 0; i <= n; i++) {
            double t = n == 0 ? 0 : (double) i / n;
            put((int) Math.round(a[0] + dx * t), (int) Math.round(a[1] + dy * t), (int) Math.round(a[2] + dz * t), s);
        }
    }

    /** Vertical cylinder: center = bottom-center block, extends `height` blocks up. */
    private void cylinder(JsonObject op) {
        int[] c = vec(op, "center");
        int r = num(op, "radius"), h = num(op, "height");
        if (r < 0 || r > 256 || h < 1 || h > 256) throw new IllegalArgumentException("radius 0-256, height 1-256");
        BlockSpec s = BlockSpec.parse(str(op, "block", null));
        boolean hollow = bool(op, "hollow");
        double rr = (r + 0.5) * (r + 0.5), inner = (r - 0.5) * (r - 0.5);
        for (int dx = -r; dx <= r; dx++) for (int dz = -r; dz <= r; dz++) {
            double d = dx * dx + dz * dz;
            if (d > rr) continue;
            if (hollow && d < inner) continue;
            for (int y = 0; y < h; y++) put(c[0] + dx, c[1] + y, c[2] + dz, s);
        }
    }

    private void sphere(JsonObject op) {
        int[] c = vec(op, "center");
        int r = num(op, "radius");
        if (r < 0 || r > 128) throw new IllegalArgumentException("radius 0-128");
        BlockSpec s = BlockSpec.parse(str(op, "block", null));
        boolean hollow = bool(op, "hollow");
        double rr = (r + 0.5) * (r + 0.5), inner = (r - 0.5) * (r - 0.5);
        for (int dx = -r; dx <= r; dx++) for (int dy = -r; dy <= r; dy++) for (int dz = -r; dz <= r; dz++) {
            double d = dx * dx + dy * dy + dz * dz;
            if (d > rr) continue;
            if (hollow && d < inner) continue;
            put(c[0] + dx, c[1] + dy, c[2] + dz, s);
        }
    }

    /** Relative blueprint: origin [x,y,z] + list of [dx,dy,dz,"block"]. */
    private void blocks(JsonObject op) {
        int[] o = vec(op, "origin");
        JsonElement le = op.get("list");
        if (le == null || !le.isJsonArray()) throw new IllegalArgumentException("'list' must be [[dx,dy,dz,\"block\"],...]");
        for (JsonElement e : le.getAsJsonArray()) {
            JsonArray t = e.getAsJsonArray();
            if (t.size() != 4) throw new IllegalArgumentException("each list entry is [dx,dy,dz,\"block\"]");
            put(o[0] + t.get(0).getAsInt(), o[1] + t.get(1).getAsInt(), o[2] + t.get(2).getAsInt(), BlockSpec.parse(t.get(3).getAsString()));
        }
    }
}
