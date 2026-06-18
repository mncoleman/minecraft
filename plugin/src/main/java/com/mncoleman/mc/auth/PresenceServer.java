package com.mncoleman.mc.auth;

import com.sun.net.httpserver.HttpServer;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.plugin.Plugin;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.Callable;
import java.util.concurrent.TimeUnit;
import java.util.logging.Logger;

/**
 * Tiny embedded HTTP endpoint exposing who is online and which world they're in,
 * for the mc-auth panel. Bound in-container only (never published to the host),
 * gated by a constant-time Bearer token. Player data is snapshotted on the main
 * thread (Bukkit collections are not thread-safe off the main thread).
 *
 *   GET /presence   Authorization: Bearer <token>
 *   -> {"players":[{"name":"Matthew","world":"cliffbuild","x":12,"y":64,"z":-8}, ...]}
 */
public final class PresenceServer {

    private final HttpServer server;

    public PresenceServer(Plugin plugin, int port, String token, Logger log) throws Exception {
        server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/presence", (ex) -> {
            try {
                String auth = ex.getRequestHeaders().getFirst("Authorization");
                if (token == null || token.isEmpty() || auth == null || !constantEquals(auth, "Bearer " + token)) {
                    ex.sendResponseHeaders(401, -1);
                    ex.close();
                    return;
                }
                String json;
                try {
                    json = Bukkit.getScheduler().callSyncMethod(plugin, (Callable<String>) () -> {
                        StringBuilder sb = new StringBuilder("{\"players\":[");
                        boolean first = true;
                        for (Player p : Bukkit.getOnlinePlayers()) {
                            if (!first) sb.append(",");
                            first = false;
                            org.bukkit.Location loc = p.getLocation();
                            sb.append("{\"name\":\"").append(jsonEscape(p.getName()))
                              .append("\",\"world\":\"").append(jsonEscape(p.getWorld().getName()))
                              .append("\",\"x\":").append(loc.getBlockX())
                              .append(",\"y\":").append(loc.getBlockY())
                              .append(",\"z\":").append(loc.getBlockZ()).append("}");
                        }
                        return sb.append("]}").toString();
                    }).get(2, TimeUnit.SECONDS);
                } catch (Exception e) {
                    json = "{\"players\":[],\"error\":\"snapshot_timeout\"}";
                }
                byte[] body = json.getBytes(StandardCharsets.UTF_8);
                ex.getResponseHeaders().set("Content-Type", "application/json");
                ex.sendResponseHeaders(200, body.length);
                try (OutputStream os = ex.getResponseBody()) { os.write(body); }
            } catch (Exception e) {
                try { ex.sendResponseHeaders(500, -1); } catch (Exception ignored) {}
                ex.close();
            }
        });
        server.setExecutor(null); // default executor (small thread pool)
        server.start();
        log.info("Presence endpoint listening on :" + port);
    }

    public void stop() {
        if (server != null) server.stop(0);
    }

    private static boolean constantEquals(String a, String b) {
        return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }
    private static String jsonEscape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
