import { SignJWT, jwtVerify } from "jose";
import { config } from "./config.ts";

const key = new TextEncoder().encode(config.jwtSecret);

export interface Session {
  sub: string;        // stable user id
  username: string;   // locked in-game username
  provider: string;   // telegram | google | email
  admin?: boolean;
}

export async function signSession(s: Session): Promise<string> {
  return await new SignJWT({
    username: s.username,
    provider: s.provider,
    admin: !!s.admin,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(s.sub)
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt()
    .setExpirationTime(`${config.sessionTtlDays}d`)
    .sign(key);
}

export async function verifySession(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ["HS256"], // pin alg — never accept "none" or RS/ES confusion
    });
    if (!payload.sub || typeof payload.username !== "string") return null;
    return {
      sub: String(payload.sub),
      username: payload.username,
      provider: String(payload.provider ?? "unknown"),
      admin: payload.admin === true,
    };
  } catch {
    return null;
  }
}
