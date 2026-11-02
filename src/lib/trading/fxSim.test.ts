import { describe, expect, it } from "vitest";
import { midsFromBook, pairMid, seedUsdBook, setPairMid, stepUsdBook } from "./fxSim";

describe("fx factor book", () => {
  it("keeps crosses consistent with the USD legs", () => {
    const book = seedUsdBook();
    const mids = midsFromBook(book);
    expect(mids.EURJPY).toBeCloseTo(mids.EURUSD * mids.USDJPY, 6);
    expect(mids.EURGBP).toBeCloseTo(mids.EURUSD / mids.GBPUSD, 6);
    expect(mids.GBPJPY).toBeCloseTo(mids.GBPUSD * mids.USDJPY, 6);
  });

  it("steps without breaking USD = 1 or producing non-positive prices", () => {
    let book = seedUsdBook();
    for (let i = 0; i < 50; i++) book = stepUsdBook(book, 0.25, new Date("2026-03-10T14:00:00Z"), () => 0.4);
    expect(book.USD).toBe(1);
    for (const v of Object.values(book)) expect(v).toBeGreaterThan(0);
  });

  it("writes a pair mid back onto the book", () => {
    const book = setPairMid(seedUsdBook(), "EUR", "USD", 1.12);
    expect(pairMid("EUR", "USD", book)).toBeCloseTo(1.12);
  });
});
