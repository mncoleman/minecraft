package com.mncoleman.mc.build;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.World;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Mannequin;
import org.bukkit.entity.Player;
import org.bukkit.inventory.EntityEquipment;
import org.bukkit.inventory.ItemStack;
import org.bukkit.persistence.PersistentDataType;

import java.util.UUID;

/**
 * The "Claude" avatar: a Paper Mannequin entity (player-shaped, no AI) with a gold
 * helmet and gold pickaxe. It is NON-PERSISTENT (never written to the world),
 * invulnerable, silent, gravity-free and immovable, and is removed on hide and on
 * plugin disable. While shown, a plugin chunk ticket keeps its chunk loaded so it
 * doesn't vanish when nobody is nearby. It appears while a build runs (hovering by
 * the blocks being placed, swinging its arm) and on request via /avatar. Movement
 * is teleport-stepping on the server thread. Any failure disables it for the
 * session — builds never depend on it.
 */
public final class Avatar {
    private static final double VIEW_DIST = 160;

    private final ClaudeBuildPlugin plugin;
    private final NamespacedKey markKey;
    private Mannequin npc;
    private String npcWorld;
    private long ticketChunk = Long.MIN_VALUE;
    private World ticketWorld;
    private int despawnTask = -1;
    private int tickCount = 0;
    private boolean broken = false;

    // Directed presence (the `avatar` tool): stays until presentUntil, can walk to
    // a goal or follow a player. Driven by one tick task that runs only while shown.
    private long presentUntil = 0;
    private double[] goal = null;           // x,y,z to walk to
    private UUID following = null;
    private double[] lookAt = null;
    private int brainTask = -1;
    private boolean building = false;
    private static final double WALK_PER_TICK = 0.24;   // ~4.8 blocks/s, a brisk walk

    public Avatar(ClaudeBuildPlugin plugin) {
        this.plugin = plugin;
        this.markKey = new NamespacedKey(plugin, "avatar");
        removeStrays();
    }

    private boolean shown() { return npc != null && npc.isValid(); }
    public boolean present() { return shown() && System.currentTimeMillis() < presentUntil; }

    private boolean enabled() { return !broken && plugin.getConfig().getBoolean("avatar-enabled", true); }
    private String displayName() {
        String n = plugin.getConfig().getString("avatar-name", "Claude");
        return n.length() > 16 ? n.substring(0, 16) : n;
    }

    public void jobStarted(JobManager.Job j) {
        if (despawnTask != -1) { Bukkit.getScheduler().cancelTask(despawnTask); despawnTask = -1; }
        building = true;
    }

    public void progress(JobManager.Job j, World w, int x, int y, int z) {
        if (!enabled()) return;
        try {
            double nx = x + 2.5, ny = y + 1, nz = z + 2.5;
            float yaw = (float) Math.toDegrees(Math.atan2(-((x + 0.5) - nx), (z + 0.5) - nz));
            float pitch = 30f;
            if (!shown() || !w.getName().equals(npcWorld)) {
                despawnAll();
                spawn(w, nx, ny, nz, yaw, pitch);
            } else {
                move(nx, ny, nz, yaw, pitch);
            }
            if ((tickCount++ % 3) == 0) npc.swingMainHand();
        } catch (Throwable t) {
            fail(t);
        }
    }

    public void jobFinished(JobManager.Job j) {
        building = false;
        if (!shown() || present()) return;   // directed presence keeps it around
        despawnTask = Bukkit.getScheduler().runTaskLater(plugin, () -> { despawnTask = -1; despawnAll(); }, 100L).getTaskId();
    }

    /** Chat line shown as if the avatar spoke. Works whether or not it's visible. */
    public void say(String message) {
        Component line = Component.text("<" + displayName() + "> ", NamedTextColor.LIGHT_PURPLE).append(Component.text(message, NamedTextColor.WHITE));
        for (Player p : Bukkit.getOnlinePlayers()) p.sendMessage(line);
        plugin.getLogger().info("[say] " + message);
        plugin.chat().add("claude", displayName(), null, message);
    }

