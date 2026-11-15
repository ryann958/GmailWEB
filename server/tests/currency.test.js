import assert from "node:assert/strict";
import test from "node:test";
import { createIdrUsdRateProvider } from "../currency.js";

test("IDR/USD rate provider validates and caches the latest reference rate", async () => {
  let now = 1_000;
  let calls = 0;
  const getRate = createIdrUsdRateProvider({
    now: () => now,
    fetchImpl: async (url) => {
      calls += 1;
      assert.equal(url, "https://api.frankfurter.dev/v1/latest?base=IDR&symbols=USD");
      return {
        ok: true,
        async json() {
          return { base: "IDR", date: "2026-11-13", rates: { USD: 0.000054811 } };
        },
      };
    },
  });

  const first = await getRate();
  now += 60_000;
  const second = await getRate();

  assert.equal(first.usdPerIdr, 0.000054811);
  assert.equal(first.rateDate, "2026-11-13");
  assert.equal(first.stale, false);
  assert.equal(second.stale, false);
  assert.equal(calls, 1);
});

test("IDR/USD rate provider flags a cached rate if refresh fails", async () => {
  let now = 1_000;
  let shouldFail = false;
  const getRate = createIdrUsdRateProvider({
    now: () => now,
    cacheTtlMs: 1,
    fetchImpl: async () => {
      if (shouldFail) throw new Error("offline");
      return {
        ok: true,
        async json() {
          return { base: "IDR", date: "2026-11-13", rates: { USD: 0.000054811 } };
        },
      };
    },
  });

  await getRate();
  now += 2;
  shouldFail = true;
  const result = await getRate();

  assert.equal(result.stale, true);
  assert.equal(result.usdPerIdr, 0.000054811);
});

test("IDR/USD rate provider reports unavailable rates without a cached value", async () => {
  const getRate = createIdrUsdRateProvider({
    fetchImpl: async () => { throw new Error("offline"); },
  });

  await assert.rejects(getRate, /Kurs IDR\/USD belum dapat dimuat/);
});
