(function () {
  "use strict";

  const STORAGE_KEY = "ruangmail-demo-v1";
  const THEME_STORAGE_KEY = "mailmu-theme";
  const CURRENCY_STORAGE_KEY = "mailmu-balance-currency";
  const REFERRAL_GOAL = 20;
  const REFERRAL_REWARD_IDR = 20_000;
  const STATUS_LABELS = {
    submitted: "Tersimpan",
    pending: "Pending",
    checking: "Sedang dicek",
    accepted: "Disetujui",
    rejected: "Ditolak",
  };
  const PAGE_LABELS = {
    overview: "Ringkasan",
    requests: "Generator teks",
    history: "Riwayat teks",
    withdrawals: "Tarik saldo",
    checker: "Status pengiriman",
    "request-detail": "Detail teks",
    community: "Komunitas",
    referral: "Undang teman",
    leaderboard: "Papan peringkat",
    rules: "Panduan",
    terms: "Privasi & ketentuan",
    support: "Bantuan",
    tickets: "Laporan saya",
    profile: "Akun MailMu",
  };
  const VALID_STATUSES = new Set(Object.keys(STATUS_LABELS));
  const toastRegion = document.getElementById("toast-region");
  const appShell = document.querySelector(".app-shell");
  const sidebar = document.getElementById("main-sidebar");
  const sidebarScrim = document.getElementById("sidebar-scrim");
  const mobileMenuToggle = document.getElementById("mobile-nav-toggle");
  const mobileViewport = window.matchMedia("(max-width: 700px)");
  let state = loadState();
  let generatedItems = [];
  let currentGeneratedText = "";
  let csrfToken = "";
  let authenticatedUser = null;
  let backendReady = Promise.resolve();
  let currentPage = "overview";
  let currentTheme = "light";
  let selectedCurrency = loadCurrencyPreference();
  let accountBalance = null;
  let withdrawalData = null;
  let withdrawalPageLoading = false;
  let referralData = null;
  let referralStatus = "idle";
  let referralError = "";
  let leaderboardEntries = [];
  let leaderboardStatus = "idle";
  let leaderboardLoading = false;
  const pageHistory = ["overview"];
  let storageWarningShown = false;

  function createInitialState() {
    return {
      version: 2,
      balance: 0,
      requests: [],
      tickets: [],
      profileName: "Pengunjung",
      rulesAcknowledged: false,
    };
  }

  function loadState() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return createInitialState();
      const parsed = JSON.parse(raw);
      if (
        !parsed ||
        ![1, 2].includes(parsed.version) ||
        !Number.isSafeInteger(parsed.balance) ||
        !Array.isArray(parsed.requests)
      ) {
        throw new Error("Format data demo tidak sesuai.");
      }
      const requests = parsed.requests.filter(
        (item) =>
          item &&
          typeof item.id === "string" &&
          typeof item.alias === "string" &&
          VALID_STATUSES.has(item.status) &&
          Number.isFinite(item.createdAt)
      );
      return {
        version: 2,
        balance: Math.max(0, parsed.balance),
        requests,
        tickets: Array.isArray(parsed.tickets)
          ? parsed.tickets.filter(
              (item) =>
                item &&
                typeof item.id === "string" &&
                typeof item.subject === "string" &&
                typeof item.message === "string" &&
                Number.isFinite(item.createdAt)
            )
          : [],
        profileName:
          typeof parsed.profileName === "string" && parsed.profileName.trim()
            ? parsed.profileName.trim().slice(0, 40)
            : "Pengunjung",
        rulesAcknowledged: parsed.rulesAcknowledged === true,
      };
    } catch (error) {
      console.error("Gagal membaca data demo MailMu:", error);
      window.setTimeout(
        () => showToast("Data lokal tidak dapat dibaca. Reset data demo untuk memulai lagi.", true),
        0
      );
      return createInitialState();
    }
  }

  function saveState() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      storageWarningShown = false;
      return true;
    } catch (error) {
      console.error("Gagal menyimpan data demo MailMu:", error);
      if (!storageWarningShown) {
        showToast("Perubahan hanya tersimpan sementara di halaman ini; penyimpanan browser gagal.", true);
        storageWarningShown = true;
      }
      return false;
    }
  }

  function loadThemePreference() {
    try {
      const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
      return savedTheme === "dark" ? "dark" : "light";
    } catch (error) {
      console.error("Gagal membaca preferensi tema MailMu:", error);
      window.setTimeout(
        () => showToast("Preferensi tema tidak dapat dibaca; tema terang digunakan.", true),
        0
      );
      return "light";
    }
  }

  function loadCurrencyPreference() {
    try {
      return window.localStorage.getItem(CURRENCY_STORAGE_KEY) === "USD" ? "USD" : "IDR";
    } catch (error) {
      console.error("Gagal membaca preferensi mata uang MailMu:", error);
      return "IDR";
    }
  }

  function saveCurrencyPreference() {
    try {
      window.localStorage.setItem(CURRENCY_STORAGE_KEY, selectedCurrency);
    } catch (error) {
      console.error("Gagal menyimpan preferensi mata uang MailMu:", error);
      showToast("Mata uang berubah, tetapi preferensinya tidak dapat disimpan.", true);
    }
  }

  function renderBalance() {
    const balanceValue = document.getElementById("stat-balance");
    const balanceNote = document.getElementById("balance-note");
    const rateNote = document.getElementById("balance-rate-note");
    const currencySelect = document.getElementById("balance-currency");
    currencySelect.value = selectedCurrency;
    currencySelect.disabled = !authenticatedUser;

    if (!authenticatedUser || !accountBalance) {
      balanceValue.textContent = "—";
      balanceNote.textContent = authenticatedUser
        ? "Saldo belum berhasil dimuat."
        : "Masuk untuk melihat saldo penghasilan Anda.";
      return;
    }

    const fractionDigits = selectedCurrency === "USD" ? 2 : 0;
    balanceValue.textContent = new Intl.NumberFormat(
      selectedCurrency === "USD" ? "en-US" : "id-ID",
      {
        style: "currency",
        currency: selectedCurrency,
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      }
    ).format(accountBalance.amount);
    const approvedLabel = `${accountBalance.approvedCount.toLocaleString("id-ID")} Gmail disetujui`;
    balanceNote.textContent = selectedCurrency === "USD"
      ? `${approvedLabel} · setara Rp${accountBalance.balanceIdr.toLocaleString("id-ID")}.`
      : approvedLabel;
    if (accountBalance.allocatedBalanceIdr > 0) {
      balanceNote.textContent += ` Rp${accountBalance.allocatedBalanceIdr.toLocaleString("id-ID")} sedang ditahan atau sudah dicairkan.`;
    }
    if (selectedCurrency === "USD") {
      const date = new Intl.DateTimeFormat("id-ID", {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(new Date(`${accountBalance.rateDate}T00:00:00Z`));
      const staleMessage = accountBalance.rateIsStale ? " (kurs tersimpan; pembaruan gagal)" : "";
      rateNote.textContent =
        `Kurs referensi harian ECB via Frankfurter: 1 IDR = $${accountBalance.usdPerIdr} · ${date}${staleMessage}`;
    } else {
      rateNote.textContent = "Rp4.000 untuk setiap Gmail yang disetujui admin.";
    }
  }

  function applyTheme(theme) {
    currentTheme = theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = currentTheme;
    const isDark = currentTheme === "dark";
    const toggle = document.getElementById("theme-toggle");
    const nextThemeLabel = isDark ? "terang" : "gelap";
    toggle.setAttribute("aria-checked", String(isDark));
    toggle.setAttribute("aria-label", `Ganti ke tema ${nextThemeLabel}`);
    toggle.title = `Ganti ke tema ${nextThemeLabel}`;
    document.getElementById("theme-toggle-mode").textContent = isDark ? "Gelap" : "Terang";
    document.querySelector('meta[name="theme-color"]').content = isDark ? "#1f1d2b" : "#f5f6fa";
  }

  function saveThemePreference() {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, currentTheme);
    } catch (error) {
      console.error("Gagal menyimpan preferensi tema MailMu:", error);
      showToast("Tema berubah, tetapi preferensinya tidak dapat disimpan di browser.", true);
    }
  }

  function showToast(message, isError) {
    const toast = document.createElement("div");
    toast.className = isError ? "toast is-error" : "toast";
    toast.textContent = message;
    toastRegion.appendChild(toast);
    window.setTimeout(() => toast.remove(), 3800);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => {
      const entities = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      };
      return entities[character];
    });
  }

  function formatDate(timestamp) {
    return new Intl.DateTimeFormat("id-ID", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(timestamp));
  }

  function getPendingCount() {
    return generatedItems.filter((item) => item.status === "submitted" || item.status === "pending").length;
  }

  function statusBadge(status) {
    return `<span class="status-badge status-${status}">${STATUS_LABELS[status]}</span>`;
  }

  function emptyState(title, description, icon) {
    return `<div class="empty-state"><span class="empty-state-icon" aria-hidden="true">${icon}</span><strong>${title}</strong><p>${description}</p></div>`;
  }

  function requestRows(items) {
    if (items.length === 0) {
      return emptyState(
        "Belum ada teks",
        "Buat dan kirim teks acak untuk memulai.",
        "＋"
      );
    }
    const rows = items
      .map((item) => {
        return `<tr>
          <td class="request-id">${escapeHtml(item.id)}</td>
          <td class="alias-cell">${escapeHtml(item.generatedText)}</td>
          <td>${statusBadge(item.status)}</td>
          <td class="date-cell">${formatDate(item.createdAt)}</td>
          <td><button class="action-button" type="button" data-detail="${escapeHtml(item.id)}">Detail</button></td>
        </tr>`;
      })
      .join("");
    return `<div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>ID</th><th>Teks acak</th><th>Status</th><th>Dibuat</th><th>Rincian</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  function render() {
    const requests = [...generatedItems].sort((a, b) => b.createdAt - a.createdAt);
    renderBalance();
    document.getElementById("nav-request-count").textContent = String(requests.length);
    document.getElementById("nav-ticket-count").textContent = String(state.tickets.length);
    document.getElementById("shortcut-ticket-count").textContent = String(state.tickets.length);
    document.getElementById("checker-waiting").textContent = String(getPendingCount());
    document.getElementById("checker-active").textContent = String(
      requests.filter((item) => item.status === "checking").length
    );
    document.getElementById("checker-done").textContent = String(
      requests.filter((item) => item.status === "accepted" || item.status === "rejected").length
    );
    document.getElementById("recent-requests").innerHTML = requestRows(requests.slice(0, 5));
    document.getElementById("request-list").innerHTML = requestRows(requests.slice(0, 10));
    document.getElementById("checker-requests").innerHTML = requestRows(requests);
    const search = document.getElementById("request-search");
    const filter = document.getElementById("request-filter");
    const query = search ? search.value.trim().toLowerCase() : "";
    const selectedStatus = filter ? filter.value : "all";
    const filtered = requests.filter((item) => {
      const matchesQuery = `${item.id} ${item.generatedText}`.toLowerCase().includes(query);
      const matchesStatus = selectedStatus === "all" || item.status === selectedStatus;
      return matchesQuery && matchesStatus;
    });
    document.getElementById("all-requests").innerHTML = requestRows(filtered);
    document.getElementById("ticket-list").innerHTML = ticketRows(state.tickets);
    document.getElementById("leaderboard-table").innerHTML = leaderboardRows();
    renderReferral();
    const accountName = authenticatedUser?.name || "Belum masuk";
    const displayName = authenticatedUser?.name || "Pengunjung";
    document.getElementById("profile-account-name").textContent = accountName;
    document.getElementById("profile-email").textContent = authenticatedUser?.email || "Belum masuk";
    document.getElementById("profile-login-link").hidden = Boolean(authenticatedUser);
    document.getElementById("dashboard-logout").hidden = !authenticatedUser;
    document.getElementById("sidebar-user-name").textContent = displayName;
    document.getElementById("profile-avatar").textContent = displayName.slice(0, 1).toUpperCase();
    document.getElementById("header-avatar").textContent = displayName.slice(0, 1).toUpperCase();
    document.getElementById("header-user-name").textContent = displayName;
    document.getElementById("welcome-name").textContent = displayName.split(/\s+/)[0];
    document.getElementById("rules-acknowledged").checked = state.rulesAcknowledged;
    renderWithdrawalHistory();
  }

  function renderReferral() {
    const linkContent = document.getElementById("referral-link-content");
    const progressContent = document.getElementById("referral-progress-content");
    if (!authenticatedUser) {
      linkContent.innerHTML = '<p>Masuk ke akun untuk melihat tautan undangan Anda.</p><a class="button button-secondary" href="./auth.html?next=%2Findex.html">Masuk ke MailMu</a>';
      progressContent.innerHTML = "<p>Progres undangan tersedia setelah Anda masuk.</p>";
      return;
    }
    if (referralStatus === "loading" || referralStatus === "idle") {
      linkContent.innerHTML = '<p role="status">Memuat tautan undangan…</p>';
      progressContent.innerHTML = '<p role="status">Memuat progres undangan…</p>';
      return;
    }
    if (referralStatus === "error") {
      const message = escapeHtml(referralError || "Data undangan tidak dapat dimuat.");
      const retryButton = '<button class="button button-secondary" type="button" data-referral-retry>Coba lagi</button>';
      linkContent.innerHTML = `<p role="alert">${message}</p>${retryButton}`;
      progressContent.innerHTML = `<p role="alert">${message}</p>${retryButton}`;
      return;
    }
    if (!referralData) return;

    const verified = referralData.verifiedReferrals;
    const goal = referralData.goal;
    const progress = Math.min(verified, goal);
    const percent = Math.min(100, Math.round((progress / goal) * 100));
    const statusMessage = referralData.rewardGranted
      ? "Reward sudah masuk ke saldo akun Anda."
      : `Undang ${goal} teman dengan email terverifikasi untuk mendapatkan reward.`;
    linkContent.innerHTML = `
      <label class="referral-url-label" for="referral-url">Tautan pendaftaran</label>
      <div class="referral-code-box">
        <input id="referral-url" type="url" readonly value="${escapeHtml(referralData.referralUrl)}" aria-label="Tautan undangan Anda" />
        <button class="button button-secondary button-small" id="copy-referral" type="button">Salin tautan</button>
      </div>
      <p>Kode undangan: <code>${escapeHtml(referralData.referralCode)}</code></p>`;
    progressContent.innerHTML = `
      <div class="referral-progress-count"><strong>${verified.toLocaleString("id-ID")}</strong><span>dari ${goal.toLocaleString("id-ID")} undangan terverifikasi</span></div>
      <div class="referral-progress-track" role="progressbar" aria-label="Progres undangan terverifikasi" aria-valuemin="0" aria-valuemax="${goal}" aria-valuenow="${progress}" aria-valuetext="${progress} dari ${goal} undangan">
        <span style="width: ${percent}%"></span>
      </div>
      <p>${referralData.totalReferrals.toLocaleString("id-ID")} pendaftaran melalui tautan, ${verified.toLocaleString("id-ID")} sudah memverifikasi email.</p>
      <div class="referral-divider"></div>
      <div class="referral-stat-row"><span>Reward</span><strong>${formatIdr(referralData.rewardAmountIdr)}</strong></div>
      <div class="referral-stat-row"><span>Status</span><strong>${statusMessage}</strong></div>`;
  }

  async function loadReferralData() {
    referralStatus = "loading";
    referralError = "";
    renderReferral();
    try {
      await backendReady;
      referralData = await apiRequest("/api/referrals");
      referralStatus = "loaded";
    } catch (error) {
      referralData = null;
      referralStatus = "error";
      referralError = error.message || "Data undangan tidak dapat dimuat.";
    }
    renderReferral();
  }

  function formatIdr(amount) {
    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0,
    }).format(Number(amount));
  }

  function withdrawalStatusLabel(status) {
    return {
      pending: "Menunggu admin",
      processing: "Sedang diproses",
      paid: "Sudah dicairkan",
      rejected: "Ditolak",
    }[status] || "Status tidak diketahui";
  }

  function renderWithdrawalHistory() {
    const history = document.getElementById("withdrawal-history");
    if (!withdrawalData) return;
    if (!withdrawalData.requests.length) {
      history.innerHTML = emptyState(
        "Belum ada pengajuan penarikan",
        "Pengajuan yang Anda buat akan muncul di sini.",
        "Rp"
      );
      return;
    }
    history.innerHTML = `<div class="data-table-wrap"><table class="data-table withdrawal-table">
      <thead><tr><th>Jumlah</th><th>Metode</th><th>Status</th><th>Diajukan</th><th>Catatan admin</th></tr></thead>
      <tbody>${withdrawalData.requests.map((item) => {
        const method = item.method === "bank"
          ? `Bank ${escapeHtml(item.bank_name)}`
          : escapeHtml(item.method.toUpperCase());
        const note = item.admin_note ? escapeHtml(item.admin_note) : "Belum ada catatan";
        return `<tr>
          <td>${formatIdr(item.amount_idr)}</td>
          <td>${method}<br><span class="withdrawal-recipient">${escapeHtml(item.recipient_name)} · ${escapeHtml(item.destination)}</span></td>
          <td><span class="withdrawal-status withdrawal-status-${escapeHtml(item.status)}">${withdrawalStatusLabel(item.status)}</span></td>
          <td>${formatDate(new Date(item.created_at).getTime())}</td>
          <td>${note}</td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>`;
  }

  async function loadWithdrawalData() {
    const summary = document.getElementById("withdrawal-summary");
    const message = document.getElementById("withdrawal-form-message");
    const submit = document.getElementById("withdrawal-submit");
    withdrawalPageLoading = true;
    submit.disabled = true;
    summary.innerHTML = '<p role="status">Memuat saldo dan batas minimum penarikan…</p>';
    message.textContent = "";
    try {
      await backendReady;
      const result = await apiRequest("/api/withdrawals");
      withdrawalData = result;
      summary.innerHTML = `<div><span>Saldo tersedia</span><strong>${formatIdr(result.availableBalanceIdr)}</strong></div>
        <div><span>Minimum penarikan</span><strong>${formatIdr(result.minimumAmountIdr)}</strong><small>Setara US$${result.minimumUsd}, mengikuti kurs saat pengajuan.</small></div>
        <p>Pengajuan menahan jumlah saldo tersebut sampai admin menyelesaikan atau menolaknya.</p>`;
      const amount = document.getElementById("withdrawal-amount");
      amount.min = String(result.minimumAmountIdr);
      amount.max = String(result.availableBalanceIdr);
      document.getElementById("withdrawal-history").removeAttribute("aria-busy");
      renderWithdrawalHistory();
      submit.disabled = !authenticatedUser || result.availableBalanceIdr < result.minimumAmountIdr;
      if (result.availableBalanceIdr < result.minimumAmountIdr) {
        message.textContent = "Saldo tersedia belum mencapai minimum penarikan.";
      }
    } catch (error) {
      summary.innerHTML = `<p role="alert">${escapeHtml(error.message || "Saldo penarikan tidak dapat dimuat.")}</p>`;
      document.getElementById("withdrawal-history").innerHTML =
        `<p class="table-message" role="alert">${escapeHtml(error.message || "Riwayat penarikan tidak dapat dimuat.")}</p>`;
      withdrawalData = null;
    } finally {
      withdrawalPageLoading = false;
    }
  }

  function navigate(page, addToHistory = true) {
    if (!PAGE_LABELS[page]) {
      showToast("Halaman yang diminta tidak tersedia.", true);
      return;
    }
    if (page !== currentPage && addToHistory) pageHistory.push(page);
    currentPage = page;
    document.getElementById("app-back-button").hidden = pageHistory.length < 2;
    document.querySelectorAll(".page-section").forEach((section) => {
      section.classList.toggle("is-visible", section.id === `page-${page}`);
    });
    document.querySelectorAll(".nav-item").forEach((item) => {
      const active = item.dataset.page === page;
      item.classList.toggle("is-active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
    document.querySelectorAll(".bottom-navigation [data-page]").forEach((item) => {
      const active = item.dataset.page === page;
      item.classList.toggle("is-active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
    const hasBottomNavigationPage = Array.from(
      document.querySelectorAll(".bottom-navigation [data-page]")
    ).some((item) => item.dataset.page === page);
    mobileMenuToggle.classList.toggle("is-page-active", !hasBottomNavigationPage);
    if (hasBottomNavigationPage) mobileMenuToggle.removeAttribute("aria-current");
    else mobileMenuToggle.setAttribute("aria-current", "page");
    mobileMenuToggle.setAttribute(
      "aria-label",
      hasBottomNavigationPage
        ? "Buka menu lainnya"
        : `Buka menu lainnya. Halaman saat ini: ${PAGE_LABELS[page]}`
    );
    mobileMenuToggle.title = hasBottomNavigationPage
      ? "Buka menu lainnya"
      : `Halaman saat ini: ${PAGE_LABELS[page]}`;
    const pageTitle = document.getElementById("breadcrumb-current");
    if (pageTitle) pageTitle.textContent = PAGE_LABELS[page];
    window.scrollTo({ top: 0, behavior: "smooth" });
    render();
    if (page === "leaderboard") loadLeaderboard();
    if (page === "withdrawals") loadWithdrawalData();
    if (page === "referral") loadReferralData();
  }

  function navigateBack() {
    if (pageHistory.length < 2) return;
    pageHistory.pop();
    navigate(pageHistory[pageHistory.length - 1], false);
  }

  function closeSidebarMenu(returnFocus = false) {
    appShell.classList.remove("is-sidebar-open");
    document.body.classList.remove("navigation-open");
    sidebarScrim.hidden = true;
    mobileMenuToggle.setAttribute("aria-expanded", "false");
    sidebar.inert = mobileViewport.matches;
    sidebar.removeAttribute("role");
    sidebar.removeAttribute("aria-modal");
    if (returnFocus) mobileMenuToggle.focus();
  }

  function openSidebarMenu() {
    if (!mobileViewport.matches) return;
    sidebar.inert = false;
    sidebar.setAttribute("role", "dialog");
    sidebar.setAttribute("aria-modal", "true");
    appShell.classList.add("is-sidebar-open");
    document.body.classList.add("navigation-open");
    sidebarScrim.hidden = false;
    mobileMenuToggle.setAttribute("aria-expanded", "true");
    document.getElementById("sidebar-close").focus();
  }

  function ticketRows(tickets) {
    if (!tickets.length) {
      return emptyState("Belum ada laporan", "Laporan demo yang dibuat akan tampil di sini.", "✉");
    }
    const rows = [...tickets]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(
        (ticket) => `<tr>
          <td class="request-id">${escapeHtml(ticket.id)}</td>
          <td class="alias-cell">${escapeHtml(ticket.subject)}</td>
          <td>${escapeHtml(ticket.message)}</td>
          <td>${statusBadge("pending")}</td>
          <td class="date-cell">${formatDate(ticket.createdAt)}</td>
        </tr>`
      )
      .join("");
    return `<div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>ID</th><th>Topik</th><th>Pesan lokal</th><th>Status</th><th>Dibuat</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  function leaderboardRows() {
    if (leaderboardStatus === "loading") {
      return emptyState("Memuat peringkat", "Mengambil data pengguna dan saldo terbaru.", "…");
    }
    if (leaderboardStatus === "error") {
      return emptyState("Peringkat tidak tersedia", "Coba buka kembali halaman peringkat sebentar lagi.", "!");
    }
    if (leaderboardStatus === "empty" || (leaderboardStatus === "idle" && !leaderboardEntries.length)) {
      return emptyState("Belum ada Gmail disetujui", "Peringkat akan muncul setelah admin menyetujui teks pengguna.", "↗");
    }

    const rows = leaderboardEntries.map((user, index) => {
      const currentUserLabel = user.isCurrentUser ? ' <span class="leaderboard-you">(Anda)</span>' : "";
      const rowClass = user.isCurrentUser ? ' class="leaderboard-current-user"' : "";
      return `<tr${rowClass}>
        <td class="request-id">${index + 1}</td>
        <td class="alias-cell">${escapeHtml(user.name)}${currentUserLabel}</td>
        <td>${user.approvedCount.toLocaleString("id-ID")}</td>
        <td>${user.balanceIdr.toLocaleString("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 })}</td>
      </tr>`;
    }).join("");
    return `<div class="data-table-wrap"><table class="data-table">
      <thead><tr><th>Posisi</th><th>Pengguna</th><th>Teks disetujui</th><th>Saldo</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }

  async function loadLeaderboard() {
    if (leaderboardLoading) return;
    leaderboardLoading = true;
    leaderboardStatus = "loading";
    render();
    try {
      await backendReady;
      if (!authenticatedUser) {
        redirectToLogin();
        return;
      }
      const result = await apiRequest("/api/leaderboard");
      leaderboardEntries = result.entries;
      leaderboardStatus = leaderboardEntries.length ? "loaded" : "empty";
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        redirectToLogin();
        return;
      }
      console.error("Gagal memuat papan peringkat:", error);
      leaderboardStatus = "error";
      showToast(error.message || "Papan peringkat tidak dapat dimuat.", true);
    } finally {
      leaderboardLoading = false;
      if (currentPage === "leaderboard") render();
    }
  }

  function openRequestDetail(id) {
    const request = generatedItems.find((item) => item.id === id);
    if (!request) {
      showToast("Detail permintaan tidak ditemukan.", true);
      return;
    }
    const statuses = ["submitted", "pending", "checking", request.status === "rejected" ? "rejected" : "accepted"];
    const lastIndex = statuses.indexOf(request.status);
    const timeline = statuses
      .map((status, index) => {
        const label = STATUS_LABELS[status];
        const reached = index <= lastIndex;
        const current = status === request.status;
        return `<li class="${reached ? "detail-step-done" : ""} ${current ? "detail-step-current" : ""}"><span>${reached ? "✓" : index + 1}</span><div><strong>${label}</strong><small>${current ? formatDate(request.updatedAt || request.createdAt) : reached ? "Tahap selesai" : "Menunggu tahap sebelumnya"}</small></div></li>`;
      })
      .join("");
    document.getElementById("detail-dialog-content").innerHTML = `
    <div class="detail-alias"><span>TEKS ACAK</span><strong>${escapeHtml(request.generatedText)}</strong><small>${escapeHtml(request.id)} · dibuat ${formatDate(request.createdAt)}</small></div>
      <div class="detail-current-status"><span>Status saat ini</span>${statusBadge(request.status)}</div>
      <ol class="detail-timeline">${timeline}</ol>
      <p class="detail-disclaimer">Teks ini tersimpan pada server dan terkait dengan akun MailMu Anda. Teks bukan alamat email atau akun.</p>`;
    const dialog = document.getElementById("request-detail-dialog");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else showToast(`Status teks ${request.id}: ${STATUS_LABELS[request.status]}.`);
  }

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  async function apiRequest(path, { method = "GET", body } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET") {
      if (!csrfToken) {
        const csrf = await apiRequest("/api/auth/csrf");
        csrfToken = csrf.csrfToken;
      }
      headers["X-CSRF-Token"] = csrfToken;
    }

    let response;
    try {
      response = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch {
      throw new Error("Server MailMu tidak dapat dijangkau. Periksa koneksi dan konfigurasi backend.");
    }

    let payload;
    try {
      payload = response.status === 204 ? {} : await response.json();
    } catch {
      throw new Error("Server mengirim respons yang tidak dapat dibaca.");
    }
    if (!response.ok) throw new ApiError(payload.error || "Permintaan tidak dapat diproses.", response.status);
    return payload;
  }

  function redirectToLogin() {
    window.location.assign(`./auth.html?next=${encodeURIComponent("/index.html")}`);
  }

  function mapGeneratedItem(item) {
    return {
      id: item.id,
      generatedText: item.generated_text,
      status: item.status,
      createdAt: new Date(item.created_at).getTime(),
    };
  }

  async function loadAccountBalance(currency = selectedCurrency) {
    const result = await apiRequest(`/api/balance?currency=${encodeURIComponent(currency)}`);
    selectedCurrency = currency;
    accountBalance = result;
    saveCurrencyPreference();
    renderBalance();
  }

  async function initializeBackend() {
    try {
      const csrf = await apiRequest("/api/auth/csrf");
      csrfToken = csrf.csrfToken;
      const session = await apiRequest("/api/auth/me");
      authenticatedUser = session.user;
      csrfToken = session.csrfToken;
      state.profileName = session.user.name;
      const result = await apiRequest("/api/generations");
      generatedItems = result.items.map(mapGeneratedItem);
      render();
      try {
        await loadAccountBalance();
      } catch (error) {
        if (selectedCurrency === "USD") {
          showToast(`${error.message} Saldo ditampilkan dalam Rupiah.`, true);
          selectedCurrency = "IDR";
          accountBalance = await apiRequest("/api/balance?currency=IDR");
          saveCurrencyPreference();
          renderBalance();
          return;
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        authenticatedUser = null;
        generatedItems = [];
        render();
        return;
      }
      showToast(error.message || "Data generator tidak dapat dimuat dari server.", true);
    }
  }

  function updateSubmitButton() {
    document.getElementById("request-submit").disabled =
      !currentGeneratedText || !document.getElementById("confirm-generated-text").checked;
    const copyButton = document.getElementById("copy-generated-text");
    copyButton.disabled = !currentGeneratedText;
    copyButton.title = currentGeneratedText ? "Salin teks acak" : "Buat teks terlebih dahulu";
  }

  async function copyGeneratedText() {
    if (!currentGeneratedText) {
      showToast("Buat teks acak terlebih dahulu.", true);
      return;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(currentGeneratedText);
      } else {
        const temporaryInput = document.createElement("textarea");
        temporaryInput.value = currentGeneratedText;
        temporaryInput.setAttribute("readonly", "");
        temporaryInput.style.position = "fixed";
        temporaryInput.style.opacity = "0";
        document.body.append(temporaryInput);
        let copied = false;
        try {
          temporaryInput.select();
          copied = document.execCommand("copy");
        } finally {
          temporaryInput.remove();
        }
        if (!copied) throw new Error("Browser menolak akses ke clipboard.");
      }
      showToast("Teks acak berhasil disalin.");
    } catch (error) {
      console.error("Gagal menyalin teks acak:", error);
      showToast("Teks tidak dapat disalin. Periksa izin clipboard browser Anda.", true);
    }
  }

  async function generateText() {
    const generateButton = document.getElementById("requests-new");
    generateButton.disabled = true;
    currentGeneratedText = "";
    document.getElementById("generated-text-preview").textContent = "Membuat teks...";
    document.getElementById("confirm-generated-text").checked = false;
    updateSubmitButton();
    try {
      await backendReady;
      if (!authenticatedUser) {
        redirectToLogin();
        return;
      }
      const result = await apiRequest("/api/generations/preview", {
        method: "POST",
        body: {},
      });
      currentGeneratedText = result.generatedText;
      document.getElementById("generated-text-preview").textContent = currentGeneratedText;
      document.getElementById("confirm-generated-text").checked = false;
      updateSubmitButton();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        redirectToLogin();
        return;
      }
      showToast(error.message || "Teks acak tidak dapat dibuat.", true);
    } finally {
      generateButton.disabled = false;
    }
  }

  async function submitGeneratedText() {
    const submitButton = document.getElementById("request-submit");
    if (!currentGeneratedText || !document.getElementById("confirm-generated-text").checked) {
      showToast("Buat teks acak dan konfirmasi sebelum mengirim.", true);
      return;
    }

    submitButton.disabled = true;
    try {
      await backendReady;
      if (!authenticatedUser) {
        redirectToLogin();
        return;
      }
      const result = await apiRequest("/api/generations", {
        method: "POST",
        body: { generatedText: currentGeneratedText },
      });
      generatedItems.unshift(mapGeneratedItem(result.item));
      currentGeneratedText = "";
      document.getElementById("generated-text-preview").textContent = "Klik acak teks";
      document.getElementById("confirm-generated-text").checked = false;
      updateSubmitButton();
      render();
      showToast("Teks berhasil disimpan ke akun Anda.");
      navigate("history");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        redirectToLogin();
        return;
      }
      showToast(error.message || "Teks tidak dapat disimpan.", true);
    } finally {
      updateSubmitButton();
    }
  }

  function resetDemo() {
    const confirmed = window.confirm("Hapus data demo lokal, laporan, profil, dan kode undangan dari browser ini? Data teks yang tersimpan di akun server tidak terhapus.");
    if (!confirmed) return;
    state = createInitialState();
    saveState();
    currentGeneratedText = "";
    document.getElementById("generated-text-preview").textContent = "Klik acak teks";
    document.getElementById("confirm-generated-text").checked = false;
    updateSubmitButton();
    render();
    showToast("Data demo lokal berhasil direset. Teks akun di server tidak dihapus.");
  }

  document.querySelectorAll("[data-go]").forEach((button) => {
    button.addEventListener("click", () => {
      navigate(button.dataset.go);
      if (appShell.classList.contains("is-sidebar-open")) closeSidebarMenu(true);
    });
  });
  document.getElementById("app-back-button").addEventListener("click", navigateBack);
  const sidebarCollapseToggle = document.getElementById("sidebar-collapse-toggle");
  sidebarCollapseToggle.addEventListener("click", () => {
    const collapsed = appShell.classList.toggle("is-sidebar-collapsed");
    sidebarCollapseToggle.setAttribute("aria-expanded", String(!collapsed));
    sidebarCollapseToggle.setAttribute(
      "aria-label",
      collapsed ? "Bentangkan sidebar" : "Lipat sidebar"
    );
    sidebarCollapseToggle.title = collapsed ? "Bentangkan sidebar" : "Lipat sidebar";
  });
  document.getElementById("sidebar-close").addEventListener("click", () => {
    closeSidebarMenu(true);
  });
  sidebarScrim.addEventListener("click", () => closeSidebarMenu(true));
  mobileMenuToggle.addEventListener("click", () => {
    if (appShell.classList.contains("is-sidebar-open")) closeSidebarMenu(true);
    else openSidebarMenu();
  });
  sidebar.inert = mobileViewport.matches;
  mobileViewport.addEventListener("change", ({ matches }) => {
    if (matches) {
      appShell.classList.remove("is-sidebar-collapsed");
      sidebarCollapseToggle.setAttribute("aria-expanded", "true");
      sidebarCollapseToggle.setAttribute("aria-label", "Lipat sidebar");
      sidebarCollapseToggle.title = "Lipat sidebar";
      sidebar.inert = !appShell.classList.contains("is-sidebar-open");
    } else {
      closeSidebarMenu(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (!appShell.classList.contains("is-sidebar-open")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeSidebarMenu(true);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      sidebar.querySelectorAll('a[href], button:not(:disabled)')
    ).filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  currentTheme = loadThemePreference();
  applyTheme(currentTheme);
  document.getElementById("theme-toggle").addEventListener("click", () => {
    applyTheme(currentTheme === "dark" ? "light" : "dark");
    saveThemePreference();
  });
  document.addEventListener("click", (event) => {
    const pageButton = event.target.closest("[data-page]");
    if (pageButton && PAGE_LABELS[pageButton.dataset.page]) {
      navigate(pageButton.dataset.page);
      if (appShell.classList.contains("is-sidebar-open")) closeSidebarMenu(true);
    }
  });
  document.getElementById("requests-new").addEventListener("click", generateText);
  document.getElementById("copy-generated-text").addEventListener("click", copyGeneratedText);
  document.getElementById("confirm-generated-text").addEventListener("change", updateSubmitButton);
  document.getElementById("request-submit").addEventListener("click", submitGeneratedText);
  document.getElementById("withdrawal-method").addEventListener("change", (event) => {
    const isBank = event.currentTarget.value === "bank";
    document.getElementById("withdrawal-bank-field").hidden = !isBank;
    document.getElementById("withdrawal-bank").required = isBank;
  });
  document.getElementById("withdrawal-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!withdrawalData || withdrawalPageLoading || !authenticatedUser) return;
    const form = event.currentTarget;
    const submit = document.getElementById("withdrawal-submit");
    const message = document.getElementById("withdrawal-form-message");
    const amountIdr = Number(form.elements.amountIdr.value);
    if (!Number.isSafeInteger(amountIdr) || amountIdr < withdrawalData.minimumAmountIdr) {
      message.textContent = `Minimum penarikan adalah ${formatIdr(withdrawalData.minimumAmountIdr)}.`;
      return;
    }
    if (amountIdr > withdrawalData.availableBalanceIdr) {
      message.textContent = `Saldo tersedia hanya ${formatIdr(withdrawalData.availableBalanceIdr)}.`;
      return;
    }
    submit.disabled = true;
    message.textContent = "Mengirim pengajuan…";
    try {
      await apiRequest("/api/withdrawals", {
        method: "POST",
        body: {
          amountIdr,
          method: form.elements.method.value,
          bankName: form.elements.bankName.value,
          recipientName: form.elements.recipientName.value,
          destination: form.elements.destination.value,
        },
      });
      form.reset();
      document.getElementById("withdrawal-bank-field").hidden = false;
      document.getElementById("withdrawal-bank").required = true;
      message.textContent = "Pengajuan terkirim. Admin akan memproses pencairan dalam 1 x 24 jam.";
      await loadAccountBalance("IDR");
      await loadWithdrawalData();
    } catch (error) {
      message.textContent = error.message || "Pengajuan penarikan tidak dapat dikirim.";
      submit.disabled = false;
    }
  });
  document.getElementById("balance-currency").addEventListener("change", async (event) => {
    const requestedCurrency = event.currentTarget.value;
    event.currentTarget.disabled = true;
    try {
      await loadAccountBalance(requestedCurrency);
    } catch (error) {
      event.currentTarget.value = selectedCurrency;
      showToast(error.message || "Saldo dalam mata uang tersebut tidak dapat dimuat.", true);
    } finally {
      event.currentTarget.disabled = !authenticatedUser;
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && authenticatedUser) {
      loadAccountBalance().catch((error) => {
        showToast(error.message || "Saldo akun tidak dapat diperbarui.", true);
      });
    }
  });
  document.getElementById("reset-demo").addEventListener("click", resetDemo);
  document.getElementById("request-search").addEventListener("input", render);
  document.getElementById("request-filter").addEventListener("change", render);
  document.getElementById("rules-acknowledged").addEventListener("change", (event) => {
    state.rulesAcknowledged = event.currentTarget.checked;
    saveState();
    showToast("Preferensi panduan demo disimpan di browser.");
  });
  document.addEventListener("click", async (event) => {
    if (event.target.closest("[data-referral-retry]")) {
      loadReferralData();
      return;
    }
    if (!event.target.closest("#copy-referral")) return;
    try {
      await navigator.clipboard.writeText(referralData.referralUrl);
      showToast("Tautan undangan disalin.");
    } catch (error) {
      console.error("Gagal menyalin tautan undangan:", error);
      showToast("Clipboard tidak tersedia. Salin tautan secara manual.", true);
    }
  });
  document.getElementById("support-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const subject = document.getElementById("ticket-subject").value;
    const message = document.getElementById("ticket-message").value.trim();
    if (!subject || !message) {
      showToast("Pilih topik dan isi pesan terlebih dahulu.", true);
      return;
    }
    state.tickets.push({
      id: `HD-${Date.now().toString(36).toUpperCase()}`,
      subject,
      message: message.slice(0, 500),
      createdAt: Date.now(),
    });
    saveState();
    event.currentTarget.reset();
    render();
    navigate("tickets");
    showToast("Laporan demo disimpan lokal; belum dikirim ke admin.");
  });
  document.getElementById("dashboard-logout").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await apiRequest("/api/auth/logout", { method: "POST", body: {} });
      authenticatedUser = null;
      generatedItems = [];
      leaderboardEntries = [];
      leaderboardStatus = "idle";
      csrfToken = "";
      render();
      showToast("Anda telah keluar dari akun MailMu.");
    } catch (error) {
      showToast(error.message || "Anda belum dapat keluar. Coba lagi.", true);
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById("close-detail-dialog").addEventListener("click", () => {
    document.getElementById("request-detail-dialog").close();
  });
  document.querySelector(".banner-dismiss").addEventListener("click", (event) => {
    event.currentTarget.closest(".demo-banner").remove();
  });
  document.addEventListener("click", (event) => {
    const detail = event.target.closest("[data-detail]");
    if (detail) openRequestDetail(detail.dataset.detail);
  });

  const date = new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  document.getElementById("today-label").textContent = date.format(new Date()).toUpperCase();
  document.getElementById("footer-year").textContent = new Date().getFullYear();
  render();
  backendReady = initializeBackend();
})();
