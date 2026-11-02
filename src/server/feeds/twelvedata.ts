/**
 * Twelve Data API integration for real-time forex prices.
 * Free tier: 800 API calls per day. Get a key at https://twelvedata.com/
 */

import { INSTRUMENTS } from "@/lib/instruments";
import type { SimCandle } from "@/lib/trading/fxSim";
import {
  asArray,
  asObject,
  asPrice,
  getJson,
  type PriceProvider,
  type ProviderQuote,
  type Timeframe,
} from "./provider";

const BASE_URL = "https://api.twelvedata.com";
const HEADERS = { "User-Agent": "PhantomFX/1.0" };

/** Read at call time so a rotated key takes effect without editing module state. */
function apiKey(): string {
  return (process.env.TWELVE_DATA_API_KEY ?? "").trim();
}

/** Twelve Data wants `EUR/USD`; our instruments carry `EURUSD`. */
const toPair = (base: string, quote: string) => `${base}/${quote}`;

export function isTwelveDataConfigured(): boolean {
  return apiKey() !== "";
}

export async function fetchTwelveDataPrices(): Promise<Map<string, ProviderQuote>> {
  const key = apiKey();
  if (!key) throw new Error("TWELVE_DATA_API_KEY not set in .env");

  const symbols = INSTRUMENTS.map((i) => toPair(i.base, i.quote)).join(",");
  const url = `${BASE_URL}/price?symbol=${encodeURIComponent(symbols)}&apikey=${key}`;
  const json = await getJson(url, HEADERS);
  const now = Date.now();
  const prices = new Map<string, ProviderQuote>();

  if (json.status === "error") throw new Error(`Twelve Data error: ${String(json.message ?? json.code ?? "unknown")}`);

  const collect = (symbolName: unknown, source: unknown) => {
    const inst = INSTRUMENTS.find((i) => toPair(i.base, i.quote) === symbolName);
    if (!inst) return;
    const mid = asPrice(asObject(source).price);
    // Twelve Data's `/price` body is `{symbol, price}`: no print timestamp. So
    // this mode stamps arrival, which makes the A-10 market age equal the
    // transport age — the print-age guard is documented as strictly weaker here,
    // because a host that answers 200 with an old number cannot be caught by a
    // clock we set ourselves. Second independent reason, alongside the credit
    // arithmetic, not to run live on the free tier: it is a backfill source, not
    // an execution source (design §6). A-11 still works, though: a symbol a batch
    // stops carrying keeps its own last arrival stamp and ages out on its own.
    // That costs nothing in practice: the cheapest cadence a free key can afford
    // (20 min) already exceeds `LIVE_PAUSE_MS`, so a Twelve Data live slot pauses
    // on transport alone.
    if (mid) prices.set(inst.symbol, { mid, time: now });
  };

  if (Array.isArray(json)) {
    for (const item of json) collect(asObject(item).symbol, item);
  } else {
    // Multi-symbol responses are keyed by pair; a single-symbol response is one object.
    const symbolName = typeof json.symbol === "string" ? json.symbol : null;
    if (symbolName) collect(symbolName, json);
    else for (const [name, value] of Object.entries(json)) collect(name, value);
  }

  if (prices.size === 0) throw new Error(`Twelve Data returned no usable prices: ${JSON.stringify(json).slice(0, 200)}`);
  return prices;
}

async function fetchTwelveDataCandles(pair: string, frame: Timeframe): Promise<SimCandle[]> {
  const key = apiKey();
  if (!key) throw new Error("TWELVE_DATA_API_KEY not set in .env");
  const url = `${BASE_URL}/time_series?symbol=${encodeURIComponent(pair)}&interval=${frame.twelve}&outputsize=${frame.twelveRange}&apikey=${key}`;
  const json = await getJson(url, HEADERS);
  if (json.status === "error") throw new Error(`Twelve Data error: ${String(json.message ?? json.code ?? "unknown")}`);

  const data: SimCandle[] = [];
  for (const raw of asArray(json.time_series)) {
    const bar = asObject(raw);
    const open = asPrice(bar.open);
    const high = asPrice(bar.high);
    const low = asPrice(bar.low);
    const close = asPrice(bar.close);
    if (open == null || high == null || low == null || close == null) continue;
    const stamp = typeof bar.datetime === "string" ? Date.parse(bar.datetime.replace(" ", "T")) : Number.NaN;
    const seconds = Number.isFinite(stamp) ? Math.floor(stamp / 1000) : data.length * frame.seconds;
    data.push({ time: Math.floor(seconds / frame.seconds) * frame.seconds, open, high, low, close });
  }
  return data.sort((a, b) => a.time - b.time);
}

export function createTwelveDataProvider(): PriceProvider {
  return {
    mode: "twelvedata",
    isConfigured: isTwelveDataConfigured,
    fetchQuotes: fetchTwelveDataPrices,
    async fetchCandles(symbol, frame) {
      const inst = INSTRUMENTS.find((i) => i.symbol === symbol);
      return inst ? fetchTwelveDataCandles(toPair(inst.base, inst.quote), frame) : [];
    },
  };
}
