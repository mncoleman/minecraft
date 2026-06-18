package com.mncoleman.mc.auth;

// NOTE: import the real gson package — the shade plugin relocates these to
// com.mncoleman.mc.auth.lib.gson in the packaged jar (post-compile).
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;

/**
 * Minimal, dependency-light HS256 JWT verifier. Uses the JDK for HMAC/Base64 and
 * the shaded Gson only to parse the claims JSON. Returns null on ANY problem
 * (fail closed) — never throws into the caller.
 */
public final class JwtVerifier {

    public static final class Result {
        public final String username;
        public final String sub;
        Result(String username, String sub) {
            this.username = username;
            this.sub = sub;
        }
    }

    private final byte[] secret;
    private final String issuer;
    private final String audience;
    private final long leewaySeconds;

    public JwtVerifier(String secret, String issuer, String audience, long leewaySeconds) {
        this.secret = secret.getBytes(StandardCharsets.UTF_8);
        this.issuer = issuer;
        this.audience = audience;
        this.leewaySeconds = leewaySeconds;
    }

    public Result verify(String token) {
        try {
            if (token == null) return null;
            String[] parts = token.split("\\.");
            if (parts.length != 3) return null;

            // 1) header: pin alg to HS256 (reject "none" / RS/ES confusion).
            JsonObject header = parseSegment(parts[0]);
            if (header == null) return null;
            JsonElement alg = header.get("alg");
            if (alg == null || !"HS256".equals(alg.getAsString())) return null;

            // 2) signature over "header.payload".
            byte[] expected = hmacSha256(secret, (parts[0] + "." + parts[1]).getBytes(StandardCharsets.US_ASCII));
            byte[] actual = Base64.getUrlDecoder().decode(parts[2]);
            if (!MessageDigest.isEqual(expected, actual)) return null;

            // 3) claims.
            JsonObject claims = parseSegment(parts[1]);
            if (claims == null) return null;

            long nowSec = System.currentTimeMillis() / 1000L;

            JsonElement exp = claims.get("exp");
            if (exp == null || nowSec > exp.getAsLong() + leewaySeconds) return null;

            JsonElement nbf = claims.get("nbf");
            if (nbf != null && nowSec + leewaySeconds < nbf.getAsLong()) return null;

            if (issuer != null && !issuer.isEmpty()) {
                JsonElement iss = claims.get("iss");
                if (iss == null || !issuer.equals(iss.getAsString())) return null;
            }
            if (audience != null && !audience.isEmpty() && !audienceMatches(claims.get("aud"))) {
                return null;
            }

            JsonElement username = claims.get("username");
            if (username == null) return null;
            String name = username.getAsString();
            if (!isValidMcName(name)) return null;

            JsonElement sub = claims.get("sub");
            return new Result(name, sub != null ? sub.getAsString() : null);
        } catch (Exception e) {
            return null; // fail closed on any parse/crypto error
        }
    }

    private boolean audienceMatches(JsonElement aud) {
        if (aud == null) return false;
        if (aud.isJsonArray()) {
            for (JsonElement e : aud.getAsJsonArray()) {
                if (audience.equals(e.getAsString())) return true;
            }
            return false;
        }
        return audience.equals(aud.getAsString());
    }

    private static boolean isValidMcName(String u) {
        if (u == null || u.length() < 3 || u.length() > 16) return false;
        for (int i = 0; i < u.length(); i++) {
            char ch = u.charAt(i);
            boolean ok = (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')
                    || (ch >= '0' && ch <= '9') || ch == '_';
            if (!ok) return false;
        }
        return true;
    }

    private static JsonObject parseSegment(String b64url) {
        byte[] json = Base64.getUrlDecoder().decode(b64url);
        JsonElement el = JsonParser.parseString(new String(json, StandardCharsets.UTF_8));
        return el != null && el.isJsonObject() ? el.getAsJsonObject() : null;
    }

    private static byte[] hmacSha256(byte[] key, byte[] data) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return mac.doFinal(data);
    }
}
