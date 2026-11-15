const STATUSES = new Set(["submitted", "pending", "checking", "accepted", "rejected"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 25;
const WITHDRAWAL_STATUSES = new Set(["processing", "paid", "rejected"]);

function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function registerAdminRoutes(app, {
  pool,
  requireAdmin,
  getAccountFunds,
  idrPerApprovedText,
}) {
  app.get("/api/admin/summary", requireAdmin, asyncRoute(async (_request, response) => {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'submitted')::int AS submitted,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'checking')::int AS checking,
        COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
        COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected
      FROM generated_items
    `);
    response.set("Cache-Control", "no-store");
    response.json({ summary: result.rows[0] });
  }));

  app.get("/api/admin/generations", requireAdmin, asyncRoute(async (request, response) => {
    const status = request.query.status || "all";
    const search = typeof request.query.q === "string" ? request.query.q.trim().slice(0, 100) : "";
    const pageValue = Number(request.query.page || 1);
    if (!["all", ...STATUSES].includes(status)) {
      return response.status(400).json({ error: "Filter status tidak valid." });
    }
    if (!Number.isSafeInteger(pageValue) || pageValue < 1 || pageValue > 100_000) {
      return response.status(400).json({ error: "Nomor halaman tidak valid." });
    }

    const result = await pool.query(
      `SELECT gi.id, gi.generated_text, gi.status, gi.created_at, gi.reviewed_at,
              gi.admin_note, u.id AS user_id, u.name AS user_name, u.email AS user_email
       FROM generated_items gi
       JOIN users u ON u.id = gi.user_id
       WHERE ($1 = 'all' OR gi.status = $1)
         AND ($2 = '' OR gi.generated_text ILIKE $3 ESCAPE '\\'
              OR u.email ILIKE $3 ESCAPE '\\' OR u.name ILIKE $3 ESCAPE '\\'
              OR gi.id::text ILIKE $3 ESCAPE '\\')
       ORDER BY gi.created_at DESC, gi.id DESC
       LIMIT $4 OFFSET $5`,
      [status, search, `%${escapeLike(search)}%`, PAGE_SIZE, (pageValue - 1) * PAGE_SIZE]
    );
    response.set("Cache-Control", "no-store");
    response.json({ items: result.rows, page: pageValue, pageSize: PAGE_SIZE });
  }));

  app.put("/api/admin/generations/:id", requireAdmin, asyncRoute(async (request, response) => {
    const { id } = request.params;
    const { status, adminNote } = request.body || {};
    if (!UUID_PATTERN.test(id)) {
      return response.status(400).json({ error: "ID kiriman tidak valid." });
    }
    if (!STATUSES.has(status)) {
      return response.status(400).json({ error: "Status kiriman tidak valid." });
    }
    if (
      adminNote !== undefined &&
      adminNote !== null &&
      (typeof adminNote !== "string" || adminNote.trim().length > 1000)
    ) {
      return response.status(400).json({ error: "Catatan admin maksimal 1000 karakter." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(
        "SELECT status, admin_note, user_id FROM generated_items WHERE id = $1 FOR UPDATE",
        [id]
      );
      if (!current.rows[0]) {
        await client.query("ROLLBACK");
        return response.status(404).json({ error: "Kiriman tidak ditemukan." });
      }

      const previous = current.rows[0];
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [previous.user_id]);
      if (previous.status === "accepted" && status !== "accepted") {
        const funds = await getAccountFunds(previous.user_id, client);
        if (funds.earnedIdr - idrPerApprovedText < funds.allocatedIdr) {
          await client.query("ROLLBACK");
          return response.status(409).json({
            error: "Status tidak dapat diubah karena saldo sudah ditahan atau dicairkan.",
          });
        }
      }
      const note = adminNote === undefined
        ? previous.admin_note
        : (adminNote?.trim() || null);
      const updated = await client.query(
        `UPDATE generated_items
         SET status = $1, admin_note = $2, reviewed_at = now(), reviewed_by = $3
         WHERE id = $4
         RETURNING id, generated_text, status, created_at, reviewed_at, admin_note`,
        [status, note, request.authUser.id, id]
      );
      await client.query(
        `INSERT INTO generated_item_reviews
           (generated_item_id, reviewed_by, previous_status, new_status, admin_note)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, request.authUser.id, previous.status, status, note]
      );
      await client.query("COMMIT");
      response.set("Cache-Control", "no-store");
      response.json({ item: updated.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.get("/api/admin/withdrawals", requireAdmin, asyncRoute(async (_request, response) => {
    const result = await pool.query(
      `SELECT wr.id, wr.user_id, wr.amount_idr, wr.method, wr.recipient_name,
              wr.destination, wr.bank_name, wr.usd_per_idr, wr.status, wr.admin_note,
              wr.created_at, wr.processed_at, u.name AS user_name, u.email AS user_email
       FROM withdrawal_requests wr
       JOIN users u ON u.id = wr.user_id
       ORDER BY CASE wr.status WHEN 'pending' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END,
                wr.created_at ASC, wr.id ASC
       LIMIT 100`
    );
    response.set("Cache-Control", "no-store");
    response.json({ requests: result.rows });
  }));

  app.put("/api/admin/withdrawals/:id", requireAdmin, asyncRoute(async (request, response) => {
    const { id } = request.params;
    const { status, adminNote } = request.body || {};
    if (!UUID_PATTERN.test(id)) {
      return response.status(400).json({ error: "ID penarikan tidak valid." });
    }
    if (!WITHDRAWAL_STATUSES.has(status)) {
      return response.status(400).json({ error: "Status penarikan tidak valid." });
    }
    if (
      adminNote !== undefined &&
      adminNote !== null &&
      (typeof adminNote !== "string" || adminNote.trim().length > 1000)
    ) {
      return response.status(400).json({ error: "Catatan admin maksimal 1000 karakter." });
    }
    const note = typeof adminNote === "string" ? adminNote.trim() : "";
    if (status === "rejected" && !note) {
      return response.status(400).json({ error: "Catatan wajib diisi saat menolak penarikan." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(
        "SELECT id, status FROM withdrawal_requests WHERE id = $1 FOR UPDATE",
        [id]
      );
      if (!current.rows[0]) {
        await client.query("ROLLBACK");
        return response.status(404).json({ error: "Pengajuan penarikan tidak ditemukan." });
      }
      const allowedNextStatuses = current.rows[0].status === "pending"
        ? new Set(["processing", "paid", "rejected"])
        : current.rows[0].status === "processing"
          ? new Set(["paid", "rejected"])
          : new Set();
      if (!allowedNextStatuses.has(status)) {
        await client.query("ROLLBACK");
        return response.status(409).json({ error: "Status penarikan ini sudah final atau tidak dapat diubah ke status tersebut." });
      }

      const updated = await client.query(
        `UPDATE withdrawal_requests
         SET status = $1,
             admin_note = $2,
             processed_by = $3,
             processed_at = CASE WHEN $1 IN ('paid', 'rejected') THEN now() ELSE NULL END,
             updated_at = now()
         WHERE id = $4
         RETURNING id, status, admin_note, processed_at`,
        [status, note || null, request.authUser.id, id]
      );
      await client.query("COMMIT");
      response.set("Cache-Control", "no-store");
      response.json({ request: updated.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));
}
