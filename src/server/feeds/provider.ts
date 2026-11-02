import type { FeedMode } from "./types";
import type { SimCandle } from "@/lib/trading/fxSim";

export interface ProviderQuote {
  mid: number;
  prevClose?: number;
  /** Provider timestamp of the print, in ms. */
  time: number;
}

export interface Timeframe {
  seconds: number;
  yahoo: string;
  yahooRange: string;
  twelve: string;
  twelveRange: number;
  /** Per-`(symbol, tf)` candle cache TTL — the request budget in design §7.3. */
  candleTtlMs: number;
}

export interface PriceProvider {
  readonly mode: FeedMode;
  /** Cheap availability probe, used for status reporting and before a first poll. */
  isConfigured(): boolean;
  fetchQuotes(): Promise<Map<string, ProviderQuote>>;
  fetchCandles(symbol: string, frame: Timeframe): Promise<SimCandle[]>;
}

export const TIMEFRAMES: Record<string, Timeframe> = {
  "1m": { seconds: 60, yahoo: "1m", yahooRange: "1d", twelve: "1min", twelveRange: 500, candleTtlMs: 60_000 },
  "5m": { seconds: 300, yahoo: "5m", yahooRange: "5d", twelve: "5min", twelveRange: 500, candleTtlMs: 300_000 },
  "15m": { seconds: 900, yahoo: "15m", yahooRange: "5d", twelve: "15min", twelveRange: 500, candleTtlMs: 900_000 },
  "1h": { seconds: 3600, yahoo: "60m", yahooRange: "1mo", twelve: "1hour", twelveRange: 500, candleTtlMs: 1_800_000 },
  "1d": { seconds: 86400, yahoo: "1d", yahooRange: "1y", twelve: "1day", twelveRange: 500, candleTtlMs: 86_400_000 },
};

/** Bars kept per symbol per feed: 5 000 minutes is above the longest tf needing minute detail. */
export const CANDLE_CAP = 5000;

/** Providers hand back unvalidated JSON; these keep the parsers honest and `any`-free. */
export function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A usable price print, or null for anything non-finite/non-positive. */
export function asPrice(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function asNumber(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * A provider that answered badly. The status keeps the `blocking()` regex
 * working, and `retryAfterMs` carries the server's own instruction so the poller
 * can wait that long instead of guessing (design §6).
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** `Retry-After` is either a number of seconds or an HTTP date. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
  const at = Date.parse(header);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(at - Date.now(), 0), RETRY_AFTER_CAP_MS);
}

/** A bogus or far-future date must not park the tape for days. */
const RETRY_AFTER_CAP_MS = 15 * 60_000;

export async function getJson(url: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ProviderError(`${res.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`, res.status, retryAfterMs(res.headers.get("retry-after")));
  }
  return asObject(await res.json());
}
