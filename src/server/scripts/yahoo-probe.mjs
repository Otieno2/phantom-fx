#!/usr/bin/env node
/**
 * Design §6.2(d) — the Yahoo reachability acceptance probe, made reproducible.
 *
 * Run it with plain node (no dependencies, no build), or through the npm scripts
 * that wrap exactly these two invocations (A-6):
 *
 *   npm run probe:yahoo          = node src/server/scripts/yahoo-probe.mjs
 *   npm run probe:yahoo:full     = node src/server/scripts/yahoo-probe.mjs --full
 *
 * What it asserts, per asked symbol:
 *   1. HTTP 200 from `v7/finance/spark` with `User-Agent: Mozilla/5.0`;
 *   2. the row shape the host really sends: keys `["symbol","response"]`, with
 *      NO `meta` at the row level — the print lives at
 *      `response[0].meta.regularMarketPrice`;
 *   3. that print is finite, positive and inside a plausible band for the pair;
 *   4. `response[0].meta.regularMarketTime` — the PRINT's own timestamp — and how
 *      old it is. This is what design A-10 ages the live slot on, and A-11 ages
 *      one symbol on: a host can answer 200 with a quote from Friday, and only
 *      this field says so. The age is reported, not asserted as a failure: an old
 *      stamp on a weekend is the market being shut, which the feed is supposed to
 *      react to, not the probe.
 *
 * Exit 0 and one `OK` line per symbol when 1–3 hold; exit 1 with the failing
 * symbol and reason otherwise, so it can be dropped into a checklist.
 *
 * OBSERVED VALUES (this machine, EU, 2026-11-02, `--symbols=EURUSD=X,GBPUSD=X`):
 *   HTTP 200 · spark.result = 2 rows · row keys exactly ["symbol","response"]
 *   row.meta ABSENT
 *   EURUSD=X -> response[0].meta.regularMarketPrice = 1.1216   (band 1.00-1.40)
 *   GBPUSD=X -> response[0].meta.regularMarketPrice = 1.3423   (band 1.10-1.60)
 *   regularMarketTime is unix SECONDS (10 digits), not ms: EURUSD=X
 *   1793635186 -> 2026-11-02T15:59:46Z, ~1m old at request time, i.e. a live tape
 *   during an open session. A second run the same evening printed the same age.
 *
 * Reachability is an environment property, not a code property: it can change
 * with no commit. Re-run weekly. A failure here is an upstream problem — the
 * feed is supposed to answer by going `degraded` and then `paused` (§5.2), and
 * the live slot must keep refusing to invent prices (R5), not go green.
 *
 * The same check by hand, when node is not the shortest path:
 *
 *   curl -s -H 'User-Agent: Mozilla/5.0' \
 *     'https://query1.finance.yahoo.com/v7/finance/spark?symbols=EURUSD=X,GBPUSD=X&range=1d&interval=1m' \
 *     | jq '.spark.result[] | {symbol, price: .response[0].meta.regularMarketPrice, printed: .response[0].meta.regularMarketTime}'
 */
import process from "node:process";

const SPARK_URL = "https://query1.finance.yahoo.com/v7/finance/spark";
const HEADERS = { "User-Agent": "Mozilla/5.0" };

/** The watchlist with the band each pair has to stay inside to be a real print. */
const PAIRS = [
  { symbol: "EURUSD=X", lo: 1.0, hi: 1.4 },
  { symbol: "GBPUSD=X", lo: 1.1, hi: 1.6 },
  { symbol: "USDJPY=X", lo: 120, hi: 180 },
  { symbol: "USDCHF=X", lo: 0.6, hi: 1.1 },
  { symbol: "AUDUSD=X", lo: 0.5, hi: 0.85 },
  { symbol: "USDCAD=X", lo: 1.15, hi: 1.55 },
  { symbol: "NZDUSD=X", lo: 0.45, hi: 0.75 },
  { symbol: "EURGBP=X", lo: 0.7, hi: 0.95 },
  { symbol: "EURJPY=X", lo: 130, hi: 195 },
  { symbol: "GBPJPY=X", lo: 160, hi: 230 },
];

