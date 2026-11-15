(function () {
  "use strict";

  const labels = {
    submitted: "Tersimpan",
    pending: "Menunggu",
    checking: "Sedang dicek",
    accepted: "Disetujui",
    rejected: "Ditolak",
  };
  const THEME_STORAGE_KEY = "mailmu-theme";
  const list = document.getElementById("submission-list");
  const withdrawalList = document.getElementById("withdrawal-list");
  const notice = document.getElementById("notice");
  let csrfToken = "";
  let page = 1;
  let hasNextPage = false;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function formatDate(value) {
    return new Intl.DateTimeFormat("id-ID", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  }

  function formatIdr(value) {
    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0,
    }).format(Number(value));
  }

  function showNotice(message, isError) {
    notice.textContent = message;
    notice.hidden = false;
    notice.classList.toggle("is-error", Boolean(isError));
  }

  function loadThemePreference() {
    try {
      return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
    } catch (error) {
      console.error("Gagal membaca preferensi tema admin MailMu:", error);
      return "light";
    }
  }

  function applyTheme(theme) {
    const isDark = theme === "dark";
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
    const toggle = document.getElementById("admin-theme-toggle");
    const nextThemeLabel = isDark ? "terang" : "gelap";
    toggle.setAttribute("aria-checked", String(isDark));
    toggle.setAttribute("aria-label", `Ganti ke tema ${nextThemeLabel}`);
    toggle.title = `Ganti ke tema ${nextThemeLabel}`;
    document.getElementById("admin-theme-mode").textContent = isDark ? "Gelap" : "Terang";
    document.querySelector('meta[name="theme-color"]').content = isDark ? "#1f1d2b" : "#f5f6fa";
    return isDark ? "dark" : "light";
  }

  function saveThemePreference(theme) {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (error) {
      console.error("Gagal menyimpan preferensi tema admin MailMu:", error);
      showNotice("Tema berubah, tetapi preferensinya tidak dapat disimpan di browser ini.", true);
    }
  }

  async function api(url, options = {}) {
    const headers = { accept: "application/json", ...options.headers };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.method && options.method !== "GET") headers["x-csrf-token"] = csrfToken;
    const response = await fetch(url, {
      ...options,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });
    if (response.status === 401) {
      window.location.assign("/auth.html?next=%2Fadmin");
      throw new Error("Sesi Anda berakhir. Silakan masuk kembali.");
    }
    const payload = response.status === 204 ? {} : await response.json();
    if (!response.ok) throw new Error(payload.error || "Permintaan admin gagal.");
    return payload;
  }

  async function loadSummary() {
    const { summary } = await api("/api/admin/summary");
    for (const [key, value] of Object.entries(summary)) {
      const target = document.querySelector(`[data-stat="${key}"]`);
      if (target) target.textContent = Number(value).toLocaleString("id-ID");
    }
  }

  function statusOptions(currentStatus) {
    return Object.entries(labels).map(([value, label]) =>
      `<option value="${value}"${value === currentStatus ? " selected" : ""}>${label}</option>`
    ).join("");
  }

  function renderItems(items) {
    if (items.length === 0) {
      list.innerHTML = '<tr><td colspan="4" class="table-message">Tidak ada kiriman yang cocok dengan filter.</td></tr>';
      return;
    }
    list.innerHTML = items.map((item) => `
      <tr>
        <td>
          <div class="generated-text">${escapeHtml(item.generated_text)}</div>
          <span class="status-pill status-${escapeHtml(item.status)}">${escapeHtml(labels[item.status] || item.status)}</span>
        </td>
        <td><div class="user-details"><strong>${escapeHtml(item.user_name)}</strong><span>${escapeHtml(item.user_email)}</span></div></td>
        <td><time datetime="${escapeHtml(item.created_at)}">${escapeHtml(formatDate(item.created_at))}</time></td>
        <td>
          <form class="review-form" data-review-id="${escapeHtml(item.id)}">
            <label><span class="sr-only">Status kiriman</span><select name="status">${statusOptions(item.status)}</select></label>
            <label><span class="sr-only">Catatan admin</span><textarea name="adminNote" maxlength="1000" placeholder="Catatan untuk riwayat review">${escapeHtml(item.admin_note || "")}</textarea></label>
            <button class="button button-primary" type="submit">Simpan review</button>
          </form>
        </td>
      </tr>
    `).join("");
  }

  async function loadItems() {
    const query = new URLSearchParams({
      page: String(page),
      status: document.getElementById("status-filter").value,
      q: document.getElementById("search-input").value.trim(),
    });
    const result = await api(`/api/admin/generations?${query}`);
    hasNextPage = result.items.length === result.pageSize;
    renderItems(result.items);
    document.getElementById("page-label").textContent = `Halaman ${page}`;
    document.getElementById("previous-page").disabled = page <= 1;
    document.getElementById("next-page").disabled = !hasNextPage;
  }

  function withdrawalMethodLabel(request) {
    if (request.method === "bank") return `Bank ${escapeHtml(request.bank_name)}`;
    return escapeHtml(request.method.toUpperCase());
  }

  function renderWithdrawals(requests) {
    if (!requests.length) {
      withdrawalList.innerHTML = '<tr><td colspan="5" class="table-message">Belum ada pengajuan penarikan.</td></tr>';
      return;
    }
    withdrawalList.innerHTML = requests.map((request) => {
      const currentStatus = request.status;
      const statusLabel = {
        pending: "Menunggu",
        processing: "Sedang diproses",
        paid: "Sudah dicairkan",
        rejected: "Ditolak",
      }[currentStatus] || currentStatus;
      const actions = currentStatus === "pending" || currentStatus === "processing"
        ? `<form class="withdrawal-review-form" data-withdrawal-id="${escapeHtml(request.id)}">
             <label><span class="sr-only">Status penarikan</span><select name="status" required>
               <option value="" selected disabled>Pilih tindakan</option>
               ${currentStatus === "pending" ? '<option value="processing">Mulai proses</option>' : ""}
               <option value="paid">Sudah ditransfer</option>
               <option value="rejected">Tolak pengajuan</option>
             </select></label>
             <label><span class="sr-only">Catatan admin</span><textarea name="adminNote" maxlength="1000" placeholder="${currentStatus === "pending" ? "Catatan (opsional)" : "Catatan penolakan wajib diisi"}">${escapeHtml(request.admin_note || "")}</textarea></label>
             <button class="button button-primary" type="submit">Simpan status</button>
           </form>`
        : `<span class="status-pill status-${escapeHtml(currentStatus)}">${escapeHtml(statusLabel)}</span>
           ${request.admin_note ? `<p class="withdrawal-admin-note">${escapeHtml(request.admin_note)}</p>` : ""}`;
      const destination = request.method === "bank"
        ? `${withdrawalMethodLabel(request)}<br>`
        : `${withdrawalMethodLabel(request)}<br>`;
      return `<tr>
        <td><strong>${formatIdr(request.amount_idr)}</strong><small class="date-detail">Minimum US$2, kurs saat pengajuan: ${Number(request.usd_per_idr).toFixed(8)} USD/IDR</small></td>
        <td><div class="user-details"><strong>${escapeHtml(request.user_name)}</strong><span>${escapeHtml(request.user_email)}</span></div></td>
        <td><div class="user-details"><strong>${escapeHtml(request.recipient_name)}</strong><span>${destination}${escapeHtml(request.destination)}</span></div></td>
        <td><time datetime="${escapeHtml(request.created_at)}">${escapeHtml(formatDate(request.created_at))}</time></td>
        <td>${actions}</td>
      </tr>`;
    }).join("");
  }

  async function loadWithdrawals() {
    const { requests } = await api("/api/admin/withdrawals");
    renderWithdrawals(requests);
  }

  async function refresh() {
    notice.hidden = true;
    try {
      await Promise.all([loadSummary(), loadItems(), loadWithdrawals()]);
    } catch (error) {
      showNotice(error.message || "Data admin tidak dapat dimuat.", true);
      throw error;
    }
  }

  document.getElementById("filter-form").addEventListener("submit", (event) => {
    event.preventDefault();
    page = 1;
    refresh().catch((error) => console.error("Gagal memuat filter admin:", error));
  });
  document.getElementById("refresh-button").addEventListener("click", () => {
    refresh().catch((error) => console.error("Gagal memuat ulang dashboard admin:", error));
  });
  document.getElementById("refresh-withdrawals").addEventListener("click", () => {
    loadWithdrawals().catch((error) => {
      showNotice(error.message || "Pengajuan penarikan tidak dapat dimuat.", true);
      console.error("Gagal memuat ulang pengajuan penarikan:", error);
    });
  });
  document.getElementById("previous-page").addEventListener("click", () => {
    page = Math.max(1, page - 1);
    refresh().catch((error) => console.error("Gagal memuat halaman kiriman:", error));
  });
  document.getElementById("next-page").addEventListener("click", () => {
    if (!hasNextPage) return;
    page += 1;
    refresh().catch((error) => console.error("Gagal memuat halaman kiriman:", error));
  });
  list.addEventListener("submit", async (event) => {
    const form = event.target.closest(".review-form");
    if (!form) return;
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await api(`/api/admin/generations/${encodeURIComponent(form.dataset.reviewId)}`, {
        method: "PUT",
        body: JSON.stringify({
          status: form.elements.status.value,
          adminNote: form.elements.adminNote.value,
        }),
      });
      await refresh();
      showNotice("Review berhasil disimpan dan dicatat.", false);
    } catch (error) {
      showNotice(error.message || "Review tidak dapat disimpan.", true);
      console.error("Gagal menyimpan review admin:", error);
    } finally {
      button.disabled = false;
    }
  });
  withdrawalList.addEventListener("submit", async (event) => {
    const form = event.target.closest(".withdrawal-review-form");
    if (!form) return;
    event.preventDefault();
    const status = form.elements.status.value;
    const adminNote = form.elements.adminNote.value.trim();
    if (status === "rejected" && !adminNote) {
      showNotice("Catatan wajib diisi saat menolak penarikan.", true);
      form.elements.adminNote.focus();
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await api(`/api/admin/withdrawals/${encodeURIComponent(form.dataset.withdrawalId)}`, {
        method: "PUT",
        body: JSON.stringify({ status, adminNote }),
      });
      await refresh();
      showNotice(
        status === "paid"
          ? "Status dicatat sebagai sudah ditransfer."
          : status === "rejected"
            ? "Pengajuan ditolak dan saldo tersedia kembali."
            : "Pengajuan ditandai sedang diproses.",
        false
      );
    } catch (error) {
      showNotice(error.message || "Status penarikan tidak dapat disimpan.", true);
      console.error("Gagal memperbarui penarikan:", error);
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById("logout-button").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
      window.location.assign("/auth.html");
    } catch (error) {
      showNotice(error.message || "Tidak dapat keluar dari akun.", true);
      button.disabled = false;
    }
  });

  let currentTheme = applyTheme(loadThemePreference());
  document.getElementById("admin-theme-toggle").addEventListener("click", () => {
    currentTheme = applyTheme(currentTheme === "dark" ? "light" : "dark");
    saveThemePreference(currentTheme);
  });

  async function initialize() {
    try {
      const session = await api("/api/auth/me");
      csrfToken = session.csrfToken;
      document.getElementById("admin-identity").textContent = session.user.email;
      await refresh();
    } catch (error) {
      showNotice(error.message || "Sesi admin tidak dapat diverifikasi.", true);
      console.error("Gagal menginisialisasi dashboard admin:", error);
    }
  }

  initialize();
})();
