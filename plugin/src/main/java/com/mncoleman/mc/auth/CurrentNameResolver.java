package com.mncoleman.mc.auth;

// NOTE: shaded Gson (relocated post-compile), same as JwtVerifier.
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentHashMap;
import java.util.logging.Logger;

/**
 * Resolves an account's CURRENT username from its stable JWT subject (the account
 * id) by calling the mc-auth internal endpoint. This makes a username change take
 * effect in-game immediately and stops the OLD name from working, regardless of
 * which (possibly stale) session JWT the browser still presents.
 *
 * Three outcomes:
 *   - found:     lock to the resolved current username.
 *   - deleted:   mc-auth says the account id no longer exists (404) -> DENY. A
 *                deleted user's JWT stays cryptographically valid until expiry, so
 *                without this they could keep playing; here we reject them.
 *   - fail-open: mc-auth unreachable / transient error -> fall back to the JWT name
 *                so a hiccup never locks players out. (Only a definitive 404 denies.)
 * A short TTL cache absorbs reconnect spam.
 */
public final class CurrentNameResolver {

    public static final class Resolution {
        public final String name;     // effective username to lock to (null when deleted)
        public final boolean deleted; // account no longer exists -> deny
        Resolution(String name, boolean deleted) { this.name = name; this.deleted = deleted; }
    }

    private static final long TTL_MS = 10_000L;

    private static final class Entry {
        final Resolution res;
        final long at;
        Entry(Resolution res, long at) { this.res = res; this.at = at; }
    }

    private final String baseUrl; // e.g. http://mc-auth:7900
    private final String token;   // shared presence token (bearer)
    private final Logger log;
    private final ConcurrentHashMap<String, Entry> cache = new ConcurrentHashMap<>();

    public CurrentNameResolver(String baseUrl, String token, Logger log) {
        this.baseUrl = baseUrl.replaceAll("/+$", "");
        this.token = token;
        this.log = log;
    }

    /** Resolve {@code sub} to a {@link Resolution}; {@code fallback} is the JWT name. */
    public Resolution resolve(String sub, String fallback) {
        if (sub == null || sub.isEmpty()) return new Resolution(fallback, false);
        long now = System.currentTimeMillis();
        Entry e = cache.get(sub);
        if (e != null && now - e.at < TTL_MS) return e.res;
        Resolution res = fetch(sub, fallback);
        cache.put(sub, new Entry(res, now));
        return res;
    }

    private Resolution fetch(String sub, String fallback) {
        HttpURLConnection con = null;
        try {
            URL u = new URL(baseUrl + "/internal/username?sub=" + URLEncoder.encode(sub, "UTF-8"));
            con = (HttpURLConnection) u.openConnection();
            con.setRequestMethod("GET");
            con.setConnectTimeout(1500);
            con.setReadTimeout(1500);
            con.setRequestProperty("Authorization", "Bearer " + token);
            int code = con.getResponseCode();
            if (code == 404) return new Resolution(null, true);        // account deleted -> deny
            if (code != 200) return new Resolution(fallback, false);   // transient -> fail open
            try (InputStream in = con.getInputStream()) {
                byte[] b = in.readAllBytes();
                JsonObject o = JsonParser.parseString(new String(b, StandardCharsets.UTF_8)).getAsJsonObject();
                if (o.has("username") && !o.get("username").isJsonNull()) {
                    return new Resolution(o.get("username").getAsString(), false);
                }
                return new Resolution(fallback, false); // 200 but no name (shouldn't happen) -> fail open
            }
        } catch (Exception ex) {
            return new Resolution(fallback, false); // network error -> fail open
        } finally {
            if (con != null) con.disconnect();
        }
    }
}
