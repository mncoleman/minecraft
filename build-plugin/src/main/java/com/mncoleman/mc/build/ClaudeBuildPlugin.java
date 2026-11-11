package com.mncoleman.mc.build;

import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.plugin.java.JavaPlugin;

import java.security.SecureRandom;

public final class ClaudeBuildPlugin extends JavaPlugin {
    private JobManager jobs;
    private Avatar avatar;
    private ApiServer api;
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
        try {
            api = new ApiServer(this, getConfig().getInt("api-port", 25581), getConfig().getString("api-token"));
        } catch (Exception e) {
            getLogger().severe("Build API failed to start: " + e);
        }
    }

    @Override
    public void onDisable() {
        if (api != null) api.stop();
        if (avatar != null) avatar.shutdown();
    }

    @Override
    public boolean onCommand(CommandSender s, Command cmd, String label, String[] args) {
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
}
