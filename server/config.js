const PRODUCTION = "production";

function isTruthy(value) {
  return value === "true" || value === "1";
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  const port = Number(env.PORT || 3000);
  const sessionSecret = env.SESSION_SECRET || "";
  const publicBaseUrl = env.PUBLIC_BASE_URL || "http://localhost:3000";

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required.");
  }
  if (sessionSecret.length < 32 || sessionSecret.includes("replace-with")) {
    throw new Error("SESSION_SECRET must contain at least 32 non-placeholder characters.");
  }

  let baseUrl;
  try {
    baseUrl = new URL(publicBaseUrl);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be an absolute URL.");
  }
  if (
    !["http:", "https:"].includes(baseUrl.protocol) ||
    (nodeEnv === PRODUCTION && baseUrl.protocol !== "https:")
  ) {
    throw new Error("PUBLIC_BASE_URL must use HTTPS in production.");
  }
  if (nodeEnv === PRODUCTION && isTruthy(env.DATABASE_SSL) !== true) {
    throw new Error("DATABASE_SSL=true is required in production.");
  }

  const smtpPort = Number(env.SMTP_PORT || 587);
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    throw new Error("SMTP_PORT must be an integer between 1 and 65535.");
  }

  return {
    nodeEnv,
    port,
    databaseUrl: env.DATABASE_URL,
    databaseSsl: isTruthy(env.DATABASE_SSL),
    sessionSecret,
    publicBaseUrl: baseUrl.origin,
    smtp: {
      host: env.SMTP_HOST || "",
      port: smtpPort,
      secure: isTruthy(env.SMTP_SECURE),
      user: env.SMTP_USER || "",
      password: env.SMTP_PASS || "",
      from: env.SMTP_FROM || "",
    },
  };
}
