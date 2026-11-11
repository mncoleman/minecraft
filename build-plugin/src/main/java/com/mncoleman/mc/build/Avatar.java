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

    public Avatar(ClaudeBuildPlugin plugin) { this.plugin = plugin; }

    private boolean enabled() { return !broken && plugin.getConfig().getBoolean("avatar-enabled", true); }
    private String displayName() {
        String n = plugin.getConfig().getString("avatar-name", "Claude");
        return n.length() > 16 ? n.substring(0, 16) : n;
    }

    public void jobStarted(JobManager.Job j) {
        if (despawnTask != -1) { Bukkit.getScheduler().cancelTask(despawnTask); despawnTask = -1; }
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
        if (npc == null) return;
        despawnTask = Bukkit.getScheduler().runTaskLater(plugin, () -> { despawnTask = -1; despawnAll(); }, 100L).getTaskId();
    }

    /** Chat line shown as if the avatar spoke. Works whether or not it's visible. */
    public void say(String message) {
        String line = ChatColor.LIGHT_PURPLE + "<" + displayName() + "> " + ChatColor.RESET + message;
        for (Player p : Bukkit.getOnlinePlayers()) p.sendMessage(line);
        plugin.getLogger().info("[say] " + message);
    }

    public void shutdown() { despawnAll(); }

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