    public void shutdown() { stopBrain(); despawnAll(); removeStrays(); }

    // ── directed presence ─────────────────────────────────────────────────────
    private void ensureShown(World w, double x, double y, double z, float yaw) {
        if (despawnTask != -1) { Bukkit.getScheduler().cancelTask(despawnTask); despawnTask = -1; }
        if (!shown() || !w.getName().equals(npcWorld)) { despawnAll(); spawn(w, x, y, z, yaw, 0f); }
        startBrain();
    }

    public String appear(World w, double x, double y, double z, float yaw, int seconds) {
        if (!enabled()) return "Avatar is turned off (/claude avatar on).";
        try {
            presentUntil = System.currentTimeMillis() + seconds * 1000L;
            goal = null; following = null; lookAt = null;
            ensureShown(w, x, y, z, yaw);
            move(x, y, z, yaw, 0f);
            return "Claude is standing at " + Math.round(x) + " " + Math.round(y) + " " + Math.round(z) + " in " + w.getName() + " for " + seconds + "s (" + viewerCount() + " player(s) can see it).";
        } catch (Throwable t) { fail(t); return "Avatar failed: " + t; }
    }

    public String walkTo(World w, double x, double y, double z, int seconds) {
        if (!shown() || !w.getName().equals(npcWorld)) return "Claude isn't shown in " + w.getName() + " — use appear first.";
        presentUntil = Math.max(presentUntil, System.currentTimeMillis() + seconds * 1000L);
        following = null; lookAt = null; goal = new double[]{x, y, z};
        startBrain();
        Location l = npc.getLocation();
        double d = Math.sqrt(Math.pow(x - l.getX(), 2) + Math.pow(y - l.getY(), 2) + Math.pow(z - l.getZ(), 2));
        return "Walking to " + Math.round(x) + " " + Math.round(y) + " " + Math.round(z) + " (~" + Math.round(d / (WALK_PER_TICK * 20)) + "s).";
    }

    public String follow(Player p, int seconds) {
        if (!enabled()) return "Avatar is turned off (/claude avatar on).";
        Location l = p.getLocation();
        presentUntil = System.currentTimeMillis() + seconds * 1000L;
        goal = null; lookAt = null; following = p.getUniqueId();
        if (!shown() || !l.getWorld().getName().equals(npcWorld)) {
            double yawR = Math.toRadians(l.getYaw());
            ensureShown(l.getWorld(), l.getX() + Math.sin(yawR) * 2, l.getY(), l.getZ() - Math.cos(yawR) * 2, l.getYaw());
        } else startBrain();
        return "Following " + p.getName() + " for " + seconds + "s.";
    }

    public String look(double x, double y, double z) {
        if (!shown()) return "Claude isn't shown — use appear first.";
        lookAt = new double[]{x, y, z};
        startBrain();
        return "Looking at " + Math.round(x) + " " + Math.round(y) + " " + Math.round(z) + ".";
    }

    public String hide() {
        presentUntil = 0; goal = null; following = null; lookAt = null;
        stopBrain(); despawnAll();
        return "Claude left.";
    }

    public com.google.gson.JsonObject status() {
        com.google.gson.JsonObject o = new com.google.gson.JsonObject();
        o.addProperty("shown", shown());
        o.addProperty("enabled", enabled());
        if (shown()) {
            Location l = npc.getLocation();
            o.addProperty("world", npcWorld);
            o.addProperty("x", Math.round(l.getX())); o.addProperty("y", Math.round(l.getY())); o.addProperty("z", Math.round(l.getZ()));
            o.addProperty("seen_by", viewerCount());
            o.addProperty("seconds_left", Math.max(0, (presentUntil - System.currentTimeMillis()) / 1000));
            o.addProperty("doing", building ? "building" : following != null ? "following" : goal != null ? "walking" : "standing");
        }
        return o;
    }

