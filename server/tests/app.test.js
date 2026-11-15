import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import session from "express-session";
import { createApp } from "../app.js";
import { verifyPassword } from "../passwords.js";

function createTestPool() {
  const users = new Map();
  const resetTokens = new Map();
  const emailVerificationCodes = new Map();
  const generatedItems = [];
  const generationReviews = [];
  const withdrawalRequests = [];
  const referralRewards = new Map();
  async function query(sql, values = []) {
    const statement = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (statement.startsWith("insert into users")) {
      const [email, emailNormalized, name, passwordHash, referredBy] = values;
      if ([...users.values()].some((user) => user.email_normalized === emailNormalized)) {
        const error = new Error("duplicate email");
        error.code = "23505";
        error.constraint = "users_email_normalized_key";
        throw error;
      }
      const user = {
        id: randomUUID(),
        email,
        email_normalized: emailNormalized,
        name,
        password_hash: passwordHash,
        email_verified_at: null,
        role: "user",
        referral_code: randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase(),
        referred_by: referredBy,
      };
      users.set(user.id, user);
      return { rows: [{ id: user.id, email, name }], rowCount: 1 };
    }
    if (statement.startsWith("select id from users where referral_code")) {
      const user = [...users.values()].find((item) => item.referral_code === values[0]);
      return { rows: user ? [{ id: user.id }] : [], rowCount: user ? 1 : 0 };
    }
    if (statement.startsWith("select referral_code from users")) {
      const user = users.get(values[0]);
      return {
        rows: user ? [{ referral_code: user.referral_code }] : [],
        rowCount: user ? 1 : 0,
      };
    }
    if (statement.includes("count(*) filter (where email_verified_at is not null)")) {
      const referred = [...users.values()].filter((item) => item.referred_by === values[0]);
      return {
        rows: [{
          total_referrals: referred.length,
          verified_referrals: referred.filter((item) => item.email_verified_at).length,
        }],
        rowCount: 1,
      };
    }
    if (statement.startsWith("select amount_idr, awarded_at from referral_rewards")) {
      const reward = referralRewards.get(values[0]);
      return { rows: reward ? [{ ...reward }] : [], rowCount: reward ? 1 : 0 };
    }
    if (statement.includes("from users where email_normalized")) {
      const user = [...users.values()].find((item) => item.email_normalized === values[0]);
      return { rows: user ? [{ ...user }] : [], rowCount: user ? 1 : 0 };
    }
    if (statement.includes("from users where id")) {
      const user = users.get(values[0]);
      return {
        rows: user
          ? [{ id: user.id, email: user.email, name: user.name, role: user.role }]
          : [],
        rowCount: user ? 1 : 0,
      };
    }
    if (statement.includes("from users u left join generated_items gi")) {
      const [ratePerApprovedText, currentUserId] = values;
      const entries = [...users.values()]
        .map((user) => {
          const approvedCount = generatedItems.filter(
            (item) => item.user_id === user.id && item.status === "accepted"
          ).length;
          return {
            name: user.name,
            approved_count: approvedCount,
            balance_idr: approvedCount * ratePerApprovedText,
            is_current_user: user.id === currentUserId,
            id: user.id,
          };
        })
        .filter((entry) => entry.approved_count > 0)
        .sort((left, right) =>
          right.approved_count - left.approved_count ||
          left.name.localeCompare(right.name) ||
          left.id.localeCompare(right.id)
        )
        .slice(0, 10)
        .map(({ id: _id, ...entry }) => entry);
      return { rows: entries, rowCount: entries.length };
    }
    if (statement.startsWith("select coalesce((") && statement.includes("as earned_idr")) {
      const [userId, ratePerApprovedText] = values;
      const approvedCount = generatedItems.filter(
        (item) => item.user_id === userId && item.status === "accepted"
      ).length;
      const rewardIdr = referralRewards.get(userId)?.amount_idr || 0;
      const allocatedIdr = withdrawalRequests
        .filter((item) =>
          item.user_id === userId &&
          ["pending", "processing", "paid"].includes(item.status)
        )
        .reduce((total, item) => total + item.amount_idr, 0);
      return {
        rows: [{
          approved_count: approvedCount,
          earned_idr: approvedCount * ratePerApprovedText + rewardIdr,
          allocated_idr: allocatedIdr,
        }],
        rowCount: 1,
      };
    }
    if (statement.startsWith("select id, amount_idr, method, recipient_name, destination, bank_name")) {
      const items = withdrawalRequests
        .filter((item) => item.user_id === values[0])
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(0, 100);
      return { rows: items, rowCount: items.length };
    }
    if (statement.includes("from withdrawal_requests wr join users u")) {
      const requests = withdrawalRequests
        .map((item) => ({
          ...item,
          user_name: users.get(item.user_id).name,
          user_email: users.get(item.user_id).email,
        }))
        .sort((left, right) =>
          ["pending", "processing", "paid", "rejected"].indexOf(left.status) -
            ["pending", "processing", "paid", "rejected"].indexOf(right.status) ||
          left.created_at.localeCompare(right.created_at)
        )
        .slice(0, 100);
      return { rows: requests, rowCount: requests.length };
    }
    if (statement.startsWith("insert into generated_items")) {
      const [userId, generatedText] = values;
      if (generatedItems.some((item) => item.generated_text === generatedText)) {
        const error = new Error("duplicate generated text");
        error.code = "23505";
        error.constraint = "generated_items_generated_text_key";
        throw error;
      }
      const item = {
        id: randomUUID(),
        user_id: userId,
        generated_text: generatedText,
        status: "submitted",
        created_at: new Date().toISOString(),
      };
      generatedItems.push(item);
      return {
        rows: [{
          id: item.id,
          generated_text: item.generated_text,
          status: item.status,
          created_at: item.created_at,
        }],
        rowCount: 1,
      };
    }
    if (statement.includes("count(*) filter")) {
      if (statement.includes("where user_id")) {
        const approvedCount = generatedItems.filter(
          (item) => item.user_id === values[0] && item.status === "accepted"
        ).length;
        return { rows: [{ approved_count: approvedCount }], rowCount: 1 };
      }
      const summary = { total: generatedItems.length };
      for (const status of ["submitted", "pending", "checking", "accepted", "rejected"]) {
        summary[status] = generatedItems.filter((item) => item.status === status).length;
      }
      return { rows: [summary], rowCount: 1 };
    }
    if (statement.includes("from generated_items gi join users u")) {
      const [status, search, , limit, offset] = values;
      const normalizedSearch = search.replace(/^%|%$/g, "").toLowerCase();
      const items = generatedItems
        .filter((item) => status === "all" || item.status === status)
        .map((item) => {
          const user = users.get(item.user_id);
          return {
            id: item.id,
            generated_text: item.generated_text,
            status: item.status,
            created_at: item.created_at,
            reviewed_at: item.reviewed_at || null,
            admin_note: item.admin_note || null,
            user_id: user.id,
            user_name: user.name,
            user_email: user.email,
          };
        })
        .filter((item) =>
          !normalizedSearch ||
          [item.generated_text, item.user_name, item.user_email, item.id]
            .some((value) => value.toLowerCase().includes(normalizedSearch))
        )
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(offset, offset + limit);
      return { rows: items, rowCount: items.length };
    }
    if (statement.includes("from generated_items")) {
      const items = generatedItems
        .filter((item) => item.user_id === values[0])
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(0, 200);
      return { rows: items, rowCount: items.length };
    }
    if (statement.startsWith("update password_reset_tokens")) {
      const token = resetTokens.get(values[0]);
      if (token) token.used = true;
      return { rows: [], rowCount: token ? 1 : 0 };
    }
    if (statement.startsWith("update email_verification_codes")) {
      const code = emailVerificationCodes.get(values[0]);
      if (code) code.usedAt = new Date().toISOString();
      return { rows: [], rowCount: code ? 1 : 0 };
    }
    if (statement.startsWith("delete from email_verification_codes")) {
      const code = emailVerificationCodes.get(values[0]);
      if (code && !code.usedAt) emailVerificationCodes.delete(values[0]);
      return { rows: [], rowCount: code && !code.usedAt ? 1 : 0 };
    }
    if (statement.startsWith("delete from sessions")) {
      return { rows: [], rowCount: 0 };
    }
    if (statement === "select 1") return { rows: [{ "?column?": 1 }], rowCount: 1 };
    throw new Error(`Unexpected test query: ${statement}`);
  }

  return {
    users,
    resetTokens,
    emailVerificationCodes,
    generatedItems,
    generationReviews,
    withdrawalRequests,
    referralRewards,
    query,
    async connect() {
      return {
        async query(sql, values = []) {
          const statement = sql.replace(/\s+/g, " ").trim().toLowerCase();
          if (["begin", "commit", "rollback"].includes(statement)) {
            return { rows: [], rowCount: 0 };
          }
          if (statement.startsWith("select id from users where id")) {
            const user = users.get(values[0]);
            return { rows: user ? [{ id: user.id }] : [], rowCount: user ? 1 : 0 };
          }
          if (statement.startsWith("select coalesce((") && statement.includes("as earned_idr")) {
            const [userId, ratePerApprovedText] = values;
            const approvedCount = generatedItems.filter(
              (item) => item.user_id === userId && item.status === "accepted"
            ).length;
            const rewardIdr = referralRewards.get(userId)?.amount_idr || 0;
            const allocatedIdr = withdrawalRequests
              .filter((item) =>
                item.user_id === userId &&
                ["pending", "processing", "paid"].includes(item.status)
              )
              .reduce((total, item) => total + item.amount_idr, 0);
            return {
              rows: [{
                approved_count: approvedCount,
                earned_idr: approvedCount * ratePerApprovedText + rewardIdr,
                allocated_idr: allocatedIdr,
              }],
              rowCount: 1,
            };
          }
          if (statement.startsWith("select count(*) filter (where status = 'accepted')")) {
            const count = generatedItems.filter(
              (item) => item.user_id === values[0] && item.status === "accepted"
            ).length;
            const rewardIdr = referralRewards.get(values[0])?.amount_idr || 0;
            return {
              rows: [{ approved_count: count, referral_reward_idr: rewardIdr }],
              rowCount: 1,
            };
          }
          if (statement.startsWith("select coalesce(sum(amount_idr), 0)::bigint as allocated_idr")) {
            const amount = withdrawalRequests
              .filter((item) =>
                item.user_id === values[0] &&
                ["pending", "processing", "paid"].includes(item.status)
              )
              .reduce((total, item) => total + item.amount_idr, 0);
            return { rows: [{ allocated_idr: amount }], rowCount: 1 };
          }
          if (statement.startsWith("insert into withdrawal_requests")) {
            const [userId, amountIdr, method, recipientName, destination, bankName, usdPerIdr] = values;
            const item = {
              id: randomUUID(),
              user_id: userId,
              amount_idr: amountIdr,
              method,
              recipient_name: recipientName,
              destination,
              bank_name: bankName,
              usd_per_idr: usdPerIdr,
              status: "pending",
              admin_note: null,
              processed_at: null,
              created_at: new Date().toISOString(),
            };
            withdrawalRequests.push(item);
            return { rows: [item], rowCount: 1 };
          }
          if (statement.startsWith("select id, status from withdrawal_requests")) {
            const item = withdrawalRequests.find((candidate) => candidate.id === values[0]);
            return {
              rows: item ? [{ id: item.id, status: item.status }] : [],
              rowCount: item ? 1 : 0,
            };
          }
          if (statement.startsWith("update withdrawal_requests")) {
            const [status, adminNote, processedBy, id] = values;
            const item = withdrawalRequests.find((candidate) => candidate.id === id);
            if (!item) return { rows: [], rowCount: 0 };
            Object.assign(item, {
              status,
              admin_note: adminNote,
              processed_by: processedBy,
              processed_at: ["paid", "rejected"].includes(status)
                ? new Date().toISOString()
                : null,
            });
            return {
              rows: [{
                id: item.id,
                status: item.status,
                admin_note: item.admin_note,
                processed_at: item.processed_at,
              }],
              rowCount: 1,
            };
          }
          if (statement.startsWith("select email_verified_at from users")) {
            const user = users.get(values[0]);
            return {
              rows: user ? [{ email_verified_at: user.email_verified_at }] : [],
              rowCount: user ? 1 : 0,
            };
          }
          if (statement.startsWith("select 1 from email_verification_codes")) {
            const recent = [...emailVerificationCodes.values()].some(
              (code) =>
                code.userId === values[0] &&
                Date.now() - new Date(code.createdAt).getTime() < 60_000
            );
            return { rows: recent ? [{ "?column?": 1 }] : [], rowCount: recent ? 1 : 0 };
          }
          if (statement.startsWith("update email_verification_codes set used_at = now() where user_id")) {
            const userId = values[0];
            for (const code of emailVerificationCodes.values()) {
              if (code.userId === userId && !code.usedAt) code.usedAt = new Date().toISOString();
            }
            return { rows: [], rowCount: 0 };
          }
          if (statement.startsWith("insert into email_verification_codes")) {
            const [userId, codeHash] = values;
            const id = randomUUID();
            emailVerificationCodes.set(id, {
              id,
              userId,
              codeHash,
              attempts: 0,
              expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
              createdAt: new Date().toISOString(),
              usedAt: null,
            });
            return { rows: [{ id }], rowCount: 1 };
          }
          if (statement.startsWith("select id, email, name, email_verified_at, referred_by from users")) {
            const user = [...users.values()].find((item) => item.email_normalized === values[0]);
            return {
              rows: user
                ? [{
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    email_verified_at: user.email_verified_at,
                    referred_by: user.referred_by || null,
                  }]
                : [],
              rowCount: user ? 1 : 0,
            };
          }
          if (statement.startsWith("select id, code_hash, expires_at, attempts from email_verification_codes")) {
            const code = [...emailVerificationCodes.values()]
              .filter((item) => item.userId === values[0] && !item.usedAt)
              .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
            return {
              rows: code
                ? [{
                    id: code.id,
                    code_hash: code.codeHash,
                    expires_at: code.expiresAt,
                    attempts: code.attempts,
                  }]
                : [],
              rowCount: code ? 1 : 0,
            };
          }
          if (statement.startsWith("update email_verification_codes set attempts")) {
            const [id, maxAttempts] = values;
            const code = emailVerificationCodes.get(id);
            if (code) {
              code.attempts += 1;
              if (code.attempts >= maxAttempts) code.usedAt = new Date().toISOString();
            }
            return { rows: [], rowCount: code ? 1 : 0 };
          }
          if (statement.startsWith("update email_verification_codes set used_at = now() where id")) {
            const code = emailVerificationCodes.get(values[0]);
            if (code) code.usedAt = new Date().toISOString();
            return { rows: [], rowCount: code ? 1 : 0 };
          }
          if (statement.startsWith("delete from email_verification_codes")) {
            const code = emailVerificationCodes.get(values[0]);
            if (code && !code.usedAt) emailVerificationCodes.delete(values[0]);
            return { rows: [], rowCount: code && !code.usedAt ? 1 : 0 };
          }
          if (statement.startsWith("update users set email_verified_at")) {
            const user = users.get(values[0]);
            if (!user || user.email_verified_at) return { rows: [], rowCount: 0 };
            user.email_verified_at = new Date().toISOString();
            return {
              rows: [{ id: user.id, email: user.email, name: user.name }],
              rowCount: 1,
            };
          }
          if (statement.startsWith("select count(*)::int as verified_count from users")) {
            const count = [...users.values()].filter(
              (user) => user.referred_by === values[0] && user.email_verified_at
            ).length;
            return { rows: [{ verified_count: count }], rowCount: 1 };
          }
          if (statement.startsWith("insert into referral_rewards")) {
            const [referrerId, amountIdr, verifiedCount] = values;
            if (referralRewards.has(referrerId)) return { rows: [], rowCount: 0 };
            const reward = {
              amount_idr: amountIdr,
              verified_referrals_at_award: verifiedCount,
              awarded_at: new Date().toISOString(),
            };
            referralRewards.set(referrerId, reward);
            return { rows: [{ ...reward }], rowCount: 1 };
          }
          if (statement.startsWith("update password_reset_tokens")) {
            const userId = values[0];
            for (const token of resetTokens.values()) {
              if (token.userId === userId && !token.used) token.used = true;
            }
            return { rows: [], rowCount: 0 };
          }
          if (statement.startsWith("insert into password_reset_tokens")) {
            const [userId, tokenHash] = values;
            resetTokens.set(tokenHash, { userId, used: false });
            return { rows: [], rowCount: 1 };
          }
          if (statement.startsWith("select user_id from password_reset_tokens")) {
            const token = resetTokens.get(values[0]);
            return {
              rows: token && !token.used ? [{ user_id: token.userId }] : [],
              rowCount: token && !token.used ? 1 : 0,
            };
          }
          if (statement.startsWith("update users set password_hash")) {
            const [passwordHash, userId] = values;
            users.get(userId).password_hash = passwordHash;
            return { rows: [], rowCount: 1 };
          }
          if (statement.startsWith("select status, admin_note, user_id from generated_items")) {
            const item = generatedItems.find((candidate) => candidate.id === values[0]);
            return {
              rows: item
                ? [{ status: item.status, admin_note: item.admin_note || null, user_id: item.user_id }]
                : [],
              rowCount: item ? 1 : 0,
            };
          }
          if (statement.startsWith("update generated_items")) {
            const [status, adminNote, reviewedBy, id] = values;
            const item = generatedItems.find((candidate) => candidate.id === id);
            if (!item) return { rows: [], rowCount: 0 };
            Object.assign(item, { status, admin_note: adminNote, reviewed_by: reviewedBy });
            item.reviewed_at = new Date().toISOString();
            return {
              rows: [{
                id: item.id,
                generated_text: item.generated_text,
                status: item.status,
                created_at: item.created_at,
                reviewed_at: item.reviewed_at,
                admin_note: item.admin_note,
              }],
              rowCount: 1,
            };
          }
          if (statement.startsWith("insert into generated_item_reviews")) {
            const [generatedItemId, reviewedBy, previousStatus, newStatus, adminNote] = values;
            generationReviews.push({
              generated_item_id: generatedItemId,
              reviewed_by: reviewedBy,
              previous_status: previousStatus,
              new_status: newStatus,
              admin_note: adminNote,
            });
            return { rows: [], rowCount: 1 };
          }
          if (statement.startsWith("update password_reset_tokens")) {
            const userId = values[0];
            for (const token of resetTokens.values()) {
              if (token.userId === userId) token.used = true;
            }
            return { rows: [], rowCount: 0 };
          }
          if (statement.startsWith("delete from sessions")) {
            return { rows: [], rowCount: 0 };
          }
          throw new Error(`Unexpected test transaction: ${statement}`);
        },
        release() {},
      };
    },
  };
}

