# Dual price feed — operator guide

Status: **implemented, and verified at the final gate plus the A-11 pass** (2026-11-02). `npm run
typecheck` clean, `npm test` **106 passed / 5 files** (80 of them in `feeds.test.ts`), lint limited to two
pre-existing `prisma/seed.js` errors, and `npm run probe:yahoo:full` → `PASS 10/10`, printing each
quote's timestamp and age (`EURGBP=X 0.8349 … printed 2026-11-02T16:52:44.000Z age 1s`).
**Two clocks are live** (§4 step 7): transport age and market age, and only the second one tells you
whether a price is still alive. **Both run per batch *and* per symbol** (A-11 is built): a pair whose own
print is older than `LIVE_MARKET_STALE_MS` is refused for new and edited risk by name, is listed in
`staleSymbols`, and is tagged `frozen` in the ticker — while the other nine keep trading and the frozen
one stays closable and managed. Nothing in this guide asks a live account to wait; the caveats that
remain are the accepted-risk list in §7.
The architecture and the reasoning behind every rule in this file live in
[`DUAL_FEED_DESIGN.md`](DUAL_FEED_DESIGN.md) — its §10 is the as-built conformance review, including
the gap list (A-1 … A-11, all closed) and the rulings that settled each one. This file is the short
operational version.
Earlier docs describe the **single-feed** system and now carry a SUPERSEDED banner at the top; they
are kept as history, not as instructions: `PRICE_FEED_FIX.md`, `FINAL_FIX_SUMMARY.md`,
`FREE_PRICE_FEEDS.md`, `TWELVE_DATA_SETUP.md`, `SETUP_COMPLETE.md`, `TESTING_STATUS.md`.
`README.md`, `START_HERE.md`, `CLIENT_DEMO_SETUP.md`, `DEMO_QUICK_REFERENCE.md` and
`TESTING_GUIDE.md` were corrected in place.

---

## 1. What runs now

Demo accounts and live accounts are priced by **two independent feeds that run at the same
time**. Each slot owns its marks, its candle store, its timer, its failure counter and its state
machine:

| Slot | Serves | Default source | Steering |
|---|---|---|---|
| `demo` | `Account.type == "DEMO"` | `simulated` (250 ms tick tape) | yes — `DEMO_WIN_RATE` bends **this tape only** |
| `live` | `Account.type == "LIVE"` | `yahoo` (2.5 s batched poll) | never; a steering call on this slot **throws** |

There is no shared-tape mode. `PRICE_FEED` alone does not merge the slots — it only supplies a
default for slots that have no switch of their own (§6).

**Which feed answers is decided by the account type read from the database, server-side.** A
query string may name an *account to look at* (ownership is checked with
`where: { id, userId }`), but a parameter can never name a feed, and the display path never
prices a trade: `placeOrder`/`openPosition`/`closePositionLocked`/`modifyPosition` re-resolve the
type from the `Account` row themselves (`src/server/trading.ts:104`, `:154`, `:225`, `:288`).
`Account.type` is an unconstrained `String` column, so anything that is not exactly `"DEMO"` or
`"LIVE"` throws `FEED_MISCONFIGURED` (HTTP 400) instead of being guessed into DEMO
(`src/server/feeds/types.ts:121-128`).

What is shared, deliberately: **one upstream poll loop per provider mode**, refcounted by
subscribers (`src/server/feeds/upstream.ts:141`). `DEMO_FEED=yahoo` + `LIVE_FEED=yahoo` costs one
2.5 s loop against Yahoo, not two.

---

## 2. Environment contract

Resolution order per slot, highest wins:

1. its own switch — `LIVE_FEED` / `DEMO_FEED`
2. `PRICE_FEED` (legacy fallback, applies to both slots)
3. the role default — `simulated` for demo, `yahoo` for live

Modes: `yahoo` | `twelvedata` | `simulated`. An unrecognised value is treated as unset, so a typo
cannot silently change the tape.

