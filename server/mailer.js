import nodemailer from "nodemailer";

export function createMailer(config) {
  const smtp = config.smtp;
  const isConfigured = Boolean(smtp.host && smtp.from);
  const transport = isConfigured
    ? nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      })
    : null;

  return {
    isConfigured,
    async sendEmailVerificationCode(email, code) {
      if (!transport) {
        throw new Error("SMTP is not configured.");
      }

      await transport.sendMail({
        from: smtp.from,
        to: email,
        subject: "Kode verifikasi email MailMu",
        text: [
          `Kode verifikasi email MailMu Anda: ${code}`,
          "Masukkan kode ini pada halaman pendaftaran dalam 10 menit.",
          "Jangan bagikan kode ini kepada siapa pun. Jika Anda tidak membuat akun MailMu, abaikan email ini.",
        ].join("\n\n"),
      });
    },
    async sendPasswordResetEmail(email, resetUrl) {
      if (!transport) {
        throw new Error("SMTP is not configured.");
      }

      await transport.sendMail({
        from: smtp.from,
        to: email,
        subject: "Atur ulang kata sandi MailMu",
        text: [
          "Kami menerima permintaan untuk mengatur ulang kata sandi akun MailMu Anda.",
          `Gunakan tautan ini dalam 30 menit: ${resetUrl}`,
          "Jika Anda tidak meminta perubahan ini, abaikan email ini.",
        ].join("\n\n"),
      });
    },
  };
}
