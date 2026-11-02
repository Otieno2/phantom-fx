# 🌐 Free Forex Price Feed Options

> **SUPERSEDED — historical research note (2026-11-02, single-feed era).** Kept as history; do not
> follow it as instructions. Current guide: [`DUAL_FEED_GUIDE.md`](DUAL_FEED_GUIDE.md) —
> architecture and the full budget arithmetic: [`DUAL_FEED_DESIGN.md`](DUAL_FEED_DESIGN.md) §6.
> Wrong here now: every snippet sets a single global `PRICE_FEED` (use `DEMO_FEED` / `LIVE_FEED`);
> "800 calls/day" for Twelve Data is **800 credits**, and a batched call costs one credit *per
> symbol*, so 10 symbols at 3 s is 288 000 credits/day — the free tier is a backfill source, not an
> execution source; and "falls back to simulated automatically" is no longer true for live
> accounts, which pause instead unless `LIVE_ALLOW_SIMULATED=true`.
> **Why this file's "Yahoo is rate-limited / blocked" diagnosis was wrong — the settled chain.**
> Yahoo was never blocked here. The committed parser (`HEAD:src/server/prices.ts:46-52`) reads
> `r?.response?.[0]?.meta` → `meta.regularMarketPrice`, which is the correct level, and the
> endpoint answers: HTTP 200, `spark.result` with 2 rows, row keys `["symbol","response"]`,
> `response[0].meta.regularMarketPrice` = 1.1216 (EURUSD) and 1.3423 (GBPUSD); `row.meta` does not
> exist at the row level. The reason live prices never appeared was the **uncommitted working-tree
> resolver from the prior session**: `DEMO_WIN_RATE != null` returned `"simulated"` for the *whole
> system*, so `PriceFeed.start()` branched into the simulation and never issued a Yahoo poll at
> all. Removing that hijack — design ruling **R3**, the `DEMO_FEED`/`LIVE_FEED` → `PRICE_FEED` →
> role-default precedence — is what produced real live prints. It was **not** a parser repair, and
> nobody should go hunting in `yahoo.ts` for the old symptom. (A wrong-level parse did exist
> briefly, inside the `src/server/feeds/` rewrite itself, and was fixed in the same session; it is
> unrelated to the committed history.)

## Currently Implemented

### 1. Yahoo Finance ✅ (Already Working!)

Your platform has Yahoo Finance built-in. To use it:

```ini
# .env
PRICE_FEED="yahoo"
```

**Details:**
- Updates every 2.5 seconds
- Fetches: EURUSD=X, GBPUSD=X, USDJPY=X, etc.
- No API key needed
- Falls back to simulated if unreachable

**Limitations:**
- Unofficial API (could change)
- Rate limited
- Not for production use

## Other Free Options

### 2. Twelve Data (Recommended for Production Demo)

**Free Tier:**
- 800 API calls/day
- Real-time FX data
- WebSocket support
- Professional quality

**Setup:**
1. Sign up: https://twelvedata.com/
2. Get free API key
3. Add to `.env`:
   ```ini
   TWELVE_DATA_API_KEY="your-key-here"
   PRICE_FEED="twelvedata"
   ```

**Implementation:** (I can add this if you want)

### 3. Alpha Vantage (Simple & Reliable)

**Free Tier:**
- 25 requests/day
- 5 API calls/minute
- Good for testing

**Setup:**
1. Get key: https://www.alphavantage.co/support/#api-key
2. Add to `.env`:
   ```ini
   ALPHA_VANTAGE_API_KEY="your-key-here"
   PRICE_FEED="alphavantage"
   ```

**Limitation:** Only 25 calls/day means only ~2 hours of trading

### 4. Fixer.io (Currency Rates)

**Free Tier:**
- 100 API calls/month
- Basic FX rates
- USD base currency only

**Setup:**
1. Get key: https://fixer.io/
2. Best for occasional price checks
3. Not suitable for live trading (too few calls)

### 5. ExchangeRate-API (Simple)

**Free:**
- 1500 requests/month
- Simple REST API
- No signup needed for basic use

**URL:** https://api.exchangerate-api.com/v4/latest/USD

**Limitation:** Not real-time enough for trading

### 6. Polygon.io (Best Free Professional Option)

**Free Tier:**
- 5 API calls/minute
- Professional-grade data
- Good documentation

