import { CANDLE_CAP, type Timeframe } from "./provider";
import type { SimCandle } from "@/lib/trading/fxSim";

export type Candle = SimCandle;

/**
 * One candle store per feed (design §7.2): a simulated feed aggregates its own
 * tape, a provider feed caches upstream bars. Nothing is shared between feeds,
 * so a demo chart can never show live bars or the other way round.
 */
export class CandleStore {
  /** This feed's own 1-minute tape, keyed by symbol. */
  private frames = new Map<string, Candle[]>();
  /** Upstream bars, keyed `symbol:seconds`, with a per-timeframe TTL. */
  private providerBars = new Map<string, { at: number; bars: Candle[] }>();
  /** One in-flight request per key, so 50 clients cost one call (§7.3). */
  private inflight = new Map<string, Promise<Candle[]>>();

  load(bars: Map<string, Candle[]>) {
    this.frames = bars;
  }

  push(symbol: string, price: number, timeMs: number) {
    const bars = this.frames.get(symbol);
    if (!bars) return;
    const t = Math.floor(timeMs / 60_000) * 60;
    const last = bars[bars.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
    } else {
      bars.push({ time: t, open: last?.close ?? price, high: price, low: price, close: price });
      while (bars.length > CANDLE_CAP) bars.shift();
    }
  }

  /** Aggregated from this feed's own tape. */
  bars(symbol: string, seconds: number): Candle[] {
    const bars = this.frames.get(symbol) ?? [];
    if (seconds === 60) return bars.map((b) => ({ ...b }));
    const out: Candle[] = [];
    for (const b of bars) {
      const t = Math.floor(b.time / seconds) * seconds;
      const last = out[out.length - 1];
      if (last && last.time === t) {
        last.high = Math.max(last.high, b.high);
        last.low = Math.min(last.low, b.low);
        last.close = b.close;
      } else out.push({ ...b, time: t });
    }
    return out;
  }

  /**
   * Provider bars, honouring the §7.3 budget: per-`(symbol, tf)` TTL, concurrent
   * callers coalesced onto one request, and the previous frame served when the
   * provider errors rather than showing an empty chart. Never rejects.
   */
  async fetched(
    symbol: string,
    frame: Timeframe,
    loader: (symbol: string) => Promise<Candle[]>,
    onError: (message: string) => void,
  ): Promise<Candle[]> {
    const key = `${symbol}:${frame.seconds}`;
    const hit = this.providerBars.get(key);
    if (hit && Date.now() - hit.at < frame.candleTtlMs) return hit.bars;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const request = loader(symbol)
      .then((bars) => {
        this.inflight.delete(key);
        if (!bars.length) {
          onError(`provider returned no candles for ${symbol} ${frame.seconds}s`);
          return hit?.bars ?? [];
        }
        const capped = bars.length > CANDLE_CAP ? bars.slice(-CANDLE_CAP) : bars;
        this.providerBars.set(key, { at: Date.now(), bars: capped });
        return capped;
      })
      .catch((err) => {
        this.inflight.delete(key);
        onError(`candle fetch failed for ${symbol}: ${(err as Error).message}`);
        return hit?.bars ?? [];
      });
    this.inflight.set(key, request);
    return request;
  }

  /** Last bars held for a provider timeframe, fresh or stale. */
  cached(symbol: string, seconds: number): Candle[] {
    return this.providerBars.get(`${symbol}:${seconds}`)?.bars ?? [];
  }
}