| Variable | Default | Meaning |
|---|---|---|
| `DEMO_FEED` | `simulated` | Source for demo accounts. |
| `LIVE_FEED` | `yahoo` | Source for live accounts — real money. |
| `PRICE_FEED` | unset | **Legacy.** Per-slot fallback only. Logs a deprecation warning when it is the only knob (`config.ts:219-224`). |
| `DEMO_WIN_RATE` | unset | Target demo win rate, 0.0–1.0. Empty disables steering. **Selects no provider**, and is forced to `null` for the live slot (`config.ts:141`, `feed.ts:425-436`). |
| `PUBLIC_FEED` | `live` | Which slot the logged-out homepage ticker reads. |
| `DEMO_FEED_ON_FAILURE` | `simulate` | Demo policy when its provider dies. |
| `LIVE_FEED_ON_FAILURE` | `pause` | Live policy. `simulate` is ignored (with a warning) unless `LIVE_ALLOW_SIMULATED=true`. |
| `LIVE_ALLOW_SIMULATED` | `false` | AND-gate on **any** simulated mark reaching the live slot, at boot or as fallback. |
| `FEED_FAILURE_THRESHOLD` | `3` | Consecutive provider failures before the policy applies. |
| `LIVE_STALE_MS` / `LIVE_PAUSE_MS` | `15000` / `60000` | **Transport** age for the live slot — how long since the host last answered. stale → `degraded`, older → `paused`. |
| `LIVE_MARKET_STALE_MS` / `LIVE_MARKET_PAUSE_MS` | `300000` / `1200000` | **Market** age — how long since the market last printed. This is the knob a weekend hits, and it is one policy for both slots (`config.ts:156-170`). 5 min of silence on an FX major means the source stopped forwarding; past 20 min a fill is a guess. |
| `DEMO_MARKET_STALE_MS` / `DEMO_MARKET_PAUSE_MS` | the `LIVE_MARKET_*` values | A demo reading a **real provider** inherits live's freshness policy and may raise its own. A simulated tape ignores both — its prints are stamped `now`. |
| `DEMO_STALE_MS` / `DEMO_PAUSE_MS` | `30000` / `120000` | Transport age for the demo slot. |
| `REMOTE_POLL_MS` | `2500` | Yahoo poll interval. |
| `DEMO_POLL_MS` | `250` | Simulated tape tick. |
| `TD_POLL_MS` | `1200000` (20 min) | Twelve Data poll interval — see §5 before lowering it. |
| `TD_DAILY_CREDIT_BUDGET` | `720` | Refusal threshold for Twelve Data cadence (§5). Not yet listed in `.env.example`. |
| `TWELVE_DATA_API_KEY` | empty | Empty key + a slot asking for `twelvedata` ⇒ that slot is `misconfigured`, never simulated. |
| `ENFORCE_MARKET_HOURS` | `false` in this repo | `true` parks a **real-provider** slot as `paused` over a closed session; a simulated tape has no session and is never affected (`feed.ts:281-288`, resolved into the plan at `config.ts:43,284`). **It does not gate market freshness** (A-10 is built): `false` does **not** buy 24/7 live execution — a closed session or a frozen provider still takes a real slot `degraded` → `paused` on the market clock (§4 step 7). |

