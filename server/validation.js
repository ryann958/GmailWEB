export function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return null;
  }
  return email;
}

export function validateRegistration(body) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = normalizeEmail(body?.email);
  const password = typeof body?.password === "string" ? body.password : "";
  const passwordLength = Array.from(password).length;

  if (name.length < 2 || Array.from(name).length > 80) {
    return { error: "Nama harus berisi 2–80 karakter." };
  }
  if (!email) {
    return { error: "Masukkan alamat email yang valid." };
  }
  if (passwordLength < 12 || passwordLength > 128) {
    return { error: "Kata sandi harus berisi 12–128 karakter." };
  }
  return { value: { name, email, password } };
}

export function validatePassword(value) {
  const password = typeof value === "string" ? value : "";
  const length = Array.from(password).length;
  if (length < 12 || length > 128) {
    return { error: "Kata sandi harus berisi 12–128 karakter." };
  }
  return { value: password };
}

export function isValidResetToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
