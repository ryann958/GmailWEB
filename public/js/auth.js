(function () {
  "use strict";

  const THEME_STORAGE_KEY = "mailmu-theme";
  const referralCode = new URLSearchParams(window.location.search)
    .get("ref")
    ?.toUpperCase();
  const validReferralCode = referralCode && /^[A-F0-9]{12}$/.test(referralCode)
    ? referralCode
    : "";
  const feedback = document.getElementById("auth-feedback");
  const logoutButton = document.getElementById("auth-logout");
  const modeCopy = {
    login: {
      eyebrow: "SELAMAT DATANG KEMBALI",
      title: "Masuk ke MailMu",
      description: "Masukkan detail akun Anda untuk melanjutkan.",
      pageTitle: "Masuk — MailMu",
    },
    register: {
      eyebrow: "MULAI DENGAN MAILMU",
      title: "Buat akun baru",
      description: "Isi detail dasar. Email harus diverifikasi sebelum akun dapat digunakan.",
      pageTitle: "Buat akun — MailMu",
    },
    verify: {
      eyebrow: "VERIFIKASI EMAIL",
      title: "Periksa kotak masuk Anda",
      description: "Verifikasi alamat email untuk mengaktifkan akun MailMu.",
      pageTitle: "Verifikasi email — MailMu",
    },
    forgot: {
      eyebrow: "PEMULIHAN AKUN",
      title: "Lupa kata sandi?",
      description: "Masukkan email akun untuk memulai pemulihan.",
      pageTitle: "Pemulihan akun — MailMu",
    },
    reset: {
      eyebrow: "PEMULIHAN AKUN",
      title: "Atur kata sandi baru",
      description: "Buat kata sandi baru untuk akun MailMu Anda.",
      pageTitle: "Atur ulang kata sandi — MailMu",
    },
  };
  let currentView = "login";
  let currentTheme = "light";
  let csrfToken = "";
  let resetToken = "";
  let pendingVerificationEmail = "";
  let submitting = false;

  class ApiError extends Error {
    constructor(message, status, code, verificationPending) {
      super(message);
      this.status = status;
      this.code = code;
      this.verificationPending = verificationPending;
    }
  }

  function showFeedback(message, isWarning) {
    feedback.textContent = message;
    feedback.classList.toggle("is-warning", Boolean(isWarning));
  }

  function clearFields(fields) {
    fields.querySelectorAll("input").forEach((input) => {
      input.value = "";
      if (input.type === "text" && input.id.endsWith("-password")) {
        input.type = "password";
        const toggle = fields.querySelector(`[data-password-toggle="${input.id}"]`);
        if (toggle) {
          toggle.setAttribute("aria-label", "Tampilkan kata sandi");
          toggle.title = "Tampilkan kata sandi";
        }
      }
    });
  }

  function setView(view) {
    if (!Object.hasOwn(modeCopy, view)) return;
    currentView = view;
    document.title = modeCopy[view].pageTitle;
    document.getElementById("auth-mode-eyebrow").textContent = modeCopy[view].eyebrow;
    document.getElementById("auth-title").textContent = modeCopy[view].title;
    document.getElementById("auth-description").textContent = modeCopy[view].description;

    document.querySelectorAll(".auth-tab").forEach((button) => {
      const active = button.dataset.authView === view;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    document.querySelector(".auth-tabs").hidden = !["login", "register"].includes(view);

    document.querySelectorAll(".auth-panel").forEach((panel) => {
      const active = panel.id === `auth-panel-${view}`;
      if (!active) clearFields(panel);
      panel.hidden = !active;
    });
    if (view === "verify") {
      document.getElementById("verification-email").textContent = pendingVerificationEmail;
    }
  }

  async function loadCsrfToken() {
    let response;
    try {
      response = await fetch("/api/auth/csrf", {
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch {
      throw new Error("Server MailMu tidak dapat dijangkau. Periksa koneksi dan konfigurasi backend.");
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Server mengirim respons yang tidak dapat dibaca. Periksa konfigurasi backend.");
    }
    if (!response.ok || typeof payload.csrfToken !== "string") {
      throw new ApiError(payload.error || "Server tidak dapat menyiapkan sesi aman.", response.status);
    }
    csrfToken = payload.csrfToken;
  }

  async function requestApi(path, { method = "GET", body } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET") {
      if (!csrfToken) await loadCsrfToken();
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

    let payload = {};
    try {
      payload = response.status === 204 ? {} : await response.json();
    } catch {
      throw new Error("Server mengirim respons yang tidak dapat dibaca. Periksa konfigurasi backend.");
    }
    if (!response.ok) {
      throw new ApiError(
        payload.error || "Permintaan tidak dapat diproses.",
        response.status,
        payload.code,
        payload.verificationPending === true
      );
    }
    return payload;
  }

  function showSession(user) {
    logoutButton.hidden = !user;
    if (user) {
      showFeedback(
        `Anda masuk sebagai ${user.email}. Hasil generator tersimpan pada akun Anda.`,
        false
      );
    }
  }

  function continueToWorkspace() {
    const next = new URLSearchParams(window.location.search).get("next");
    if (next === "/index.html" || next === "/admin") window.location.assign(next);
  }

  async function initializeSession() {
    try {
      await loadCsrfToken();
      const result = await requestApi("/api/auth/me");
      csrfToken = result.csrfToken;
      showSession(result.user);
      continueToWorkspace();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        showFeedback("Siap. Masuk atau buat akun MailMu untuk melanjutkan.", false);
        return;
      }
      showFeedback(error.message || "Sesi akun tidak dapat dimuat.", true);
    }
  }

  function applyTheme(theme) {
    currentTheme = theme === "dark" ? "dark" : "light";
    const isDark = currentTheme === "dark";
    const toggle = document.getElementById("auth-theme-toggle");
    const nextThemeLabel = isDark ? "terang" : "gelap";

    document.documentElement.dataset.theme = currentTheme;
    toggle.setAttribute("aria-checked", String(isDark));
    toggle.setAttribute("aria-label", `Ganti ke tema ${nextThemeLabel}`);
    toggle.title = `Ganti ke tema ${nextThemeLabel}`;
    document.getElementById("auth-theme-mode").textContent = isDark ? "Gelap" : "Terang";
    document.querySelector('meta[name="theme-color"]').content = isDark ? "#1f1d2b" : "#f5f6fa";
  }

  function loadTheme() {
    try {
      return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
    } catch (error) {
      console.error("Gagal membaca preferensi tema MailMu:", error);
      showFeedback("Preferensi tema tidak dapat dibaca; tema terang digunakan.", true);
      return "light";
    }
  }

  function saveTheme() {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, currentTheme);
    } catch (error) {
      console.error("Gagal menyimpan preferensi tema MailMu:", error);
      showFeedback("Tema berubah, tetapi preferensinya tidak dapat disimpan di browser.", true);
    }
  }

  async function handleSubmit(button) {
    if (submitting) return;
    const view = button.dataset.authSubmit;
    const fields = document.getElementById(`auth-fields-${view}`);
    const invalidField = [...fields.querySelectorAll("input")].find((input) => !input.checkValidity());
    if (invalidField) {
      invalidField.reportValidity();
      invalidField.focus();
      return;
    }

    const read = (id) => document.getElementById(id).value;
    const email = view === "login"
      ? read("login-email")
      : view === "verify"
        ? pendingVerificationEmail
        : read(`${view}-email`);
    let path;
    let body;
    if (view === "login") {
      path = "/api/auth/login";
      body = { email, password: read("login-password") };
    } else if (view === "register") {
      path = "/api/auth/register";
      body = { email, name: read("register-name"), password: read("register-password") };
      if (validReferralCode) body.referralCode = validReferralCode;
    } else if (view === "verify") {
      if (!email) {
        showFeedback("Email pendaftaran tidak ditemukan. Silakan mulai pendaftaran kembali.", true);
        setView("register");
        return;
      }
      path = "/api/auth/email-verification/verify";
      body = { email, code: read("verification-code") };
    } else if (view === "forgot") {
      path = "/api/auth/forgot-password";
      body = { email };
    } else {
      if (!resetToken) {
        showFeedback("Tautan pemulihan tidak ditemukan. Minta tautan baru untuk melanjutkan.", true);
        return;
      }
      if (read("reset-password") !== read("reset-password-confirm")) {
        showFeedback("Konfirmasi kata sandi tidak cocok.", true);
        document.getElementById("reset-password-confirm").focus();
        return;
      }
      path = "/api/auth/reset-password";
      body = { token: resetToken, password: read("reset-password") };
    }

    submitting = true;
    button.disabled = true;
    try {
      const result = await requestApi(path, { method: "POST", body });
      if (result.csrfToken) csrfToken = result.csrfToken;
      if (view === "login" || view === "verify") {
        showSession(result.user);
        continueToWorkspace();
      } else if (view === "register") {
        pendingVerificationEmail = result.email || email;
        setView("verify");
        showFeedback(result.message || "Kode verifikasi telah dikirim ke email Anda.", false);
      } else if (view === "forgot") {
        showFeedback(result.message, false);
      } else {
        resetToken = "";
        window.history.replaceState(null, "", window.location.pathname);
        setView("login");
        showFeedback(result.message, false);
      }
    } catch (error) {
      if (
        error instanceof ApiError &&
        ((view === "login" && error.code === "email_not_verified") ||
          error.verificationPending)
      ) {
        pendingVerificationEmail = email;
        setView("verify");
        showFeedback(error.message, true);
      } else {
        showFeedback(error.message || "Permintaan tidak dapat diproses.", true);
      }
    } finally {
      clearFields(fields);
      submitting = false;
      button.disabled = false;
    }
  }

  document.querySelectorAll("[data-auth-view]").forEach((button) => {
    button.addEventListener("click", () => {
      const view = button.dataset.authView;
      if (modeCopy[view]) {
        setView(view);
        showFeedback("Siap. Masukkan detail akun Anda.", false);
      }
    });
  });

  document.querySelectorAll("[data-auth-submit]").forEach((button) => {
    button.addEventListener("click", () => handleSubmit(button));
  });

  document.getElementById("resend-verification-code").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (submitting || !pendingVerificationEmail) return;
    submitting = true;
    button.disabled = true;
    try {
      const result = await requestApi("/api/auth/email-verification/resend", {
        method: "POST",
        body: { email: pendingVerificationEmail },
      });
      showFeedback(result.message, false);
    } catch (error) {
      showFeedback(error.message || "Kode verifikasi tidak dapat dikirim ulang.", true);
    } finally {
      submitting = false;
      button.disabled = false;
    }
  });

  document.querySelectorAll(".auth-fields input").forEach((input) => {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        document.querySelector(`[data-auth-submit="${currentView}"]`).click();
      }
    });
  });

  document.querySelectorAll("[data-password-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.passwordToggle);
      const shouldShow = input.type === "password";
      input.type = shouldShow ? "text" : "password";
      button.setAttribute("aria-label", shouldShow ? "Sembunyikan kata sandi" : "Tampilkan kata sandi");
      button.title = shouldShow ? "Sembunyikan kata sandi" : "Tampilkan kata sandi";
    });
  });

  logoutButton.addEventListener("click", async () => {
    logoutButton.disabled = true;
    try {
      await requestApi("/api/auth/logout", { method: "POST", body: {} });
      logoutButton.hidden = true;
      csrfToken = "";
      showFeedback("Anda telah keluar dari akun MailMu.", false);
      await loadCsrfToken();
    } catch (error) {
      showFeedback(error.message || "Anda belum dapat keluar. Coba lagi.", true);
    } finally {
      logoutButton.disabled = false;
    }
  });

  currentTheme = loadTheme();
  applyTheme(currentTheme);
  document.getElementById("auth-theme-toggle").addEventListener("click", () => {
    applyTheme(currentTheme === "dark" ? "light" : "dark");
    saveTheme();
  });

  const resetParameter = new URLSearchParams(window.location.search).get("reset");
  if (resetParameter) {
    resetToken = resetParameter;
    setView("reset");
  }
  initializeSession();
})();
