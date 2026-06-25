package com.mncoleman.mc.auth;

import net.lax1dude.eaglercraft.backend.server.api.EnumWebSocketHeader;
import net.lax1dude.eaglercraft.backend.server.api.event.IEaglercraftAuthCheckRequiredEvent.EnumAuthResponse;
import net.lax1dude.eaglercraft.backend.server.api.event.IEaglercraftAuthCheckRequiredEvent.EnumAuthType;
import net.lax1dude.eaglercraft.backend.server.api.bukkit.event.EaglercraftAuthCheckRequiredEvent;
import net.lax1dude.eaglercraft.backend.server.api.bukkit.event.EaglercraftAuthCookieEvent;
import net.lax1dude.eaglercraft.backend.server.api.bukkit.event.EaglercraftAuthPasswordEvent;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;

import java.nio.charset.StandardCharsets;
import java.util.logging.Logger;

/**
 * The security boundary. On the Eaglercraft handshake the browser sends its
 * same-site session cookie (the mc-auth JWT) as the HTTP Cookie header. We read
 * it off the connection, validate it, and LOCK the in-game username to the
 * authenticated identity so per-world permissions key on an unspoofable name.
 *
 * lock-mode = require (default):
 *   1. AuthCheckRequiredEvent: no valid JWT -> kick. Valid JWT -> the typed
 *      username MUST equal the account's CURRENT username. That name is resolved
 *      from the JWT's stable sub via mc-auth (CurrentNameResolver), NOT the name
 *      frozen in the token, so a rename takes effect immediately and the old name
 *      stops working. (The offline UUID derives from the typed/INIT name and is
 *      NOT re-derived from setProfileUsername on Bukkit, so they must match or
 *      world data/permissions attach to the wrong UUID.)
 *      On match: require cookie auth so a username-setting event fires next.
 *   2. AuthCookieEvent / AuthPasswordEvent: re-validate, setProfileUsername +
 *      setLoginAllowed (or deny).
 *
 * lock-mode = skip (fallback only): admit any valid-JWT holder under their
 *   client-chosen name (NO username lock). Use only if the require handshake
 *   regresses; per-world sharing is NOT safe in this mode.
 *
 * If misconfigured (no secret), verifier is null and EVERY connection is denied.
 */
public final class AuthListener implements Listener {

    private final JwtVerifier verifier; // null => deny everyone
    private final CurrentNameResolver resolver; // null => use the JWT's own name
    private final String cookieName;
    private final String kickMessage;
    private final boolean lockUsername; // true = require (lock), false = skip (fallback)
    private final Logger log;

    public AuthListener(JwtVerifier verifier, CurrentNameResolver resolver, String cookieName, String kickMessage, boolean lockUsername, Logger log) {
        this.verifier = verifier;
        this.resolver = resolver;
        this.cookieName = cookieName;
        this.kickMessage = kickMessage;
        this.lockUsername = lockUsername;
        this.log = log;
    }

    @EventHandler(priority = EventPriority.NORMAL)
    public void onAuthCheck(EaglercraftAuthCheckRequiredEvent event) {
        JwtVerifier.Result r = resolve(event.getPendingConnection().getWebSocketHeader(EnumWebSocketHeader.HEADER_COOKIE));
        if (r == null) {
            event.kickUser(kickMessage); // sets DENY + kick
            return;
        }

        if (!lockUsername) {
            // Fallback: admit under the client-chosen name (no lock). Not secure
            // for sharing; only for emergency revert.
            log.info("[authcheck] (skip-mode) admit JWT user " + r.username);
            event.setAuthRequired(EnumAuthResponse.SKIP);
            return;
        }

        // lock-mode require: the typed name must equal the account username, or
        // the offline UUID won't match the identity.
        String typed = requestedName(event);
        if (!r.username.equals(typed)) {
            log.info("[authcheck] name mismatch: typed='" + typed + "' jwt='" + r.username + "' -> kick");
            event.kickUser("Set your in-game username to: " + r.username
                    + "\n(Main menu -> Edit Profile -> Username), then reconnect.");
            return;
        }

        log.info("[authcheck] lock OK for " + r.username + " -> require cookie auth");
        event.setNicknameSelectionEnabled(false);
        event.setUseAuthType(EnumAuthType.PLAINTEXT); // mandatory on REQUIRE; password is ignored
        event.setEnableCookieAuth(true);
        event.setAuthRequired(EnumAuthResponse.REQUIRE);
    }

    @EventHandler(priority = EventPriority.NORMAL)
    public void onAuthCookie(EaglercraftAuthCookieEvent event) {
        JwtVerifier.Result r = resolve(event.getLoginConnection().getWebSocketHeader(EnumWebSocketHeader.HEADER_COOKIE));
        if (r == null) {
            event.setLoginDenied(kickMessage);
            return;
        }
        event.setProfileUsername(r.username);
        event.setLoginAllowed();
    }

    @EventHandler(priority = EventPriority.NORMAL)
    public void onAuthPassword(EaglercraftAuthPasswordEvent event) {
        // Fallback path if the client prompts for a password instead of cookie:
        // ignore whatever was typed, trust the validated HTTP cookie.
        JwtVerifier.Result r = resolve(event.getLoginConnection().getWebSocketHeader(EnumWebSocketHeader.HEADER_COOKIE));
        if (r == null) {
            event.setLoginDenied(kickMessage);
            return;
        }
        event.setProfileUsername(r.username);
        event.setLoginAllowed();
    }

    /** The INIT-packet username the client connects with (feeds the offline UUID). */
    private static String requestedName(EaglercraftAuthCheckRequiredEvent e) {
        try {
            byte[] b = e.getAuthUsername();
            return b == null ? "" : new String(b, StandardCharsets.US_ASCII);
        } catch (Throwable t) {
            return "";
        }
    }

    private JwtVerifier.Result resolve(String cookieHeader) {
        if (verifier == null || cookieHeader == null) return null;
        String token = extractCookie(cookieHeader, cookieName);
        if (token == null) return null;
        JwtVerifier.Result r = verifier.verify(token);
        if (r == null) return null;
        // Map the (possibly stale) JWT name to the account's CURRENT username via
        // its stable sub, so a rename takes effect immediately and the old name
        // fails. A deleted account (404) is DENIED; a lookup hiccup fails open to
        // the JWT name so a transient mc-auth issue never locks players out.
        if (resolver != null) {
            CurrentNameResolver.Resolution res = resolver.resolve(r.sub, r.username);
            if (res.deleted) {
                log.info("[authcheck] account deleted (sub=" + r.sub + ") -> deny");
                return null;
            }
            if (res.name != null && !res.name.equals(r.username)) {
                return new JwtVerifier.Result(res.name, r.sub);
            }
        }
        return r;
    }

    /** Parse a single cookie value out of a "k=v; k2=v2" Cookie header. */
    static String extractCookie(String header, String name) {
        if (header == null) return null;
        for (String part : header.split(";")) {
            int eq = part.indexOf('=');
            if (eq <= 0) continue;
            if (part.substring(0, eq).trim().equals(name)) {
                return part.substring(eq + 1).trim();
            }
        }
        return null;
    }
}
