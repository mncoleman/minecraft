package com.mncoleman.mc.build;

import com.mojang.authlib.GameProfile;
import net.minecraft.server.v1_12_R1.*;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.craftbukkit.v1_12_R1.CraftServer;
import org.bukkit.craftbukkit.v1_12_R1.CraftWorld;
import org.bukkit.craftbukkit.v1_12_R1.entity.CraftPlayer;
import org.bukkit.craftbukkit.v1_12_R1.inventory.CraftItemStack;
import org.bukkit.entity.Player;

import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

/**
 * Packet-only "Claude" avatar: a fake player that exists ONLY as packets sent to
 * nearby clients (never added to the world, never ticks, can't be hit or saved).
 * It appears while a build runs, hovers next to the blocks being placed and swings
 * its arm, then disappears a few seconds after the job ends. Any failure disables
 * it for the rest of the session — the build itself never depends on it.
 */
public final class Avatar {
    private static final double VIEW_DIST = 160;

    private final ClaudeBuildPlugin plugin;
    private EntityPlayer npc;
    private String npcWorld;
    private final Set<UUID> viewers = new HashSet<>();
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

    public Avatar(ClaudeBuildPlugin plugin) { this.plugin = plugin; }

    public boolean present() { return npc != null && System.currentTimeMillis() < presentUntil; }

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
            if (npc == null || !w.getName().equals(npcWorld)) {
                despawnAll();
                spawn(w, nx, ny, nz, yaw, pitch);
            } else {
                npc.setLocation(nx, ny, nz, yaw, pitch);
                sendAll(new PacketPlayOutEntityTeleport(npc));
                sendAll(new PacketPlayOutEntityHeadRotation(npc, (byte) (yaw * 256f / 360f)));
            }
            refreshViewers(w);
            if ((tickCount++ % 3) == 0) sendAll(new PacketPlayOutAnimation(npc, 0));
        } catch (Throwable t) {
            fail(t);
        }
    }

    public void jobFinished(JobManager.Job j) {
        building = false;
        if (npc == null || present()) return;   // directed presence keeps it around
        despawnTask = Bukkit.getScheduler().runTaskLater(plugin, () -> { despawnTask = -1; despawnAll(); }, 100L).getTaskId();
    }

    /** Chat line shown as if the avatar spoke. Works whether or not it's visible. */
    public void say(String message) {
        String line = ChatColor.LIGHT_PURPLE + "<" + displayName() + "> " + ChatColor.RESET + message;
        for (Player p : Bukkit.getOnlinePlayers()) p.sendMessage(line);
        plugin.getLogger().info("[say] " + message);
        plugin.chat().add("claude", displayName(), null, message);
    }

    public void shutdown() { despawnAll(); stopBrain(); }

    // ── directed presence ─────────────────────────────────────────────────────
    private void ensureShown(World w, double x, double y, double z, float yaw) {
        if (despawnTask != -1) { Bukkit.getScheduler().cancelTask(despawnTask); despawnTask = -1; }
        if (npc == null || !w.getName().equals(npcWorld)) { despawnAll(); spawn(w, x, y, z, yaw, 0f); }
        startBrain();
    }

    public String appear(World w, double x, double y, double z, float yaw, int seconds) {
        if (!enabled()) return "Avatar is turned off (/claude avatar on).";
        try {
            presentUntil = System.currentTimeMillis() + seconds * 1000L;
            goal = null; following = null; lookAt = null;
            ensureShown(w, x, y, z, yaw);
            move(x, y, z, yaw, 0f);
            return "Claude is standing at " + Math.round(x) + " " + Math.round(y) + " " + Math.round(z) + " in " + w.getName() + " for " + seconds + "s (" + viewers.size() + " player(s) can see it).";
        } catch (Throwable t) { fail(t); return "Avatar failed: " + t; }
    }

    public String walkTo(World w, double x, double y, double z, int seconds) {
        if (npc == null || !w.getName().equals(npcWorld)) return "Claude isn't shown in " + w.getName() + " — use appear first.";
        presentUntil = Math.max(presentUntil, System.currentTimeMillis() + seconds * 1000L);
        following = null; lookAt = null; goal = new double[]{x, y, z};
        double d = Math.sqrt(Math.pow(x - npc.locX, 2) + Math.pow(y - npc.locY, 2) + Math.pow(z - npc.locZ, 2));
        return "Walking to " + Math.round(x) + " " + Math.round(y) + " " + Math.round(z) + " (~" + Math.round(d / (WALK_PER_TICK * 20)) + "s).";
    }

    public String follow(Player p, int seconds) {
        if (!enabled()) return "Avatar is turned off (/claude avatar on).";
        org.bukkit.Location l = p.getLocation();
        presentUntil = System.currentTimeMillis() + seconds * 1000L;
        goal = null; lookAt = null; following = p.getUniqueId();
        if (npc == null || !l.getWorld().getName().equals(npcWorld)) {
            double yawR = Math.toRadians(l.getYaw());
            ensureShown(l.getWorld(), l.getX() + Math.sin(yawR) * 2, l.getY(), l.getZ() - Math.cos(yawR) * 2, l.getYaw());
        }
        return "Following " + p.getName() + " for " + seconds + "s.";
    }

    public String look(double x, double y, double z) {
        if (npc == null) return "Claude isn't shown — use appear first.";
        lookAt = new double[]{x, y, z};
        return "Looking at " + Math.round(x) + " " + Math.round(y) + " " + Math.round(z) + ".";
    }

    public String hide() {
        presentUntil = 0; goal = null; following = null; lookAt = null;
        despawnAll(); stopBrain();
        return "Claude left.";
    }

    public com.google.gson.JsonObject status() {
        com.google.gson.JsonObject o = new com.google.gson.JsonObject();
        o.addProperty("shown", npc != null);
        o.addProperty("enabled", enabled());
        if (npc != null) {
            o.addProperty("world", npcWorld);
            o.addProperty("x", Math.round(npc.locX)); o.addProperty("y", Math.round(npc.locY)); o.addProperty("z", Math.round(npc.locZ));
            o.addProperty("seen_by", viewers.size());
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
            if (npc == null) { stopBrain(); return; }
            if (!present() && !building) { if (despawnTask == -1) { despawnAll(); stopBrain(); } return; }
            if (building) return;                       // builds steer it via progress()
            World w = Bukkit.getWorld(npcWorld);
            if (w == null) { despawnAll(); stopBrain(); return; }
            double[] g = goal;
            if (following != null) {
                Player p = Bukkit.getPlayer(following);
                if (p == null || !p.getWorld().getName().equals(npcWorld)) { following = null; }
                else {
                    org.bukkit.Location l = p.getLocation();
                    double dist = Math.sqrt(Math.pow(l.getX() - npc.locX, 2) + Math.pow(l.getZ() - npc.locZ, 2));
                    if (dist > 3.5) {
                        double k = (dist - 2.5) / dist;   // stop ~2.5 blocks away
                        g = new double[]{npc.locX + (l.getX() - npc.locX) * k, l.getY(), npc.locZ + (l.getZ() - npc.locZ) * k};
                    } else g = null;
                    if (dist > 48) { move(l.getX() + 2, l.getY(), l.getZ() + 2, npc.yaw, 0f); g = null; } // fell far behind: catch up
                    lookAt = new double[]{l.getX(), l.getY() + 1.6, l.getZ()};
                }
            }
            double x = npc.locX, y = npc.locY, z = npc.locZ;
            float yaw = npc.yaw, pitch = npc.pitch;
            if (g != null) {
                double dx = g[0] - x, dy = g[1] - y, dz = g[2] - z, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (d <= WALK_PER_TICK) { x = g[0]; y = g[1]; z = g[2]; if (g == goal) goal = null; }
                else { x += dx / d * WALK_PER_TICK; y += dy / d * WALK_PER_TICK; z += dz / d * WALK_PER_TICK; }
                yaw = (float) Math.toDegrees(Math.atan2(-dx, dz)); pitch = 0f;
            }
            if (lookAt != null && (g == null || following != null)) {
                double dx = lookAt[0] - x, dy = lookAt[1] - (y + 1.62), dz = lookAt[2] - z;
                yaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
                pitch = (float) -Math.toDegrees(Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)));
            }
            if (x != npc.locX || y != npc.locY || z != npc.locZ || yaw != npc.yaw || pitch != npc.pitch) move(x, y, z, yaw, pitch);
            if ((tickCount++ % 20) == 0) refreshViewers(w);
        } catch (Throwable t) { fail(t); }
    }

    private void move(double x, double y, double z, float yaw, float pitch) {
        npc.setLocation(x, y, z, yaw, pitch);
        sendAll(new PacketPlayOutEntityTeleport(npc));
        sendAll(new PacketPlayOutEntityHeadRotation(npc, (byte) (yaw * 256f / 360f)));
    }

    /** Debug: show the avatar 3 blocks in front of a player for 15 s; returns a status line. */
    public String test(Player p) {
        if (broken) return "Avatar is disabled after an earlier error (see console); /claude avatar on resets it.";
        try {
            org.bukkit.Location l = p.getLocation();
            double yawR = Math.toRadians(l.getYaw());
            double x = l.getX() - Math.sin(yawR) * 3, z = l.getZ() + Math.cos(yawR) * 3;
            float face = (l.getYaw() + 180f) % 360f; // look back at the player
            if (despawnTask != -1) { Bukkit.getScheduler().cancelTask(despawnTask); despawnTask = -1; }
            despawnAll();
            spawn(l.getWorld(), x, l.getY(), z, face, 0f);
            for (int k = 0; k < 15; k++) Bukkit.getScheduler().runTaskLater(plugin, () -> { if (npc != null) sendAll(new PacketPlayOutAnimation(npc, 0)); }, 20L * k + 10);
            despawnTask = Bukkit.getScheduler().runTaskLater(plugin, () -> { despawnTask = -1; despawnAll(); }, 300L).getTaskId();
            String msg = "Avatar shown at " + Math.round(x) + " " + Math.round(l.getY()) + " " + Math.round(z) + " to " + viewers.size() + " player(s), entity id " + npc.getId() + ", for 15s.";
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

    // ── packets ───────────────────────────────────────────────────────────────
    private void spawn(World w, double x, double y, double z, float yaw, float pitch) {
        MinecraftServer srv = ((CraftServer) Bukkit.getServer()).getServer();
        WorldServer ws = ((CraftWorld) w).getHandle();
        GameProfile gp = new GameProfile(UUID.randomUUID(), displayName());
        npc = new EntityPlayer(srv, ws, gp, new PlayerInteractManager(ws));
        npc.setLocation(x, y, z, yaw, pitch);
        npcWorld = w.getName();
        viewers.clear();
        refreshViewers(w);
        plugin.getLogger().info("[avatar] spawned in " + npcWorld + " at " + Math.round(x) + " " + Math.round(y) + " " + Math.round(z) + " for " + viewers.size() + " viewer(s)");
    }

    private void refreshViewers(World w) {
        if (npc == null) return;
        Set<UUID> now = new HashSet<>();
        for (Player p : w.getPlayers()) {
            if (p.getLocation().distanceSquared(new org.bukkit.Location(w, npc.locX, npc.locY, npc.locZ)) > VIEW_DIST * VIEW_DIST) continue;
            now.add(p.getUniqueId());
            if (!viewers.contains(p.getUniqueId())) show(p);
        }
        for (UUID u : new HashSet<>(viewers)) {
            if (!now.contains(u)) { Player p = Bukkit.getPlayer(u); if (p != null) hide(p); }
        }
        viewers.clear();
        viewers.addAll(now);
    }

    private void show(Player p) {
        PlayerConnection c = ((CraftPlayer) p).getHandle().playerConnection;
        c.sendPacket(new PacketPlayOutPlayerInfo(PacketPlayOutPlayerInfo.EnumPlayerInfoAction.ADD_PLAYER, npc));
        c.sendPacket(new PacketPlayOutNamedEntitySpawn(npc));
        c.sendPacket(new PacketPlayOutEntityHeadRotation(npc, (byte) (npc.yaw * 256f / 360f)));
        c.sendPacket(new PacketPlayOutEntityEquipment(npc.getId(), EnumItemSlot.MAINHAND,
            CraftItemStack.asNMSCopy(new org.bukkit.inventory.ItemStack(Material.GOLD_PICKAXE))));
        c.sendPacket(new PacketPlayOutEntityEquipment(npc.getId(), EnumItemSlot.HEAD,
            CraftItemStack.asNMSCopy(new org.bukkit.inventory.ItemStack(Material.GOLD_HELMET))));
    }

    private void hide(Player p) {
        if (npc == null) return;
        PlayerConnection c = ((CraftPlayer) p).getHandle().playerConnection;
        c.sendPacket(new PacketPlayOutEntityDestroy(npc.getId()));
        c.sendPacket(new PacketPlayOutPlayerInfo(PacketPlayOutPlayerInfo.EnumPlayerInfoAction.REMOVE_PLAYER, npc));
    }

    private void sendAll(Packet<?> pk) {
        for (UUID u : viewers) {
            Player p = Bukkit.getPlayer(u);
            if (p != null) ((CraftPlayer) p).getHandle().playerConnection.sendPacket(pk);
        }
    }

    private void despawnAll() {
        if (npc == null) return;
        try {
            for (UUID u : viewers) { Player p = Bukkit.getPlayer(u); if (p != null) hide(p); }
        } catch (Throwable ignored) {}
        viewers.clear();
        npc = null; npcWorld = null;
    }

    private void fail(Throwable t) {
        broken = true;
        plugin.getLogger().warning("Avatar disabled after error: " + t);
        try { despawnAll(); } catch (Throwable ignored) {}
    }
}
