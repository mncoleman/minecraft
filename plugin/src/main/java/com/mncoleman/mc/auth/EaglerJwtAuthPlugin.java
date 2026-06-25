package com.mncoleman.mc.auth;

import net.lax1dude.eaglercraft.backend.server.api.bukkit.EaglerXServerAPI;
import org.bukkit.plugin.java.JavaPlugin;

public final class EaglerJwtAuthPlugin extends JavaPlugin {

    private PresenceServer presence;

    @Override
    public void onEnable() {
        saveDefaultConfig();

        // Secret: env first (preferred), then config.yml.
        String secret = System.getenv("MC_JWT_SECRET");
        if (secret == null || secret.isEmpty()) {
            secret = getConfig().getString("jwt-secret", "");
        }

        String cookieName = getConfig().getString("cookie-name", "mc_session");
        String issuer = getConfig().getString("issuer", "mc-auth");
        String audience = getConfig().getString("audience", "minecraft.mncoleman.com");
        String kick = getConfig().getString("kick-message", "Please log in at https://minecraft.mncoleman.com to play.");
        long leeway = getConfig().getLong("leeway-seconds", 30L);
        // lock-mode: "require" (default) locks the in-game username to the account;
        // "skip" is the emergency fallback that admits without locking.
        String lockMode = getConfig().getString("lock-mode", "require");
        boolean lockUsername = !"skip".equalsIgnoreCase(lockMode);

        // Confirm EaglercraftXServer is present (we depend on it).
        try {
            EaglerXServerAPI.instance();
        } catch (Throwable t) {
            getLogger().warning("EaglerXServerAPI not reachable in onEnable (continuing; events still bind): " + t);
        }

        JwtVerifier verifier;
        if (secret == null || secret.isEmpty()) {
            getLogger().severe("No JWT secret set (MC_JWT_SECRET env or jwt-secret in config.yml). "
                    + "FAILING CLOSED: every connection will be denied until this is fixed.");
            verifier = null; // AuthListener denies everyone
        } else {
            verifier = new JwtVerifier(secret, issuer, audience, leeway);
            getLogger().info("EaglerJwtAuth ready (issuer=" + issuer + ", aud=" + audience + ", cookie=" + cookieName
                    + ", lock-mode=" + (lockUsername ? "require" : "skip") + ").");
        }

        // Presence token (shared with mc-auth) — used both for the presence endpoint
        // below AND as the bearer for the current-username lookup against mc-auth.
        String presenceToken = System.getenv("MC_PRESENCE_TOKEN");
        if (presenceToken == null || presenceToken.isEmpty()) presenceToken = getConfig().getString("presence-token", "");

        // Current-username resolver: maps a JWT's account id to the live username so
        // renames take effect immediately and old names stop working. Optional —
        // disabled (and we fall back to the JWT name) if not configured.
        String mcAuthUrl = getConfig().getString("mc-auth-url", "http://mc-auth:7900");
        CurrentNameResolver resolver = null;
        if (presenceToken != null && !presenceToken.isEmpty() && mcAuthUrl != null && !mcAuthUrl.isEmpty()) {
            resolver = new CurrentNameResolver(mcAuthUrl, presenceToken, getLogger());
            getLogger().info("Username resolver enabled (mc-auth=" + mcAuthUrl + ").");
        } else {
            getLogger().info("Username resolver disabled (no presence token / mc-auth url); using JWT name as-is.");
        }

        getServer().getPluginManager().registerEvents(
                new AuthListener(verifier, resolver, cookieName, kick, lockUsername, getLogger()), this);

        // Presence endpoint (for the mc-auth panel). Only starts if a token is set.
        int presencePort = getConfig().getInt("presence-port", 25580);
        if (presenceToken != null && !presenceToken.isEmpty()) {
            try {
                presence = new PresenceServer(this, presencePort, presenceToken, getLogger());
            } catch (Exception e) {
                getLogger().warning("Presence endpoint failed to start: " + e);
            }
        } else {
            getLogger().info("Presence endpoint disabled (no MC_PRESENCE_TOKEN).");
        }
    }

    @Override
    public void onDisable() {
        if (presence != null) presence.stop();
    }
}
