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
 * which (possibly stale) session JWT the browser still presents — including the
 * admin-rename case, where the target's cookie is never rotated.
 *
 * Fails OPEN to the name baked in the JWT, so an mc-auth hiccup never locks
 * players out. A short TTL cache absorbs reconnect spam without hammering mc-auth.
 */
public final class CurrentNameResolver {

    private static final long TTL_MS = 10_000L;

    private static final class Entry {
        final String name; // null = looked up and missing/errored
        final long at;
        Entry(String name, long at) { this.name = name; this.at = at; }
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

    /** Current username for {@code sub}, or {@code fallback} on any miss/error. */
    public String currentName(String sub, String fallback) {
        if (sub == null || sub.isEmpty()) return fallback;
        long now = System.currentTimeMillis();
        Entry e = cache.get(sub);
        if (e != null && now - e.at < TTL_MS) return e.name != null ? e.name : fallback;
        String name = fetch(sub);
        cache.put(sub, new Entry(name, now)); // cache hits AND misses (brief) to avoid spam
        return name != null ? name : fallback;
    }

    private String fetch(String sub) {
        HttpURLConnection con = null;
        try {
            URL u = new URL(baseUrl + "/internal/username?sub=" + URLEncoder.encode(sub, "UTF-8"));
            con = (HttpURLConnection) u.openConnection();
            con.setRequestMethod("GET");
            con.setConnectTimeout(1500);
            con.setReadTimeout(1500);
            con.setRequestProperty("Authorization", "Bearer " + token);
            if (con.getResponseCode() != 200) return null;
            try (InputStream in = con.getInputStream()) {
                byte[] b = in.readAllBytes();
                JsonObject o = JsonParser.parseString(new String(b, StandardCharsets.UTF_8)).getAsJsonObject();
                if (o.has("username") && !o.get("username").isJsonNull()) {
                    return o.get("username").getAsString();
                }
                return null;
            }
        } catch (Exception ex) {
            return null; // fail open
        } finally {
            if (con != null) con.disconnect();
        }
    }
}
