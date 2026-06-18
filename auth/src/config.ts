function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function splitList(s?: string): string[] {
  return (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT ?? 7900),
  dbPath: process.env.DB_PATH ?? "/data/mc-auth.sqlite",

  // Shared HS256 secret with the in-game plugin.
  jwtSecret: reqEnv("MC_JWT_SECRET"),
  issuer: "mc-auth",
  audience: process.env.JWT_AUDIENCE ?? "minecraft.mncoleman.com",

  cookieName: process.env.COOKIE_NAME ?? "mc_session",
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS ?? 7),
  devInsecureCookie: process.env.DEV_INSECURE_COOKIE === "true",

  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "https://minecraft.mncoleman.com").replace(/\/+$/, ""),

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    botUsername: (process.env.TELEGRAM_BOT_USERNAME ?? "").replace(/^@/, ""),
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  },

  adminEmails: splitList(process.env.ADMIN_EMAILS).map((e) => e.toLowerCase()),
  adminTelegramIds: splitList(process.env.ADMIN_TELEGRAM_IDS),

  allowlistBootstrap: process.env.ALLOWLIST ?? "",
};

export function providersEnabled() {
  return {
    telegram: Boolean(config.telegram.botToken && config.telegram.botUsername),
    google: Boolean(config.google.clientId && config.google.clientSecret),
    email: true,
  };
}

export function isAdminEmail(email?: string | null): boolean {
  return !!email && config.adminEmails.includes(email.toLowerCase());
}
export function isAdminTelegram(id?: string | null): boolean {
  return !!id && config.adminTelegramIds.includes(String(id));
}