test("auth API registers, authenticates, resets passwords, and ends sessions", async (t) => {
  const pool = createTestPool();
  let sentResetEmail;
  const sentVerificationEmails = [];
  let exchangeRateUnavailable = false;
  const app = await createApp({
    pool,
    config: {
      nodeEnv: "test",
      sessionSecret: "mailmu-test-session-secret-with-sufficient-length",
      publicBaseUrl: "http://localhost:3000",
    },
    mailer: {
      isConfigured: true,
      async sendPasswordResetEmail(email, url) {
        sentResetEmail = { email, url };
      },
      async sendEmailVerificationCode(email, code) {
        sentVerificationEmails.push({ email, code });
      },
    },
    currencyRateProvider: async () => {
      if (exchangeRateUnavailable) throw new Error("Kurs tidak tersedia pada pengujian.");
      return {
        usdPerIdr: 0.000054811,
        rateDate: "2026-11-13",
        source: "Test reference rate",
        stale: false,
      };
    },
    sessionStore: new session.MemoryStore(),
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  async function request(path, { method = "GET", csrfToken, body, redirect = "follow" } = {}) {
    const headers = { accept: "application/json" };
    if (cookie) headers.cookie = cookie;
    if (csrfToken) headers["x-csrf-token"] = csrfToken;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect,
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      cookie = /max-age=0/i.test(setCookie) ? "" : setCookie.split(";")[0];
    }
    return response;
  }

  const rejectedWithoutCsrf = await request("/api/auth/register", {
    method: "POST",
    body: {},
  });
  assert.equal(rejectedWithoutCsrf.status, 403);

  const csrfResponse = await request("/api/auth/csrf");
  assert.equal(csrfResponse.status, 200);
  let { csrfToken } = await csrfResponse.json();

  const unauthenticatedPreview = await request("/api/generations/preview", {
    method: "POST",
    csrfToken,
    body: {},
  });
  assert.equal(unauthenticatedPreview.status, 401);
  assert.equal((await request("/api/leaderboard")).status, 401);
  assert.equal((await request("/api/withdrawals")).status, 401);
  const unauthenticatedAdminPage = await request("/admin", { redirect: "manual" });
  assert.equal(unauthenticatedAdminPage.status, 303);
  assert.equal(unauthenticatedAdminPage.headers.get("location"), "/auth.html?next=%2Fadmin");
  assert.equal((await request("/api/admin/summary")).status, 401);
  const missingCsrfPreview = await request("/api/generations/preview", {
    method: "POST",
    body: {},
  });
  assert.equal(missingCsrfPreview.status, 403);

  const password = "correct horse battery";
  const registration = await request("/api/auth/register", {
    method: "POST",
    csrfToken,
    body: { name: "MailMu User", email: "Tester@example.test", password },
  });
  assert.equal(registration.status, 201);
  let registrationResult = await registration.json();
  assert.equal(registrationResult.email, "tester@example.test");
  assert.equal(registrationResult.verificationRequired, true);
  assert.equal(sentVerificationEmails.length, 1);
  assert.match(sentVerificationEmails[0].code, /^\d{6}$/);
  const user = [...pool.users.values()][0];
  assert.equal(user.email_verified_at, null);
  assert.notEqual(user.password_hash, password);
  assert.equal(await verifyPassword(password, user.password_hash), true);

  const unverifiedLogin = await request("/api/auth/login", {
    method: "POST",
    csrfToken,
    body: { email: "tester@example.test", password },
  });
  assert.equal(unverifiedLogin.status, 403);
  assert.equal((await unverifiedLogin.json()).code, "email_not_verified");
  assert.equal((await request("/api/auth/me")).status, 401);

  const wrongFirstCode = sentVerificationEmails[0].code === "000000" ? "000001" : "000000";
  const invalidVerification = await request("/api/auth/email-verification/verify", {
    method: "POST",
    csrfToken,
    body: { email: "tester@example.test", code: wrongFirstCode },
  });
  assert.equal(invalidVerification.status, 400);

  const resendVerification = await request("/api/auth/email-verification/resend", {
    method: "POST",
    csrfToken,
    body: { email: "tester@example.test" },
  });
  assert.equal(resendVerification.status, 202);
  assert.equal(sentVerificationEmails.length, 1);

  const verifyRegistration = await request("/api/auth/email-verification/verify", {
    method: "POST",
    csrfToken,
    body: {
      email: "tester@example.test",
      code: sentVerificationEmails[0].code,
    },
  });
  assert.equal(verifyRegistration.status, 200);
  const verifiedResult = await verifyRegistration.json();
  csrfToken = verifiedResult.csrfToken;
  assert.equal(verifiedResult.user.email, "tester@example.test");
  assert.ok(user.email_verified_at);
  const reusedVerificationCode = await request("/api/auth/email-verification/verify", {
    method: "POST",
    csrfToken: verifiedResult.csrfToken,
    body: {
      email: "tester@example.test",
      code: sentVerificationEmails[0].code,
    },
  });
  assert.equal(reusedVerificationCode.status, 400);

  const sessionResponse = await request("/api/auth/me");
  assert.equal(sessionResponse.status, 200);
  assert.equal((await sessionResponse.json()).user.id, user.id);
  assert.match(user.referral_code, /^[A-F0-9]{12}$/);
  for (let index = 0; index < 19; index += 1) {
    const referredId = randomUUID();
    pool.users.set(referredId, {
      id: referredId,
      email: `invite${index}@example.test`,
      email_normalized: `invite${index}@example.test`,
      name: `Invite ${index}`,
      email_verified_at: new Date().toISOString(),
      role: "user",
      referral_code: randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase(),
      referred_by: user.id,
    });
  }
  const referralProgressBeforeReward = await request("/api/referrals");
  assert.equal(referralProgressBeforeReward.status, 200);
  const initialReferralData = await referralProgressBeforeReward.json();
  assert.equal(initialReferralData.verifiedReferrals, 19);
  assert.equal(initialReferralData.goal, 20);
  assert.equal(initialReferralData.rewardAmountIdr, 20_000);
  assert.equal(initialReferralData.rewardGranted, false);
  assert.match(initialReferralData.referralUrl, new RegExp(`ref=${user.referral_code}`));
  const nineteenReferrals = await request("/api/referrals");
  assert.equal((await nineteenReferrals.json()).verifiedReferrals, 19);

  const initialBalance = await request("/api/balance");
  assert.equal(initialBalance.status, 200);
  assert.equal((await initialBalance.json()).balanceIdr, 0);
  const initialUsdBalance = await request("/api/balance?currency=USD");
  assert.equal(initialUsdBalance.status, 200);
  assert.equal((await initialUsdBalance.json()).amount, 0);
  exchangeRateUnavailable = true;
  assert.equal((await request("/api/balance?currency=USD")).status, 503);
  exchangeRateUnavailable = false;
  assert.equal((await request("/api/balance?currency=EUR")).status, 400);
  assert.equal((await request("/api/admin/summary")).status, 403);
  assert.equal((await request("/api/admin/generations")).status, 403);
  assert.equal((await request("/api/admin/withdrawals")).status, 403);
  assert.equal((await request(`/api/admin/generations/${randomUUID()}`, {
    method: "PUT",
    csrfToken,
    body: { status: "accepted" },
  })).status, 403);
  assert.equal((await request("/admin")).status, 403);

  const preview = await request("/api/generations/preview", {
    method: "POST",
    csrfToken,
    body: {},
  });
  assert.equal(preview.status, 200);
  const { generatedText } = await preview.json();
  assert.match(generatedText, /^[A-Za-z0-9]{20}@ryann\.com$/);
  assert.match(generatedText.slice(0, 20), /\d/);

  const alteredText = await request("/api/generations", {
    method: "POST",
    csrfToken,
    body: { generatedText: `${"A".repeat(20)}@ryann.com` },
  });
  assert.equal(alteredText.status, 400);

  const savedText = await request("/api/generations", {
    method: "POST",
    csrfToken,
    body: { generatedText },
  });
  assert.equal(savedText.status, 201);
  const savedItem = (await savedText.json()).item;
  assert.equal(savedItem.generated_text, generatedText);
  assert.equal(savedItem.status, "submitted");
  assert.equal(pool.generatedItems.length, 1);
  assert.equal(pool.generatedItems[0].user_id, user.id);

  user.role = "admin";
  const adminPage = await request("/admin");
  assert.equal(adminPage.status, 200);
  assert.match(await adminPage.text(), /Dashboard admin/);
  assert.equal((await request("/admin/admin.css")).status, 200);
  assert.equal((await request("/admin/admin.js")).status, 200);
  const summaryResponse = await request("/api/admin/summary");
  assert.equal(summaryResponse.status, 200);
  assert.equal((await summaryResponse.json()).summary.total, 1);
  const adminListResponse = await request("/api/admin/generations?status=submitted&page=1");
  assert.equal(adminListResponse.status, 200);
  const adminItems = (await adminListResponse.json()).items;
  assert.equal(adminItems.length, 1);
  assert.equal(adminItems[0].user_email, user.email);
  const reviewResponse = await request(`/api/admin/generations/${savedItem.id}`, {
    method: "PUT",
    csrfToken,
    body: { status: "checking", adminNote: "Sedang ditinjau." },
  });
  assert.equal(reviewResponse.status, 200);
  assert.equal((await reviewResponse.json()).item.status, "checking");
  assert.equal(pool.generationReviews.length, 1);
  assert.equal(pool.generationReviews[0].reviewed_by, user.id);
  assert.equal(pool.generationReviews[0].previous_status, "submitted");
  const checkingBalance = await request("/api/balance");
  assert.equal((await checkingBalance.json()).balanceIdr, 0);
  const approveResponse = await request(`/api/admin/generations/${savedItem.id}`, {
    method: "PUT",
    csrfToken,
    body: { status: "accepted", adminNote: "Disetujui." },
  });
  assert.equal(approveResponse.status, 200);
  const approvedBalance = await request("/api/balance");
  const approvedBalanceData = await approvedBalance.json();
  assert.equal(approvedBalanceData.approvedCount, 1);
  assert.equal(approvedBalanceData.amount, 4000);
  const approvedUsdBalance = await request("/api/balance?currency=USD");
  assert.equal((await approvedUsdBalance.json()).amount, 0.22);
  pool.withdrawalRequests.push({
    user_id: user.id,
    amount_idr: 4_000,
    status: "pending",
  });
  const protectedApproval = await request(`/api/admin/generations/${savedItem.id}`, {
    method: "PUT",
    csrfToken,
    body: { status: "rejected" },
  });
  assert.equal(protectedApproval.status, 409);
  pool.withdrawalRequests.pop();

  for (let rank = 1; rank <= 12; rank += 1) {
    const userId = `00000000-0000-4000-8000-${String(rank).padStart(12, "0")}`;
    pool.users.set(userId, {
      id: userId,
      email: `rank${rank}@example.test`,
      name: `Ranking User ${String(rank).padStart(2, "0")}`,
      role: "user",
    });
    for (let approved = 0; approved < rank; approved += 1) {
      pool.generatedItems.push({
        id: randomUUID(),
        user_id: userId,
        generated_text: `Rank${rank}Text${approved}`,
        status: "accepted",
        created_at: new Date().toISOString(),
      });
    }
  }
  pool.generatedItems.push({
    id: randomUUID(),
    user_id: "00000000-0000-4000-8000-000000000012",
    generated_text: "unapproved-ranking-text",
    status: "pending",
    created_at: new Date().toISOString(),
  });
  const leaderboardResponse = await request("/api/leaderboard");
  assert.equal(leaderboardResponse.status, 200);
  const leaderboard = (await leaderboardResponse.json()).entries;
  assert.equal(leaderboard.length, 10);
  assert.equal(leaderboard[0].name, "Ranking User 12");
  assert.equal(leaderboard[0].approvedCount, 12);
  assert.equal(leaderboard[0].balanceIdr, 48_000);
  assert.equal(leaderboard[0].isCurrentUser, false);
  assert.equal(leaderboard[9].name, "Ranking User 03");
  assert.equal("email" in leaderboard[0], false);

  const userHistory = await request("/api/generations");
  assert.equal(userHistory.status, 200);
  const historyItems = (await userHistory.json()).items;
  assert.equal(historyItems.length, 1);
  assert.equal(historyItems[0].generated_text, generatedText);

  const replayedText = await request("/api/generations", {
    method: "POST",
    csrfToken,
    body: { generatedText },
  });
  assert.equal(replayedText.status, 400);

  for (let index = 0; index < 20; index += 1) {
    pool.generatedItems.push({
      id: randomUUID(),
      user_id: user.id,
      generated_text: `ApprovedUserText${index}`,
      status: "accepted",
      created_at: new Date().toISOString(),
    });
  }
  const withdrawalInfoResponse = await request("/api/withdrawals");
  assert.equal(withdrawalInfoResponse.status, 200);
  const withdrawalInfo = await withdrawalInfoResponse.json();
  assert.equal(withdrawalInfo.availableBalanceIdr, 84_000);
  assert.equal(withdrawalInfo.minimumAmountIdr, Math.ceil(2 / 0.000054811));
  const belowMinimum = await request("/api/withdrawals", {
    method: "POST",
    csrfToken,
    body: {
      amountIdr: 30_000,
      method: "bank",
      bankName: "Bank Test",
      recipientName: "Test Recipient",
      destination: "1234567890",
    },
  });
  assert.equal(belowMinimum.status, 400);
  assert.match((await belowMinimum.json()).error, /Minimum penarikan/);
  const bankWithdrawalResponse = await request("/api/withdrawals", {
    method: "POST",
    csrfToken,
    body: {
      amountIdr: 40_000,
      method: "bank",
      bankName: "Bank Test",
      recipientName: "Test Recipient",
      destination: "1234567890",
    },
  });
  assert.equal(bankWithdrawalResponse.status, 201);
  const bankWithdrawal = (await bankWithdrawalResponse.json()).request;
  assert.equal(bankWithdrawal.status, "pending");
  assert.equal(bankWithdrawal.bank_name, "Bank Test");
  const walletWithdrawalResponse = await request("/api/withdrawals", {
    method: "POST",
    csrfToken,
    body: {
      amountIdr: 40_000,
      method: "dana",
      recipientName: "Test Recipient",
      destination: "+6281234567890",
    },
  });
  assert.equal(walletWithdrawalResponse.status, 201);
  const walletWithdrawal = (await walletWithdrawalResponse.json()).request;
  const balanceWithRequests = await request("/api/balance");
  const balanceWithRequestsData = await balanceWithRequests.json();
  assert.equal(balanceWithRequestsData.earnedBalanceIdr, 84_000);
  assert.equal(balanceWithRequestsData.allocatedBalanceIdr, 80_000);
  assert.equal(balanceWithRequestsData.availableBalanceIdr, 4_000);
  const overdraw = await request("/api/withdrawals", {
    method: "POST",
    csrfToken,
    body: {
      amountIdr: withdrawalInfo.minimumAmountIdr,
      method: "ovo",
      recipientName: "Test Recipient",
      destination: "+6281234567890",
    },
  });
  assert.equal(overdraw.status, 400);
  assert.match((await overdraw.json()).error, /melebihi saldo/);
  const adminWithdrawalsResponse = await request("/api/admin/withdrawals");
  assert.equal(adminWithdrawalsResponse.status, 200);
  assert.equal((await adminWithdrawalsResponse.json()).requests.length, 2);
  const startProcessing = await request(`/api/admin/withdrawals/${bankWithdrawal.id}`, {
    method: "PUT",
    csrfToken,
    body: { status: "processing" },
  });
  assert.equal(startProcessing.status, 200);
  const markPaid = await request(`/api/admin/withdrawals/${bankWithdrawal.id}`, {
    method: "PUT",
    csrfToken,
    body: { status: "paid" },
  });
  assert.equal(markPaid.status, 200);
  const invalidPaidTransition = await request(`/api/admin/withdrawals/${bankWithdrawal.id}`, {
    method: "PUT",
    csrfToken,
    body: { status: "processing" },
  });
  assert.equal(invalidPaidTransition.status, 409);
  const rejectWithoutReason = await request(`/api/admin/withdrawals/${walletWithdrawal.id}`, {
    method: "PUT",
    csrfToken,
    body: { status: "rejected" },
  });
  assert.equal(rejectWithoutReason.status, 400);
  const rejectWallet = await request(`/api/admin/withdrawals/${walletWithdrawal.id}`, {
    method: "PUT",
    csrfToken,
    body: { status: "rejected", adminNote: "Nomor tujuan tidak valid." },
  });
  assert.equal(rejectWallet.status, 200);
  const balanceAfterProcessing = await request("/api/balance");
  assert.equal((await balanceAfterProcessing.json()).availableBalanceIdr, 44_000);
  const userWithdrawalHistory = await request("/api/withdrawals");
  const userWithdrawalHistoryData = await userWithdrawalHistory.json();
  assert.deepEqual(
    userWithdrawalHistoryData.requests.map((item) => item.status).sort(),
    ["paid", "rejected"]
  );
  assert.equal(userWithdrawalHistoryData.requests.find((item) => item.status === "rejected").admin_note, "Nomor tujuan tidak valid.");

  const duplicate = await request("/api/auth/register", {
    method: "POST",
    csrfToken,
    body: { name: "Another User", email: "tester@example.test", password },
  });
  assert.equal(duplicate.status, 409);

  const badLogin = await request("/api/auth/login", {
    method: "POST",
    csrfToken,
    body: { email: "tester@example.test", password: "incorrect password" },
  });
  assert.equal(badLogin.status, 401);

  const unknownEmail = await request("/api/auth/forgot-password", {
    method: "POST",
    csrfToken,
    body: { email: "unknown@example.test" },
  });
  const unknownResult = await unknownEmail.json();
  assert.equal(unknownEmail.status, 202);
  assert.equal(sentResetEmail, undefined);

  const forgot = await request("/api/auth/forgot-password", {
    method: "POST",
    csrfToken,
    body: { email: "tester@example.test" },
  });
  assert.equal(forgot.status, 202);
  assert.deepEqual(unknownResult, await forgot.json());
  assert.equal(sentResetEmail.email, "tester@example.test");
  const resetToken = new URL(sentResetEmail.url).searchParams.get("reset");
  assert.match(resetToken, /^[A-Za-z0-9_-]{43}$/);

  const newPassword = "another correct horse";
  const reset = await request("/api/auth/reset-password", {
    method: "POST",
    csrfToken,
    body: { token: resetToken, password: newPassword },
  });
  assert.equal(reset.status, 200);

  const tokenReuse = await request("/api/auth/reset-password", {
    method: "POST",
    csrfToken,
    body: { token: resetToken, password },
  });
  assert.equal(tokenReuse.status, 400);

  const oldPasswordLogin = await request("/api/auth/login", {
    method: "POST",
    csrfToken,
    body: { email: "tester@example.test", password },
  });
  assert.equal(oldPasswordLogin.status, 401);

  const login = await request("/api/auth/login", {
    method: "POST",
    csrfToken,
    body: { email: "tester@example.test", password: newPassword },
  });
  assert.equal(login.status, 200);
  const loginResult = await login.json();
  csrfToken = loginResult.csrfToken;

  const logout = await request("/api/auth/logout", {
    method: "POST",
    csrfToken,
    body: {},
  });
  assert.equal(logout.status, 204);
  assert.equal((await request("/api/auth/me")).status, 401);

  const secondCsrfResponse = await request("/api/auth/csrf");
  assert.equal(secondCsrfResponse.status, 200);
  const secondCsrfToken = (await secondCsrfResponse.json()).csrfToken;
  const secondRegistration = await request("/api/auth/register", {
    method: "POST",
    csrfToken: secondCsrfToken,
    body: {
      name: "Second User",
      email: "second@example.test",
      password: "another strong password",
      referralCode: user.referral_code,
    },
  });
  assert.equal(secondRegistration.status, 201);
  const secondEmailVerification = sentVerificationEmails.at(-1);
  const verifySecondRegistration = await request("/api/auth/email-verification/verify", {
    method: "POST",
    csrfToken: secondCsrfToken,
    body: {
      email: secondEmailVerification.email,
      code: secondEmailVerification.code,
    },
  });
  assert.equal(verifySecondRegistration.status, 200);
  csrfToken = (await verifySecondRegistration.json()).csrfToken;
  assert.equal(pool.referralRewards.get(user.id).amount_idr, 20_000);
  assert.equal(pool.referralRewards.get(user.id).verified_referrals_at_award, 20);
  const inviterLogin = await request("/api/auth/login", {
    method: "POST",
    csrfToken,
    body: { email: user.email, password: newPassword },
  });
  assert.equal(inviterLogin.status, 200);
  csrfToken = (await inviterLogin.json()).csrfToken;
  const rewardedBalance = await request("/api/balance");
  assert.equal((await rewardedBalance.json()).balanceIdr, 64_000);
  const rewardedReferralProgress = await request("/api/referrals");
  const rewardedReferralData = await rewardedReferralProgress.json();
  assert.equal(rewardedReferralData.verifiedReferrals, 20);
  assert.equal(rewardedReferralData.rewardGranted, true);
  const secondUserLogin = await request("/api/auth/login", {
    method: "POST",
    csrfToken,
    body: { email: "second@example.test", password: "another strong password" },
  });
  assert.equal(secondUserLogin.status, 200);
  csrfToken = (await secondUserLogin.json()).csrfToken;
  const secondUserHistory = await request("/api/generations");
  assert.equal(secondUserHistory.status, 200);
  assert.deepEqual((await secondUserHistory.json()).items, []);
  const secondUserBalance = await request("/api/balance");
  assert.equal(secondUserBalance.status, 200);
  assert.equal((await secondUserBalance.json()).balanceIdr, 0);

  const thirdRegistration = await request("/api/auth/register", {
    method: "POST",
    csrfToken,
    body: {
      name: "Third User",
      email: "third@example.test",
      password: "third strong password",
    },
  });
  assert.equal(thirdRegistration.status, 201);
  const thirdVerificationEmail = sentVerificationEmails.at(-1);
  const thirdUser = [...pool.users.values()].find(
    (item) => item.email_normalized === "third@example.test"
  );
  const storedCode = [...pool.emailVerificationCodes.values()].find(
    (item) => item.userId === thirdUser.id
  );
  assert.notEqual(storedCode.codeHash, thirdVerificationEmail.code);
  assert.match(storedCode.codeHash, /^[a-f0-9]{64}$/);

  const wrongCode = thirdVerificationEmail.code === "000000" ? "000001" : "000000";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const wrongVerification = await request("/api/auth/email-verification/verify", {
      method: "POST",
      csrfToken,
      body: { email: thirdVerificationEmail.email, code: wrongCode },
    });
    assert.equal(wrongVerification.status, 400);
  }
  assert.equal(storedCode.attempts, 5);
  assert.ok(storedCode.usedAt);
});