const full = process.argv.includes("--full");
const asked = full ? PAIRS : PAIRS.slice(0, 2);
const url = `${SPARK_URL}?symbols=${encodeURIComponent(asked.map((p) => p.symbol).join(","))}&range=1d&interval=1m`;

/** @returns {Promise<number>} the resolved status code; throws on anything unusable. */
async function probe() {
  const res = await fetch(url, { headers: HEADERS, cache: "no-store", signal: AbortSignal.timeout(10_000) });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  const json = JSON.parse(body);
  const rows = json?.spark?.result;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`no spark.result rows in the response`);

  let priced = 0;
  for (const pair of asked) {
    const row = rows.find((r) => r?.symbol === pair.symbol);
    if (!row) {
      console.error(`FAIL ${pair.symbol}: the host returned no row for it`);
      continue;
    }
    // The shape, asserted rather than trusted: `meta` is one level down.
    const keys = Object.keys(row).sort().join(",");
    if (keys !== "response,symbol") {
      console.error(`FAIL ${pair.symbol}: row keys are [${keys}], expected [response,symbol]`);
      continue;
    }
    const meta = row.response?.[0]?.meta;
    const price = Number(meta?.regularMarketPrice);
    if (!Number.isFinite(price) || price <= 0) {
      console.error(`FAIL ${pair.symbol}: response[0].meta.regularMarketPrice is ${JSON.stringify(meta?.regularMarketPrice)}`);
      continue;
    }
    if (price < pair.lo || price > pair.hi) {
      console.error(`FAIL ${pair.symbol}: ${price} is outside the plausible band ${pair.lo}-${pair.hi}`);
      continue;
    }
    // The print's own timestamp, which is what A-10 ages the live slot on.
    // Yahoo sends unix SECONDS here; a 13-digit value would be ms, so the unit is
    // decided by magnitude rather than assumed.
    const stamp = Number(meta?.regularMarketTime);
    const printedAt = Number.isFinite(stamp) && stamp > 0 ? (stamp > 1e11 ? stamp : stamp * 1000) : null;
    if (printedAt === null) {
      console.error(`FAIL ${pair.symbol}: response[0].meta.regularMarketTime is ${JSON.stringify(meta?.regularMarketTime)}`);
      continue;
    }
    const ageMs = Date.now() - printedAt;
    const age = ageMs < 120_000 ? `${Math.round(ageMs / 1000)}s` : ageMs < 7_200_000 ? `${Math.round(ageMs / 60_000)}m` : `${(ageMs / 3_600_000).toFixed(1)}h`;
    // An old stamp is reported, not failed: over a weekend it means the market is
    // shut, which is exactly what the feed's market-age guard is for. What matters
    // is that the number is visible here, because HTTP 200 alone hides it.
    const pastGuard = ageMs > 1_200_000 ? ` · older than LIVE_MARKET_PAUSE_MS=1200000, so a live slot on this tape is paused` : "";
    priced += 1;
    console.log(`OK ${pair.symbol} ${price} (band ${pair.lo}-${pair.hi}) printed ${new Date(printedAt).toISOString()} age ${age}${pastGuard}`);
  }
  if (priced !== asked.length) throw new Error(`${asked.length - priced} of ${asked.length} symbols unusable`);
  return rows.length;
}

try {
  const rows = await probe();
  console.log(`PASS ${asked.length}/${asked.length} symbols priced, ${rows} rows, ${new Date().toISOString()}`);
} catch (err) {
  console.error(`PROBE FAILED: ${err.message}`);
  console.error("This is an upstream/environment result, not a licence to simulate: the live slot must stay paused (§5.2, R5).");
  process.exit(1);
}
