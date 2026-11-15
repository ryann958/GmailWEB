import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import connectPgSimple from "connect-pg-simple";
import express from "express";
import { rateLimit } from "express-rate-limit";
import session from "express-session";
import helmet from "helmet";
import { hashPassword, verifyPassword } from "./passwords.js";
import { createIdrUsdRateProvider } from "./currency.js";
import { registerAdminRoutes } from "./routes/admin.js";
import {
  GENERATED_TEXT_PATTERN,
  generateRandomText,
} from "./generations.js";
import {
  isValidResetToken,
  normalizeEmail,
  validatePassword,
  validateRegistration,
} from "./validation.js";

const PUBLIC_DIRECTORY = fileURLToPath(new URL("../public/", import.meta.url));
const ADMIN_DIRECTORY = fileURLToPath(new URL("../frontend/admin/", import.meta.url));
const SESSION_COOKIE_NAME = "mailmu.sid";
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const RESET_TOKEN_LIFETIME_MS = 30 * 60 * 1000;
const EMAIL_VERIFICATION_CODE_LIFETIME_MINUTES = 10;
const EMAIL_VERIFICATION_MAX_ATTEMPTS = 5;
const IDR_PER_APPROVED_TEXT = 4000;
const REFERRAL_GOAL = 20;
const REFERRAL_REWARD_IDR = 20_000;
const MINIMUM_WITHDRAWAL_USD = 2;
const WITHDRAWAL_METHODS = new Set(["bank", "dana", "ovo", "gopay"]);
const GENERIC_RESET_MESSAGE =
  "Jika akun dengan alamat tersebut tersedia, instruksi pemulihan akan dikirim.";

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name };
}

