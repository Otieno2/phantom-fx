import { afterAll, afterEach, describe, expect, it } from "vitest";
import { INSTRUMENTS } from "@/lib/instruments";
import { fetchYahooQuotes } from "./yahoo";

/**
 * The shape Yahoo's `v7/finance/spark` actually answers with, captured against
 * the live host on 2026-11-02 (`node src/server/scripts/yahoo-probe.mjs`, §6.2(d)):
 *
 *   HTTP 200, `spark.result` = 2 rows for a 2-symbol request,
 *   row keys exactly `["symbol", "response"]` — there is NO `row.meta`,
 *   the current print lives at `response[0].meta.regularMarketPrice`:
 *     EURUSD=X -> 1.1216   GBPUSD=X -> 1.3423
 *
 * Attribution, because it matters (design §10): `git show HEAD:src/server/prices.ts`
 * already read `r?.response?.[0]?.meta` correctly, so this parser was never the
 * reason the live feed showed no prices. The cause was the working-tree resolver
 * that mapped `DEMO_WIN_RATE` to a system-wide `simulated` mode, so no Yahoo poll
 * was ever attempted; R3 (a win rate selects no provider) is what restored live
 * prices. These tests pin the shape so a future "simplification" that reads
 * `regularMarketPrice` off the row fails here instead of quietly emptying a tape.
 */
const BASE = 1_800_000_000;

function sparkRow(symbol: string, meta: Record<string, unknown>, closes: (number | null)[]) {
  return {
    symbol,
    response: [
      {
        meta: { symbol, regularMarketTime: BASE, ...meta },
        timestamp: closes.map((_, i) => BASE + i * 60),
        indicators: { quote: [{ close: closes }] },
      },
    ],
  };
}

function stub(rows: unknown[]) {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ spark: { result: rows, error: null } }),
    text: async () => "",
  })) as unknown as typeof globalThis.fetch;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("yahoo spark parsing", () => {
  it("prices every watchlist symbol from its meta block", async () => {
    stub(
      INSTRUMENTS.map((inst, n) =>
        sparkRow(inst.yahoo, { regularMarketPrice: 1.1 + n * 0.01, chartPreviousClose: 1.05 + n * 0.01 }, [1.0, 1.02]),
      ),
    );
    const quotes = await fetchYahooQuotes();

    expect(quotes.size).toBe(INSTRUMENTS.length);
    expect(quotes.get("EURUSD")?.mid).toBe(1.1);
    expect(quotes.get("EURUSD")?.prevClose).toBe(1.05);
    expect(quotes.get("EURUSD")?.time).toBe(BASE * 1000);
  });

  it("reads the two-symbol capture from 2026-11-02 exactly as the host sent it", async () => {
    const rows = [
      sparkRow("EURUSD=X", { regularMarketPrice: 1.1216, chartPreviousClose: 1.1203 }, [1.121, 1.1216]),
      sparkRow("GBPUSD=X", { regularMarketPrice: 1.3423, chartPreviousClose: 1.3401 }, [1.341, 1.3423]),
    ];
    // The observed row keys, pinned rather than assumed: nothing at the top level
    // but `symbol` and `response`.
    expect(Object.keys(rows[0])).toEqual(["symbol", "response"]);
    stub(rows);

    const quotes = await fetchYahooQuotes();
    expect(quotes.get("EURUSD")?.mid).toBe(1.1216);
    expect(quotes.get("GBPUSD")?.mid).toBe(1.3423);
    expect(quotes.get("GBPUSD")?.prevClose).toBe(1.3401);
  });

  it("refuses a flat row: a print at the top level is not a price source", async () => {
    // The regression this guards is a parser "simplified" into reading the row
    // itself. The real host has no `meta` there, so the honest answer is no
    // prices at all — which the feed turns into `paused`, not into a stale tape
    // presented as live.
    stub([{ symbol: "EURUSD=X", regularMarketPrice: 1.1216, response: [{}] }]);
    const quotes = await fetchYahooQuotes();

    expect(quotes.size).toBe(0);
  });

  it("falls back to the tail of the series when meta carries no print", async () => {
    const inst = INSTRUMENTS[0];
    stub([sparkRow(inst.yahoo, {}, [1.1, 1.12, null])]);
    const quotes = await fetchYahooQuotes();

    expect(quotes.get(inst.symbol)?.mid).toBe(1.12);
    expect(quotes.get(inst.symbol)?.prevClose).toBe(1.12);
  });

  it("drops an unusable symbol instead of failing the whole tape", async () => {
    stub([
      sparkRow(INSTRUMENTS[0].yahoo, { regularMarketPrice: 1.2 }, []),
      sparkRow(INSTRUMENTS[1].yahoo, {}, [null]),
    ]);
    const quotes = await fetchYahooQuotes();

    expect([...quotes.keys()]).toEqual([INSTRUMENTS[0].symbol]);
  });

  it("returns nothing when the provider answers with an empty result", async () => {
    stub([]);
    expect((await fetchYahooQuotes()).size).toBe(0);
  });
});
