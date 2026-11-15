const RATE_URL = "https://api.frankfurter.dev/v1/latest?base=IDR&symbols=USD";
const RATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;

export function createIdrUsdRateProvider({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  cacheTtlMs = RATE_CACHE_TTL_MS,
} = {}) {
  let cachedRate = null;

  return async function getIdrUsdRate() {
    if (cachedRate && now() - cachedRate.fetchedAt < cacheTtlMs) {
      return { ...cachedRate.value, stale: false };
    }

    try {
      const response = await fetchImpl(RATE_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Exchange-rate service returned ${response.status}.`);

      const payload = await response.json();
      const rate = payload?.rates?.USD;
      if (
        payload?.base !== "IDR" ||
        typeof payload.date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(payload.date) ||
        typeof rate !== "number" ||
        !Number.isFinite(rate) ||
        rate <= 0
      ) {
        throw new Error("Exchange-rate service returned an invalid IDR/USD rate.");
      }

      const value = {
        usdPerIdr: rate,
        rateDate: payload.date,
        source: "Frankfurter / European Central Bank reference rates",
      };
      cachedRate = { value, fetchedAt: now() };
      return { ...value, stale: false };
    } catch (error) {
      if (cachedRate) return { ...cachedRate.value, stale: true };
      throw new Error("Kurs IDR/USD belum dapat dimuat. Coba lagi saat koneksi tersedia.", {
        cause: error,
      });
    }
  };
}