function tokensMatch(expected, actual) {
  if (typeof expected !== "string" || typeof actual !== "string") return false;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

function regenerateSession(request) {
  return new Promise((resolve, reject) => {
    request.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

function saveSession(request) {
  return new Promise((resolve, reject) => {
    request.session.save((error) => (error ? reject(error) : resolve()));
  });
}

function destroySession(request) {
  return new Promise((resolve, reject) => {
    request.session.destroy((error) => (error ? reject(error) : resolve()));
  });
}

function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function createResetToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: createHash("sha256").update(token).digest("hex") };
}

async function issueResetToken(pool, userId) {
  const { token, tokenHash } = createResetToken();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
      [userId]
    );
    await client.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '30 minutes')`,
      [userId, tokenHash]
    );
    await client.query("COMMIT");
    return { token, tokenHash };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function createEmailVerificationCode(userId, secret) {
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const codeHash = createHmac("sha256", secret)
    .update(`email-verification:${userId}:${code}`)
    .digest("hex");
  return { code, codeHash };
}

async function issueEmailVerificationCode(pool, userId, secret) {
  const client = await pool.connect();
  const { code, codeHash } = createEmailVerificationCode(userId, secret);
  try {
    await client.query("BEGIN");
    const user = await client.query(
      "SELECT email_verified_at FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    if (!user.rows[0] || user.rows[0].email_verified_at) {
      await client.query("COMMIT");
      return { alreadyVerified: true };
    }

    const recentCode = await client.query(
      `SELECT 1 FROM email_verification_codes
       WHERE user_id = $1 AND created_at > now() - interval '1 minute'
       LIMIT 1`,
      [userId]
    );
    if (recentCode.rowCount > 0) {
      await client.query("COMMIT");
      return { rateLimited: true };
    }

    await client.query(
      "UPDATE email_verification_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
      [userId]
    );
    const inserted = await client.query(
      `INSERT INTO email_verification_codes (user_id, code_hash, expires_at)
       VALUES ($1, $2, now() + interval '10 minutes')
       RETURNING id`,
      [userId, codeHash]
    );
    await client.query("COMMIT");
    return { id: inserted.rows[0].id, code };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createApp({
  pool,
  config,
  mailer,
  sessionStore,
  currencyRateProvider = createIdrUsdRateProvider(),
} = {}) {
  if (!pool || !config || !mailer) {
    throw new Error("createApp requires a database pool, configuration, and mailer.");
  }

  const app = express();
  const PgSession = connectPgSimple(session);
  const store =
    sessionStore ||
    new PgSession({
      pool,
      tableName: "sessions",
      createTableIfMissing: false,
      pruneSessionInterval: 15 * 60,
    });
  const secureCookies = config.nodeEnv === "production";
  const cookieOptions = {
    httpOnly: true,
    secure: secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_MS,
  };
  const clearCookieOptions = { ...cookieOptions };
  delete clearCookieOptions.maxAge;

  app.disable("x-powered-by");
  if (secureCookies) app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          imgSrc: ["'self'", "data:"],
          objectSrc: ["'none'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "https://fonts.googleapis.com"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use(express.json({ limit: "16kb", strict: true }));
  app.use(
    session({
      name: SESSION_COOKIE_NAME,
      secret: config.sessionSecret,
      store,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: cookieOptions,
    })
  );

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Terlalu banyak percobaan. Coba lagi beberapa saat." },
  });
  const emailVerificationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Terlalu banyak percobaan verifikasi. Coba lagi beberapa saat." },
  });
  const passwordResetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Terlalu banyak permintaan pemulihan. Coba lagi beberapa saat." },
  });
  const generationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Terlalu banyak permintaan generator. Coba lagi beberapa saat." },
  });

  const requireUser = asyncRoute(async (request, response, next) => {
    const userId = request.session?.userId;
    if (!userId) return response.status(401).json({ error: "Masuk ke akun untuk menggunakan generator." });

    const result = await pool.query(
      "SELECT id, email, name, role FROM users WHERE id = $1",
      [userId]
    );
    if (!result.rows[0]) {
      await destroySession(request);
      response.clearCookie(SESSION_COOKIE_NAME, clearCookieOptions);
      return response.status(401).json({ error: "Sesi tidak lagi berlaku. Silakan masuk kembali." });
    }
    request.authUser = result.rows[0];
    next();
  });
  const requireAdmin = (request, response, next) => {
    if (request.authUser.role !== "admin") {
      return response.status(403).json({ error: "Akses khusus admin." });
    }
    next();
  };
  async function getAccountFunds(userId, queryable = pool) {
    const result = await queryable.query(
      `SELECT
         COALESCE((
           SELECT COUNT(*) FILTER (WHERE status = 'accepted')
           FROM generated_items
           WHERE user_id = $1
         ), 0)::bigint AS approved_count,
         COALESCE((
           SELECT COUNT(*) FILTER (WHERE status = 'accepted')
           FROM generated_items
           WHERE user_id = $1
         ), 0)::bigint * $2
           + COALESCE((
             SELECT amount_idr
             FROM referral_rewards
             WHERE referrer_id = $1
           ), 0)::bigint AS earned_idr,
         COALESCE((
           SELECT SUM(amount_idr)
           FROM withdrawal_requests
           WHERE user_id = $1 AND status IN ('pending', 'processing', 'paid')
         ), 0)::bigint AS allocated_idr`,
      [userId, IDR_PER_APPROVED_TEXT]
    );
    const approvedCount = Number(result.rows[0].approved_count);
    const earnedIdr = Number(result.rows[0].earned_idr);
    const allocatedIdr = Number(result.rows[0].allocated_idr);
    if (
      !Number.isSafeInteger(approvedCount) ||
      !Number.isSafeInteger(earnedIdr) ||
      !Number.isSafeInteger(allocatedIdr)
    ) {
      throw new Error("Saldo akun melebihi batas angka yang dapat diproses.");
    }
    return {
      approvedCount,
      earnedIdr,
      allocatedIdr,
      availableIdr: Math.max(0, earnedIdr - allocatedIdr),
    };
  }

  app.get(
    "/api/health",
    asyncRoute(async (_request, response) => {
      await pool.query("SELECT 1");
      response.json({ status: "ok" });
    })
  );

  app.get(["/admin", "/admin/", "/admin/index.html"], asyncRoute(async (request, response) => {
    const userId = request.session?.userId;
    if (!userId) {
      return response.redirect(303, "/auth.html?next=%2Fadmin");
    }
    const result = await pool.query("SELECT role FROM users WHERE id = $1", [userId]);
    if (!result.rows[0]) {
      await destroySession(request);
      response.clearCookie(SESSION_COOKIE_NAME, clearCookieOptions);
      return response.redirect(303, "/auth.html?next=%2Fadmin");
    }
    if (result.rows[0].role !== "admin") {
      return response.status(403).type("text").send("Akses khusus admin.");
    }
    response.set("Cache-Control", "no-store");
    response.sendFile(path.join(ADMIN_DIRECTORY, "index.html"));
  }));

  app.get("/admin/admin.css", (_request, response) => {
    response.sendFile(path.join(ADMIN_DIRECTORY, "admin.css"));
  });
  app.get("/admin/admin.js", (_request, response) => {
    response.sendFile(path.join(ADMIN_DIRECTORY, "admin.js"));
  });

  app.get("/api/auth/csrf", (request, response, next) => {
    if (!request.session.csrfToken) {
      request.session.csrfToken = randomBytes(32).toString("base64url");
    }
    request.session.save((error) => {
      if (error) return next(error);
      response.set("Cache-Control", "no-store");
      response.json({ csrfToken: request.session.csrfToken });
    });
  });

  app.use("/api", (request, response, next) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
      return next();
    }
    if (!tokensMatch(request.session?.csrfToken, request.get("X-CSRF-Token"))) {
      return response.status(403).json({ error: "Permintaan tidak valid. Muat ulang halaman dan coba lagi." });
    }
    next();
  });

  app.post("/api/auth/register", authLimiter, asyncRoute(async (request, response) => {
    const validation = validateRegistration(request.body);
    if (validation.error) return response.status(400).json({ error: validation.error });
    const referralCode = request.body?.referralCode;
    if (
      referralCode !== undefined &&
      referralCode !== null &&
      (typeof referralCode !== "string" || !/^[A-F0-9]{12}$/i.test(referralCode))
    ) {
      return response.status(400).json({ error: "Kode undangan tidak valid." });
    }
    if (!mailer.isConfigured) {
      return response.status(503).json({
        error: "Verifikasi email belum tersedia. Konfigurasikan layanan email terlebih dahulu.",
      });
    }

    let referrerId = null;
    if (referralCode) {
      const referrer = await pool.query(
        "SELECT id FROM users WHERE referral_code = $1",
        [referralCode.toUpperCase()]
      );
      if (!referrer.rows[0]) {
        return response.status(400).json({ error: "Kode undangan tidak ditemukan." });
      }
      referrerId = referrer.rows[0].id;
    }

    const passwordHash = await hashPassword(validation.value.password);
    const inserted = await pool.query(
      `INSERT INTO users (email, email_normalized, name, password_hash, referred_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, name`,
      [validation.value.email, validation.value.email, validation.value.name, passwordHash, referrerId]
    );
    const user = inserted.rows[0];

    const verification = await issueEmailVerificationCode(
      pool,
      user.id,
      config.sessionSecret
    );
    try {
      await mailer.sendEmailVerificationCode(user.email, verification.code);
    } catch (error) {
      console.error("Email verification delivery failed:", error.message);
      await pool.query(
        "DELETE FROM email_verification_codes WHERE id = $1 AND used_at IS NULL",
        [verification.id]
      );
      response.set("Cache-Control", "no-store");
      return response.status(503).json({
        error: "Akun tersimpan, tetapi kode verifikasi gagal dikirim. Coba kirim ulang kode.",
        code: "verification_email_failed",
        email: user.email,
        verificationPending: true,
      });
    }
    response.set("Cache-Control", "no-store");
    response.status(201).json({
      message: "Kode verifikasi telah dikirim ke email Anda.",
      email: user.email,
      verificationRequired: true,
    });
  }));

  const dummyPasswordHash = await hashPassword(randomBytes(32).toString("base64url"));

  app.post("/api/auth/login", authLimiter, asyncRoute(async (request, response) => {
    const email = normalizeEmail(request.body?.email);
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!email || password.length === 0 || Array.from(password).length > 128) {
      return response.status(400).json({ error: "Masukkan email dan kata sandi yang valid." });
    }

    const result = await pool.query(
      "SELECT id, email, name, password_hash, email_verified_at FROM users WHERE email_normalized = $1",
      [email]
    );
    const user = result.rows[0];
    const passwordMatches = await verifyPassword(
      password,
      user?.password_hash || dummyPasswordHash
    );
    if (!user || !passwordMatches) {
      return response.status(401).json({ error: "Email atau kata sandi tidak cocok." });
    }
    if (!user.email_verified_at) {
      return response.status(403).json({
        error: "Email belum diverifikasi. Masukkan kode yang dikirim ke email Anda.",
        code: "email_not_verified",
      });
    }

    await regenerateSession(request);
    request.session.userId = user.id;
    request.session.csrfToken = randomBytes(32).toString("base64url");
    await saveSession(request);
    response.set("Cache-Control", "no-store");
    response.json({ user: publicUser(user), csrfToken: request.session.csrfToken });
  }));

  app.post(
    "/api/auth/email-verification/resend",
    emailVerificationLimiter,
    asyncRoute(async (request, response) => {
      const email = normalizeEmail(request.body?.email);
      if (!email) return response.status(400).json({ error: "Masukkan alamat email yang valid." });
      if (!mailer.isConfigured) {
        return response.status(503).json({
          error: "Layanan email belum tersedia. Coba lagi setelah SMTP dikonfigurasi.",
        });
      }

      const result = await pool.query(
        "SELECT id, email, email_verified_at FROM users WHERE email_normalized = $1",
        [email]
      );
      const user = result.rows[0];
      if (user && !user.email_verified_at) {
        const verification = await issueEmailVerificationCode(
          pool,
          user.id,
          config.sessionSecret
        );
        if (verification.code) {
          try {
            await mailer.sendEmailVerificationCode(user.email, verification.code);
          } catch (error) {
            console.error("Email verification delivery failed:", error.message);
            await pool.query(
              "DELETE FROM email_verification_codes WHERE id = $1 AND used_at IS NULL",
              [verification.id]
            );
            response.set("Cache-Control", "no-store");
            return response.status(503).json({
              error: "Kode verifikasi tidak dapat dikirim saat ini. Coba lagi nanti.",
            });
          }
        }
      }
      response.set("Cache-Control", "no-store");
      response.status(202).json({
        message: "Jika email terdaftar dan belum diverifikasi, kode akan dikirim. Jika baru meminta kode, tunggu satu menit sebelum mencoba lagi.",
      });
    })
  );

  app.post(
    "/api/auth/email-verification/verify",
    emailVerificationLimiter,
    asyncRoute(async (request, response) => {
      const email = normalizeEmail(request.body?.email);
      const code = request.body?.code;
      if (!email || typeof code !== "string" || !/^\d{6}$/.test(code)) {
        return response.status(400).json({ error: "Masukkan email dan kode verifikasi 6 digit yang valid." });
      }

      const client = await pool.connect();
      let verifiedUser;
      let invalidCode = false;
      try {
        await client.query("BEGIN");
        const userResult = await client.query(
          `SELECT id, email, name, email_verified_at, referred_by
           FROM users WHERE email_normalized = $1`,
          [email]
        );
        const user = userResult.rows[0];
        if (!user || user.email_verified_at) {
          invalidCode = true;
        } else {
          const codeResult = await client.query(
            `SELECT id, code_hash, expires_at, attempts
             FROM email_verification_codes
             WHERE user_id = $1 AND used_at IS NULL
             ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
            [user.id]
          );
          const verification = codeResult.rows[0];
          const codeHash = createHmac("sha256", config.sessionSecret)
            .update(`email-verification:${user.id}:${code}`)
            .digest("hex");
          if (
            !verification ||
            new Date(verification.expires_at).getTime() <= Date.now()
          ) {
            if (verification) {
              await client.query(
                "UPDATE email_verification_codes SET used_at = now() WHERE id = $1",
                [verification.id]
              );
            }
            invalidCode = true;
          } else if (!tokensMatch(verification.code_hash, codeHash)) {
            await client.query(
              `UPDATE email_verification_codes
               SET attempts = attempts + 1,
                   used_at = CASE WHEN attempts + 1 >= $2 THEN now() ELSE used_at END
               WHERE id = $1`,
              [verification.id, EMAIL_VERIFICATION_MAX_ATTEMPTS]
            );
            invalidCode = true;
          } else {
            const updated = await client.query(
              `UPDATE users SET email_verified_at = now(), updated_at = now()
               WHERE id = $1 AND email_verified_at IS NULL
               RETURNING id, email, name`,
              [user.id]
            );
            await client.query(
              "UPDATE email_verification_codes SET used_at = now() WHERE id = $1",
              [verification.id]
            );
            verifiedUser = updated.rows[0];
            invalidCode = !verifiedUser;
            if (verifiedUser && user.referred_by) {
              await client.query(
                "SELECT id FROM users WHERE id = $1 FOR UPDATE",
                [user.referred_by]
              );
              const referralCount = await client.query(
                `SELECT COUNT(*)::int AS verified_count
                 FROM users
                 WHERE referred_by = $1 AND email_verified_at IS NOT NULL`,
                [user.referred_by]
              );
              const verifiedCount = Number(referralCount.rows[0].verified_count);
              if (!Number.isSafeInteger(verifiedCount)) {
                throw new Error("Jumlah undangan terverifikasi melebihi batas angka yang dapat diproses.");
              }
              if (verifiedCount >= REFERRAL_GOAL) {
                await client.query(
                  `INSERT INTO referral_rewards
                     (referrer_id, amount_idr, verified_referrals_at_award)
                   VALUES ($1, $2, $3)
                   ON CONFLICT (referrer_id) DO NOTHING`,
                  [user.referred_by, REFERRAL_REWARD_IDR, verifiedCount]
                );
              }
            }
          }
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      if (invalidCode) {
        response.set("Cache-Control", "no-store");
        return response.status(400).json({
          error: "Kode verifikasi tidak valid atau kedaluwarsa. Minta kode baru jika diperlukan.",
        });
      }

      await regenerateSession(request);
      request.session.userId = verifiedUser.id;
      request.session.csrfToken = randomBytes(32).toString("base64url");
      await saveSession(request);
      response.set("Cache-Control", "no-store");
      response.json({
        user: publicUser(verifiedUser),
        csrfToken: request.session.csrfToken,
      });
    })
  );

  app.get("/api/auth/me", asyncRoute(async (request, response) => {
    response.set("Cache-Control", "no-store");
    if (!request.session?.userId) {
      return response.status(401).json({ error: "Belum masuk." });
    }
    const result = await pool.query(
      "SELECT id, email, name FROM users WHERE id = $1",
      [request.session.userId]
    );
    if (!result.rows[0]) {
      await destroySession(request);
      response.clearCookie(SESSION_COOKIE_NAME, clearCookieOptions);
      return response.status(401).json({ error: "Sesi tidak lagi berlaku." });
    }
    response.json({ user: publicUser(result.rows[0]), csrfToken: request.session.csrfToken });
  }));

  app.post(
    "/api/generations/preview",
    generationLimiter,
    requireUser,
    asyncRoute(async (request, response) => {
      const generatedText = generateRandomText();
      request.session.pendingGeneration = generatedText;
      await saveSession(request);
      response.set("Cache-Control", "no-store");
      response.json({ generatedText });
    })
  );

  app.post(
    "/api/generations",
    generationLimiter,
    requireUser,
    asyncRoute(async (request, response) => {
      const generatedText = request.body?.generatedText;
      if (
        typeof generatedText !== "string" ||
        !GENERATED_TEXT_PATTERN.test(generatedText) ||
        !tokensMatch(request.session.pendingGeneration, generatedText)
      ) {
        return response.status(400).json({ error: "Buat teks acak baru sebelum mengirimkannya." });
      }

      try {
        const result = await pool.query(
          `INSERT INTO generated_items (user_id, generated_text)
           VALUES ($1, $2)
           RETURNING id, generated_text, status, created_at`,
          [request.authUser.id, generatedText]
        );
        delete request.session.pendingGeneration;
        await saveSession(request);
        response.set("Cache-Control", "no-store");
        response.status(201).json({ item: result.rows[0] });
      } catch (error) {
        if (error?.code === "23505" && error?.constraint === "generated_items_generated_text_key") {
          delete request.session.pendingGeneration;
          await saveSession(request);
          return response.status(409).json({ error: "Teks ini sudah pernah dikirim. Acak teks baru." });
        }
        throw error;
      }
    })
  );

  app.get(
    "/api/generations",
    requireUser,
    asyncRoute(async (request, response) => {
      const result = await pool.query(
        `SELECT id, generated_text, status, created_at
         FROM generated_items
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 200`,
        [request.authUser.id]
      );
      response.set("Cache-Control", "no-store");
      response.json({ items: result.rows });
    })
  );

  app.get(
    "/api/referrals",
    requireUser,
    asyncRoute(async (request, response) => {
      const [account, activity] = await Promise.all([
        pool.query("SELECT referral_code FROM users WHERE id = $1", [request.authUser.id]),
        pool.query(
          `SELECT COUNT(*)::int AS total_referrals,
                  COUNT(*) FILTER (WHERE email_verified_at IS NOT NULL)::int AS verified_referrals
           FROM users
           WHERE referred_by = $1`,
          [request.authUser.id]
        ),
      ]);
      if (!account.rows[0]) {
        return response.status(404).json({ error: "Akun MailMu tidak ditemukan." });
      }
      const reward = await pool.query(
        "SELECT amount_idr, awarded_at FROM referral_rewards WHERE referrer_id = $1",
        [request.authUser.id]
      );
      const referralUrl = new URL("/auth.html", config.publicBaseUrl);
      referralUrl.searchParams.set("ref", account.rows[0].referral_code);
      referralUrl.searchParams.set("next", "/index.html");
      const totalReferrals = Number(activity.rows[0].total_referrals);
      const verifiedReferrals = Number(activity.rows[0].verified_referrals);
      const rewardAmountIdr = reward.rows[0]
        ? Number(reward.rows[0].amount_idr)
        : REFERRAL_REWARD_IDR;
      if (
        !Number.isSafeInteger(totalReferrals) ||
        !Number.isSafeInteger(verifiedReferrals) ||
        !Number.isSafeInteger(rewardAmountIdr)
      ) {
        throw new Error("Data undangan melebihi batas angka yang dapat diproses.");
      }
      response.set("Cache-Control", "no-store");
      response.json({
        referralCode: account.rows[0].referral_code,
        referralUrl: referralUrl.toString(),
        totalReferrals,
        verifiedReferrals,
        goal: REFERRAL_GOAL,
        rewardAmountIdr,
        rewardGranted: Boolean(reward.rows[0]),
        awardedAt: reward.rows[0]?.awarded_at || null,
      });
    })
  );

  app.get(
    "/api/balance",
    requireUser,
    asyncRoute(async (request, response) => {
      const currency = request.query.currency || "IDR";
      if (currency !== "IDR" && currency !== "USD") {
        return response.status(400).json({ error: "Mata uang harus IDR atau USD." });
      }
      const funds = await getAccountFunds(request.authUser.id);
      response.set("Cache-Control", "no-store");

      if (currency === "IDR") {
        return response.json({
          currency,
          amount: funds.availableIdr,
          balanceIdr: funds.availableIdr,
          earnedBalanceIdr: funds.earnedIdr,
          allocatedBalanceIdr: funds.allocatedIdr,
          availableBalanceIdr: funds.availableIdr,
          approvedCount: funds.approvedCount,
          ratePerApprovedTextIdr: IDR_PER_APPROVED_TEXT,
        });
      }

      try {
        const rate = await currencyRateProvider();
        return response.json({
          currency,
          amount: Number((funds.availableIdr * rate.usdPerIdr).toFixed(2)),
          balanceIdr: funds.availableIdr,
          earnedBalanceIdr: funds.earnedIdr,
          allocatedBalanceIdr: funds.allocatedIdr,
          availableBalanceIdr: funds.availableIdr,
          approvedCount: funds.approvedCount,
          ratePerApprovedTextIdr: IDR_PER_APPROVED_TEXT,
          usdPerIdr: rate.usdPerIdr,
          rateDate: rate.rateDate,
          rateSource: rate.source,
          rateIsStale: rate.stale,
        });
      } catch (error) {
        console.error("IDR/USD exchange rate unavailable:", error.message);
        return response.status(503).json({ error: error.message });
      }
    })
  );

  app.get(
    "/api/withdrawals",
    requireUser,
    asyncRoute(async (request, response) => {
      let rate;
      try {
        rate = await currencyRateProvider();
      } catch (error) {
        console.error("Withdrawal exchange rate unavailable:", error.message);
        return response.status(503).json({ error: error.message });
      }

      const [funds, result] = await Promise.all([
        getAccountFunds(request.authUser.id),
        pool.query(
          `SELECT id, amount_idr, method, recipient_name, destination, bank_name,
                  status, admin_note, usd_per_idr, created_at, processed_at
           FROM withdrawal_requests
           WHERE user_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT 100`,
          [request.authUser.id]
        ),
      ]);
      response.set("Cache-Control", "no-store");
      response.json({
        requests: result.rows,
        availableBalanceIdr: funds.availableIdr,
        minimumAmountIdr: Math.ceil(MINIMUM_WITHDRAWAL_USD / rate.usdPerIdr),
        minimumUsd: MINIMUM_WITHDRAWAL_USD,
        usdPerIdr: rate.usdPerIdr,
        rateDate: rate.rateDate,
        rateIsStale: rate.stale,
      });
    })
  );

  app.post(
    "/api/withdrawals",
    requireUser,
    asyncRoute(async (request, response) => {
      const {
        amountIdr,
        method,
        recipientName,
        destination,
        bankName,
      } = request.body || {};
      if (!Number.isSafeInteger(amountIdr) || amountIdr <= 0) {
        return response.status(400).json({ error: "Nominal penarikan harus berupa Rupiah bulat yang valid." });
      }
      if (!WITHDRAWAL_METHODS.has(method)) {
        return response.status(400).json({ error: "Pilih metode pencairan yang tersedia." });
      }
      const cleanRecipientName = typeof recipientName === "string" ? recipientName.trim() : "";
      const cleanDestination = typeof destination === "string" ? destination.trim() : "";
      const cleanBankName = typeof bankName === "string" ? bankName.trim() : "";
      if (!/^[\p{L}\p{N}][\p{L}\p{N} .'-]{1,79}$/u.test(cleanRecipientName)) {
        return response.status(400).json({ error: "Nama pemilik rekening/akun harus 2-80 karakter." });
      }
      if (!/^[\p{L}\p{N}+][\p{L}\p{N} .+()/-]{2,63}$/u.test(cleanDestination)) {
        return response.status(400).json({ error: "Nomor rekening atau nomor akun harus 3-64 karakter." });
      }
      if (
        method === "bank" &&
        !/^[\p{L}\p{N}][\p{L}\p{N} .'-]{1,79}$/u.test(cleanBankName)
      ) {
        return response.status(400).json({ error: "Nama bank harus 2-80 karakter." });
      }

      let rate;
      try {
        rate = await currencyRateProvider();
      } catch (error) {
        console.error("Withdrawal exchange rate unavailable:", error.message);
        return response.status(503).json({ error: error.message });
      }
      const minimumAmountIdr = Math.ceil(MINIMUM_WITHDRAWAL_USD / rate.usdPerIdr);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [request.authUser.id]);
        const earnedResult = await client.query(
          `SELECT COUNT(*) FILTER (WHERE status = 'accepted')::bigint AS approved_count,
                  COALESCE((
                    SELECT amount_idr
                    FROM referral_rewards
                    WHERE referrer_id = $1
                  ), 0)::bigint AS referral_reward_idr
           FROM generated_items
           WHERE user_id = $1`,
          [request.authUser.id]
        );
        const allocatedResult = await client.query(
          `SELECT COALESCE(SUM(amount_idr), 0)::bigint AS allocated_idr
           FROM withdrawal_requests
           WHERE user_id = $1 AND status IN ('pending', 'processing', 'paid')`,
          [request.authUser.id]
        );
        const approvedCount = Number(earnedResult.rows[0].approved_count);
        const referralRewardIdr = Number(earnedResult.rows[0].referral_reward_idr);
        const earnedIdr = approvedCount * IDR_PER_APPROVED_TEXT + referralRewardIdr;
        const allocatedIdr = Number(allocatedResult.rows[0].allocated_idr);
        if (!Number.isSafeInteger(earnedIdr) || !Number.isSafeInteger(allocatedIdr)) {
          throw new Error("Saldo akun melebihi batas angka yang dapat diproses.");
        }
        const availableIdr = Math.max(0, earnedIdr - allocatedIdr);
        if (amountIdr < minimumAmountIdr) {
          await client.query("ROLLBACK");
          return response.status(400).json({
            error: `Minimum penarikan setara US$${MINIMUM_WITHDRAWAL_USD} (Rp${minimumAmountIdr.toLocaleString("id-ID")}).`,
          });
        }
        if (amountIdr > availableIdr) {
          await client.query("ROLLBACK");
          return response.status(400).json({
            error: `Nominal melebihi saldo yang tersedia (Rp${availableIdr.toLocaleString("id-ID")}).`,
          });
        }

        const inserted = await client.query(
          `INSERT INTO withdrawal_requests
             (user_id, amount_idr, method, recipient_name, destination, bank_name, usd_per_idr)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, amount_idr, method, recipient_name, destination, bank_name,
                     status, admin_note, usd_per_idr, created_at, processed_at`,
          [
            request.authUser.id,
            amountIdr,
            method,
            cleanRecipientName,
            cleanDestination,
            method === "bank" ? cleanBankName : null,
            rate.usdPerIdr,
          ]
        );
        await client.query("COMMIT");
        response.set("Cache-Control", "no-store");
        response.status(201).json({ request: inserted.rows[0] });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    })
  );

  app.get(
    "/api/leaderboard",
    requireUser,
    asyncRoute(async (request, response) => {
      const result = await pool.query(
        `SELECT u.name,
                COUNT(gi.id) FILTER (WHERE gi.status = 'accepted')::int AS approved_count,
                COUNT(gi.id) FILTER (WHERE gi.status = 'accepted')::int * $1 AS balance_idr,
                u.id = $2 AS is_current_user
         FROM users u
         LEFT JOIN generated_items gi ON gi.user_id = u.id
         GROUP BY u.id, u.name
         HAVING COUNT(gi.id) FILTER (WHERE gi.status = 'accepted') > 0
         ORDER BY approved_count DESC, u.name ASC, u.id ASC
         LIMIT 10`,
        [IDR_PER_APPROVED_TEXT, request.authUser.id]
      );
      response.set("Cache-Control", "no-store");
      response.json({
        entries: result.rows.map((row) => ({
          name: row.name,
          approvedCount: Number(row.approved_count),
          balanceIdr: Number(row.balance_idr),
          isCurrentUser: row.is_current_user,
        })),
      });
    })
  );

  registerAdminRoutes(app, {
    pool,
    requireAdmin: [requireUser, requireAdmin],
    getAccountFunds,
    idrPerApprovedText: IDR_PER_APPROVED_TEXT,
  });

  app.post("/api/auth/forgot-password", passwordResetLimiter, asyncRoute(async (request, response) => {
    if (!mailer.isConfigured) {
      return response.status(503).json({ error: "Pemulihan kata sandi belum tersedia. Konfigurasikan layanan email." });
    }
    const email = normalizeEmail(request.body?.email);
    if (!email) return response.status(400).json({ error: "Masukkan alamat email yang valid." });

    const result = await pool.query(
      "SELECT id, email FROM users WHERE email_normalized = $1",
      [email]
    );
    if (result.rows[0]) {
      const { token, tokenHash } = await issueResetToken(pool, result.rows[0].id);
      const resetUrl = new URL("/auth.html", config.publicBaseUrl);
      resetUrl.searchParams.set("reset", token);
      try {
        await mailer.sendPasswordResetEmail(result.rows[0].email, resetUrl.toString());
      } catch (error) {
        console.error("Password reset email delivery failed:", error.message);
        await pool.query(
          "UPDATE password_reset_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL",
          [tokenHash]
        );
        return response.status(503).json({ error: "Email pemulihan tidak dapat dikirim saat ini. Coba lagi nanti." });
      }
    }
    response.set("Cache-Control", "no-store");
    response.status(202).json({ message: GENERIC_RESET_MESSAGE });
  }));

  app.post("/api/auth/reset-password", passwordResetLimiter, asyncRoute(async (request, response) => {
    const token = request.body?.token;
    const validation = validatePassword(request.body?.password);
    if (!isValidResetToken(token)) {
      return response.status(400).json({ error: "Tautan pemulihan tidak valid atau sudah kedaluwarsa." });
    }
    if (validation.error) return response.status(400).json({ error: validation.error });

    const passwordHash = await hashPassword(validation.value);
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const client = await pool.connect();
    let userId;
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `SELECT user_id FROM password_reset_tokens
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
         FOR UPDATE`,
        [tokenHash]
      );
      userId = result.rows[0]?.user_id;
      if (!userId) {
        await client.query("ROLLBACK");
        return response.status(400).json({ error: "Tautan pemulihan tidak valid atau sudah kedaluwarsa." });
      }
      await client.query(
        "UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2",
        [passwordHash, userId]
      );
      await client.query(
        "UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
        [userId]
      );
      await client.query("DELETE FROM sessions WHERE sess->>'userId' = $1", [userId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    response.set("Cache-Control", "no-store");
    response.json({ message: "Kata sandi berhasil diperbarui. Silakan masuk dengan kata sandi baru." });
  }));

  app.post("/api/auth/logout", asyncRoute(async (request, response) => {
    await destroySession(request);
    response.clearCookie(SESSION_COOKIE_NAME, clearCookieOptions);
    response.set("Cache-Control", "no-store");
    response.status(204).end();
  }));

  app.use("/api", (_request, response) => {
    response.status(404).json({ error: "Endpoint tidak ditemukan." });
  });

  app.use(express.static(PUBLIC_DIRECTORY, { fallthrough: true, index: "index.html" }));

  app.use((error, _request, response, _next) => {
    if (error?.type === "entity.parse.failed") {
      return response.status(400).json({ error: "Format JSON permintaan tidak valid." });
    }
    if (error?.code === "23505" && error?.constraint === "users_email_normalized_key") {
      return response.status(409).json({ error: "Akun dengan alamat email tersebut sudah terdaftar." });
    }
    console.error("Request failed:", error?.message || "Unknown error");
    response.status(500).json({ error: "Terjadi kesalahan server. Coba lagi nanti." });
  });

  return app;
}
