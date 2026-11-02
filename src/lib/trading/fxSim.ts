import { INSTRUMENTS } from "@/lib/instruments";

export interface SimCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export function gaussian(rand = Math.random) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** USD per 1 unit of each currency. USD is always 1. */
export type UsdBook = Record<string, number>;

const USD_CCYS = ["EUR", "GBP", "JPY", "CHF", "AUD", "CAD", "NZD"] as const;

/** Dollar betas: risk currencies positive, JPY/CHF negative (flight-to-safety). */
const BETA: Record<string, number> = {
  EUR: 0.55,
  GBP: 0.5,
  JPY: -0.35,
  CHF: -0.25,
  AUD: 0.65,
  CAD: 0.6,
  NZD: 0.7,
};

const ANN_VOL: Record<string, number> = {
  EUR: 0.045,   // Reduced further from 0.06
  GBP: 0.055,   // Reduced from 0.07
  JPY: 0.05,    // Reduced from 0.065
  CHF: 0.04,    // Reduced from 0.055
  AUD: 0.06,    // Reduced from 0.08
  CAD: 0.045,   // Reduced from 0.06
  NZD: 0.065,   // Reduced from 0.085
};

export function seedUsdBook(): UsdBook {
  const book: UsdBook = { USD: 1 };
  for (const inst of INSTRUMENTS) {
    if (inst.quote === "USD") book[inst.base] = inst.seedPrice;
    else if (inst.base === "USD") book[inst.quote] = 1 / inst.seedPrice;
  }
  return book;
}

export function pairMid(base: string, quote: string, book: UsdBook): number {
  const b = book[base];
  const q = book[quote];
  if (!b || !q) return 0;
  return b / q;
}

export function midsFromBook(book: UsdBook): Record<string, number> {
  const out: Record<string, number> = {};
  for (const inst of INSTRUMENTS) out[inst.symbol] = pairMid(inst.base, inst.quote, book);
  return out;
}

/** Session volume: Tokyo / London / NY overlap, then a quiet Asia afternoon. */
export function sessionVolMultiplier(now = new Date()): number {
  const h = now.getUTCHours() + now.getUTCMinutes() / 60;
  if (h >= 12 && h < 16) return 1.5;
  if (h >= 7 && h < 12) return 1.15;
  if (h >= 16 && h < 21) return 1.08;
  if (h >= 0 && h < 7) return 0.78;
  return 0.48;
}

export function stepUsdBook(book: UsdBook, dtSec: number, now = new Date(), rand = Math.random): UsdBook {
  const next: UsdBook = { ...book, USD: 1 };
  const sess = sessionVolMultiplier(now);
  const dollar = gaussian(rand);
  const sqrtDt = Math.sqrt(Math.max(dtSec, 1e-6));
  const sqrtYear = Math.sqrt(365.25 * 24 * 3600);
  for (const ccy of USD_CCYS) {
    const px = book[ccy];
    if (!px) continue;
    const sigma = ((ANN_VOL[ccy] ?? 0.045) * sess) / sqrtYear;
    const beta = BETA[ccy] ?? 0.4;
    const idio = gaussian(rand);
    const shock = beta * dollar + Math.sqrt(Math.max(0, 1 - beta * beta)) * idio;
    // Reduced jump probability and size for smoother prices
    const jump = rand() < 0.0002 * dtSec ? gaussian(rand) * sigma * 8 : 0;
    // Reduced multiplier from 0.85 to 0.65 for even more stable prices
    next[ccy] = px * Math.exp(sigma * sqrtDt * shock * 0.65 + jump);
  }
  return next;
}

/** Apply a pair's mid move back onto the currency book so crosses stay internally consistent. */
export function setPairMid(book: UsdBook, base: string, quote: string, mid: number): UsdBook {
  const current = pairMid(base, quote, book);
  if (!current || !Number.isFinite(mid) || mid <= 0) return book;
  const ratio = mid / current;
  const next: UsdBook = { ...book, USD: 1 };
  if (quote === "USD") next[base] = (next[base] ?? 0) * ratio;
  else if (base === "USD") next[quote] = (next[quote] ?? 0) / ratio;
  else {
    const s = Math.sqrt(ratio);
    next[base] = (next[base] ?? 0) * s;
    next[quote] = (next[quote] ?? 0) / s;
  }
  return next;
}

export function generateHistory(
  minutes: number,
  rand = Math.random,
): { book: UsdBook; bars: Map<string, SimCandle[]> } {
  let book = seedUsdBook();
  const start = Date.now() - minutes * 60_000;
  const bars = new Map<string, SimCandle[]>();
  for (const inst of INSTRUMENTS) bars.set(inst.symbol, []);

  let prev = midsFromBook(book);
  for (let i = 0; i < minutes; i++) {
    const tMs = start + i * 60_000;
    book = stepUsdBook(book, 60, new Date(tMs), rand);
    const mids = midsFromBook(book);
    const time = Math.floor(tMs / 60_000) * 60;
    for (const inst of INSTRUMENTS) {
      const close = mids[inst.symbol];
      const open = prev[inst.symbol] ?? close;
      const wick = Math.abs(gaussian(rand)) * inst.pipSize * (2 + rand() * 6);
      const high = Math.max(open, close) + wick * (0.3 + rand());
      const low = Math.min(open, close) - wick * (0.3 + rand());
      bars.get(inst.symbol)!.push({
        time,
        open,
        high: high === low ? high + inst.pipSize * 0.1 : high,
        low,
        close,
      });
    }
    prev = mids;
  }
  return { book, bars };
}
