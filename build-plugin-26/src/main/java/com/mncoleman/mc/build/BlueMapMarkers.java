package com.mncoleman.mc.build;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import de.bluecolored.bluemap.api.BlueMapAPI;
import de.bluecolored.bluemap.api.BlueMapMap;
import de.bluecolored.bluemap.api.markers.ExtrudeMarker;
import de.bluecolored.bluemap.api.markers.LineMarker;
import de.bluecolored.bluemap.api.markers.MarkerSet;
import de.bluecolored.bluemap.api.markers.POIMarker;
import de.bluecolored.bluemap.api.markers.ShapeMarker;
import de.bluecolored.bluemap.api.math.Color;
import de.bluecolored.bluemap.api.math.Line;
import de.bluecolored.bluemap.api.math.Shape;
import com.flowpowered.math.vector.Vector3d;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The panel's map features as BlueMap markers. mc-auth (the source of truth,
 * its map_features table) pushes the whole set for a map; we replace every
 * "claude-*" marker set on that BlueMap map with it. Secret features are never
 * sent here. The last payload per map is saved to disk and re-applied whenever
 * BlueMap (re)enables, because API markers vanish on `bluemap reload`.
 *
 * Only loaded when BlueMap is installed (soft-depend), so ClaudeBuild still runs
 * without it.
 */
final class BlueMapMarkers {
    private BlueMapMarkers() {}
    private static final String PREFIX = "claude-";
    private static final Map<String, JsonObject> LAST = new ConcurrentHashMap<>();
    private static File store;

    static void init(ClaudeBuildPlugin plugin) {
        store = new File(plugin.getDataFolder(), "bluemap-markers.json");
        try {
            if (store.isFile()) {
                JsonObject all = JsonParser.parseString(Files.readString(store.toPath(), StandardCharsets.UTF_8)).getAsJsonObject();
                for (Map.Entry<String, JsonElement> e : all.entrySet()) LAST.put(e.getKey(), e.getValue().getAsJsonObject());
            }
        } catch (Exception e) { plugin.getLogger().warning("bluemap-markers.json unreadable: " + e); }
        BlueMapAPI.onEnable(api -> {
            int n = 0;
            for (Map.Entry<String, JsonObject> e : LAST.entrySet()) {
                try { n += apply(api, e.getKey(), e.getValue()); }
                catch (Exception ex) { plugin.getLogger().warning("BlueMap markers for " + e.getKey() + " skipped: " + ex); }
            }
            plugin.getLogger().info("BlueMap enabled: applied " + n + " Map-tab markers");
        });
    }