Recommended production-shaped demo config (this repo's current `.env`):

```ini
DEMO_FEED="simulated"
DEMO_WIN_RATE="0.6"
LIVE_FEED="yahoo"
ENFORCE_MARKET_HOURS="false"
```

Result: demo trades against a steered tape at a ~60 % win rate **while live accounts trade the
real Yahoo tape in the same process**. The two tapes cannot see each other.

---

## 3. Feed states, and what each one permits

Per slot, evaluated on read (`types.ts:141-172`, `feed.ts:148-197`). The one conditional cell:

| State | `open` | `close` (manual) | `modify` | `manage` (SL/TP/stop-out) |
|---|---|---|---|---|
| `running` | ✅ | ✅ | ✅ | ✅ |
| `degraded`, real marks | ❌ | ✅ | ❌ | **✅** |
| `degraded`, simulated marks (live only) | ❌ | ❌ | ❌ | **✅** |
| `paused` | ❌ | ❌ | ❌ | ❌ |
| `misconfigured` / `starting` / `idle` / `stopped` | ❌ | ❌ | ❌ | ❌ |

`degraded` permits `close` (`types.ts:145`), and `closeAction(reason)` decides which
column a closure is judged under: a client or admin close is `close`, an SL/TP/stop-out is `manage`
(`types.ts:118`). So on a stale-but-real tape, nothing that reduces exposure is blocked.

- **`degraded`** — marks exist but are older than `*_STALE_MS`, or the provider failed
  `2`–`threshold-1` times, or a live slot is running on the failure fallback tape. Held positions
  keep their stop-loss, take-profit and stop-out evaluations against the last known marks; new
  orders are refused. Rationale: a client's protective orders were *accepted at those levels*, and
  refusing to honour them while the tape lags is worse than acting on a slightly old price.
- **`paused`** — marks older than `*_PAUSE_MS`, or `FEED_FAILURE_THRESHOLD` consecutive failures, or
  a `401/403/429` rejection, or a closed session.
  **Nothing executes, including SL/TP and stop-out.** The refusal message says so honestly:
  *"Live trading is paused: … Open positions are safe and no new trades will be filled."*
  Leaving `paused` takes two consecutive good polls, so a flapping host cannot thrash.
- **The `degraded` exception, as built (A-5).** `PERMISSIONS.degraded = ["manage","close"]`, and
  `degraded` **on simulated marks** is a separate documented table — `["manage"]` only
  (`types.ts:159-172`), applied inside the one money gate `permits()` (`feed.ts:149`). So a live slot
  that **fell back** to its own simulation manages stops and stop-outs but refuses a manual close,
  with a reason that says why: *"opening or closing on a price this system invented would book P&L
  that never happened"*. `modify` stays refused either way.
  **What that is not:** it is not a lock on an opted-in simulation. A slot *booted* with
  `LIVE_ALLOW_SIMULATED=true` is `running`, and `running` permits `close` — the boundary is consent,
  not the nature of the mark (design §10.10 ruling 2). `manage` stays unconditional in every
  `degraded` case, because a refused stop-out is a position left running unprotected.
- **This table is the *slot* verdict, and there is a second layer under it (A-11).** Even when a state
  permits `open`, an individual pair whose own print is older than the market floor is refused for
  `open`/`modify` by name — `close` and `manage` are never refused that way. A `running` slot can
  therefore still say no to *your* symbol; the payload's `staleSymbols` tells you which ones (§4 step 7).
- A live slot **never** silently becomes a simulation. Simulation reaches live only through
  `LIVE_ALLOW_SIMULATED=true`, and then:
  - **booted that way** (`LIVE_FEED=simulated` + the opt-in, or `PRICE_FEED=simulated` inherited):
    the slot is `running` and **it does take new orders** — `permits("open")` is `true`
    (`feeds.test.ts:426`). It is *not* pinned at `degraded`; what you get is a loud startup warning,
    `capped` in the resolved config, `simulatedMarks: true` in every payload and `SIMULATED live
    prices` in the boot line. This is the documented meaning of the opt-in: you asked to trade money
    against a synthetic tape, and the platform tells you so instead of refusing.
  - **fell back to it after the provider died**: pinned at `degraded` — `manage` and `close` only,
    no new risk (`feeds.test.ts:429-453`).

Money-path refusals are `FeedError`s: `FEED_STALE`/`FEED_PAUSED`/`FEED_STARTING`/`FEED_STOPPED`
⇒ HTTP **503**, `FEED_MISCONFIGURED` ⇒ HTTP **400** (`lib/http.ts:38`). Both carry a `code` so the
client can tell "try again" from "your config is wrong".

---

## 4. How to verify it is actually dual

1. **Startup log** — `bootstrap.ts` prints one line per slot plus every config warning:
   `[bootstrap] price feeds: demo=simulated (running) live=yahoo (running), trading engine running`
   A live slot on simulated marks prints `SIMULATED live prices`.
2. **REST** — `GET /api/prices` and `GET /api/prices/stream` accept `?account=<id>` (an unknown or
   foreign id is a 404 with `source: "rejected"`, never someone else's tape) and return the
   feed block: `feed` (`DEMO`/`LIVE`/`null`), `source` (`account`/`session-default`/`anonymous`),
   `feedKey` (`demo`/`live`), `mode`, `state`, `degraded`, `paused`, `stale`, `simulatedMarks`,
   `reason`, `marketOpen`, plus the two clocks — `lastMarkAt`, `lastQuoteMarketTime`, `marketAgeMs`,
   `transportAgeMs` — and `staleSymbols`, the pairs whose own print is past the market floor. Each tick
   carries `time`, that symbol's own print stamp.
   ```bash
   curl -s "http://localhost:3000/api/prices?account=$DEMO_ID" | jq .feed,.mode,.state
   curl -s "http://localhost:3000/api/prices?account=$LIVE_ID" | jq .feed,.mode,.state
   # → "DEMO" "simulated" "running"   /   "LIVE" "yahoo" "running"
   ```
   Two browser tabs, one on each account, show **different prices at the same instant**. That is
   the visible proof.
3. **Charts** — `/api/candles` is served by the same slot that prices the session, so the demo tab
   charts the simulated tape and the live tab charts Yahoo's bars.
4. **Admin** — the dashboard lists both feed statuses side by side
   (`admin/overview` → `feeds: [demo.status(), live.status()]`, `feedWarnings`), and each open
   position row is marked by *its own* account type's feed.
5. **Steering isolation** — `rg "liveCount|addLiveExposure|removeLiveExposure" src/` returns
   nothing; `rg "priceFeed\b" src/` returns nothing; `rg "serves" src/server/feeds/` returns
   nothing. The unit suite proves the behaviour: `src/server/feeds/feeds.test.ts` asserts a steered
   demo tape diverges from an unsteered twin while the live tape is untouched, that steering calls
   on the live slot throw, and that no plan can make a steerable slot serve `LIVE`.
6. **Degraded vs paused** — set `LIVE_STALE_MS="50"` and watch a live tab go `degraded` (banner:
   *"prices stale · open trades still managed"*) and then `paused` (*"trading paused — open
   positions are not being closed either"*). New orders are refused in both; `degraded` keeps
   executing SL/TP and still lets the client close, `paused` executes nothing at all.

### 7. What a real live tape actually requires

Say these out loud before you promise a client "live prices":

- **Yahoo has to be reachable from the host.** Do not eyeball it, run the probe:
  `node src/server/scripts/yahoo-probe.mjs --full` → `OK` per symbol and `PASS 10/10`, with the
  print read from `response[0].meta.regularMarketPrice`. Observed on this machine 2026-11-02:
  EURUSD 1.1196 / GBPUSD 1.3412 at 16:09:39Z and 1.1216 / 1.3423 earlier the same evening — the
  prints *moved between runs*, which is the evidence that matters. Exit 1 names the failing symbol.
  It is an **unofficial** endpoint: it can 403/429 or change shape without notice, and when it does
  the live slot pauses rather than inventing prices (§3).
- **The repo never shipped a broken Yahoo parser.** Say this plainly, because the story going around
  is wrong twice over. The committed parser already read the right JSON level
  (`HEAD:src/server/prices.ts:46-52` → `r?.response?.[0]?.meta`), and the committed code
  honoured `PRICE_FEED` (`:22`). The fix that produced real live prices was **feed precedence**:
  in the previous session's *uncommitted* working tree, any set `DEMO_WIN_RATE` resolved the whole
  system to `simulated`, so `start()` never issued a Yahoo request. Nobody should be hunting in
  `yahoo.ts` for that symptom — see design §10.6.
- **`DEMO_WIN_RATE` must not hijack the source — and it used to.** It selects **no** provider today;
  it only bends the demo slot's own tape (`config.ts:50-56`, `:141`). If `/api/prices` reports
  `mode: "simulated"` for a live account, look at `DEMO_WIN_RATE`, `PRICE_FEED` and `LIVE_FEED`
  before you look at any feed code.
- **A ~1-minute tape, polled every 2.5 s.** The live slot asks Yahoo about every 2.5 seconds, but the
  spark print itself refreshes roughly **once a minute**. Expect the chart and the bid/ask to step
  once a minute, not tick-by-tick; polling faster buys nothing and spends goodwill on an unofficial
  host.
- **Two clocks, and only one of them is the market.** Every slot now tracks **transport age** (when
  the host last answered → `lastMarkAt`, floors `LIVE_STALE_MS=15000` / `LIVE_PAUSE_MS=60000`) and
  **market age** (when the market last printed → `lastQuoteMarketTime`, floors
  `LIVE_MARKET_STALE_MS=300000` / `LIVE_MARKET_PAUSE_MS=1200000`). The state is the worse of the two
  (`feed.ts:232-257`). That is the whole A-10 fix: **a host that answers 200 with a dead price no
  longer looks healthy.**
  - **`ENFORCE_MARKET_HOURS=false` does not buy 24/7 live execution.** That switch gates the session
    clock only; market freshness is a property of the print, not of your calendar setting. A closed
    session or a frozen provider takes a real-provider slot `degraded` then `paused` **even on an
    install that asked to trade around the clock**, while a simulated demo tape keeps moving — its
    prints are stamped `now` by construction, so it has no age to run out of.
  - **What a weekend looks like now:** from Friday 22:00 UTC the live slot prints
    `degraded` at 5 minutes of print silence and `paused` at 20, with a reason that names the market
    rather than your connection —
    *"the newest quote is 3h 12m old while the host keeps answering (transport 2s)"* — and the demo
    tab carries on trading. This is correct behaviour, not an outage. The daily rollover lull can age
    a major out too; 5 minutes of silence on EURUSD means the source stopped forwarding.
  - **How to read it:** `curl -s "http://localhost:3000/api/prices?account=$LIVE_ID" | jq '{state,reason,marketAgeMs,transportAgeMs,lastQuoteMarketTime,prints:[.ticks[].time]}'`.
    `marketAgeMs` is what explains a weekend; `transportAgeMs` is what explains an outage; if only
    `transportAgeMs` moves, the host is fine and the market is not. `lastQuoteMarketTime` is what an
    "as of …" label should be drawn from, and `Tick.time` is the per-symbol print stamp.
  - **If you really want a slot to trade on older prints, raise the market knobs deliberately** —
    `LIVE_MARKET_STALE_MS` / `LIVE_MARKET_PAUSE_MS`, or `DEMO_MARKET_*` for a demo reading a real
    provider (they default to the `LIVE_*` values, because one dead price is one dead price). Do not
    reach for `ENFORCE_MARKET_HOURS=false`; it no longer does what you think, and writing down why you
    widened an age floor is the difference between a config and a decision.
  - **The batch clock has a per-symbol partner (A-11, built).** The slot clock is the *newest* print in
    the batch, so one frozen pair inside nine fresh ones does not move `state` — and it no longer gets to
    trade. Each symbol is aged on **its own** stamp (`feed.ts:491-497`), and the trading surface drops any
    pair past `LIVE_MARKET_STALE_MS` for `open` and `modify` only (`:508-516`). The refusal names the
    pair, its age and the threshold, not "prices are stale":
    *"Live EURGBP has no live quote — its print is 6m 12s old (the per-symbol gate is 5m) while the rest
    of the tape is live, so open would price risk off a dead quote. Held EURGBP positions are still
    marked, managed and closable."* (`:519-533`). `close`, SL/TP and stop-out are **never** refused this
    way — the frozen pair is exactly the one whose owner wants out, and a refused stop is a position
    running unprotected. The gate shares `LIVE_MARKET_STALE_MS`; there is no second knob, and you should
    not look for one.
  - **How to see it without ordering anything:** the payload carries `staleSymbols`, an array of the pairs
    whose own print is past the gate (`feed.ts:541` → `/api/prices` → `usePrices.ts:120`).
    `… | jq '{state,marketAgeMs,staleSymbols,prints:[.ticks[]|{symbol,time}]}'` — `state: "running"` with
    `staleSymbols: ["EURGBP"]` is the normal look of a healthy tape with one dead pair, and the board
    prints *"No live quote for EURGBP — held positions still marked and closable"* in the header and tags
    that cell `frozen` (`LiveTicker.tsx:21-41`). Empty `staleSymbols` = every pair printed inside the
    window. Do not read `state: "running"` as "this symbol is alive"; read `staleSymbols`, or that
    symbol's `Tick.time`.
- **How to tell which state you are looking at:**
  `curl -s "http://localhost:3000/api/prices?account=$LIVE_ID" | jq '{mode,state,reason,marketAgeMs,transportAgeMs,marketOpen}'`
  — `mode: "yahoo", state: "running"` with a small `marketAgeMs` = real, live tape;
  `state: "paused"` + a reason naming the print age = the market is shut and the platform knows it;
  a reason naming the transport = the host is not answering; `state: "degraded"` = real money being
  managed and closable on old marks, no new orders; `mode: "simulated"` on a live account = fix this
  before the meeting — if you *booted* it that way (`LIVE_ALLOW_SIMULATED=true`) it trades on numbers
  the system invented (§3), and if it *fell back*, `close` is now refused with a reason that says so.

---

## 5. Twelve Data: what the numbers say

The free tier is **800 credits/day**, and a comma-separated batch consumes **one credit per
symbol** (vendor-documented). With this platform's 10 instruments:

| Cadence | Polls/day | Credits/day | Verdict |
|---|---|---|---|
| 3 s (the old `TWELVE_DATA_POLL_MS`) | 28 800 | **288 000** | 360× the free tier. Impossible. |
| 20 min (current `TD_POLL_MS` default) | 72 | **720** | Fits, with 80 credits of headroom for candle backfill. |
| 1 poll / 13–18 min | ~80–110 | ~800–1100 | The ceiling; already too stale to trade. |

So Twelve Data free is an **observation and backfill source, not an execution source**: at 20-minute
marks the live slot is permanently `degraded`/`paused` by §3 and cannot accept orders. Yahoo
(batched `spark`, one HTTP request for all 10 symbols, no key, no published quota) is the live
execution source, with the caveat that it is **unofficial** and can rate-limit or reformat without
notice.

Guard now in place (`config.ts:117-132`, `:144-190`): a `twelvedata` slot whose cadence exceeds
`TD_DAILY_CREDIT_BUDGET` (default 720) is **refused at boot** — `LIVE_FEED=twelvedata` becomes
`misconfigured` with the arithmetic in the message (`288000 credits/day, but
TD_DAILY_CREDIT_BUDGET=720. Cheapest cadence that fits: TD_POLL_MS=1200000`); a demo slot instead
falls back to its own simulated tape with a warning, because the demo costs zero credits.
Poll failures back off exponentially with jitter (2.5 → 5 → 10 → 20 → 40 → 60 s cap) and honour
`Retry-After` (`upstream.ts:76-81`, `provider.ts:76-96`).

---

## 6. The legacy `PRICE_FEED` path

`PRICE_FEED` still works, as a per-slot default only. Two cases:

- `PRICE_FEED="yahoo"` → demo **and** live on Yahoo, no steering effect on live, both slots
  tradable. Deprecated but legal.
- `PRICE_FEED="simulated"` → **the live slot inherits simulated marks.** This is the one
  deliberate exception in the design: a legacy install keeps trading instead of being refused, but
  it is loud and capped:
  ```
  [bootstrap] feed config: PRICE_FEED=simulated is the legacy switch and applies to both roles
              (demo=simulated, live=simulated). Prefer DEMO_FEED and LIVE_FEED.
  [bootstrap] feed config: LIVE slot inherited PRICE_FEED=simulated: live marks are SIMULATED.
              Set LIVE_ALLOW_SIMULATED=true to keep this, or LIVE_FEED to a real provider.
  [prices:live] LIVE tape is running on SIMULATED marks (live marks are simulated (inherited
              from PRICE_FEED)) — held positions are marked, no new risk is taken on a real account
  ```
  That slot does **not** silently disappear and it is not quietly degraded either: it boots
  `live=simulated (running, SIMULATED live prices)` and **it will take new orders** — the opt-in is
  what makes that legal (`feeds.test.ts:418-426` asserts `permits("open") === true`). What protects
  you is visibility, not a lock: `capped` in the resolved config, `simulatedMarks: true` in every
  payload, the banner above in the log, and "Simulated" in the UI.
  Only a slot that **fell back after provider loss** is pinned at `degraded` — manages and closes
  what is open, takes nothing new (§3).

`PRICE_FEED_ON_FAILURE` **does not exist** — no code path reads it. Per-role policy is
`DEMO_FEED_ON_FAILURE` / `LIVE_FEED_ON_FAILURE` only. (An earlier revision of the design doc
claimed otherwise; it is corrected in §10 of that doc.)

Fix a legacy install by naming both switches:

```ini
DEMO_FEED="simulated"
LIVE_FEED="yahoo"
# PRICE_FEED="simulated"   ← remove, or leave commented: it is only a fallback
```

---

## 7. Closed list, and the risks that remain on purpose

Pass 4 (88 tests) closed the operator-facing list I published in the morning — per-slot market hours
come from the plan (`config.ts:43,284`), `TD_DAILY_CREDIT_BUDGET` is documented at `.env.example:111`,
the feed classes are genuinely narrowed (`LiveFeed`/`DemoFeed`), a bad `?account=` is a 404 with
`source: "rejected"`. Pass 5 built the `degraded`-on-simulated-marks gate (`types.ts:159-172`) and **A-10**
— market age with its own clocks and floors (§4 step 7), so the trap I warned about (print-ageing against
a 15 s transport threshold bricking a healthy feed) never arose: `MARKET_STALE_MS=300_000` /
`MARKET_PAUSE_MS=1_200_000` are separate numbers, deliberately wider than a ~60 s print cadence. Pass 6
built **A-11**, the per-symbol half of the same idea. **The gap list A-1 … A-11 is closed** (design §10.3);
nothing here asks you to hold a live account back.

What is left is not gaps. It is five accepted risks, each a decision with a reason, each visible somewhere
an operator can see it:

- **A protective close on a frozen pair is logged, not blocked.** I asked for a gate here and was
  overruled correctly: refusing to manage a dead pair leaves the position running with no stop at all.
  So the stop or TP fires on the last known mark and, **after the close settles**, the server logs a line
  naming the pair, the age of the mark and the settled price (`feed.ts:559-564` → `trading.ts:296-301`).
  Read it as: *that level may have fired late, early or not at all.* If you are reconciling a client's
  stop-out and see that warning, the price is the one to question.
- **Margin and P&L conversion rates are last-known by design.** The price that decides a trade is gated;
  the rate that only scales it is not — dropping a dead pair from the conversion map would turn one
  frozen symbol into an outage on the other nine. Same logic as the equity display.
- **Twelve Data carries no print timestamp.** Its `/price` body is `{symbol, price}`, so the provider
  stamps arrival (`twelvedata.ts:49-55`): `marketAgeMs` equals `transportAgeMs`, and *both* the slot and
  per-symbol print-age guards are inert on that mode — there is no print to age. It costs nothing today,
  because the cheapest cadence a free key can afford (20 min) already exceeds `LIVE_PAUSE_MS`, so a
  Twelve Data live slot pauses on transport alone. That is a **second, independent** reason the free tier
  is a backfill source and not an execution source (§5): it cannot tell you when its price was made.
- **`LIVE_ALLOW_SIMULATED=true` is a staging switch.** A live slot booted that way is `running` and takes
  orders and closes — the boundary is your consent, not the mark's age (design §10.10 ruling 2) — and it
  marks the house's own exposure on live accounts with numbers nobody made. The only guard is visibility:
  `simulatedMarks: true`, `mode: "simulated"`, the `SIMULATED live prices` boot line, the "Simulated"
  label in the ticker. Have a named person decide before a real account runs on it.
- **Anonymous views can show the other slot.** `publicFeed()` falls back to whichever slot is `running`
  when the preferred one is not; the payload labels the switch (`source: "anonymous"`, `simulatedMarks`)
  and `LiveTicker` prints "Simulated". Trade with `?account=` and you get that account's own tape or a 404.
- **The evidence gate is manual, by scope.** `npm run probe:yahoo` and `npm run probe:yahoo:full` are real
  scripts now (`package.json:14-15`) and print each quote's timestamp and age, so mixed per-symbol ages
  are documented provider behaviour rather than a fixture invention — one Yahoo batch has been seen
  carrying two distinct print stamps, and an earlier run a spread of 11 s across the set. But there is no
  repo-owned CI, and no test drives a *real* print through `/api/prices`: the route is covered by fixture
  tests. **Run `npm run probe:yahoo:full` before a client demo.**

Unmeasured provider facts: Twelve Data free-tier forex quote quality and its per-minute limit (design O2),
Yahoo's batch ceiling beyond the 10 symbols confirmed live (design O3). Demo win-rate fidelity is
**nearest-target, not per-account** (design §4.3): one shared demo tape aims at one client's target per
symbol at a time — fair, starving nobody, approximate. Per-account demo books are deferred (D1), as are
Twelve Data as a genuine execution source (D3, needs a paid tier) and persistent candle history (D4).