    private void startBrain() {
        if (brainTask != -1) return;
        brainTask = Bukkit.getScheduler().runTaskTimer(plugin, this::brain, 1L, 1L).getTaskId();
    }
    private void stopBrain() { if (brainTask != -1) { Bukkit.getScheduler().cancelTask(brainTask); brainTask = -1; } }

    private void brain() {
        try {
            if (!shown()) { npc = null; npcWorld = null; releaseTicket(); stopBrain(); return; }
            if (!present() && !building) { if (despawnTask == -1) { despawnAll(); stopBrain(); } return; }
            if (building) return;                       // builds steer it via progress()
            Location cur = npc.getLocation();
            double x = cur.getX(), y = cur.getY(), z = cur.getZ();
            float yaw = cur.getYaw(), pitch = cur.getPitch();
            double[] g = goal;
            if (following != null) {
                Player p = Bukkit.getPlayer(following);
                if (p == null || !p.getWorld().getName().equals(npcWorld)) { following = null; }
                else {
                    Location l = p.getLocation();
                    double dist = Math.sqrt(Math.pow(l.getX() - x, 2) + Math.pow(l.getZ() - z, 2));
                    if (dist > 3.5) {
                        double k = (dist - 2.5) / dist;   // stop ~2.5 blocks away
                        g = new double[]{x + (l.getX() - x) * k, l.getY(), z + (l.getZ() - z) * k};
                    } else g = null;
                    if (dist > 48) { move(l.getX() + 2, l.getY(), l.getZ() + 2, yaw, 0f); return; } // fell far behind: catch up
                    lookAt = new double[]{l.getX(), l.getY() + 1.6, l.getZ()};
                }
            }
            double nx = x, ny = y, nz = z;
            if (g != null) {
                double dx = g[0] - x, dy = g[1] - y, dz = g[2] - z, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (d <= WALK_PER_TICK) { nx = g[0]; ny = g[1]; nz = g[2]; if (g == goal) goal = null; }
                else { nx += dx / d * WALK_PER_TICK; ny += dy / d * WALK_PER_TICK; nz += dz / d * WALK_PER_TICK; }
                yaw = (float) Math.toDegrees(Math.atan2(-dx, dz)); pitch = 0f;
            }
            if (lookAt != null && (g == null || following != null)) {
                double dx = lookAt[0] - nx, dy = lookAt[1] - (ny + 1.62), dz = lookAt[2] - nz;
                yaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
                pitch = (float) -Math.toDegrees(Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)));
            }
            if (nx != x || ny != y || nz != z || yaw != cur.getYaw() || pitch != cur.getPitch()) move(nx, ny, nz, yaw, pitch);
            tickCount++;
        } catch (Throwable t) { fail(t); }
    }

    private void move(double x, double y, double z, float yaw, float pitch) {
        World w = npc.getWorld();
        Location to = new Location(w, x, y, z, yaw, pitch);
        holdTicket(w, ((long) ((int) Math.floor(x) >> 4) << 32) ^ (((int) Math.floor(z) >> 4) & 0xFFFFFFFFL));
        Location cur = npc.getLocation();
        if (cur.getX() != x || cur.getY() != y || cur.getZ() != z) npc.teleport(to);
        npc.setRotation(yaw, pitch);
        npc.setBodyYaw(yaw);
    }

    /** Debug: show the avatar 3 blocks in front of a player for 15 s; returns a status line. */
    public String test(Player p) {
        if (broken) return "Avatar is disabled after an earlier error (see console); /claude avatar on resets it.";
        try {
            Location l = p.getLocation();
            double yawR = Math.toRadians(l.getYaw());
            double x = l.getX() - Math.sin(yawR) * 3, z = l.getZ() + Math.cos(yawR) * 3;
            float face = (l.getYaw() + 180f) % 360f; // look back at the player
            if (despawnTask != -1) { Bukkit.getScheduler().cancelTask(despawnTask); despawnTask = -1; }
            despawnAll();
            spawn(l.getWorld(), x, l.getY(), z, face, 0f);
            for (int k = 0; k < 15; k++) Bukkit.getScheduler().runTaskLater(plugin, () -> { if (shown()) npc.swingMainHand(); }, 20L * k + 10);
            despawnTask = Bukkit.getScheduler().runTaskLater(plugin, () -> { despawnTask = -1; despawnAll(); }, 300L).getTaskId();
            String msg = "Avatar shown at " + Math.round(x) + " " + Math.round(l.getY()) + " " + Math.round(z) + " to " + viewerCount() + " player(s), entity " + npc.getUniqueId() + ", for 15s.";
            plugin.getLogger().info("[avatar test] " + msg);
            return msg;
        } catch (Throwable t) { fail(t); return "Avatar failed: " + t; }
    }

    public void setEnabled(boolean on) {
        plugin.getConfig().set("avatar-enabled", on);
        plugin.saveConfig();
        if (!on) despawnAll();
        if (on) broken = false;
    }

    // ── entity ────────────────────────────────────────────────────────────────
    private void spawn(World w, double x, double y, double z, float yaw, float pitch) {
        Location at = new Location(w, x, y, z, yaw, pitch);
        holdTicket(w, ((long) ((int) Math.floor(x) >> 4) << 32) ^ (((int) Math.floor(z) >> 4) & 0xFFFFFFFFL));
        String name = displayName();
        npc = w.spawn(at, Mannequin.class, m -> {
            m.setPersistent(false);              // never saved to the world
            m.setInvulnerable(true);
            m.setSilent(true);
            m.setGravity(false);
            m.setCollidable(false);
            m.setImmovable(true);
            m.setRemoveWhenFarAway(false);
            m.customName(Component.text(name, NamedTextColor.GOLD));
            m.setCustomNameVisible(true);
            try { m.setDescription(null); } catch (Throwable ignored) {}   // hide the "NPC" line under the name
            m.getPersistentDataContainer().set(markKey, PersistentDataType.BYTE, (byte) 1);
            EntityEquipment eq = m.getEquipment();
            eq.setHelmet(new ItemStack(Material.GOLDEN_HELMET));
            eq.setItemInMainHand(new ItemStack(Material.GOLDEN_PICKAXE));
        });
        npcWorld = w.getName();
        plugin.getLogger().info("[avatar] spawned in " + npcWorld + " at " + Math.round(x) + " " + Math.round(y) + " " + Math.round(z) + " for " + viewerCount() + " viewer(s)");
    }

    private int viewerCount() {
        if (!shown()) return 0;
        Location l = npc.getLocation();
        int n = 0;
        for (Player p : l.getWorld().getPlayers()) if (p.getLocation().distanceSquared(l) <= VIEW_DIST * VIEW_DIST) n++;
        return n;
    }

    private void holdTicket(World w, long chunk) {
        if (w == ticketWorld && chunk == ticketChunk) return;
        int cx = (int) (chunk >> 32), cz = (int) chunk;
        w.addPluginChunkTicket(cx, cz, plugin);
        releaseTicket();
        ticketWorld = w; ticketChunk = chunk;
    }

    private void releaseTicket() {
        if (ticketWorld != null) {
            try { ticketWorld.removePluginChunkTicket((int) (ticketChunk >> 32), (int) ticketChunk, plugin); } catch (Throwable ignored) {}
        }
        ticketWorld = null; ticketChunk = Long.MIN_VALUE;
    }

    private void despawnAll() {
        if (npc != null) { try { npc.remove(); } catch (Throwable ignored) {} }
        npc = null; npcWorld = null;
        releaseTicket();
    }

    /** Remove any avatar left in loaded chunks (e.g. after a reload). */
    private void removeStrays() {
        try {
            for (World w : Bukkit.getWorlds())
                for (Entity e : w.getEntitiesByClass(Mannequin.class))
                    if (e.getPersistentDataContainer().has(markKey, PersistentDataType.BYTE) && e != npc) e.remove();
        } catch (Throwable ignored) {}
    }

    private void fail(Throwable t) {
        broken = true;
        plugin.getLogger().warning("Avatar disabled after error: " + t);
        try { despawnAll(); } catch (Throwable ignored) {}
    }
}