    static synchronized JsonObject set(ClaudeBuildPlugin plugin, JsonObject body) throws Exception {
        String map = body.has("map") ? body.get("map").getAsString() : null;
        if (map == null || !map.matches("[A-Za-z0-9_-]{1,64}")) throw new IllegalArgumentException("missing or bad 'map'");
        if (!body.has("sets") || !body.get("sets").isJsonArray()) throw new IllegalArgumentException("'sets' must be an array");
        // Build every set first: a payload that doesn't parse is refused whole, before
        // it replaces what's stored or touches BlueMap.
        int bad = 0;
        for (JsonElement se : body.getAsJsonArray("sets")) {
            if (!se.isJsonObject()) throw new IllegalArgumentException("each set must be an object");
            JsonObject s = se.getAsJsonObject();
            if (s.has("markers") && !s.get("markers").isJsonArray()) throw new IllegalArgumentException("'markers' must be an array");
            if (s.has("markers")) for (JsonElement me : s.getAsJsonArray("markers")) {
                try { marker(me.getAsJsonObject()); } catch (Exception ex) { bad++; }
            }
        }
        LAST.put(map, body);
        if (store != null) {
            JsonObject all = new JsonObject();
            for (Map.Entry<String, JsonObject> e : LAST.entrySet()) all.add(e.getKey(), e.getValue());
            File tmp = new File(store.getParentFile(), store.getName() + ".tmp");
            Files.writeString(tmp.toPath(), all.toString(), StandardCharsets.UTF_8);
            Files.move(tmp.toPath(), store.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
        }
        JsonObject o = new JsonObject();
        o.addProperty("stored", true);
        BlueMapAPI api = BlueMapAPI.getInstance().orElse(null);
        o.addProperty("bluemap_enabled", api != null);
        if (api != null) o.addProperty("applied", apply(api, map, body));
        o.addProperty("skipped_markers", bad);
        return o;
    }

    /** Replace the claude-* marker sets on one BlueMap map. Returns the marker count. */
    private static int apply(BlueMapAPI api, String mapId, JsonObject body) {
        BlueMapMap map = api.getMap(mapId).orElse(null);
        if (map == null) return 0;
        Map<String, MarkerSet> sets = map.getMarkerSets();
        Map<String, MarkerSet> built = new java.util.LinkedHashMap<>();
        int n = 0;
        for (JsonElement se : body.getAsJsonArray("sets")) {
          try {
            JsonObject s = se.getAsJsonObject();
            MarkerSet set = MarkerSet.builder()
                .label(str(s, "label", "Map"))
                .toggleable(true)
                .defaultHidden(s.has("hidden") && s.get("hidden").getAsBoolean())
                .sorting(s.has("sorting") ? s.get("sorting").getAsInt() : 0)
                .build();
            JsonArray ms = s.has("markers") ? s.getAsJsonArray("markers") : new JsonArray();
            for (JsonElement me : ms) {
                try {
                    JsonObject m = me.getAsJsonObject();
                    String id = str(m, "id", "m" + n);
                    set.put(id, marker(m));
                    n++;
                } catch (Exception ignored) { /* one bad marker never sinks the set */ }
            }
            built.put(PREFIX + str(s, "id", "set"), set);
          } catch (Exception ex) { /* one bad set never sinks the others */ }
        }
        // swap in one go, so the map never shows a half-cleared state for long
        sets.keySet().removeIf(k -> k.startsWith(PREFIX) && !built.containsKey(k));
        sets.putAll(built);
        return n;
    }

    private static de.bluecolored.bluemap.api.markers.Marker marker(JsonObject m) {
        String type = str(m, "type", "poi");
        String label = str(m, "label", "");
        String detail = m.has("detail") ? m.get("detail").getAsString() : null;
        Color line = color(str(m, "color", "#46d17f"), 1f);
        Color fill = color(str(m, "color", "#46d17f"), m.has("fill") ? m.get("fill").getAsFloat() : 0.12f);
        int width = m.has("width") ? m.get("width").getAsInt() : 3;
        switch (type) {
            case "line": {
                JsonArray pts = m.getAsJsonArray("points");
                Vector3d[] v = new Vector3d[pts.size()];
                for (int i = 0; i < v.length; i++) { JsonArray p = pts.get(i).getAsJsonArray(); v[i] = new Vector3d(p.get(0).getAsDouble(), p.get(1).getAsDouble(), p.get(2).getAsDouble()); }
                LineMarker.Builder b = LineMarker.builder().label(label).line(new Line(v)).lineColor(line).lineWidth(width).depthTestEnabled(false);
                if (detail != null) b.detail(detail);
                if (m.has("maxDistance")) b.maxDistance(m.get("maxDistance").getAsDouble());
                return b.build();
            }
            case "box": {
                JsonArray r = m.getAsJsonArray("rect");
                Shape sh = Shape.createRect(r.get(0).getAsDouble(), r.get(1).getAsDouble(), r.get(2).getAsDouble(), r.get(3).getAsDouble());
                float minY = m.has("minY") ? m.get("minY").getAsFloat() : 60f, maxY = m.has("maxY") ? m.get("maxY").getAsFloat() : minY + 1;
                ExtrudeMarker.Builder b = ExtrudeMarker.builder().label(label).shape(sh, minY, maxY).lineColor(line).fillColor(fill).lineWidth(Math.max(1, width - 1)).depthTestEnabled(false);
                if (detail != null) b.detail(detail);
                if (m.has("maxDistance")) b.maxDistance(m.get("maxDistance").getAsDouble());
                return b.build();
            }
            case "area": {
                JsonArray r = m.getAsJsonArray("rect");
                Shape sh = Shape.createRect(r.get(0).getAsDouble(), r.get(1).getAsDouble(), r.get(2).getAsDouble(), r.get(3).getAsDouble());
                float y = m.has("y") ? m.get("y").getAsFloat() : 64f;
                ShapeMarker.Builder b = ShapeMarker.builder().label(label).shape(sh, y).lineColor(line).fillColor(fill).lineWidth(Math.max(1, width - 1)).depthTestEnabled(false);
                if (detail != null) b.detail(detail);
                if (m.has("maxDistance")) b.maxDistance(m.get("maxDistance").getAsDouble());
                return b.build();
            }
            default: {
                JsonArray p = m.getAsJsonArray("pos");
                POIMarker.Builder b = POIMarker.builder().label(label).position(p.get(0).getAsDouble(), p.get(1).getAsDouble(), p.get(2).getAsDouble());
                if (detail != null) b.detail(detail);
                if (m.has("icon")) b.icon(m.get("icon").getAsString(), 12, 12);
                if (m.has("maxDistance")) b.maxDistance(m.get("maxDistance").getAsDouble());
                return b.build();
            }
        }
    }

    private static Color color(String hex, float alpha) {
        try {
            int v = Integer.parseInt(hex.replace("#", ""), 16);
            return new Color((v >> 16) & 255, (v >> 8) & 255, v & 255, alpha);
        } catch (Exception e) { return new Color(70, 209, 127, alpha); }
    }
    private static String str(JsonObject o, String k, String d) { return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsString() : d; }
}
