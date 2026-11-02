import { INSTRUMENTS } from "@/lib/instruments";
import type { SimCandle } from "@/lib/trading/fxSim";
import {
  asArray,
  asNumber,
  asObject,
  asPrice,
  getJson,
  type PriceProvider,
  type ProviderQuote,
  type Timeframe,
} from "./provider";

const SPARK_URL = "https://query1.finance.yahoo.com/v7/finance/spark";
const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const HEADERS = { "User-Agent": "Mozilla/5.0" };

/** Newest usable close inside a spark series block, for symbols whose meta has no print. */
function lastPrice(blocks: unknown[]): number | null {
  const closes = asArray(asObject(blocks[0]).close);
  for (let i = closes.length - 1; i >= 0; i--) {
    const price = asPrice(closes[i]);
    if (price) return price;
  }
  return null;
}

/**
 * Spark carries a 1-minute series per symbol. The current print lives in
 * `response[0].meta.regularMarketPrice`; symbols Yahoo leaves out of meta are
 * priced from the tail of their own series, so one request covers the watchlist.
 */
export async function fetchYahooQuotes(): Promise<Map<string, ProviderQuote>> {
  const symbols = INSTRUMENTS.map((i) => i.yahoo).join(",");
  const url = `${SPARK_URL}?symbols=${encodeURIComponent(symbols)}&range=1d&interval=1m`;
  const json = await getJson(url, HEADERS);
  const now = Date.now();
  const out = new Map<string, ProviderQuote>();

  for (const entry of asArray(asObject(json.spark).result)) {
    const row = asObject(entry);
    const symbol = typeof row.symbol === "string" ? row.symbol : "";
    const inst = INSTRUMENTS.find((i) => i.yahoo === symbol);
    if (!inst) continue;
    const block = asObject(asArray(row.response)[0]);
    const meta = asObject(block.meta);
    const mid =
      asPrice(meta.regularMarketPrice) ?? asPrice(meta.fulldayPrice) ?? lastPrice(asArray(asObject(block.indicators).quote));
    if (!mid) continue;
    out.set(inst.symbol, {
      mid,
      prevClose: asPrice(meta.chartPreviousClose) ?? asPrice(meta.previousClose) ?? mid,
      time: (asNumber(meta.regularMarketTime) ?? now / 1000) * 1000,
    });
  }
  return out;
}

/** 1-minute bars aggregated into the requested frame, matching the simulation's candle shape. */
export async function fetchYahooCandles(yahooSymbol: string, frame: Timeframe): Promise<SimCandle[]> {
  const url = `${CHART_URL}/${encodeURIComponent(yahooSymbol)}?interval=${frame.yahoo}&range=${frame.yahooRange}`;
  const json = await getJson(url, HEADERS);
  const result = asObject(asArray(json.chart ? asObject(json.chart).result : undefined)[0]);
  const stamps = asArray(result.timestamp);
  const quote = asObject(asArray(result.indicators ? asObject(result.indicators).quote : undefined)[0]);

  const data: SimCandle[] = [];
  stamps.forEach((raw, i) => {
    const t = asNumber(raw);
    const open = asPrice(asArray(quote.open)[i]);
    const high = asPrice(asArray(quote.high)[i]);
    const low = asPrice(asArray(quote.low)[i]);
    const close = asPrice(asArray(quote.close)[i]);
    if (t == null || open == null || high == null || low == null || close == null) return;
    const time = Math.floor(t / frame.seconds) * frame.seconds;
    const last = data[data.length - 1];
    if (last && last.time === time) {
      last.high = Math.max(last.high, high);
      last.low = Math.min(last.low, low);
      last.close = close;
    } else data.push({ time, open, high, low, close });
  });
  return data;
}

export function createYahooProvider(): PriceProvider {
  return {
    mode: "yahoo",
    isConfigured: () => true,
    fetchQuotes: fetchYahooQuotes,
    async fetchCandles(symbol, frame) {
      const pair = INSTRUMENTS.find((i) => i.symbol === symbol)?.yahoo;
      return pair ? fetchYahooCandles(pair, frame) : [];
    },
  };
}
