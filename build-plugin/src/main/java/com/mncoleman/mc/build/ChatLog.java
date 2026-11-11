package com.mncoleman.mc.build;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.bukkit.ChatColor;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.AsyncPlayerChatEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;

import java.util.ArrayDeque;
import java.util.Locale;

/**
 * In-memory log of recent game chat (plus joins/leaves and what Claude says), so
 * Claude can read it or follow it live. Nothing is written to disk; the log is
 * lost on restart. Long-poll readers block on this object until a new line lands.
 */
public final class ChatLog implements Listener {
    private static final int MAX = 500;
    private final ArrayDeque<JsonObject> lines = new ArrayDeque<>();
    private long seq = 0;

    public synchronized void add(String kind, String player, String world, String message) {
        JsonObject o = new JsonObject();
        o.addProperty("id", ++seq);
        o.addProperty("time", java.time.Instant.now().toString().substring(0, 19) + "Z");
        o.addProperty("kind", kind);          // chat | join | leave | claude
        o.addProperty("player", player);
        if (world != null) o.addProperty("world", world);
        String m = ChatColor.stripColor(message == null ? "" : message);
        o.addProperty("message", m);
        if ("chat".equals(kind) && m.toLowerCase(Locale.ROOT).contains("@claude")) o.addProperty("to_claude", true);
        lines.addLast(o);
        while (lines.size() > MAX) lines.removeFirst();
        notifyAll();
    }

    /** Lines with id > since (oldest first), waiting up to waitMs for at least one. since < 0 = only the latest `limit`. */
    public synchronized JsonObject read(long since, int limit, long waitMs) throws InterruptedException {
        long until = System.currentTimeMillis() + waitMs;
        boolean reset = since > seq;          // server restarted since the caller's cursor
        if (reset) since = seq;
        if (since >= 0) {
            while (seq <= since && System.currentTimeMillis() < until) wait(Math.max(1, until - System.currentTimeMillis()));
        }
        JsonArray out = new JsonArray();
        int skip = 0;
        if (since < 0) skip = Math.max(0, lines.size() - limit);
        int i = 0;
        for (JsonObject o : lines) {
            if (i++ < skip) continue;
            if (since >= 0 && o.get("id").getAsLong() <= since) continue;
            out.add(o);
            if (out.size() >= limit) break;
        }
        JsonObject r = new JsonObject();
        r.add("messages", out);
        long cursor = out.size() > 0 ? out.get(out.size() - 1).getAsJsonObject().get("id").getAsLong() : Math.max(since, seq);
        if (since < 0) cursor = seq;
        r.addProperty("cursor", cursor);
        long oldest = lines.isEmpty() ? seq + 1 : lines.peekFirst().get("id").getAsLong();
        if (reset) r.addProperty("note", "the game server restarted; chat history before that is gone");
        else if (since >= 0 && since + 1 < oldest) r.addProperty("note", "some older messages were dropped (the log keeps the last " + MAX + ")");
        return r;
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onChat(AsyncPlayerChatEvent e) { add("chat", e.getPlayer().getName(), e.getPlayer().getWorld().getName(), e.getMessage()); }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onJoin(PlayerJoinEvent e) { add("join", e.getPlayer().getName(), e.getPlayer().getWorld().getName(), "joined the game"); }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onQuit(PlayerQuitEvent e) { add("leave", e.getPlayer().getName(), e.getPlayer().getWorld().getName(), "left the game"); }
}
