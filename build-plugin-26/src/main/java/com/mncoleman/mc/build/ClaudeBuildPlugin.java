package com.mncoleman.mc.build;

import org.bukkit.Bukkit;
import org.bukkit.NamespacedKey;
import org.bukkit.boss.BarColor;
import org.bukkit.boss.BarStyle;
import org.bukkit.boss.BossBar;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.plugin.java.JavaPlugin;

import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

public final class ClaudeBuildPlugin extends JavaPlugin {
    private JobManager jobs;
    private Avatar avatar;
    private ApiServer api;
    private Hud hud;
    private final ChatLog chat = new ChatLog();
    public ChatLog chat() { return chat; }

    public JobManager jobs() { return jobs; }
    public Avatar avatar() { return avatar; }

    @Override
    public void onEnable() {
        saveDefaultConfig();
        if (getConfig().getString("api-token", "").isEmpty()) {
            byte[] b = new byte[32];
            new SecureRandom().nextBytes(b);
            StringBuilder sb = new StringBuilder();
            for (byte x : b) sb.append(String.format("%02x", x));
            getConfig().set("api-token", sb.toString());
            saveConfig();
            getLogger().info("Generated a new api-token in config.yml");
        }
        getServer().getPluginManager().registerEvents(chat, this);
        avatar = new Avatar(this);
        jobs = new JobManager(this);
        if (getServer().getPluginManager().getPlugin("BlueMap") != null) {
            try { BlueMapMarkers.init(this); } catch (Throwable t) { getLogger().warning("BlueMap markers unavailable: " + t); }
        }
        hud = new Hud(this);
        getServer().getPluginManager().registerEvents(hud, this);
        getServer().getScheduler().runTaskTimer(this, hud::tick, 20L, 1L);
        try {
            api = new ApiServer(this, getConfig().getInt("api-port", 25581), getConfig().getString("api-token"));
        } catch (Exception e) {
            getLogger().severe("Build API failed to start: " + e);
        }
    }

    @Override
    public void onDisable() {
        if (hud != null) hud.clear();
        if (api != null) api.stop();
        if (avatar != null) avatar.shutdown();
        for (org.bukkit.World w : getServer().getWorlds()) w.removePluginChunkTickets(this);
    }

    @Override
    public boolean onCommand(CommandSender s, Command cmd, String label, String[] args) {
        if (cmd.getName().equalsIgnoreCase("hud")) {
            if (!(s instanceof Player p)) { s.sendMessage("Run this in game."); return true; }
            s.sendMessage(hud.toggle(p) ? "HUD on. Type /hud to hide it." : "HUD off. Type /hud to show it again.");
            return true;
        }
        if (args.length >= 2 && args[0].equalsIgnoreCase("avatar") && args[1].equalsIgnoreCase("test")) {
            if (!(s instanceof org.bukkit.entity.Player)) { s.sendMessage("Run this in game."); return true; }
            s.sendMessage(avatar.test((org.bukkit.entity.Player) s));
            return true;
        }
        if (args.length >= 2 && args[0].equalsIgnoreCase("avatar")) {
            boolean on = args[1].equalsIgnoreCase("on");
            avatar.setEnabled(on);
            s.sendMessage("Claude avatar " + (on ? "enabled" : "disabled"));
            return true;
        }
        if (args.length >= 1 && args[0].equalsIgnoreCase("cancel")) {
            s.sendMessage(jobs.cancelCurrent() ? "Cancelled the running build." : "No build is running.");
            return true;
        }
        JobManager.Job c = jobs.current();
        s.sendMessage("ClaudeBuild: " + (c == null ? "idle" : ("running " + c.id + " " + c.cursor + "/" + c.size()))
            + ", queued " + jobs.queued() + ", avatar " + (getConfig().getBoolean("avatar-enabled") ? "on" : "off"));
        return true;
    }

    /**
     * Coordinates-and-time HUD: one boss bar per player across the top of the
     * screen ("x 133  y 83  z 114 · NE · 07:42 Day"), refreshed every tick; a
     * packet only goes out when the text, colour or (coarse) progress changes.
     * The 1.8 Eaglercraft client had this built in; the 26 client does not.
     * On by default; /hud toggles it, remembered on the player.
     */
    static final class Hud implements Listener {
        private final JavaPlugin plugin;
        private final NamespacedKey off;
        private final Map<UUID, BossBar> bars = new HashMap<>();
        Hud(JavaPlugin plugin) { this.plugin = plugin; this.off = new NamespacedKey(plugin, "hud_off"); }

        boolean enabled(Player p) { return !p.getPersistentDataContainer().has(off, PersistentDataType.BYTE); }

        boolean toggle(Player p) {
            if (enabled(p)) { p.getPersistentDataContainer().set(off, PersistentDataType.BYTE, (byte) 1); remove(p.getUniqueId()); return false; }
            p.getPersistentDataContainer().remove(off); update(p); return true;
        }

        void tick() { for (Player p : Bukkit.getOnlinePlayers()) { if (enabled(p)) update(p); else remove(p.getUniqueId()); } }

        private void update(Player p) {
            BossBar bar = bars.computeIfAbsent(p.getUniqueId(), id -> {
                BossBar b = Bukkit.createBossBar("", BarColor.WHITE, BarStyle.SOLID);
                b.addPlayer(p);
                return b;
            });
            if (!bar.getPlayers().contains(p)) bar.addPlayer(p);
            org.bukkit.Location l = p.getLocation();
            long t = Math.floorMod(p.getWorld().getTime(), 24000L);
            int hour = (int) ((t / 1000 + 6) % 24), min = (int) (t % 1000 * 60 / 1000);
            String phase = t < 12000 ? "Day" : t < 13000 ? "Dusk" : t < 23000 ? "Night" : "Dawn";
            String title = String.format("x %d  y %d  z %d  \u00b7  %s  \u00b7  %02d:%02d %s",
                l.getBlockX(), l.getBlockY(), l.getBlockZ(), facing(l.getYaw()), hour, min, phase);
            if (!title.equals(bar.getTitle())) bar.setTitle(title);
            BarColor color = phase.equals("Night") ? BarColor.BLUE : phase.equals("Day") ? BarColor.YELLOW : BarColor.PINK;
            if (bar.getColor() != color) bar.setColor(color);
            double progress = Math.floor(t / 240.0) / 100.0;   // 1% steps, so it isn't resent every tick
            if (Math.abs(bar.getProgress() - progress) > 1e-9) bar.setProgress(progress);
        }

        private static String facing(float yaw) {
            String[] d = {"S", "SW", "W", "NW", "N", "NE", "E", "SE"};
            return d[(int) Math.floorMod(Math.round(yaw / 45f), 8)];
        }

        private void remove(UUID id) { BossBar b = bars.remove(id); if (b != null) b.removeAll(); }

        void clear() { for (BossBar b : bars.values()) b.removeAll(); bars.clear(); }

        @EventHandler public void onQuit(PlayerQuitEvent e) { remove(e.getPlayer().getUniqueId()); }
    }
}