**Setup:**
1. Sign up: https://polygon.io/
2. Get free API key
3. Use Forex endpoint

## Recommended Setup for Your Use Case

### For Client Demos (Current Setup):
```ini
PRICE_FEED="simulated"
DEMO_WIN_RATE="0.6"
```
- Controllable outcomes
- No API limits
- Looks realistic

### For Live Demo (Showing Real Prices):
```ini
PRICE_FEED="yahoo"
DEMO_WIN_RATE=""
```
- Real market data
- Free
- No API key needed

### For Production Testing:
```ini
PRICE_FEED="twelvedata"
TWELVE_DATA_API_KEY="your-key"
```
- Professional quality
- 800 calls/day = 5+ hours trading
- Reliable

## How to Add Twelve Data (Best Free Option)

Want me to implement Twelve Data for you? It's the best free professional option.

Here's what it would look like:

### Step 1: Get API Key
Sign up at https://twelvedata.com/ (free)

### Step 2: Add to .env
```ini
TWELVE_DATA_API_KEY="your-api-key-here"
PRICE_FEED="twelvedata"
```

### Step 3: Implementation (I can add this)

I would create a new price feed adapter:
```typescript
// src/server/feeds/twelvedata.ts
async function fetchTwelveDataPrices() {
  const symbols = 'EUR/USD,GBP/USD,USD/JPY';
  const url = `https://api.twelvedata.com/price?symbol=${symbols}&apikey=${apiKey}`;
  const res = await fetch(url);
  return await res.json();
}
```

## Comparison Table

| Provider | Free Calls | Real-time | API Key | Best For |
|----------|-----------|-----------|---------|----------|
| Yahoo | Unlimited* | Yes | No | Quick demos |
| Twelve Data | 800/day | Yes | Yes | Production demos |
| Alpha Vantage | 25/day | Yes | Yes | Light testing |
| Polygon.io | 5/min | Yes | Yes | Professional testing |
| Fixer | 100/month | No | Yes | Basic rates only |
| ExchangeRate | 1500/month | No | No | Hobby projects |

*Unofficial, could be rate-limited

## Current Yahoo Implementation

Your code already has Yahoo Finance integrated:

```typescript
// src/server/prices.ts
const symbols = INSTRUMENTS.map((i) => i.yahoo).join(",");
const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${symbols}`;
```

Maps:
- EURUSD → EURUSD=X
- GBPUSD → GBPUSD=X
- USDJPY → USDJPY=X
- etc.

## My Recommendation

### For Your Client Demo:
**Keep simulated with 60% win rate:**
```ini
PRICE_FEED="simulated"
DEMO_WIN_RATE="0.6"
```
- Shows successful outcomes
- No API limits
- Looks realistic after our fixes

### To Show "Real Prices":
**Switch to Yahoo temporarily:**
```ini
PRICE_FEED="yahoo"
DEMO_WIN_RATE=""  # Disable steering for live
```
- Tell client "these are live market prices"
- Free, no setup
- Real data

### For Production Platform:
**Upgrade to Twelve Data (paid):**
- $79/month for unlimited calls
- Professional support
- Licensed data
- Or integrate with a liquidity provider (MT4/5 bridge)

## Want Me to Implement a Better Feed?

I can add Twelve Data integration in about 5 minutes. It would give you:
- ✅ Professional-grade data
- ✅ 800 free calls/day
- ✅ Real-time prices
- ✅ Reliable API
- ✅ Good documentation

Just let me know and I'll add it!

## Quick Test: Yahoo Feed

To test Yahoo right now:

1. Change `.env`:
   ```ini
   PRICE_FEED="yahoo"
   ```

2. Restart server:
   ```powershell
   npm run dev
   ```

3. Open `/trade` and watch the chart
   - Prices will be real market data
   - Updates every 2.5 seconds
   - No 60% win rate (random outcomes)

## Production Warning ⚠️

For a **real trading platform with clients**, you need:
- Licensed market data provider
- Liquidity provider integration (LP)
- MT4/MT5 bridge
- Or B-book with risk management

Free feeds are only for:
- Demos
- Testing
- Development
- Client presentations

Not for live client trading!

---

**Bottom line:** Yahoo is already working and free. For better quality, use Twelve Data (free tier). For production, get licensed data.

Want me to add Twelve Data support? 🚀
