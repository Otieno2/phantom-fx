# DUAL PRICE FEED — Architecture Design

**Author:** ATLAS (Senior Systems Architect) · **Date:** 2026-11-02 · **Status:** design, **amended
2026-11-02 18:05 after the as-built conformance review — see §10.** §0–§9 remain the normative
design; §10 records which rulings were adopted, which were implemented differently, what is still
open, and corrects two claims this document itself got wrong.
**Target repo:** `phantom-fx` (Next.js 16.4.0 / React 19 / TypeScript / Prisma + SQLite)
**Audience:** NOVA (implementation), INFINITY (coordination), ORACLE (steering maths review, optional).

Business requirement: **DEMO accounts run on a simulated tape with win-rate steering (`DEMO_WIN_RATE`) while LIVE accounts run on a real provider (Yahoo or Twelve Data) at the same time.** Today one global feed serves both, so the goals conflict.

---

## 0. Verified ground truth (what I read, not what the docs claim)

Read in full: `src/server/prices.ts`, `src/server/trading.ts`, `src/server/engine.ts`, `src/server/bootstrap.ts`, `src/server/feeds/twelvedata.ts`, `src/server/instrumentCache.ts`, `src/app/api/prices/route.ts`, `src/app/api/prices/stream/route.ts`, `src/app/api/candles/route.ts`, `src/app/api/orders/route.ts`, `src/app/api/admin/overview/route.ts`, `src/lib/auth.ts`, `src/lib/http.ts`, `src/lib/instruments.ts`, `src/lib/trading/{math,fxSim,demoOutcome}.ts`, `src/lib/client/usePrices.ts`, `src/components/trade/{TradeTerminal,AccountBar,PriceChart}.tsx`, `prisma/schema.prisma`, `.env`, `.env.example`, `package.json`.

Confirmed defects / facts:

| # | Finding | Evidence |
|---|---|---|
| F1 | `PriceFeed` declares `demoMode`, `liveMode`, `demoMids`, `liveMids`, `liveTimer`, `liveFailures`, `lastLiveUpdate` and **no code reads or writes them** | prices.ts:96-110, grep shows zero other references |
| F2 | `resolveFeedMode(forAccountType)` exists; **no caller ever passes an account type**. `mode` is initialised as `resolveFeedMode()` with no argument | prices.ts:95 |
| F3 | `fetchTwelveDataPrices`, `isTwelveDataConfigured` imported, never called; `getTwelveDataQuota` never imported | prices.ts:22 |
| F4 | `start()` runs exactly one feed from `this.mode`; a Yahoo poll that fails 3× with no marks **silently flips `this.mode = "simulated"`** and starts the simulation | prices.ts:209-215 |
| F5 | `applyDemoSteer()` mutates the one shared `book`, and returns early when `liveCount > 0` — one live position disables steering for every demo user | prices.ts:262-278 |
| F6 | Steering picks **one target per symbol, first-wins by Map insertion order** — concurrent demo positions on the same pair fight | prices.ts:267-270 |
| F7 | `engine.processTick()` evaluates **all** pending orders and **all** open positions (demo and live) against one global `priceFeed.quotes()` | engine.ts:13-14, 16-56 |
| F8 | `/api/prices`, `/api/prices/stream`, `/api/candles` carry no account context; both price routes emit the global `priceFeed.mode` | route.ts files |
| F9 | `SimHistory` is a `globalThis` singleton; demo bars and live bars share one array. `SimHistory.seed()` is **dead code** | prices.ts:314-365 |
| F10 | `getCandles()` branches on the **global** `priceFeed.mode`, so chart source follows whichever feed happens to be running | prices.ts:382 |
| F11 | `marketOpen()` returns `true` whenever `priceFeed.mode === "simulated"`, i.e. the mode of one global feed decides market hours for everyone | prices.ts:416 |
| F12 | `PRICE_FEED` is documented in `.env.example` and `DUAL_FEED_GUIDE.md` but **read nowhere in code** | grep: only the comment at prices.ts:82 |
| F13 | Twelve Data client has a real type error: `src/server/feeds/twelvedata.ts(69,61): error TS18047: 'value' is possibly 'null'` | verified with `npx tsc --noEmit --incremental false` |
| F14 | **Baseline typecheck is already red: 12 errors** — 8 in `src/lib/trading/fxSim.ts` (TS7053 `UsdBook` index signature), 3 in `src/lib/trading/demoOutcome.test.ts` (`ProcessEnv` requires `NODE_ENV`), 1 in `feeds/twelvedata.ts`. Quality gates must be expressed as a *delta*, not "clean" | same command |
| F15 | Live env: `DEMO_FEED="simulated"`, `LIVE_FEED="yahoo"`, `DEMO_WIN_RATE="0.6"`, `ENFORCE_MARKET_HOURS="false"`, `TWELVE_DATA_API_KEY` empty | `.env` |
| F16 | **Yahoo is reachable from this machine** — NOVA's live test returned a real EURUSD value ≈ 1.1215. The real-provider path is verifiable, not hypothetical | NOVA, corroborated by §6 design test |
| F17 | Auth layer is sufficient for routing: `getCurrentUser()` verifies the `pfx_session` JWT and loads the user; `requireOwnAccount(userId, accountId)` proves ownership; `Account.type ∈ {"DEMO","LIVE"}` with `@@unique([userId, type])` (one demo + one live account per user) | auth.ts:40-76, schema.prisma:23-38 |
| F18 | **Was:** staleness measured against poll success, not against the print — a host answering 200 with a frozen close kept the slot `running`. **Fixed on the pass-5 tree (A-10 closed).** The slot now keeps **two clocks**: `lastMarkAt` (transport — when we last heard from the host) and `lastQuoteMarketTime` (market — when the market last printed), each with its own floors, and `ageVerdict()` decides the state from both. A frozen tape while the host keeps answering reads `degraded` then `paused`, with the reason naming the print age. `ENFORCE_MARKET_HOURS=false` cannot lift it: it gates the session clock, not whether a price is alive | `feed.ts:232-257` (`ageVerdict`), `:262-264` (`marketAgeMs`), `:365-379` (both clocks, market clock recomputed over the current marks), `config.ts:156-170` (floors) — §10.3 A-10, §9.1 K11, §10.10 |
| F19 | **The market clock aged the batch, not the symbol** *(the defect as filed; A-11, now CLOSED)*. `lastQuoteMarketTime` is the *newest* print in the payload (`:377-379`), so one frozen pair among nine fresh ones never moved the slot state, and the slot-level surface filled the aged symbol at a dead price while the slot said `running`. **As built:** a per-symbol clock, `quoteAgeMs(symbol)` (`feed.ts:491-497`, clamped `Math.min(m.time, now)` like the slot clock, `null` when unmarked) and a per-symbol gate on the **trading surface only**, `tradeQuotes(action)` (`:508-516`), which drops aged pairs for `open`/`modify` and returns the full map for `close`/`manage`; `assertSymbolTradable()` throws `FEED_STALE` with a reason naming the pair, its age and the threshold (`:519-533`). Aged pairs stay in `ticks()`/`displayQuotes()` and are published as `staleSymbols` (`:541` → `types.ts:95` → `feed-context.ts:99` → `LiveTicker.tsx:21-41`). `quoteFor()` is documented display-only and has no production callers | `feed.ts:491-548`, `:559-564`; `trading.ts:68-74`, `:296-301`; `engine.ts:29` — §10.3 A-11, §10.10 |

Design constraints taken as given: single Node process (`instrumentation.ts` → `startServices()`), SQLite, no Redis, no message bus, 10 instruments (`INSTRUMENTS`), no plan to add a WebSocket broker.

---

## 1. Feed topology — decision: **two independent feed instances behind a registry, sharing refcounted upstream pollers**

### 1.1 Options considered

| Option | Shape | Verdict |
|---|---|---|
| **A. One feed, per-account views** | keep the `priceFeed` singleton; add `quotesFor(type)`, `midsFor(type)` | Rejected. Isolation becomes *discipline*: every one of the ~15 call sites must remember to pass the right key. One forgotten argument re-creates F5/F7. F1 is the proof — someone already tried this shape inside one object and abandoned six fields half-written. |
| **B. Two fully independent feeds, each owning its own poller** | `new PriceFeed(demoPlan)`, `new PriceFeed(livePlan)` | Rejected as stated. If both roles resolve to the same remote provider, we make **two** HTTP call loops against Yahoo/Twelve Data: doubled request rate, doubled ban exposure, doubled quota burn, and two different marks for the same pair at the same instant. |
| **C. Chosen: two feed *views* + refcounted *upstreams*** | each role gets its own `Feed` instance (own marks, own candle store, own state machine, own steering surface); remote providers are one shared `Upstream` per provider id, subscribed by whichever feeds need it | Accepts B's type-level isolation and removes its cost duplication. |

### 1.2 Why C fits *this* codebase specifically

1. **The blast radius of F5 is caused by shared mutable state, not by steering itself.** `applyDemoSteer()` calls `setPairMid(this.book, …)` on the one book that also feeds live marks. Splitting the instance means the live instance **has no `book` field and no `setPairMid` import**. Isolation stops being a rule and becomes unrepresentable to violate.
2. **The engine is the hard part, and C matches it.** F7 is the real bug: `processTick()` settles every account against one quote set. Under C the engine subscribes per feed and filters by account type — a mechanical change (relation filter, already supported by Prisma/SQLite: `where: { status: "PENDING", account: { type: "DEMO" } }`). Under A the engine would need a per-account quote-set lookup inside three nested loops, with 6 new parameters threaded through `openPosition` / `closePositionLocked` / `getAccountState`.
3. **Config already assumes two modes.** `resolveFeedMode("DEMO"|"LIVE")` is correct and complete; it simply has no consumer (F2). C makes the existing function the authority instead of deleting it.
4. **Upstream sharing is ~40 lines and buys the safety we need on Yahoo.** Yahoo is unofficial (F16: reachable today, `DUAL_FEED_GUIDE.md` repeatedly reports rate-limiting). Two loops polling the same host at 2.5 s doubles the probability of a 429 that would pause real-money trading for no reason.
5. **`globalThis` singletons stay, but there is only one of them** (the registry), which is what keeps dev-mode HMR from starting feeds twice.

### 1.3 Component blueprint

```
                     ┌──────────────────────────────────────────────┐
                     │ FeedRegistry (globalThis.__feedRegistry)     │
                     │  demo: DemoFeed      live: LiveFeed          │
                     └───────────┬───────────────────┬──────────────┘
                     DemoFeed    │                   │  LiveFeed
        role "demo"              │                   │  role "live"
   mode = DEMO_FEED              │                   │  mode = LIVE_FEED
   ┌─────────────────────────┐   │                   │  ┌─────────────────────────┐
   │ marks (own Map)         │   │                   │  │ marks (own Map)         │
   │ CandleStore (own)       │   │                   │  │ CandleStore (own)       │
   │ FeedStateMachine (own)  │   │                   │  │ FeedStateMachine (own)  │
   │ DemoSteering  ◄─────────┼───┘                   │  │ (absent by construction)│
   │ own SimSource if        │                       │  │ assertTradable() gate   │
   │ DEMO_FEED=simulated     │                       │  └───────────┬─────────────┘
   └───────────┬─────────────┘                       │              │
               │ subscribe (no sharing needed:       │              │ subscribe
               │ simulated is never shared)          │              │
               │                                     │       ┌──────▼───────────────────┐
               │                                     │       │ Upstream registry        │
               │  if DEMO_FEED=yahoo/twelvedata ─────┼──────►│ "yahoo"      → 1 poller   │
               │                                     │       │ "twelvedata" → 1 poller   │
               └─────────────────────────────────────┘       │ refcount acquire/release  │
                                                            └───────────────────────────┘
```

Rules:
- **Simulated sources are never shared.** A shared simulated book is exactly F5. If both roles are `simulated`, two independent books run — the live one is unsteerable and visibly synthetic (gated by `LIVE_ALLOW_SIMULATED`, §8).
- **Remote upstreams are shared and refcounted**, keyed by provider id. Interval of an upstream = `min(interval requested by its subscribers)`; all feeds publishing from that upstream re-emit at their own cadence but never poll twice.
- A feed never calls a provider directly; it only subscribes.

---

## 2. Interface contract — binding for NOVA

This is the merge-surface. Names, arities and return types are final; **deviations require a comment in the PR, not a silent rename.**

### 2.1 New files

```
src/server/feeds/types.ts        # all shared types + errors (no runtime deps)
src/server/feeds/config.ts       # env -> FeedPlan (pure, total, testable)
src/server/feeds/feed.ts         # class FeedInstance implements DemoFeed & LiveFeed surfaces
src/server/feeds/steering.ts     # class DemoSteeringController implements DemoSteering
src/server/feeds/state.ts        # class FeedStateMachine
src/server/feeds/upstream.ts     # upstream registry, refcounted pollers
src/server/feeds/sources/simulated.ts
src/server/feeds/sources/yahoo.ts
src/server/feeds/sources/twelvedata.ts   # moves the existing client body, fixes F13
src/server/feeds/candles.ts      # CandleStore: MemoryCandleStore (sim) | RemoteCandleStore
src/server/feeds/registry.ts     # priceFeedFor(), demoFeed(), liveFeed(), startFeeds()
```

`src/server/prices.ts` survives as a **thin facade** re-exporting the registry helpers (so unre-migrated call sites keep compiling) and is deleted in the follow-up slice, not this one.

### 2.2 `types.ts` — exact signatures

```ts
import type { BidAsk, QuoteMap } from "@/lib/trading/math";
import type { Candle } from "./candles";   // §7.2: `export type Candle = SimCandle`

export type AccountType = "DEMO" | "LIVE";            // matches Account.type
export type FeedRole = "demo" | "live";
export type FeedMode = "simulated" | "yahoo" | "twelvedata";

export type FeedState =
  | "idle"           // constructed, start() not called
  | "starting"       // started, zero marks yet
  | "running"        // fresh marks; every action permitted
  | "degraded"       // marks exist but older than staleMs; management-only
  | "paused"         // no trustworthy marks; all money paths rejected
  | "misconfigured"  // env cannot produce a legal feed (e.g. live=simulated without the opt-in)
  | "stopped";

export type FeedAction = "open" | "close" | "modify" | "manage";

/** Unchanged field-for-field from the current Tick. Do not add fields: client types.ts/usePrices.ts mirror it. */
export interface Tick {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  changePct: number;
  time: number;
}

export interface FeedStatus {
  role: FeedRole;
  mode: FeedMode;
  state: FeedState;
  startedAt: number;        // epoch ms, 0 before start
  lastMarkAt: number;       // epoch ms, 0 before first mark
  stale: boolean;
  failures: number;         // consecutive upstream failures
  pausedReason: string | null;
  steeringEnabled: boolean; // always false for role "live"
  winRate: number | null;   // always null for role "live"
}

export interface DemoPositionTrack {   // moved verbatim from prices.ts:42-52
  id: string; accountId: string; symbol: string;
  side: "BUY" | "SELL"; openPrice: number;
  stopLoss: number | null; takeProfit: number | null;
  pipSize: number; spreadPips: number;
}

/** Capability surface: exists ONLY on the demo feed. */
export interface DemoSteering {
  track(pos: DemoPositionTrack): void;
  updateStops(id: string, sl: number | null, tp: number | null): void;
  untrack(id: string): void;
  clearAccount(accountId: string): void;
  status(): { enabled: boolean; winRate: number | null; tracked: number };
}

export interface Feed {
  readonly role: FeedRole;
  mode(): FeedMode;
  state(): FeedState;
  status(): FeedStatus;

  start(): void;                 // idempotent
  stop(): void;                  // idempotent; releases upstream subscription

  ticks(): Tick[];               // all known symbols, instrument-ordered
  quotes(): QuoteMap;            // symbol -> { bid, ask, time }
  quoteFor(symbol: string): (BidAsk & { time: number }) | null;
  candles(symbol: string, tf: string): Candle[];      // sync, from this feed's own CandleStore

  /** THE money gate. Throws FeedError for any action the current state forbids. */
  assertTradable(action: FeedAction): void;
  isTradable(action: FeedAction): { ok: true } | { ok: false; code: FeedErrorCode; reason: string };

  onTick(listener: (ticks: Tick[]) => void): () => void;    // returns unsubscribe
  onStatus(listener: (status: FeedStatus) => void): () => void;
}

export interface DemoFeed extends Feed { readonly role: "demo"; readonly steering: DemoSteering; }
export interface LiveFeed extends Feed { readonly role: "live"; }   // deliberately empty: no steering surface

export type FeedErrorCode =
  | "FEED_PAUSED" | "FEED_STALE" | "FEED_MISCONFIGURED" | "FEED_STARTING";

export class FeedError extends Error {
  readonly code: FeedErrorCode;
  readonly status: 400 | 503;          // 503 for paused/stale, 400 for misconfigured
  constructor(code: FeedErrorCode, message: string);
}
```

`Candle` is `SimCandle` (`import type { SimCandle as Candle } from "@/lib/trading/fxSim"`), re-exported from `feeds/candles.ts` so the store and the interface share one definition. Field shape is unchanged, so `PriceChart.tsx` needs no type edit.

### 2.3 `registry.ts` — the selection API

```ts
export function priceFeedFor(accountType: AccountType): DemoFeed | LiveFeed;
export function priceFeedFor(accountType: "DEMO"): DemoFeed;
export function priceFeedFor(accountType: "LIVE"): LiveFeed;
export function priceFeedFor(accountType: AccountType): DemoFeed | LiveFeed { /* map */ }

export function demoFeed(): DemoFeed;
export function liveFeed(): LiveFeed;
/** Pre-login / marketing ticker. Resolved from PUBLIC_FEED (default "live"), §8. */
export function publicFeed(): Feed;

/** Source of truth = DB, never a client-supplied type. Throws HttpError(404) if missing. */
export function accountTypeOf(accountId: string): Promise<AccountType>;
export function feedForAccount(accountId: string): Promise<DemoFeed | LiveFeed>;

export function startFeeds(): void;      // idempotent, called once from bootstrap
export function stopFeeds(): void;
export function feedStatuses(): FeedStatus[];   // admin panel

/** Deprecated shim kept this slice only; every use is a review defect. */
export const priceFeed: Feed;   // === publicFeed()
```

Overloads are mandatory so that `priceFeedFor("LIVE").steering` is a compile error. That single line is the structural guarantee the business requirement depends on.

### 2.4 `config.ts` — pure env resolution

```ts
export interface FeedPlan {
  role: FeedRole;
  mode: FeedMode;
  pollMs: number;          // simulated: DEMO_POLL_MS / LIVE_SIM_POLL_MS; remote: REMOTE_POLL_MS
  staleMs: number;
  pauseMs: number;
  maxFailures: number;
  steering: { enabled: boolean; winRate: number | null };
  allowSimulated: boolean; // LIVE_ALLOW_SIMULATED
  onFailure: FailurePolicy; // "pause" | "simulate" — name adopted from NOVA config.ts:6 (§2.6-R5); default "pause" for live
}
export interface ResolvedPlan { demo: FeedPlan; live: FeedPlan; publicRole: FeedRole; warnings: string[]; }
export function resolvePlan(env?: NodeJS.ProcessEnv): ResolvedPlan;
```

`resolvePlan` must be pure and cover the whole §8 table; no `process.env` reads anywhere else in `src/server/feeds/**` after this slice.

### 2.5 Public function signatures that must **not** change (merge-risk reduction)

Deliberately unchanged — only their bodies resolve feeds: `getAccountState(accountId)`, `placeOrder(accountId, input)`, `openPosition(accountId, inst, side, volume, sl, tp, quotes, pendingOrderId?)`, `closePosition(positionId, accountId, reason)`, `closePositionLocked(positionId, reason, quotes)`, `modifyPosition(...)`, `cancelOrder(...)`, `positionsWithPnl(positions, quotes)`.

Changed signatures (callers must be updated in the same commit):

```ts
// engine.ts
export async function processTick(feed: DemoFeed | LiveFeed): Promise<void>;   // was: ()
export function startEngine(): void;                                            // unchanged, subscribes to both feeds

// prices.ts / trading.ts
export function marketOpen(feed?: Feed): boolean;   // was: marketOpen(); default = publicFeed()

// bootstrap.ts
export async function startServices(): Promise<void>;  // unchanged; now calls startFeeds() + hydrate per role
```

Events: the old `priceFeed.on("ticks", …)` becomes `feed.onTick(cb) → unsubscribe`. The stream route must use the returned unsubscribe in `cleanup()`.

### 2.6 Reconciliation with the implementation appearing in parallel (written 15:32, mid-design)

While this document was being written, `src/server/feeds/{config,feed,provider,sim,yahoo,twelvedata}.ts` appeared on disk (NOVA, uncommitted), followed by `feeds/registry.ts` (15:34) and `src/server/feed-context.ts` (15:35). I read their exported surface, all of `config.ts`, `feed.ts:61-140/184-208`, and all of `feed-context.ts`. **The tree was moving under this design**: the line numbers in the table below cite files as they stood at 15:38 and are **stale** — they were re-verified against the current tree (17:56–17:58) in §10, which is where the rulings' as-built status lives. Where NOVA's shape is better than mine, I adopt it; where it re-opens a finding from §0, it must change.

**SHIP-BLOCKING — SB1: the legacy "shared tape" collapse reproduces the exact bug this project exists to fix.**
`config.ts:26` `isDualFeed()` is true only if `DEMO_FEED` **or** `LIVE_FEED` parses. When neither is set, `feedPlan()` (`config.ts:87-99`) returns **one** `FeedConfig` with `steerable: true`, `serves: ["DEMO","LIVE"]`, `onFailure: "simulate"`, and both slots collapse onto it (`{ dual: false, demo: shared, live: shared }`). Result: win-rate steering moves the marks that LIVE accounts trade against, and a dead provider silently becomes simulated prices on the live role — F5 and F4, rebuilt by construction.
**It is reachable from the committed config:** `.env.example` sets `PRICE_FEED="simulated"` and `DEMO_WIN_RATE="0.6"` and sets **neither** `DEMO_FEED` nor `LIVE_FEED`. `legacyFeedMode()` (`config.ts:44`) sees a win rate, returns `"simulated"` → non-dual → steered tape serving `LIVE`. The current developer `.env` (F15) *does* set both keys, so the target install is safe; the example install is not.
**Ruling: delete the collapse.** There are always two slots. `serves: AccountType[]` and `key: "legacy"` go away; `key` is `"demo" | "live"` and the served type is implied by `key`. Enforce the invariant at startup (and in test T9) rather than trusting callers:

```ts
// INVARIANT — asserted in feedPlan()/startFeeds(), never inferred
if (cfg.steerable && servesLive(cfg)) throw new FeedError("FEED_MISCONFIGURED", "steering cannot serve LIVE");
// servesLive(cfg) === (cfg.key === "live")   — the legacy slot disappears, so this is the only case
```
and `onFailure` must default to `"pause"` for any live slot. The `demoWinRateFromEnv()` → mode link (`config.ts:44`) is removed outright (R3).

| # | Divergence observed | Ruling |
|---|---|---|
| R1 | `class Feed extends EventEmitter` (`feed.ts:76`) instead of `interface Feed` + `DemoFeed`/`LiveFeed` | **Adopt NOVA's single class** — less churn, and `FeedOverrides` (`feed.ts:61-66`) is better than anything in my draft. Keep the **typed surfaces** as the compile-time boundary: export `interface DemoFeed extends Feed { steering: DemoSteering }` and `LiveFeed`, and make `priceFeedFor()`'s overloads (§2.3) return the narrowed types. Type-only, zero runtime cost, preserves "`.steering` on LIVE does not compile". |
| R2 | Steering is guarded at runtime: `if (!this.config.steerable) return;` (`feed.ts:242`, `283`) | **Convert the silent no-op into a throw.** A `trackDemoPosition()` reaching a non-steerable feed means the caller resolved the wrong feed — that is a defect, and silence is precisely how F5 survived. `throw new FeedError("FEED_MISCONFIGURED", "steering is not available on the live feed")`. R1 stops legitimate misuse; R2 catches illegitimate misuse loudly. |
| R3 | `legacyFeedMode()` lets `DEMO_WIN_RATE` select the provider (`config.ts:44`) | **Reject.** Precedence is `DEMO_FEED`/`LIVE_FEED` → `PRICE_FEED` → role default (`simulated` demo / `yahoo` live). `DEMO_WIN_RATE` only ever sets `steering.winRate`. Same defect as F12/§8.2: one demo-scope variable must not choose the system's price source. |
| R4 | `PRICE_FEED` honoured only in the non-dual branch (`config.ts:45`) | **Keep the honouring, drop the branch:** `PRICE_FEED` becomes the per-role fallback (SB1). This makes §8.1 true for every install rather than only for installs missing both new keys. |
| R5 | `FailurePolicy = "pause" \| "simulate"` (`config.ts:6`) via `DEMO_FEED_ON_FAILURE` / `LIVE_FEED_ON_FAILURE` / `PRICE_FEED_ON_FAILURE`, defaulting to `"simulate"` for demo and legacy | **Adopt the names** (`FailurePolicy`, `*_FEED_ON_FAILURE`) over my `LIVE_FEED_FALLBACK_TO_SIMULATED`, and rename my `LIVE_MAX_FAILURES` → their existing `FEED_FAILURE_THRESHOLD` (`config.ts:85`). But: default `"pause"` for any live slot (SB1), and `policy === "simulate"` on a live slot additionally requires `LIVE_ALLOW_SIMULATED=true` — otherwise `misconfigured`. `feed.ts:133-141` currently starts a **simulation merely because an API key is missing**, which is the F4 class of bug; reject that. **One deliberate exception:** a live slot whose mode was inherited from `PRICE_FEED=simulated` gets `allowSimulated` implicitly plus a startup warning — it keeps legacy installs trading while removing the contamination, which is the actual point. |
| R6 | `isStale()` + `providerDown` boolean (`feed.ts:184-191`): one "blocked" notion | **Insufficient — add `degraded`** from §5.2. The two states carry different engine permissions: `degraded` = manage-only (SL/TP/stop-out still execute, protecting live risk), `paused` = nothing executes. One boolean forces a bad choice: halting protective-order evaluation at 15 s, or accepting new trades on 90 s-old marks. Keep `isStale()` as a derived field; add per-slot `staleMs`/`pauseMs`. |
| R7 | `createYahooProvider()` / `createTwelveDataProvider()` constructed **per instance** (`feed.ts:111-118`), though `providerForMode()` (`feed.ts:397`) hints at a shared factory | **`providerForMode(mode)` becomes a memoized upstream singleton per mode** (§1.3): the poll loop and failure counters live on the provider, `Feed` subscribes and re-emits. Otherwise `DEMO_FEED=yahoo` + `LIVE_FEED=yahoo` = two 2.5 s loops against an unofficial host (§6.2c). The target config (demo=simulated) is unaffected — fix this before anyone points demo at a remote provider. |
| R8 | `CANDLE_CACHE_MS = 20_000` flat (`provider.ts:35`); `CandleHistory` per feed (`sim.ts:6`) | **Store-per-feed adopted — that is §7.2, correct.** Replace the flat TTL with §7.3's per-timeframe table plus in-flight coalescing (18 730 vs 216 000 requests/day); cap 5 000 bars per symbol per feed. |
| R9 | `Tick` (`feed.ts:17`) and `DemoPositionTrack` (`feed.ts:26`) re-declared; `FeedMode`/`AccountType` re-declared in `config.ts:3-4` | Duplicate declarations are drift. **`types.ts` owns them**; `config.ts`/`feed.ts` import. `Tick` stays field-for-field (§2.2) so `usePrices.ts` and `trade/types.ts` need no edit. |
| R10 | `registry.ts` appeared at 15:34 with `feeds()`, `feedFor(accountType: AccountType \| null \| undefined)`, `feedForPosition`-equivalent | **Adopt the module, fix the signature.** `feedFor()` must take a **required** `AccountType` — an optional/nullable role is exactly how F2 survived (`resolveFeedMode(forAccountType?)` had a caller-less parameter for months). `priceFeedFor()` overloads (§2.3) are the typed surface; `feedFor(type)` may stay as the untyped internal if it throws on null. `feedForRequest(req)` in `src/server/feed-context.ts` is **correct on the trust rule** — ownership-checked via `where: { id: accountId, userId: user.id }`, type read back from the row, never accepted from the client (§3.1). Keep it. |
| R11 | `feed-context.ts:34` — anonymous / no-`account` requests fall back to `feedFor("DEMO")` | **Reject the hardcoded DEMO.** That puts the marketing ticker, which promises *"Live market prices"* (`page.tsx:9`), on the **steered simulated tape** — the credibility failure §3.5 exists to prevent. Route the fallback through `publicFeed()` (`PUBLIC_FEED`, default `live`), and extend `FeedSelection.source` to `"account" \| "session-default" \| "anonymous"` so the payload can say which. |
| R12 | `feedForAccountType(type: string \| null \| undefined)` and `feed-context.ts:29` both coerce: `type === "LIVE" ? "LIVE" : "DEMO"` | **Reject the coercion; it can price real money on the demo tape.** `Account.type` is an unconstrained `String` (`schema.prisma:28`), so a row holding `"live"`, `"Live"`, `"REAL"` or `""` silently resolves to **DEMO** — i.e. a LIVE account gets steered simulated marks, the exact opposite of the business requirement. Rule: `if (type === "LIVE") return "LIVE"; if (type === "DEMO") return "DEMO"; throw new FeedError("FEED_MISCONFIGURED", \`unknown account type on ${accountId}\`)`. Fail closed on the money path; never guess. Add test T10. |

Adopted from NOVA beyond the table: `FeedOverrides` test injection (extend T2/T6 to use it instead of patching timers), and their `status()` fields (`feed.ts:199-208`: `provider`, `steerable`, `paused`, `reason`, `trackedDemoPositions`) — keep those names, add `role`, `lastMarkAt`, `winRate`, `state`. `feed.ts:73-75`'s own comment ("Nothing is shared between two Feed instances… keeps a steered demo tape and a real live tape from contaminating each other") is the right principle; SB1 is the case where the code does not yet follow it.

**T9 (new, from SB1).** `feedPlan({ PRICE_FEED: "simulated", DEMO_WIN_RATE: "0.6" })` — the committed `.env.example` shape — must yield **two** configs, the live one with `steerable === false` and `onFailure === "pause"` (unless `LIVE_ALLOW_SIMULATED=true`), and no config may satisfy `steerable && servesLive`.

**Naming ruling.** `resolvePlan()` in §2.4 **is** NOVA's `feedPlan()` — keep `feedPlan()`, and extend its return to carry the §8 fields (`staleMs`, `pauseMs`, `publicRole`, `warnings`). Every other name in §2 (`priceFeedFor`, `demoFeed`, `liveFeed`, `publicFeed`, `feedForAccount`, `accountTypeOf`, `startFeeds`, `stopFeeds`, `feedStatuses`, `DemoSteering`, `FeedStatus`, `FeedError`, `FeedState`, `CandleStore`) is authoritative; `CandleHistory` (`sim.ts:6`) is renamed `CandleStore` at implementation time or aliased, but not both exported.

### 2.6.1 Ruling status as built (verified 2026-11-02 18:05 against the 17:56–17:58 tree)

Line numbers below are **current**. `typecheck` clean; `npm test` 70/70 across 5 files; review gates
(`priceFeed`, `liveCount`/`addLiveExposure`/`removeLiveExposure`, `serves`, `SimHistory`) return zero
hits in `src/`.

| # | Status | Where, and what changed since the ruling |
|---|---|---|
| SB1 | **adopted, closed** | `feedPlan()` always returns two slots (`config.ts:214-240`); `key: FeedRole` + `purpose: servedType(role)` replace `key:"legacy"`/`serves[]`; the invariant is asserted per slot (`config.ts:229-234`) and `createRegistry` throws if the two instances are identical (`registry.ts:45`). Tested: `feeds.test.ts:150-173` |
| R1 | **adopted class, narrowed surfaces NOT built** | `Feed` remains one class (`feed.ts:71`); there is no `DemoFeed`/`LiveFeed` type and no `priceFeedFor()` overload, so `liveFeed().trackDemoPosition(…)` still **compiles** — see §10.3 A-1 |
| R2 | **adopted** | `notSteerable()` throws `FEED_MISCONFIGURED` from all four steering methods (`feed.ts:458-518`); tested `feeds.test.ts:212-245` |
| R3 | **adopted** | `roleMode()` never consults `DEMO_WIN_RATE` (`config.ts:50-56`); `winRate` is forced `null` for the live slot (`config.ts:141`); tested `feeds.test.ts:101-118` (T9) |
| R4 | **adopted** | `PRICE_FEED` is the per-role fallback with a startup warning (`config.ts:53-54`, `219-224`); tested `feeds.test.ts:87-93`, `:120-130` |
| R5 | **adopted, plus the R5 exception** | AND-gate (`config.ts:157-164`), keyless-`twelvedata` live slot is `illegal` (`:184-186`), inherited `PRICE_FEED=simulated` warns and caps (`:173-182`), a missing key no longer starts a simulation except for a demo slot that says so (`feed.ts:227-239`). `FEED_FAILURE_THRESHOLD` kept (`config.ts:143`). **Correction:** `PRICE_FEED_ON_FAILURE` is *not* implemented and is not in §5.4's block any more — see §10.4 C-1 |
| R6 | **adopted** | `degraded` and `paused` are separate states with distinct permissions (`types.ts:94-106`), per-slot `staleMs`/`pauseMs` (`config.ts:201-202`), age-based `settleAge()` (`feed.ts:180-193`); tested `feeds.test.ts:253-320` |
| R7 | **adopted** | `Upstream` is memoized per `(mode, pollMs)` on `globalThis` and refcounted by subscribers (`upstream.ts:135-151`); one poll reaches both slots (`feeds.test.ts:541-609`) |
| R8 | **adopted** | per-feed `CandleStore`, per-timeframe TTL carried on `Timeframe.candleTtlMs` (`provider.ts:29-35`), in-flight coalescing, `CANDLE_CAP = 5000`, stale-on-error (`candles.ts`); tested `feeds.test.ts:611-681`. `CANDLE_TTL_MS_1M` (my §8.2 knob) was **not** implemented — the TTL is per-frame data, not env |
| R9 | **adopted** | `types.ts` owns `AccountType`/`FeedMode`/`FeedRole`/`Tick`/`DemoPositionTrack`/`FeedStatus`/`FeedError`/permissions; `Tick` field-for-field unchanged (`feeds.test.ts:725-732`) |
| R10 | **adopted** | `feedFor(accountType: AccountType)` required (`registry.ts:107`), `resolveFeedMode(accountType, env)` required (`config.ts:243`); `feedForRequest` resolves by owned account (`feed-context.ts:24-39`). `priceFeedFor()` overloads not built (R1) |
| R11 | **adopted** | anonymous → `publicFeed()` (`registry.ts:126-132`, default `live`, falls back to the other slot only when the preferred one is not `running`); `source: "account" \| "session-default" \| "anonymous"` (`feed-context.ts:13`) |
| R12 | **adopted** | `asAccountType()` fail-closed, 400-class `FEED_MISCONFIGURED`, names the row (`types.ts:121-128`); used by `trading.ts:37`, `:84`, `:154`, `:225`, `:288`, `registry.ts:138`, `feed-context.ts:33`; tested T10 `feeds.test.ts:175-210` |
| Naming | **adopted** | `feedPlan()` kept and extended (`staleMs`, `pauseMs`, `publicRole`, `warnings`); `CandleStore` is the only export; `priceFeed`/`SimHistory`/`marketOpen()` zero-arg all gone (`prices.ts` is a 34-line facade) |

**Two findings NOVA surfaced independently, both confirmed by me, and one of them I must correct.**

1. **Steering pinned the tape — real, and the root cause of the historical "prices stopped
   moving" reports.** Fixed with a release band: inside `0.2 × pipSize` of the target the random
   step is left alone (`demoOutcome.ts:55-77`, `RELEASE = 0.2`), and `applyDemoSteer()` skips the
   write-back when `next === current` (`feed.ts:544-553`). "Steering is a pull, not a clamp."
   Regression-tested at `feeds.test.ts:509-527` (800 steps: the tape reaches its target *and keeps
   printing distinct prices*).
2. **Yahoo spark print level — settled against the git record; my dissent at this table's first
   draft is closed by §10.6.** `HEAD:src/server/prices.ts:46-52` already read
   `r?.response?.[0]?.meta` → `meta.regularMarketPrice`, so the committed parser was **correct** and
   the claim "the live feed has never produced a real price in this repo" was never about the
   parser. A wrong-level parse did exist — briefly, inside NOVA's own `src/server/feeds/` rewrite,
   fixed within that session — and is unrelated to the committed history or to the user-visible
   symptom. Cause, evidence and the probe numbers are in **§10.6**; `yahoo.test.ts`'s fixture shape
   is correct. O3 (batch ceiling beyond ~25 symbols) stays open; T8 stays a manual step (§10.3 A-6).

---

## 3. Request routing — resolving account type through the existing session/auth layer

### 3.1 The trust rule (stated explicitly, as required)

> **A client-supplied account *type* is never trusted for anything that moves money.** No endpoint reads `?type=`, `?demo=`, or a `type` field in a body to decide a feed. `AccountType` is derived server-side, exactly once, from `prisma.account.type` for an `accountId` whose ownership has been proven with `requireOwnAccount(user.id, accountId)` (`src/lib/auth.ts:72`). A client may name *which of its own accounts* it is looking at — it may not name *what kind of account* it is.

Consequences, in order of severity:
- `placeOrder`, `closePosition`, `modifyPosition`, `cancelOrder`, and **all engine settlement** resolve the feed via `feedForAccount(accountId)` (DB read). No exception.
- Read-only display endpoints may accept `accountId` as a *hint*, but must still prove ownership before honouring it; an unproven or absent `accountId` falls back to `publicFeed()`, never to "whatever the attacker asked for".
- The feed chosen for a display route must be the same one the money path will use for that account, otherwise the UI shows prices that cannot be traded at. Hence display routes resolve too — they are not allowed to keep the global singleton.

### 3.2 `GET /api/prices`

```ts
export const GET = route(async (req: Request) => {
  const user = await getCurrentUser();                       // null for anonymous
  const accountId = new URL(req.url).searchParams.get("accountId");
  const feed = await resolveFeedForView(user, accountId);    // §3.5
  return json({
    instruments, ticks: feed.ticks(), marketOpen: marketOpen(feed),
    feed: feedStatusPayload(feed.status()),
    account: user ? { id: accountId ?? null, type: await safeAccountType(user, accountId) } : null,
    mode: feed.mode(),          // DEPRECATED, kept for AccountBar.tsx:62
  });
});
```

`resolveFeedForView`: if `user` and `accountId` → `requireOwnAccount(user.id, accountId)` then `priceFeedFor(account.type)`. If `user` without `accountId` → `demoFeed()` (the terminal's default per `TradeTerminal.tsx:27`). If anonymous → `publicFeed()`.

### 3.3 `GET /api/prices/stream` (SSE)

- Same resolution at handshake. `EventSource` is same-origin, so the `pfx_session` cookie rides automatically; `await cookies()` inside a route handler is valid in Next 16.4 (verified in `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cookies.md`). `accountId` arrives as a query parameter because EventSource cannot set headers.
- **The connection is bound to one feed for its lifetime.** No mid-stream role switch. The client changes feeds by closing and reopening.
- Subscribe only to the resolved feed's `onTick`; store the returned unsubscribe and call it in `cleanup()` and `cancel()`. (The current code subscribes to the global emitter and would leak across roles.)
- Envelope: `{ ticks, mode, marketOpen, feed: { role, mode, state, stale, lastMarkAt, pausedReason, steeringEnabled } }`. Add `: state <json>\n\n` as a named event on every `FeedStateMachine` transition so a paused live feed reaches the UI without a poll.
- A `paused` live feed **keeps streaming** — with `stale: true` and its last marks — because hiding the fact is worse than showing frozen prices. The UI must render the pause.

Client contract (NOVA): `usePrices(accountId?: string)`; `accountId` in the `useEffect` dependency array, closing the old `EventSource` when it changes. `TradeTerminal` passes `activeId`. `FeedState` gains `feed: FeedStatusPayload | null`; `mode: string` stays.

### 3.4 `GET /api/candles`

`/api/candles?symbol&tf[&accountId]` → resolve exactly as §3.2, then `feed.candles(symbol, tf)` (§7). Response gains the same `feed` payload. Chart data moves no money, so a `paused`/`degraded` feed still serves candles (marked stale) — a user staring at a blank chart cannot be told "trading paused" convincingly.

### 3.5 Public pre-login ticker — what it serves

The landing page (`src/app/page.tsx` → `LiveTicker.tsx`) advertises *"Live market prices"* and *"Streaming quotes on 10 major and cross currency pairs"*. Decision:

- `PUBLIC_FEED="live"` **by default**: the anonymous ticker shows the **live feed's** marks. Marketing claim true, no extra poller (it is the same instance the live accounts use — the public route is a *reader*, not a third feed).
- If the live feed is not `running` (i.e. `degraded` / `paused` / `misconfigured`), `publicFeed()` resolution serves `demoFeed()` and the payload carries `mode: "simulated"` + `state`, so `LiveTicker` prints **"Simulated prices"**. A marketing page showing a synthetic tape labelled honestly is acceptable; showing it unlabelled is not.
- `PUBLIC_FEED="demo"` is the escape hatch for a client demo where Yahoo must never be touched by anonymous traffic.
- The public ticker is read-only by construction: anonymous visitors have no `accountId`, so no money path can ever resolve to it.

### 3.6 Admin surfaces

`admin/overview` (`priceFeed.quotes()` at line 27, `feed:` at line 42) and `admin/positions` (line 16) show **live clients' exposure** → must use `liveFeed()` explicitly and report `feedStatuses()` for both roles. Admin P/L on live positions computed off a demo tape would misstate the book (`brokerPnl24h` is the house's own revenue line).

---

## 4. Steering isolation — how win-rate targeting becomes structurally incapable of touching live marks

### 4.1 The five mechanical guarantees

1. **The live feed has no steering surface.** `DemoSteering` exists only on `DemoFeed` (§2.2). `LiveFeed` is `{ } extends Feed`. There is no `trackDemoPosition`, no `demoTargets` map, no `applyDemoSteer`, and no `book: UsdBook` field on the live path — therefore no code path, however written, can mutate a live mark by steering. `priceFeedFor("LIVE").steering` does not compile.
2. **Steering writes are confined to one object graph.** `DemoSteeringController` receives, by constructor injection, the *demo* `SimSource` and nothing else. `setPairMid` / `stepUsdBook` are imported by `sources/simulated.ts` for the demo instance only. The live instance's marks come from `sources/yahoo.ts`, which imports no mutation helper.
3. **`liveCount` and its whole API are deleted**, not repurposed: `addLiveExposure()`, `removeLiveExposure()`, the `liveCount > 0` guard in `applyDemoSteer()` (F5), and both call sites in `bootstrap.ts:28` and `trading.ts:182/231`. **Review gate:** `rg "liveCount|addLiveExposure|removeLiveExposure" src/` must return zero hits.
4. **Steering enablement is decided once, at plan resolution, not per tick.** Today `demoWinRateFromEnv()` is re-read inside `applyDemoSteer()` (every 250 ms) and inside `openPosition` — and its mere presence hijacks provider selection (F12/§8). Under the design, `FeedPlan.steering = {enabled, winRate}` is computed in `resolvePlan()` and injected. `enabled` is `winRate != null && plan.mode === "simulated" && plan.role === "demo"`. Non-simulated demo feeds get `enabled: false` and a startup warning (never a silent no-op).
5. **Hydration is role-scoped.** `bootstrap.ts` `hydrateOpenPositions()` groups by `account.type`: DEMO rows → `demoFeed().steering.track(...)`; LIVE rows → nothing at all (no counter to bump). Restarting the server with live positions open no longer disables demo steering.

### 4.2 What replaces the `liveCount` pause hack — the cross-feed invariant

The old hack "paused steering when anyone held a live position" was a crude attempt to stop demo manipulation from being visible in live prices. Under C the concern inverts and must be stated as an invariant:

> **No live mark, live candle, live quote or live settlement decision may ever be a function of a demo position.** Proof obligation: the live feed's mark set derives only from (a) an upstream poller, or (b) `stepUsdBook` on a book seeded from `LIVE_FEED`'s own simulated source. Neither reads `demoTargets`. Verified by test T6 (§9.3).

Corollary the other way: the demo feed *may* diverge from the real tape — that is the product feature.

### 4.3 F6: multi-demo-user target contention (decision + limits)

One shared demo tape with per-symbol single-target steering means concurrent demo users' targets collide and first-wins by Map order. Decision for this slice:
- Deterministic arbitration: among tracked targets for a symbol, steer toward **the target whose `targetMid` is nearest the current mid**. Deterministic, insertion-order-independent, and no target starves permanently (a nearest-first rule drains as prices sweep).
- **Honesty note:** blended steering degrades win-rate *accuracy* as concurrent demo positions rise; `stableUnit(id)` fixes each position's intended outcome, but the shared path cannot deliver all of them. This feature is correct for **one demo user at a time** (the actual client-demo use case) and approximate for many. True isolation requires per-account demo books (§9.2 deferral D1).
- Synthetic-SL/TP injection in `openPosition` (`trading.ts:132-137`) stays, but is guarded by `plan.role === "demo"` **and** `steering.enabled`; it must never inject stops into a LIVE account's position.

---

## 5. Failure & staleness semantics, per feed

### 5.1 The policy decision

> **A live feed may NEVER silently fall back to simulated prices while real money is at stake.** F4 (Yahoo failing 3× quietly starts the simulator, and `marketOpen()` then returns `true` because mode is `"simulated"`, F11 — the simulator keeps *forcing* market hours open, so trading continues around the clock on fake prices) is deleted outright. When live marks are not trustworthy, live trading is **paused** and the reason is surfaced to the client, the admin panel and the audit log.

The override exists (§5.4) because operators may legitimately want a demo-styled "live" account; it is default-off, requires two independent opt-ins, and is loud: an `AuditLog` row, a `feed.status` event, a UI banner, and every payload carrying `mode: "simulated"`.

### 5.2 State machine (per feed; `FeedStateMachine`)

```
   start()                first mark               staleMs exceeded        pauseMs exceeded
idle ──────────► starting ──────────► running ──────────► degraded ──────────► paused            ◄── (live: NO fallback)
  ▲                 │                    ▲   │                │                  │  │
  │                 │ misconfig          │   │ fresh mark     │ fresh mark       │  │ operator/LIVE_STALE_MS
  │                 ▼                    └───┴────────────────┴──────────────────┘  │ override=on
  │            misconfigured ◄──────────────────────────────────────────────────────┘
  │                 ▲                                     ▲   (recovery: 2 consecutive fresh marks)
  │                 └── resolvePlan() says illegal ───────┘
  └─────────────────────────────────────────────  stop()  ────────────────────────────► stopped
```

| Transition | Trigger (exact) | Marks emitted? | `open` | `close` (manual) | `modify` | `manage` (SL/TP/stop-out) |
|---|---|---|---|---|---|---|
| `idle → starting` | `start()` | no | ✗ FEED_STARTING | ✗ | ✗ | ✗ |
| `starting → running` | first mark set | yes | ✓ | ✓ | ✓ | ✓ |
| `running → degraded` | `now - lastMarkAt > staleMs` **or** `failures ≥ 2` | yes (stale) | ✗ FEED_STALE | ✗ | ✗ | **✓** |
| `degraded → running` | fresh mark (age ≤ `staleMs`) | yes | ✓ | ✓ | ✓ | ✓ |
| `degraded → paused` | `now - lastMarkAt > pauseMs` **or** `failures ≥ maxFailures` **or** upstream HTTP 401/403/429 | yes (stale, `stale: true`) | ✗ FEED_PAUSED | ✗ | ✗ | ✗ |
| `running → paused` | same, immediate (skips degraded if `failures ≥ maxFailures`) | yes (stale) | ✗ | ✗ | ✗ | ✗ |
| `paused → running` | `pauseMs` window satisfied by **2 consecutive** successful polls (hysteresis, no flapping) | yes | ✓ | ✓ | ✓ | ✓ |
| any → `paused` | `ENFORCE_MARKET_HOURS=true` and market closed, on a **remote** feed | last known | ✗ | ✗ | ✗ | ✗ |
| any → `misconfigured` | `resolvePlan()` illegal (e.g. `LIVE_FEED=simulated` without opt-in, `LIVE_FEED=twelvedata` with empty key) | no | ✗ | ✗ | ✗ | ✗ |
| any → `stopped` | `stop()` | no | ✗ | ✗ | ✗ | ✗ |

Defaults: `staleMs = 15_000`, `pauseMs = 60_000`, `maxFailures = 3` (tighter than today's global 30 s `isStale()`). Recovery hysteresis `2` consecutive good polls.

> **Pass-5 status of this table (A-5 + A-10, as built).** The `running → degraded` row's `close`
> column is **✓, gated on the marks being real**: `PERMISSIONS.degraded = ["manage","close"]`
> (`types.ts:141-149`) with the exception table `DEGRADED_ON_SIMULATED_MARKS = ["manage"]`
> (`:159-172`), applied at `feed.ts:149`; `closeAction(reason)` decides which column a closure is
> judged under (`types.ts:118`). An opted-in `LIVE_ALLOW_SIMULATED` slot is `running`, not `degraded`,
> so it keeps `close` — consent at boot, not mark quality (§10.10 ruling 2).
> **The age floors in the row above are not the ones that decide market staleness.** A-10 shipped
> with its own clocks — `marketStaleMs = 300_000` / `marketPauseMs = 1_200_000`
> (`config.ts:156-170`, overridable per role) — because a ~60-second Yahoo print cadence would have
> held a healthy feed permanently `degraded` against `staleMs = 15_000`. So `running → degraded` now
> triggers on `transportMs > staleMs` **or** `quoteMs > marketStaleMs`, and the print-age half is
> what catches a weekend (§10.10).
>
> **Pass-6 addition: this table is necessary, not sufficient (A-11).** It answers for the *slot*. A
> second layer ages each symbol on its own print and applies it to the **trading surface only**
> (`feed.ts:491-533`): `open`/`modify` lose any pair past `marketStaleMs` even in a `running` slot,
> `close`/`manage` never do. So read the ✓ columns as "permitted by the tape" — whether *this symbol*
> is permitted is `staleSymbols` (`:541`). §10.3 A-11, §10.10 rulings 4–6.

### 5.3 Per-feed differences

- **Simulated feed (demo, the default):** cannot lose its source — it is a local clock. Its only failure mode is event-loop starvation, caught by the same `staleMs` rule; `failures` stays 0. If its own timer dies, demo goes `degraded → paused` **for demo accounts only**. Blast radius of a dead Yahoo is therefore one role, not the process — this is the main reliability win of §1.
- **Remote feed (live, the default `yahoo`):** `degraded` is a deliberate *risk-management* state. In `degraded` the engine keeps evaluating SL/TP and stop-out against last-known marks. Justification: silently *stopping* risk evaluation on a real account is worse than acting on a slightly old price — the client's protective orders were accepted at those levels, and refusing to honour them while the tape lags is the larger harm. Stop-out (equity protection) also runs in `degraded` because it only ever closes positions in the client's favour.
- **In `paused`, nothing runs — including SL/TP and stop-out.** This is the honest reading of "no trustworthy price": executing protective orders on a 90-second-old mark in a fast market can realize a price the client never had. **This is a business decision, not a technical one, and it needs INFINITY's sign-off** (§9.4 O1): it means a live account can be exposed for the duration of the pause. Mitigation: `pauseMs = 60_000` is the *last* threshold; `degraded` (still managing) is entered at 15 s.
- Cross-role contamination is impossible: `processTick(demoFeed)` filters `account.type = "DEMO"`, `processTick(liveFeed)` filters `"LIVE"`. `withLock(accountId)` continues to serialize per account; the two loops cannot touch the same account.

### 5.4 Config that overrides the default

```
LIVE_FEED_ON_FAILURE=pause            # pause | simulate — the ONLY fallback permission (§2.6-R5)
DEMO_FEED_ON_FAILURE=simulate         # demo may degrade to its own simulation; it costs nothing
LIVE_ALLOW_SIMULATED=false            # AND-gate: any simulated mark reaching live, at boot OR as fallback
LIVE_STALE_MS=15000                   # -> degraded (manage + close; no new orders)
LIVE_PAUSE_MS=60000                   # -> paused (nothing executes)
DEMO_STALE_MS=30000                   # per-slot, as designed
DEMO_PAUSE_MS=120000                  # per-slot, as designed
FEED_FAILURE_THRESHOLD=3              # consecutive failures -> paused (NOVA's existing name, config.ts:143)
```
**Amendment (§10.4 C-1):** this block previously also listed `PRICE_FEED_ON_FAILURE=pause`. That
knob **does not exist and never did in the as-built tree** — no policy path reads it (it survives
only as an HMR cache-key entry at `registry.ts:71`). An F12-class dead knob in my own document; the
legacy install's live policy is `LIVE_FEED_ON_FAILURE`'s default (`pause`), which is what §5.1
required anyway, so the rule stands and only the knob was wrong.
Activating a live fallback requires **both** `LIVE_FEED_ON_FAILURE=simulate` **and** `LIVE_ALLOW_SIMULATED=true`; one alone yields `paused` plus a startup warning naming the missing variable. On activation: `logFeedFallback()` writes `AuditLog { action: "FEED_LIVE_FALLBACK", details: json({from, reason, at}) }`, `FeedStatus.mode` becomes `"simulated"`, `state` becomes `"degraded"` permanently (never `"running"` — a simulated tape on the live role is by definition not a real tape), and every price payload carries it.

### 5.5 Money-path plumbing

`trading.ts` `liveQuotes()` becomes:
```ts
async function quotesForTrading(accountId: string, action: FeedAction): Promise<QuoteMap> {
  const feed = await feedForAccount(accountId);
  feed.assertTradable(action);       // throws FeedError -> HttpError 503 -> { error, code }
  return feed.quotes();
}
```
`FeedError.status = 503` and message `"Live trading is paused: <reason>. Your open positions are safe and no new trades will be filled."` Note for NOVA: `route()` in `lib/http.ts` maps `HttpError` by `status`, so a 503 needs no wrapper change; but the client `api()` helper must surface non-2xx messages (verify `src/lib/client/api.ts` treats 503 like 400).

---

## 6. Provider budget — Yahoo vs Twelve Data across the instrument set

### 6.1 Facts established

- Instrument set: **10 pairs** (`INSTRUMENTS`, `src/lib/instruments.ts:13-24`). Every poll is whole-set today (`INSTRUMENTS.map(i => i.yahoo).join(",")`).
- **Yahoo `v7/finance/spark` is batched**: all 10 symbols in **one HTTP request**, no key, no *published* quota, but unofficial and IP rate-limit-prone (`DUAL_FEED_GUIDE.md:13,80,207,289` all report rate limiting/blocking). **F16: reachable from this machine right now (EURUSD ≈ 1.1215)** — this is a live-verifiable path, not a dead one.
- **Twelve Data free tier: 800 credits/day.** Verified against the vendor's own article: a comma-separated batch **consumes one credit per symbol** — `https://support.twelvedata.com/en/articles/5203360-batch-api-requests`: *"each symbol consumes one API credit"*. So a whole-set poll costs **10 credits**, not 1. (The commonly cited per-minute free limit (~8/min) is **not verified here**; the day budget binds first anyway.)
- Yahoo `v8/finance/chart` (candles) is **per symbol**, one request per `(symbol, tf)`.
- `TWELVE_DATA_POLL_MS = 3000` at prices.ts:39 — the comment "800 calls/day = ~1 call per 108 seconds, but we poll multiple pairs" is the arithmetic error at the heart of the problem.

### 6.2 The arithmetic

**(a) What the current Twelve Data constant would cost**
```
polls/day/role = 86400 / 3 s        = 28 800
credits/day    = 28 800 × 10 syms   = 288 000 credits/day
budget                              =             800 credits/day
overrun                             =            360×   the allowance
```
Twelve Data at 3 s is not "tight", it is 360 times impossible. Confirms the constant must go.

**(b) Maximum affordable cadence for a 10-pair live feed**
```
polls/day = 800 credits ÷ 10 symbols              = 80 full-set polls/day
continuous (24h) interval = 86 400 s ÷ 80         = 1 080 s  = 18 min/poll
market-hours only (120 h/week = 71.4% of a week):
  effective seconds/day = 86 400 × 0.714          = 61 714 s
  interval            = 61 714 ÷ 80               = 771 s   ≈ 12.9 min/poll
symbols-per-poll trade-off (24h, whole budget):
   1 symbol  → 800 polls → 108 s      2 symbols → 400 polls → 216 s
   5 symbols → 160 polls → 540 s      10 symbols → 80 polls → 1080 s
```
**Conclusion: the Twelve Data free tier cannot serve a tradable live tape.** The best it affords for 10 pairs is one mark every ~13–18 minutes. Against §5 thresholds (`staleMs 15 s`, `pauseMs 60 s`) a 780 s cadence is `paused` from the second poll onward: real-money trading would be permanently blocked. Twelve Data on a free key is an **observation and backfill** source, not an execution source.

**(c) Recommended schedule that fits**

| Feed role | Provider | Cadence | Requests or credits per day | Fits? |
|---|---|---|---|---|
| live | **yahoo** (batched, 10 syms) | `REMOTE_POLL_MS=2500` | 34 560 req/day (24h); **24 686** if gated to market hours (×0.714) | ✓ no quota; ban exposure is the risk, bounded by refcount (§1.2) + backoff + `paused` on 429 |
| demo | **simulated** | `DEMO_POLL_MS=250` | **0 external calls** | ✓ free by construction |
| live (backup) | twelvedata | `LIVE_TD_POLL_MS=1_200_000` (20 min) | 72 polls × 10 = **720 credits** | ✓ with 80 credits headroom — **but `state` stays `degraded`/`paused`; trading blocked by design** |
| candles (live) | yahoo v8 chart | per-tf TTL, §7.3 | **18 730 → 13 373** with market-hours gating | ✓ additive to the above |
| candles (demo) | in-memory | — | **0** | ✓ |

**Worst case under the dual feed, quantified:**
```
Target config (DEMO_FEED=simulated, LIVE_FEED=yahoo):
  external calls/day = 24 686 (quotes) + 13 373 (candles) ≈ 38 059 ≈ 0.44 req/s sustained
  → IDENTICAL to the current single-feed cost. The dual feed adds ZERO provider load,
    because the demo half is local and the live half is one shared poller.
Banned config (DEMO_FEED=simulated, LIVE_FEED=twelvedata @ 3 s):
  288 000 credits/day → 401/429 within ~13 minutes of uptime → live feed PAUSED. Unusable.
Pathological config (DEMO_FEED=yahoo, LIVE_FEED=yahoo):
  refcounting means ONE poller for "yahoo" -> 24 686/day, not 49 372. Sharing is the cap.
Worst non-degenerate config (DEMO_FEED=yahoo, LIVE_FEED=twelvedata):
  yahoo 24 686 (1 poller, shared by nothing) + TD capped at 720 credits/day. Both fit.
```
Budget guards to implement now (cheap, prevent the 360× class of mistake): `resolvePlan()` computes `creditsPerDay = (86400 / pollMs * 1000) * symbolsPerPoll` at startup and **refuses** (`misconfigured`, with the number in the message) any live/twelvedata plan above `TD_DAILY_CREDIT_BUDGET` (default 720). Plus: exponential backoff with jitter on failures (2.5 s → 5 → 10 → 20 → 60 s cap), honour `Retry-After`, and treat 401/403/429 as immediate `paused` rather than retry-hammer. Never pipe a per-symbol loop: always the batched comma form.

**(d) Verification, since Yahoo is reachable (F16)** — this is now a testable acceptance criterion, not an assumption: `curl` `https://query1.finance.yahoo.com/v7/finance/spark?symbols=EURUSD=X&range=1d&interval=1m` with `User-Agent: Mozilla/5.0`, assert HTTP 200 and a finite `regularMarketPrice` in ~1.0–1.3, then assert the same value reaches `/api/prices` as a `LIVE` tick within 3 s with `feed.mode="yahoo"` and `feed.state="running"`. Do it at design-implementation time, record the observed value in the PR, and re-run weekly — reachability is an environment property that can change without any code change.

---

## 7. Per-feed candle history, and the fate of `SimHistory`

### 7.1 Principle

**Candles belong to a feed, exactly like marks.** One shared `SimHistory` singleton (F9) means a LIVE user's chart contains demo bars produced by steering, and a demo user can be shown Yahoo bars — and `getCandles()` picks the source from whichever global mode happens to be set (F10). The chart is what the client reads to decide entries; mixing histories is a correctness and credibility failure of the same order as F5.

### 7.2 Design

```ts
// src/server/feeds/candles.ts
export type Candle = SimCandle;                       // shape unchanged (prisma-free, client-safe)
export interface CandleStore {
  get(symbol: string, seconds: number): Candle[];     // sync; aggregation from 1m base bars
  push(symbol: string, mid: number, timeMs: number): void;
  seedBars(bars: Map<string, Candle[]>): void;
  replaceAll(symbol: string, bars: Candle[]): void;   // remote snapshot wins over appended bars
  size(): number;
}
export class MemoryCandleStore implements CandleStore {}     // demo: seeded 500 min + live appends
export class RemoteCandleStore  implements CandleStore {}     // live: Yahoo chart + TTL cache + 1m stitching
```
- `FeedInstance` **owns** a `CandleStore`. `feed.candles(symbol, tf)` is synchronous and never hits the network; a store-refresh job does the I/O.
- Demo path (unchanged behaviour, now instance-scoped): `generateHistory(500)` seeds bars + book from the **demo** `SimSource`, and each 250 ms tick calls `this.history.push(...)`. Steering therefore writes into demo candles — visible, intentional, contained.
- Live path: `RemoteCandleStore` fetches `v8/finance/chart/{yahoo}` per `(symbol, tf)` on the §7.3 schedule and `replaceAll` on success; between fetches it stitches 1-minute bars from polled mids (`push`) so the live chart advances instead of jumping every 20 minutes.
- **`SimHistory.seed()` — NOVA's finding #2, ruling: DELETE.** It is dead (F9), and after this refactor its job (bootstrap a history from live mids) is the constructor's business. Specifically do **not** repurpose it to seed the live store from demo bars: that would import synthetic prices into a real-money chart. Live history starts empty and fills from the provider; the live chart is briefly short. Accept that visibly.
- `globalThis` retention: only `__feedRegistry` (holding both feeds and their stores) survives HMR; `__priceFeed` and `__simHistory` globals are removed. Cap **5 000 one-minute bars per symbol per feed** (was 20 000) — at 10 symbols that is 50 000 small objects per feed, roughly 5–10 MB, and 5 000 minutes ≈ 3.5 trading days is above the longest advertised timeframe that needs minute granularity.

### 7.3 Candle request budget

Per-`(symbol, tf)` TTL, replacing the flat 20 s (`candleCache`, prices.ts:376-386), plus **in-flight coalescing** (one promise per key, so 50 concurrent clients cost one request):

| tf | TTL | refreshes/day/symbol | × 10 symbols |
|---|---|---|---|
| 1m | 60 s | 1 440 | 14 400 |
| 5m | 300 s | 288 | 2 880 |
| 15m | 900 s | 96 | 960 |
| 1h | 1 800 s | 48 | 480 |
| 1d | 86 400 s | 1 | 10 |
| | | | **18 730/day ceiling**, server-coalesced → **independent of user count**; ~13 373 with market-hours gating. (The current flat 20 s TTL permits ~216 000/day.) |

`getCandles(symbol, tf)` becomes `feed.candles(symbol, tf)` — no async network call in the request path. Demo candles: 0 requests. Live candles: bounded by the table above.

---

## 8. Environment contract

### 8.1 `PRICE_FEED` — NOVA's finding #1, ruling: **IMPLEMENT it** (do not delete the claim)

F12 is correct: `PRICE_FEED` is read nowhere; `resolveFeedMode()` consults only `DEMO_WIN_RATE`, `DEMO_FEED`, `LIVE_FEED`. `.env.example` ships `PRICE_FEED="simulated"`, `DUAL_FEED_GUIDE.md` documents it, and the comment at prices.ts:82 promises a compatibility path that does not exist.

Decision: honour it, as the **legacy default for both roles**, because the safe failure mode is the one that matches the file the operator actually has. If we instead deleted the promise, a deployment whose only knob is `PRICE_FEED="simulated"` and whose `DEMO_WIN_RATE` is unset would boot a **Yahoo poller behind a live account** the operator believed was simulated — the worst available surprise. Cost is a pure function in `resolvePlan()`; no runtime overhead. The comment at prices.ts:82 becomes true rather than being removed.

### 8.2 Precedence table (highest wins; all resolution in `resolvePlan()`)

| Setting | Wins over | Effect |
|---|---|---|
| `LIVE_ALLOW_SIMULATED` (bool, default `false`) | `LIVE_FEED`, `LIVE_FEED_ON_FAILURE`, `PRICE_FEED` | AND-gate on any simulated mark reaching the live role, at config time *or* as failure fallback. Without it, `LIVE_FEED=simulated` ⇒ `state: "misconfigured"`, live trading blocked. Sole exception: a live mode inherited from `PRICE_FEED=simulated` (§2.6-R5) |
| `LIVE_FEED_ON_FAILURE` (`pause` \| `simulate`, **default `pause`**) | the deleted F4 auto-switch | The only fallback permission, and it still needs `LIVE_ALLOW_SIMULATED`. `DEMO_FEED_ON_FAILURE` defaults to `simulate` (harmless). **There is no `PRICE_FEED_ON_FAILURE`** — a legacy install gets the live slot's `pause` default, which is the outcome this row wanted (§5.4 amendment, §10.4 C-1) |
| `DEMO_FEED` (`simulated` \| `yahoo` \| `twelvedata`) | `PRICE_FEED`, `DEMO_WIN_RATE` | Demo role provider. **Unset ⇒ inherit `PRICE_FEED`, else `simulated`** |
| `LIVE_FEED` (`yahoo` \| `twelvedata` \| `simulated`) | `PRICE_FEED` | Live role provider. **Unset ⇒ inherit `PRICE_FEED`, else `yahoo`** |
| `PRICE_FEED` (legacy: `simulated` \| `yahoo` \| `twelvedata`) | nothing | Default for **both** roles, only where `DEMO_FEED`/`LIVE_FEED` are unset. Emits one startup deprecation warning listing the two replacement variables |
| `DEMO_WIN_RATE` (float 0–1, empty = off) | — | **Enables steering only. Selects no provider, ever.** This is the precedence fix: today its presence flips the entire feed to `simulated` (prices.ts:83-84) — i.e. one demo-scope env var silently chose the whole system's source, which is precisely why the two goals were irreconcilable |
| `PUBLIC_FEED` (`live` \| `demo`, default `live`) | — | Anonymous ticker source (§3.5) |
| `TWELVE_DATA_API_KEY` | — | With a mode of `twelvedata` and an empty/whitespace key ⇒ that feed is `misconfigured` and the other role is unaffected. Today: the import is dead (F3), so nothing checks it |
| `ENFORCE_MARKET_HOURS` (`false` \| `true`, default `true`) | — | **Session clock only.** `simulated` slot: no session, never paused by hours; remote slot: real FX clock (Sun 22:00–Fri 22:00 UTC) and `paused` when closed. **As built (A-2 closed): resolved into the plan at boot (`config.ts:43,284`) and read from `this.config` (`feed.ts:281-288`) — no `process.env` inside the feed.** And **as ruled (A-10): it does not gate market freshness.** `false` no longer buys 24/7 live execution; a closed session or a frozen provider takes a real-provider slot `degraded` then `paused` regardless, through `LIVE_MARKET_*` (§10.10) |
| `LIVE_MARKET_STALE_MS` (300000), `LIVE_MARKET_PAUSE_MS` (1200000), `DEMO_MARKET_STALE_MS`, `DEMO_MARKET_PAUSE_MS` (default to the `LIVE_*` values) | `ENFORCE_MARKET_HOURS` | **Market-age floors (A-10).** How long since the *market* last printed, judged separately from how long since the *host* answered. One policy for both slots because freshness is a property of the print; a demo reading a real provider may raise its own. A simulated tape is immune — its prints are stamped `now` (`config.ts:156-170`, `feed.ts:232-257`, `:377-379`) |
| `REMOTE_POLL_MS` (2500), `DEMO_POLL_MS` (250), `TD_POLL_MS` (1200000), `TD_DAILY_CREDIT_BUDGET` (720), `LIVE_STALE_MS` (15000), `LIVE_PAUSE_MS` (60000), `DEMO_STALE_MS` (30000), `DEMO_PAUSE_MS` (120000), `FEED_FAILURE_THRESHOLD` (3) | — | New knobs, all defaulted; absent ⇒ today's recommended numbers. **As built:** `LIVE/DEMO_STALE_MS` and `_PAUSE_MS` are **transport** ages only since A-10; `TD_DAILY_CREDIT_BUDGET` is documented at `.env.example:111` (A-3 closed); `CANDLE_TTL_MS_1M` was **not** built — the candle TTL is per-timeframe data on `Timeframe.candleTtlMs` (`provider.ts:29-35`), which is better than one env knob per frame |
| `DEMO_BALANCE`, `AUTH_SECRET`, `ADMIN_*`, `DATABASE_URL` | — | Unchanged, out of scope |

Never an env source for account type: `AccountType` comes from the database only (§3.1).

### 8.3 Stays for backwards compatibility

`PRICE_FEED`, `DEMO_WIN_RATE`, `DEMO_FEED`, `LIVE_FEED`, `TWELVE_DATA_API_KEY`, `ENFORCE_MARKET_HOURS`, `DEMO_BALANCE`; the `mode` field in `/api/prices` and SSE payloads; `getCandles`' `(symbol, tf)` ordering; the `Tick` shape; `TIMEFRAMES`; every exported `trading.ts` signature (§2.5). Removal of `priceFeed`, `mode`, and `marketOpen()`'s zero-arg form is a **declared follow-up slice**, not this PR.

### 8.4 Resolved values for the current `.env` (F15)

| | mode | steering | poll | stale/pause | initial state |
|---|---|---|---|---|---|
| **demo** | `simulated` | **enabled, winRate 0.6** | 250 ms | 30 s | `running` |
| **live** | `yahoo` | n/a (surface absent) | 2 500 ms, batched 10 syms | 15 s / 60 s | `starting` → `running` on first spark poll |
| **public** | `yahoo` (`PUBLIC_FEED=live`) | — | shared upstream | as live | follows live |

`twelvedata` is unselected by either role, so the F13 type error is not on the runtime path — but `feeds/twelvedata.ts:69` must still be fixed in this slice (`"price" in value` after `typeof value === "object"` leaves `value: object | null`; narrow with `value !== null && typeof value === "object" && "price" in value`), because `LIVE_FEED=twelvedata` becomes a *reachable* configuration the moment the key is filled in, and `resolvePlan()` will call `isTwelveDataConfigured()`. **(As built: F13 and the rest of the F14 baseline are gone — `tsc` reports 0 errors. This paragraph is kept as the original instruction, not as an open item.)**

### 8.5 Two rulings recorded against the contract (INFINITY, 2026-11-02)

**(a) O1, the degraded/paused risk call — ruled and implemented.** `degraded` **executes** held
positions' SL/TP and stop-out against last-known marks and refuses new opens; `paused` **executes
nothing**. This is the asymmetry §5.3 argued for, signed off as a business decision rather than left
to engineering: risk-*reducing* actions survive a stale tape, risk-*taking* actions do not.
As built: `types.ts:94-106`, `engine.ts:20-22`/`:47-58`, tests `feeds.test.ts:253-320`.
Amendment now ruled on top of it (see §10.7), **and built**: `degraded` also permits a manual
`close`, gated on the marks being real — `PERMISSIONS.degraded = ["manage","close"]` with
`DEGRADED_ON_SIMULATED_MARKS = ["manage"]` as the one documented exception (`types.ts:141-172`,
applied at `feed.ts:149`). See §10.10 ruling 2 for why an *opted-in* simulated live slot keeps
`close` while a *fallback* one loses it.

**(b) The Twelve Data budget guard is deliberately asymmetric.** A `twelvedata` slot whose cadence
exceeds `TD_DAILY_CREDIT_BUDGET` (default 720 credits/day) is treated differently by role, and the
difference is a product of what each role is for:

| Slot over budget | Behaviour | Why |
|---|---|---|
| **live** | `illegal` ⇒ the slot boots `misconfigured`, prices nothing, and refuses with the arithmetic in the message (`288000 credits/day, but TD_DAILY_CREDIT_BUDGET=720. Cheapest cadence that fits: TD_POLL_MS=1200000`) | Real money cannot be marked by a metered source that is guaranteed to run out of credits mid-session: the honest answer is "this configuration cannot trade", not "it will work until 14:00" |
| **demo** | keeps its **own simulated tape** (mode rewritten to `simulated`) plus a startup warning naming the credit maths | The demo's price source costs nothing; silently spending a paid key's budget to render a fake market is the worse failure |

Tests: `feeds.test.ts:811-864` (live refusal, affordable cadence accepted, paid-plan ceiling
raises it, demo keeps its tape). Follow-up requested of NOVA and **shipped**: `TD_DAILY_CREDIT_BUDGET`
is documented at `.env.example:105-111` with the same live/demo asymmetry spelled out, so an operator
who hits the refusal can find the knob the error message names (A-3 closed, §10.8). NOVA also
mode-scoped the guard: it used to read `TD_POLL_MS` even for a `yahoo` slot, which could park a live
slot `misconfigured` over a cadence it never used (§10.8).

---

## 9. Risks, minimal slice, deferrals

### 9.1 Risks

| ID | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| K1 | **Yahoo is unofficial.** Reachable today (F16); can 429/403/reformat without notice. It is the sole live execution source, i.e. a business single point of failure. | High / High | `paused` (never synthetic), refcounted single poller, backoff+jitter, market-hours gating to cut ~29 % of calls, weekly reachability probe (§6.2(d)). Long-term: a paid provider or broker feed. |
| K2 | **B-book pricing integrity.** `admin/overview.ts:39-40` states the house is counterparty on live trades; client losses are revenue. Marking the house's own exposure with a free unofficial tape means the P&L people sign off on is only as trustworthy as Yahoo. | Medium / High | Out of engineering scope but **flagged to INFINITY as a business risk**; §5 makes the tape's failure visible instead of synthesising it, which is the most engineering can do. |
| K3 | **Position migration across the switch.** Open positions exist before/after deploy; `openPosition`-time steering injection and the deleted `addLiveExposure` counter change hydrate semantics. | High / Low | Role-scoped hydration (§4.1 item 5); demo positions keep steering, live positions need nothing. SQLite is single-writer; start both feeds before hydrating. |
| K4 | **Double settlement in the engine** if both tick loops call `processTick` (stop-out loops 100× per account). | Medium / High | Per-role relation filter (§5.3) + existing `withLock(accountId)`; the `running` guard in `engine.ts:9` becomes **per feed** (`Map<FeedRole, boolean>`) or a shared one is retained deliberately — decide explicitly, don't inherit it by accident. |
| K5 | **Client shows prices it cannot trade at** (feed badge still `mode` only, `AccountBar.tsx:62`). | High / Medium | Payload carries `state` + `pausedReason`; UI renders "LIVE TRADING PAUSED"; `assertTradable` server-side is the actual guarantee. |
| K6 | **HMR / duplicate registries** in dev starting two pollers per provider. | Medium / Low | One `globalThis.__feedRegistry` slot; `startFeeds()` idempotent; upstream refcount release on `stop()`. |
| K7 | **Typecheck baseline is already red** (F14: 12 errors, 8 in `fxSim.ts`, which this work touches via `UsdBook` ownership). | High / Low | Gate on **delta**, not zero: F13 fixed, count ≤ 11 (or 4 if `fxSim` errors are fixed, which they should be, as they are 5 lines of `Record<string, number>` typing), `npm run test` green. |
| K8 | Steering accuracy degrades with concurrent demo users (§4.3). | Medium | Low for the single-client-demo use case; documented limitation; D1. |
| K9 | **Implementation drift.** NOVA's parallel `src/server/feeds/*` re-opens F4/F5 through the legacy shared-tape collapse (SB1, §2.6), and diverges on 12 contract points, two of which (R11, R12) can price live money on the demo tape | High / High | §2.6 rules each point; SB1 + R12 + T9/T10 are merge-blocking; the invariant `steerable ⇒ ¬servesLive` is asserted at startup, not reviewed by eye |
| K10 | A `paused` live feed freezes SL/TP and stop-out (§5.2) — client exposure during the pause. | Low / High | `degraded` still manages from 15 s; `paused` only at 60 s; needs sign-off (O1). |
| K11 | **A responsive host with a frozen tape looks healthy (F18).** Staleness was timed from poll success, not from the print, so over a weekend — or against any host that keeps serving the same close — the live slot stayed `running` and filled orders at a price the market stopped printing. | **Closed (A-10, pass 5).** Was High / High for weekend installs | **Built:** two clocks, market ageing on the print with its own floors (`MARKET_STALE_MS=300_000`, `MARKET_PAUSE_MS=1_200_000`, `config.ts:156-170`), `ageVerdict()` consulted by `applyQuotes()` instead of forcing `running`, and leaving `paused` needing both `goodPolls ≥ RECOVERY_POLLS` **and** a `running` verdict. `ENFORCE_MARKET_HOURS=false` no longer buys 24/7 live execution — market freshness is a property of the print, ruled and implemented (§10.10). The batch-level clock it left behind was K12/A-11, now closed by the per-symbol gate. |
| K12 | **Batch-level market age (F19/A-11).** The slot aged on the newest print in the payload, so a single frozen symbol inside an otherwise fresh batch never demoted the slot, and the trading surface had no per-symbol test. One pair could be traded at Friday's price on Monday. | **Closed (A-11, pass 6).** Was High / Medium | **Built:** `quoteAgeMs(symbol)` per pair (`feed.ts:491-497`) and `tradeQuotes(action)` (`:508-516`) drop aged symbols for `open`/`modify` only, while `close`/`manage` keep them — the frozen pair is exactly the one whose stop or whose owner wants out, so refusing it traps the position (same reasoning as `manage` in the slot table, §5.3/A-5). Enforced at every money path by `quotesFor()` (`trading.ts:68-74`) and `engine.ts:29` for pending fills. Slot verdict deliberately unchanged. Aged protective closes are **logged, not blocked** (`agedMarkNote()` `feed.ts:559-564`, emitted after settlement at `trading.ts:296-301`) — accepted residual risk, §10.10. |


### 9.2 Minimal slice that satisfies the business requirement

Do exactly these seven, then stop:
1. `resolvePlan()` + `FeedPlan` (§2.4, §8) — **including** the `DEMO_WIN_RATE` precedence fix and `PRICE_FEED` inheritance.
2. `Feed` / `DemoFeed` / `LiveFeed` / `DemoSteering` types and the overloaded `priceFeedFor()` (§2.2–2.3).
3. `FeedInstance` with its own marks, `CandleStore` and `FeedStateMachine`; `SimSource`, `YahooSource`, `TwelveDataSource`, upstream refcounting (§1.3, §7).
4. Delete `liveCount`/`addLiveExposure`/`removeLiveExposure`, `applyDemoSteer`'s guard, and the F4 auto-fallback-to-simulated branch. Fix F13.
5. Money paths resolve by DB account type: `quotesForTrading()`, `getAccountState`, `openPosition`, `closePositionLocked`, `modifyPosition`; **`processTick(feed)` per role** with relation-filtered queries; role-scoped `hydrateOpenPositions()`; `marketOpen(feed)`.
6. `/api/prices`, `/api/prices/stream`, `/api/candles` resolve via `accountId` + `requireOwnAccount` (or `publicFeed()`), and every payload carries the `feed` status block; `usePrices(accountId?)` reconnects on switch.
7. Tests T1–T7 below.

Already satisfied by 1–7: demo steered at 0.6 while live runs Yahoo simultaneously; steering cannot touch live marks; no silent synthetic prices on live; no doubled provider cost; charts per feed.

**Deliberately deferred:** D1 per-account demo books (true multi-user win-rate fidelity, and the natural fix for R8/F6); D2 admin feed-health panel for both roles (beyond the status payload); D3 Twelve Data as a genuine live backup (needs a paid tier — free tier is 360× short, §6.2); D4 persistent candle history in Prisma (restarts re-seed); D5 removing the deprecated `priceFeed`/`mode`/zero-arg `marketOpen()`; D6 market-hours enforcement redesign (out of scope); D7 the `demoOutcome.test.ts`/`fxSim.ts` type errors beyond those this slice touches; D8 per-feed remote poll cadence differences (upstream interval is `min()` of subscribers, which is the simplest correct rule).

### 9.3 Acceptance tests (unit-testable without network; one requires it)

- **T1** — `resolvePlan({ DEMO_FEED: "simulated", LIVE_FEED: "yahoo", DEMO_WIN_RATE: "0.6" })` → `demo.mode="simulated"`, `demo.steering={enabled:true, winRate:0.6}`, `live.mode="yahoo"`, `live.steering={enabled:false, winRate:null}`.
- **T2** — the regression that used to be impossible: track a demo position, **and** hold a live position; step the demo tape; assert the demo target is still steered (`liveCount` no longer exists to disable it) and the live `quotes()` are byte-identical to the unsteered control.
- **T3** — `resolvePlan({ PRICE_FEED: "simulated" })` → both roles `simulated` + one deprecation warning; `resolvePlan({ PRICE_FEED: "simulated", LIVE_FEED: "yahoo" })` → demo simulated, live yahoo.
- **T4** — `resolvePlan({ LIVE_FEED: "simulated" })` → `misconfigured`; with `LIVE_ALLOW_SIMULATED=true` → starts, `steeringEnabled=false` even when `DEMO_WIN_RATE` set.
- **T5** — state machine: 3 consecutive failures ⇒ `paused`; `assertTradable("open")` throws `FeedError` with `code="FEED_PAUSED"`, `status=503`; `ENFORCE_MARKET_HOURS=true` and no fallback ⇒ **never** `mode === "simulated"` on the live role.
- **T6** — **the §4.2 invariant proof**: any mutation attempted through the demo steering controller leaves the live feed's `quotes()` unchanged (property-style, 200 randomised steps).
- **T7** — budget guard: `{ LIVE_FEED: "twelvedata", TD_POLL_MS: 3000 }` → `misconfigured`, message contains the computed `288000` vs `720`.
- **T10** (from R12) — `feedForAccountType("live")`, `("LIVE ")`, `("REAL")`, `(null)`, `("")` each **throw** `FEED_MISCONFIGURED`; only exact `"LIVE"` resolves to the live feed and only exact `"DEMO"` to the demo feed. This is the fail-closed guard that stops a mis-cased `Account.type` from pricing real money on the steered demo tape.
- **T8** (network) — §6.2(d) Yahoo probe: real EURUSD within tolerance reaching `/api/prices` with `feed.state="running"` and `feed.mode="yahoo"`.

### 9.4 Open questions — unresolved, stated plainly

- **O1 — RESOLVED and implemented (2026-11-02).** Ruled as recommended: `degraded` **executes** held
  positions' SL/TP/stop-out against last-known marks and refuses anything new; `paused` **executes
  nothing**. As first built: `PERMISSIONS.degraded = ["manage"]` (the table is now `types.ts:141-149`), the engine reads
  `mayManage`/`mayOpen` separately per feed (`engine.ts:20-22`, `:47-58`), and a manual or
  administrative close was refused while degraded because it is `close`, not `manage`
  (`trading.ts:231`). Tested at `feeds.test.ts:261-288`.
  **Widened by the A-5 ruling of 18:05** (my §10.7 objection accepted): `degraded` is now
  `["manage", "close"]` (`types.ts:145`) and `closeAction(reason)` decides which half a close is
  judged under — `MANUAL`/`ADMIN` → `close`, `SL`/`TP`/`STOP_OUT` → `manage`
  (`types.ts:118`, `trading.ts:246`, `:295`, tested `feeds.test.ts:313-335`). I accept that split as
  better than my letter (see §10.8). The `simulatedMarks` half of the accepted ruling is **not**
  implemented — §10.9 item 1.
- **O2:** Twelve Data's free **per-minute** limit (~8/min is folklore) is unverified here; only the per-symbol credit counting is vendor-confirmed. If a paid/live TD deployment is planned, confirm the per-minute limit first. TD forex quote quality on the free tier is likewise unmeasured.
- **O3:** Yahoo `spark` batch limit is not documented publicly; 10 symbols works today (F16). If the instrument set grows past ~25, batch splitting must be designed — currently unbounded and unverified.
- **O4:** Should a `paused` live feed's public ticker switch to the demo tape (§3.5) or print "prices unavailable"? I chose "switch, labelled honestly". Marketing may prefer the other answer.
- **O5:** The synthetic SL/TP injection in `openPosition` (`trading.ts:132-137`, applied only to DEMO when steering is on) is a product behaviour masquerading as code. I preserved it. Whether it should be surfaced in the demo UI is a product call.

---

## 10. As-built conformance review (read-only audit 17:55–18:15; pass 4 §10.8–§10.9; final gate and A-11 §10.10)

**Method.** `src/server/feeds/**` (types, config, registry, feed, upstream, candles, provider,
yahoo, twelvedata), `src/server/{prices,feed-context,trading,engine,bootstrap}.ts`, the
prices/candles/stream/admin/reset routes, `lib/http.ts`, `lib/client/{api,usePrices}.ts`, the four
feed-aware components and both feed test files were read in full and checked against **§2.6**,
**§5.2** and **§8.2**. Evidence is `file:line` in the current tree. `npm run typecheck` clean;
`npx vitest run` green (**106 tests / 5 files, 80 in `feeds.test.ts`** on the pass-6 tree; §10.5 and
§10.8 preserve the counts I last ran at each earlier pass).
**Line-ref caveat, pass 6:** `feed.ts` grew ~65 lines when the per-symbol gate was inserted at
`:485-564`, and `types.ts`/`config.ts` shifted by up to 8 when the exception table and the market floors
went in. Refs in **§10.1, §10.2, §10.8 and §10.9** were read on the 17:55–18:15 tree and some are
therefore low by that amount; they are labelled as that snapshot rather than silently renumbered.
The pass-6 anchors, verified by me: `permits()` `feed.ts:148-149`, `refusal()` `:178-197`,
`ageVerdict()` `:232-257`, transport stamp `:367`, market stamp `:379`, `quoteAgeMs` `:491-497`,
`tradeQuotes` `:508-516`, `agedSymbol`/`assertSymbolTradable` `:519-533`, `staleSymbols` `:541`,
`agedMarkNote` `:559-564`, `status()` `:604`, `simulatedMarks` `:652`; `PERMISSIONS` `types.ts:141-149`,
`closeAction` `:118`, `DEGRADED_ON_SIMULATED_MARKS` + `permittedActions`/`permitted` `:159-172`,
`FeedStatus.staleSymbols` `:95`; `MARKET_STALE_MS`/`MARKET_PAUSE_MS` `config.ts:156-157`,
`marketAges()` `:168-170`, `enforceMarketHours()` `:43` → plan `:284`, `feedPlan()` `:295`;
`quotesFor()` `trading.ts:68-74`, aged-close warn `:296-301`, `engine.ts:29`.
**Caveat that matters:** the tree moved *during* this audit — `config.ts`, `feed.ts`, `upstream.ts`,
`provider.ts`, `trading.ts` at 17:56–17:58 and `feeds.test.ts` at 18:05. Four of my hardening items
(§6 backoff, `TD_DAILY_CREDIT_BUDGET` refusal, §4.3 contention, market-hours per feed) landed while
I was writing, with tests. The list below is only what survived the re-check; anything I had
flagged and found fixed is marked as such.

### 10.1 List A — rulings correctly implemented (§2.6 / §5.2 / §8.2)

Per-ruling as-built status is tabulated in **§2.6.1**; the load-bearing ones, with evidence:

- **Two slots always, invariant asserted, no `serves`** — `config.ts:214-240`, `registry.ts:45`;
  tests `feeds.test.ts:150-173`.
- **Fail-closed account type, everywhere it matters** — `types.ts:121-128` (400-class), reached from
  `trading.ts:37/84/154/225/288`, `registry.ts:138`, `feed-context.ts:33`; T10 at
  `feeds.test.ts:175-210` covers eleven bogus values including `"Live"`, `"REAL"`, `""`, `null`.
- **§5.2 permissions exactly as the table** — `types.ts:94-106`; `degraded` = `["manage"]`
  only, `paused`/`misconfigured` = `[]`; verified action-by-action at
  `feeds.test.ts:253-320`, and the engine consumes them per feed (`engine.ts:20-22`, `:47-58`).
  *(Pass 4: `degraded` is `["manage","close"]` — §10.8/O1. The verification claim was true at 17:55.)*
- **§5.2 transitions** — age-based `degraded`/`paused` on read (`feed.ts:180-193`), failure-count
  `paused` at threshold and `blocking` 401/403/429 ⇒ immediate `paused`
  (`feed.ts:296-315`), empty response counted as a failure (`upstream.ts:108`), recovery needs two
  good polls (`feed.ts:284-287`), closed session parks a remote slot (`feed.ts:186-189`) and is
  tested for the *asymmetry* — live paused / demo running on a Saturday
  (`feeds.test.ts:937-985`).
- **§5.1 never silent on live** — keyless or illegal live slot ⇒ `misconfigured`, zero ticks
  (`feed.ts:297-319`, `config.ts:295`); fallback live ⇒ `degraded` **forever**, never `running`
  (`feed.ts:722-727`, test `:429-453`); `simulatedMarks` in every payload.
- **§8.2 precedence** — own switch → `PRICE_FEED` → role default, unknown value = unset
  (`config.ts:18-21`, `50-56`; tests `:80-99`); `DEMO_WIN_RATE` selects nothing (T9); AND-gate
  (`config.ts:157-164`); per-slot stale/pause/poll/threshold (`config.ts:143-144`, `201-203`).
- **§4 structural isolation** — steering methods throw (`feed.ts:458-518`); live `winRate` forced
  `null` (`config.ts:141`); `steerable` requires `mode === "simulated"` (`feed.ts:434-436`);
  synthetic stops now gated on `feed.steerable`, not on `winRate != null` (`trading.ts:162` — a gap
  I raised mid-audit and found closed); registration only for `DEMO` (`trading.ts:201`, `:267`,
  `:296`); engine filters `account: { type: feed.servedType }` for both pending orders and open
  positions (`engine.ts:28`, `:49`) with a **per-feed** busy set (`engine.ts:9`, closing K4).
- **§1.3/§6/§7 plumbing** — `Upstream` memoized per `(mode, pollMs)` on `globalThis`, refcounted,
  auto-stopping, non-overlapping (`upstream.ts:54-103`, `135-151`; tests `:541-609`); per-feed
  `CandleStore` with per-frame TTL, coalescing, cap and serve-stale (`candles.ts`, tests `:611-681`);
  exponential backoff + ±25 % jitter + `Retry-After` honoured and cleared
  (`upstream.ts:76-94`, `provider.ts:65-96`; tests `:736-809`); TD credit refusal with the
  arithmetic in the message (`config.ts:117-132`, `187-190`; tests `:811-864` — this is my **T7**).
- **§3 routing** — anonymous → `publicFeed()`, `?account` ownership-checked, three-way `source`,
  SSE bound at handshake with per-feed `on`/`off` for `ticks` **and** `status`
  (`feed-context.ts:24-39`, `stream/route.ts`); `FeedError` → 503/400 with `code`
  (`http.ts:38`) and `api()` surfaces non-2xx messages (`client/api.ts:19`); admin marks live
  exposure through `feedFor("LIVE")` and lists both statuses; reset clears only the demo slot.
- **Gates clean** — zero hits in `src/` for `priceFeed`, `liveCount`/`addLiveExposure`/
  `removeLiveExposure`, `serves`, `SimHistory`, `CANDLE_CACHE_MS`, `providerDown`.

### 10.2 List B — implemented differently than specified (all **accepted**)

| ID | Difference | Ruling |
|---|---|---|
| B-1 | One `Feed` class; `DemoFeed`/`LiveFeed`/`priceFeedFor()` overloads not built (§2.2/§2.3) | **Accept the class.** Isolation is enforced by the registry (`registry.ts:45`), by the two role guards (`trading.ts:46-48`) and by the throwing steering methods, so the *behaviour* is right; what is lost is compile-time refusal. Residual gap = **A-1** |
| B-2 | `quotes()` returns `{}` unless `running`/`degraded`, and a second surface `displayQuotes()` serves the frozen tape (`feed.ts:328-367`) | **Accept — better than my spec.** Screens read `displayQuotes()`; defence in depth if a caller forgets the gate. Pass-6 amendment: the **money** path no longer reads `quotes()` alone — `tradeQuotes(action)` layers the per-symbol print-age gate on it (`feed.ts:508-516`), and `quotes()` survives as the slot-gated surface that settlement and conversion rates deliberately use |
| B-3 | `candles(symbol, frame)` is `async` and takes a `Timeframe` object; facade is `getCandles(feed, symbol, tf)` (`prices.ts:31-33`) | Accept — a provider read cannot be synchronous |
| B-4 | `marketOpen(feed)` requires the feed argument (mine was optional, `prices.ts:26`) | Accept — stricter, and it is what kills the global-hours bug class |
| B-5 | Payload is `feed: AccountType \| null` + `feedKey` + `source` + `state`/`degraded`/`paused`/`stale`/`simulatedMarks`/`reason`/`marketOpen`, with flat `mode` kept (`feed-context.ts:51-68`). **Pass 6:** A-10 added `lastMarkAt`/`lastQuoteMarketTime`/`marketAgeMs`/`transportAgeMs` and A-11 added `staleSymbols` — all additive, no field renamed or removed | Accept — satisfies §2.5's "must not change" list and gives the UI what K5 asked for. The additive-only rule is what made the `staleSymbols` client change a one-line `?? []` instead of a breaking release (`usePrices.ts:120`) |
| B-6 | `status()` reports `paused: true` for `misconfigured` too (`feed.ts:414`) | Accept — a slot that executes nothing is paused from the client's point of view; `state` is the precise field |
| B-7 | `failures` lives on the shared `Upstream`, so two slots on one provider see the same count while each runs its own state machine (`upstream.ts:33`, `feed.ts:381-383`) | Accept — that is the point of R7; the shared outage *should* hit both |
| B-8 | `degraded` is also entered at 2 consecutive failures while marks are still fresh (`feed.ts:317-319`) | Accept — strictly earlier and safer than §5.2's table; §5.2's age row remains the other entry |
| B-9 | The first poll that leaves `paused` updates marks without publishing (`feed.ts:284-288`) | Accept — hysteresis with no visible tick stream is correct while `quotes()` is still empty |
| B-10 | `publicFeed()` prefers `running`, not "degraded-tolerant" (`registry.ts:126-132`) | Accept, and it is the honest answer to **O4**: label the switch, never blank the ticker |
| B-11 | Steering step narrowed to 0.08–0.45 pips (`demoOutcome.ts:72-74`) | Accept — product tuning, and `RELEASE = 0.2` is what actually fixed the flat-line |
| B-12 | `Twelve Data` key read at call time (`twelvedata.ts:21-24`) rather than injected | Accept — rotation without a restart is worth the one `process.env` read |
| B-13 | Margin and P&L conversion rates read the **full** mark set, not the gated map (`trading.ts:64-66` comment, `feed.quotes()`) | **Accept (pass 6, ruling 5).** Dropping a dead pair made an unrelated fill throw `No conversion rate for JPY` — one frozen symbol as an outage on nine. The price that decides a trade is gated; the rate that only scales it is last-known, as the equity display already is |
| B-14 | No `LIVE_SYMBOL_STALE_MS`: the per-symbol gate shares the slot's `marketStaleMs` (`feed.ts:513`, `:522`) | **Accept (pass 6, ruling 6), and it corrects my own pass-5 note** which assumed a second knob. One threshold for one physical quantity — fewer numbers for an operator to set inconsistently |
| B-15 | I asked that engine settlement honour the per-symbol clock; it **logs** instead of gating (`feed.ts:559-564` → `trading.ts:296-301`) | **OVERRULED, and the reasoning is better (ruling 4).** Refusing to manage a frozen pair leaves it running with no stop; gating `close` per-symbol contradicts A-5. The warn fires after the transaction settles, so a refused or failed close cannot log a claim |

### 10.3 List C — not, or only partly, implemented (gaps A-1 … A-11)

Ordered by consequence. A-1 … A-9 are what survived the re-check; **A-10 was found while ranking
them for §10.7 and was the only one of the ten that could price real money on a dead market.**

> **Status as of pass 6 (A-11 shipped): A-1 … A-11 are CLOSED** — evidence in **§10.8** (A-1…A-9),
> **§10.10** (A-5's gate, A-10, and A-11 as built). The bullets below are the findings as filed; I have
> not rewritten them into a success story, only marked where each one landed. **No item in this list is
> open.** What remains is residual risk that has been *accepted by ruling*, not a gap: §10.10's
> accepted-risk list.

- **A-1 (was R1's second half).** No compile-time steering boundary: `liveFeed()` returns `Feed`,
  so `liveFeed().trackDemoPosition(…)` type-checks and only fails at runtime
  (`registry.ts:111-117`). Six lines of type aliases + overloads would close it. *Low risk today
  because every caller is inside `trading.ts` and gated by role.*
- **A-2.** `ENFORCE_MARKET_HOURS` is still one global knob, read straight from `process.env` inside
  `Feed.marketOpen()` (`feed.ts:281`), so §2.4's "only `config.ts` reads env" is violated and there
  is no `LIVE_ENFORCE_MARKET_HOURS`/`DEMO_ENFORCE_MARKET_HOURS`. The **semantics** are per-feed and
  tested (`feeds.test.ts:937-985`): a weekend pauses the live slot while the demo tape keeps
  running. What you cannot do is pause one real-provider slot's hours and not another's.
- **A-3.** `TD_DAILY_CREDIT_BUDGET` is implemented and tested (`config.ts:208`) but **absent from
  `.env.example`** — an operator cannot discover the only knob that lets a paid plan raise the
  ceiling. (I could not add it: this turn is root-markdown only.)
- **A-4.** `feedForRequest` silently drops to the session default when `?account` names an id that
  does not exist or belongs to someone else (`feed-context.ts:30-38`): the response is labelled
  `source: "session-default"`, which is truthful, but a caller expecting its own account gets the
  demo tape with no error. 404 would be clearer. Display-only.
- **A-5.** `closePosition()` pre-gates `"close"` for *every* reason and `closePositionLocked()` then
  re-derives `manage` for SL/TP/stop-out (`trading.ts:275` vs `:231`), and `placeOrder` evaluates
  the `open` gate twice (`:110`, `:155`). Harmless today (the engine calls the locked form
  directly), but an administrative force-close of a protective reason on a `degraded` live slot is
  refused. Decide explicitly whether ADMIN closes belong to `manage`.
- **A-6.** **T8 is still not automated.** `yahoo.test.ts` pins the spark shape against a
  self-authored fixture (`stub()` — it does not prove the host matches), and no test drives a real
  price through `/api/prices`. My live probe at 18:04 closes the *provider* question (HTTP 200,
  `spark.result`, EURUSD 1.1213 / GBPUSD 1.342 / USDJPY 157.678 in one batched request), not the
  end-to-end route. Keep it as a manual pre-demo step.
- **A-7.** `config.ts:235` warns about a shared upstream only when both slots are `yahoo`
  (`demo.mode === live.mode && demo.mode !== "simulated" && demo.mode === "yahoo"` — the middle
  clause is dead). Two slots on `twelvedata` share a loop silently.
- **A-8.** `registry.ts:71` still hashes `PRICE_FEED_ON_FAILURE` into the HMR signature. It changes
  no behaviour, and it implies support for a knob that does not exist — the F12 pattern in miniature
  (see §10.4 C-1).
- **A-9.** `isTradable()`'s `code` is typed `string`, not `FeedErrorCode` (`feed.ts:130`), so a
  client-side `switch` on it is unchecked. Cosmetic.
- **A-10 (F18/K11) — CLOSED on the pass-5 tree; built better than my brief and better than
  INFINITY's.** The defect as filed (verified by me on the 18:15 tree, now superseded):
  ```
  feed.ts:288 (then)  this.mids.set(symbol, { mid, prevClose, time: q.time })  // stamp stored, display only
  feed.ts:290 (then)  this.lastMarkAt = now                                     // clock = poll success
  feed.ts:196 (then)  const age = Date.now() - this.lastMarkAt                  // ageing = that clock
  ```
  **As built:** the slot keeps two clocks and both decide the state. `lastMarkAt` is the *transport*
  clock (`feed.ts:367`); `lastQuoteMarketTime` is the *market* clock, **recomputed from the current
  mark set on every poll** (`:377-379`), and `ageVerdict()` (`:232-257`) returns
  `running | degraded | paused` from `transportMs` against `staleMs`/`pauseMs` **and** `quoteMs`
  against `marketStaleMs`/`marketPauseMs`. `applyQuotes()` now *consults* that verdict instead of
  forcing `running` (`:384-399`), `settleAge()` only demotes, and leaving `paused` requires both
  `goodPolls ≥ RECOVERY_POLLS` **and** a `running` verdict — with a loud warning when the host
  answers but its marks are not alive. The refusal names the market, not the connection:
  *"the newest quote is 3h 12m old while the host keeps answering (transport 2s)"* (`:255-258`).
  Two deviations from the letter, both accepted (§10.10): market ageing has **its own floors**
  (`MARKET_STALE_MS=300_000`, `MARKET_PAUSE_MS=1_200_000`, `config.ts:156-170`) instead of reusing
  `staleMs`/`pauseMs`, and the market clock is **recomputed** rather than carried as a monotonic max
  — my `age = now - max(q.time)` would have let a host that starts replaying older prints keep
  `running` forever. Future stamps clamp to arrival; a payload with no usable stamp falls back to
  transport age and says so.
  **Ruling, resolved in code rather than by override:** market age is independent of
  `ENFORCE_MARKET_HOURS` — that switch is the session clock, not a licence to trade expired prints —
  so a closed or frozen tape takes a real-provider slot `degraded` then `paused` even on an install
  that asked for 24/7, while a simulated demo tape (prints stamped `now` by construction) keeps
  moving. My weekend-demo objection is answered by `DEMO_MARKET_*` overriding down from
  `LIVE_MARKET_*` (`config.ts:168-170`): one freshness policy for both slots, raisable per role.
- **A-11 (F19/K12) — CLOSED at pass 6, verified by me against the tree. Filed by INFINITY.** The finding,
  as filed: the market clock aged the **batch**, not the **symbol** — `lastQuoteMarketTime` is the
  *newest* print in the payload (`feed.ts:377-379`), so one frozen pair inside nine fresh ones never
  moved the slot state, and the slot-level surface (`quotes()` `:479-483`, then `quoteFor(symbol)`)
  priced an order on the dead symbol while the slot reported `running`. Same failure class as A-10 at
  one-symbol granularity, and it survived every guard A-10 added.
  **As built** (`feed.ts:491-564`, re-run: 106 tests / 5 files, 80 in `feeds.test.ts`):
  `quoteAgeMs(symbol, now)` ages that pair's own stamp with the same future clamp as the slot clock and
  returns `null` when unmarked (`:491-497`); `tradeQuotes(action, now)` applies the per-symbol gate on
  top of the slot verdict, dropping aged pairs for `open`/`modify` and returning the full map for
  `close`/`manage` (`:508-516`); `agedSymbol()` writes the refusal naming the pair, its print age and
  the threshold (`:519-527`); `assertSymbolTradable()` throws `FEED_STALE` with it (`:530-533`);
  `staleSymbols()` publishes the aged set (`:541` → `types.ts:95` → `feed-context.ts:99` →
  `usePrices.ts:57,80,120` with `?? []`, so an old SSE frame cannot crash the board → `LiveTicker.tsx:21-41`
  names the pairs in the header and tags the cell `frozen`). Aged pairs stay in `ticks()`/
  `displayQuotes()`. `quoteFor()` has no production callers and is documented display-only.
  **Enforcement layer** — my explicit question, and the answer is that it is one function: every money
  path in `trading.ts` goes through `quotesFor(feed, accountType, action, symbol)`, which asserts the
  slot gate, then the symbol gate, then returns the gated map (`trading.ts:68-74`); pending fills read
  `tradeQuotes("open")` (`engine.ts:29`); settlement reads the ungated `feed.quotes()` **by ruling**.
  NOVA's audit conclusion — no fill price is read through an ungated path — matches what I traced.
  My requested *reason* discipline shipped: a refusal says which pair and how old, not `FEED_STALE`
  alone. And the knob question resolved as I preferred: the gate **shares** `marketStaleMs`; there is
  no `LIVE_SYMBOL_STALE_MS` — one threshold for one physical quantity, and no second number for an
  operator to get wrong (§10.10).

### 10.4 Corrections to this document

- **C-1.** §5.4 and §8.2 listed `PRICE_FEED_ON_FAILURE` as a real knob. It never was one; no policy
  path reads it. Both sections amended. The *rule* it was meant to carry (a legacy install must not
  simulate a LIVE-serving slot by default) is satisfied anyway by `LIVE_FEED_ON_FAILURE`'s
  `pause` default.
- **C-2.** §7.3/§8.2 proposed `CANDLE_TTL_MS_1M`. Not built and not needed: the TTL is
  per-`Timeframe` data (`provider.ts:29-35`), which is the better shape.
- **C-3.** Every `prices.ts:NN` citation in §0–§9 refers to the **pre-split** file, now deleted.
  The facts moved to `config.ts:50-56` (precedence), `config.ts:101` (poll defaults),
  `yahoo.ts:44-49` (spark parse) and `feed.ts` (state machine).
- **C-4.** §2.4's "no `process.env` outside `config.ts`" was not met: `feed.ts:281` (A-2) and
  `twelvedata.ts:23` (accepted, B-12) read it. *(Pass 4: the A-2 half is closed — hours are resolved
  into the plan (`config.ts:43,284`) and `Feed.marketOpen()` reads `this.config` (`feed.ts:281-288`).
  The Twelve Data key read remains, accepted.)*
- **C-5.** §6.1 called the Twelve Data per-minute limit unverified — still true, and now moot: the
  day-budget guard binds first.
- **C-6 (mine, pass 4).** §5.4/§8.2 and the operator guide said a live slot running on simulated
  marks "is pinned at `degraded`, never `running`". **True only for the post-failure fallback**
  (`feed.ts:519`, tested `feeds.test.ts:429-453`). A slot *configured* onto simulated marks boots at
  `running` and `permits("open") === true` (`feeds.test.ts:423`) — which is what T4 and the AND-gate
  row always meant: an explicit opt-in is honoured loudly, not locked out. Corrected in
  `DUAL_FEED_GUIDE.md` §3/§6, `README.md`, `SETUP_COMPLETE.md` and `DEMO_QUICK_REFERENCE.md`. The
  design rule itself does not change; my description of its enforcement did.
- **C-7 (pass 4).** §5.2 and §9.1 K10 describe `degraded` as **manage-only**. After the A-5 ruling it
  is manage **and close** (`types.ts:145`). The risk text in both places is otherwise still correct,
  and the K10 mitigation ("`degraded` still manages from 15 s") now also covers a client exit.
  Where §5.2's *reason* sentence says `manage` only, read it as widened; the table's `open`/`modify`
  refusals are unchanged.

### 10.5 What remains open

Design rulings: **O2** (Twelve Data free-tier per-minute limit and quote quality — unmeasured),
**O3** (Yahoo batch ceiling beyond ~25 symbols — unverified; 10 confirmed live today), **O4**
(answered in code by `publicFeed()`; a product sign-off on the label is still welcome), **O5**
(synthetic demo stops are a product decision I preserved, now correctly gated on `steerable`).

Engineering, in priority order *(as filed at pass 3 — **every item below has since closed**, and so has
the A-11 that replaced them; see §10.8, §10.10 and the pass-6 note there for the evidence)*: **A-6** (automate
T8 or keep it as a written pre-demo step),
**A-2** (per-slot market hours via `config.ts`), **A-1** (narrowed feed surfaces), **A-3**
(`TD_DAILY_CREDIT_BUDGET` in `.env.example`), **A-8** (delete the dead key), **A-4/A-5/A-7/A-9**
(clarity, not correctness). Deferred by design: D1 per-account demo books (the only real fix for
multi-user win-rate fidelity — §4.3's nearest-target rule makes the contention *fair*, not exact),
D3 Twelve Data as a genuine execution source (needs a paid tier), D4 persistent candle history.

**Verification snapshot, re-run by me at the end of this review:**
`npx tsc --noEmit --incremental false` — **0 errors**. `npx vitest run` — **5 files / 82 tests, all
passing** (`feeds.test.ts` 58, `yahoo.test.ts` 4, plus the three `lib/trading` suites). `npm run lint`
— **2 errors, both pre-existing `no-require-imports` in `prisma/seed.js`**, unrelated to the feeds.
Live provider probe at 18:04 — HTTP 200, `spark.result`, EURUSD 1.1213 / GBPUSD 1.342 / USDJPY
157.678 in one batched request (A-6: this covers the provider, not the app route).
*(Superseded at 18:15 by the pass-4 re-run in §10.8: 88 tests, and the same probe now scripted and
`PASS 10/10`.)*

### 10.6 Settled: why the client never saw live prices (my dissent closed, and partly conceded)

Two probes and the git record, checked by INFINITY and me independently, agree:

- **Live shape (HTTP 200):** `spark.result` with 2 rows, row keys `["symbol","response"]`,
  `row.meta` **absent**, `response[0].meta.regularMarketPrice` = **1.1216** (EURUSD) and **1.3423**
  (GBPUSD). The parser's assumed shape is the host's actual shape.
- **Committed code (`git show HEAD:src/server/prices.ts`):** lines 46-52 already read
  `r?.response?.[0]?.meta` → `meta.regularMarketPrice`, and line 22 was
  `mode = PRICE_FEED === "simulated" ? "simulated" : "yahoo"` — so **HEAD's parser was right and
  HEAD honoured `PRICE_FEED`.**

**Causal chain, replacing the parser story entirely.** The user never saw live prices because of the
**uncommitted working-tree resolver from the prior session**: when `DEMO_WIN_RATE != null` it
returned `"simulated"` for the *whole system*, so `start()` branched into the simulation and never
issued a Yahoo poll. The fix that produced real live prints is the **R3 precedence ruling**
(`DEMO_WIN_RATE` selects no provider, ever — `config.ts:50-56`, `:141`), not a parser repair.
The wrong-level parse did exist, but only inside NOVA's own intermediate `src/server/feeds/`
rewrite, and she fixed it within that session; `yahoo.test.ts`'s fixture shape is correct.

**What I concede.** My dissent disproved the *scope* of the parser claim ("never produced a real
price in this repo") — it did not disprove that a parser defect existed, and it was not the reason
the demo failed either. **What I keep.** The engineering consequence matters more than the
attribution: an engineer told "the parser was broken" audits `yahoo.ts`; the actual hazard sat in
`resolveFeedMode()` precedence, and it is the class of bug §8.2 exists to prevent. Both probes are
now written down so nobody re-litigates them. **Still open after pass 6:** the T8 half of A-6 — the probe
is now a real npm script (`npm run probe:yahoo`, `probe:yahoo:full`) and prints each quote's stamp and age,
but no automated test drives a *real* print through `/api/prices`, and CI stays out of scope (there is no
repo-owned CI config to add it to). **Still open as accepted risk, not as a gap:** the residual list in
§10.10. The lesson of A-10/A-11 one level up is now enforced in code, not prose: *a slot verdict is not a
symbol verdict*, which is why `tradeQuotes(action)` ages every pair on its own print
(`feed.ts:508-516`) and why `staleSymbols` rides in the payload (`:541`) — "the state says `running`" is
still not evidence that the pair you are filling is alive, and the build no longer asks you to treat it as
such. (A-10 itself is closed: `feed.ts:232-257` compares the *print* age, not the poll age.)

### 10.7 Gap ranking (ship-blocking vs deferrable), with my disagreement

Against INFINITY's rulings of 2026-11-02. "Ship-blocking" = do not call the dual-feed work done, or
demo it to a client with a live account, until it is closed.

| Gap | Verdict | One-line reason |
|---|---|---|
| **A-10** | **SHIP-BLOCKING** (new; not yet assigned to anyone) | It prices live money against a print the market stopped making, and the repo's own `.env` (`ENFORCE_MARKET_HOURS=false`) is the setting that removes the guard |
| **A-4** | **SHIP-BLOCKING** — ruled, agreed | A wrong or foreign `?account` id silently showing the steered demo tape is an honesty defect on a screen a client watches; fail closed with 404 |
| **A-5** | **SHIP-BLOCKING**, **but I dispute its current form** — see below | Agreed that refusing a manual close is worse for the client; the exception is that `degraded` also covers a live slot running on **synthetic** marks |
| **A-2** | Ship-blocking **if** A-10 is solved by the env route; otherwise deferrable | Per-slot hours in `config.ts` is one of the two acceptable fixes for the weekend hole; on its own it is a convenience |
| **A-3** | Deferrable **for a Yahoo install**, blocking **for a Twelve Data install** | The boot refusal names a knob that no shipped example documents, so a TD deployment cannot self-resolve; `.env.example` is NOVA's file to edit (requested, not done) |
| A-1 | Deferrable, worth doing now | Three runtime guards already hold (`registry.ts:45`, `trading.ts:46-48`, throwing steering); this buys compile-time refusal, six lines |
| A-6 | Deferrable, but write it into the pre-demo checklist | The provider is proven live; the app route is proven only by fixture tests whose shape I authored myself |
| A-7 | Deferrable | A missing "both slots share one loop" note for `twelvedata` is log completeness, not behaviour |
| A-8 | Deferrable, delete-on-touch | A dead key in an HMR signature implies support for a knob that does not exist (C-1) |
| A-9 | Deferrable | `code: string` weakens client typing; no money path depends on it |

**Pass-4 status of this ranking (18:15).** The verdicts above were written against the pre-A-5 tree;
they are kept as the record of what I thought at 18:05. What actually happened: **A-1, A-2, A-3, A-4,
A-7, A-8, A-9 are closed** and **A-5's permission shipped** (each with evidence in §10.8);
**A-6 is mostly closed** by `src/server/scripts/yahoo-probe.mjs`; **A-10 remains, and is now the
whole ranking** — plus the missing `simulatedMarks` gate and the age-floor trap, which were
unimaginable when this table was written. Ship-blocking today = **§10.9 items 1 and 2**.

> **Pass-5 correction to that note (final gate).** Both items I called ship-blocking closed while I
> was writing §10.8/§10.9 — the `simulatedMarks` gate shipped, and A-10 shipped with its own market
> clocks, so the age-floor trap never arose (§10.9 items 1–2, §10.10). The ranking above is therefore
> **historical**: at pass 5 the only open engineering item was **A-11**, inheriting A-10's failure class
> at per-symbol granularity. **Pass 6: A-11 shipped too, so this table has no open row** — every gap
> listed here is closed, and what is left is the accepted-risk list in §10.10, which is a sign-off, not
> a to-do. The methodological point stands — a gap list is a snapshot, and the honest version says how
> stale it is.

**Where I disagree (A-5, narrowly).** Making `close` a `degraded`-permitted action is right for a
slot whose marks are **real but old** — closing reduces exposure, exactly like the SL/TP that
`manage` already honours, and a client watching a 20-second-old EURUSD should be allowed to exit.
But `degraded` is also the state a **live slot on the failure fallback tape** is pinned at
(`feed.ts:722-727`), and a live slot booted under `LIVE_ALLOW_SIMULATED=true` (`capped`), and there
the mark is not stale, it is **invented**: `close` would settle real money against a simulated price
and book the P&L the house takes as revenue (K2). Proposal: `degraded: ["manage", "close"]` **gated
on `!simulatedMarks`** — permit it when `capped === null && fellBack === false`, keep refusing it
when the tape is synthetic, while `manage` stays allowed in every `degraded` case because protective
closures were promised at those levels when the position was opened. That keeps the intent of the
ruling without making "live trading is degraded" and "live trading is fiction" the same permission
set. `modify` remains refused in both.

**Ruling accepted 2026-11-02 18:05**, with `close` gated on the marks being real. What is actually in
the tree is in §10.8 — the permission half shipped, the gate did not.

### 10.8 Close-out (pass 4, verified by me against the 18:15 tree)

> **Pass 5 note.** Everything below was true at 18:15 and is kept as measured. Two rows moved:
> **A-5's gate shipped** and **A-10 shipped** — see §10.10 for the as-built evidence, and note that
> the `feed.ts:288/290/196` triple cited here was replaced by the rewrite. Final gate numbers:
> **0 type errors / 99 tests (73 in `feeds.test.ts`) / 2 pre-existing lint errors / probe
> `PASS 10/10` with print age.**

Verification re-run by me, not taken on report: `tsc --noEmit --incremental false` → **0 errors**.
`vitest run` → **88 tests / 5 files, all passing** (up from 82). `npm run lint` → **2 errors, both
the pre-existing `no-require-imports` in `prisma/seed.js`**. `node src/server/scripts/yahoo-probe.mjs`
→ `PASS 2/2` at 16:09:39Z (EURUSD 1.1196, GBPUSD 1.3412); `--full` → **`PASS 10/10`** in one batched
request at 16:09:50Z. Two probes ~5 min apart moved both prints, which is independent evidence that
the host is answering with a live market and not a frozen close.

| Gap | State | Evidence, and my verdict on the deviation |
|---|---|---|
| A-1 | **closed** | `LiveFeed` (`feed.ts:559`) and `DemoFeed` (`:567`) are real subclasses; steering lives only on the demo one. Proven at compile time by four `@ts-expect-error` lines (`feeds.test.ts:251,253,255,257`) — if the surfaces ever merge, the build fails on the *unused* directive. **Better than my letter**, which asked for type aliases + overloads; subclassing puts the behaviour where the type is. |
| A-2 | **closed** | `enforceMarketHours` resolved into the plan (`config.ts:43`, `:284`) and read from `this.config` in `Feed.marketOpen()` (`feed.ts:281-288`). §2.4's "only `config.ts` reads env" now holds on the hours path. |
| A-3 | **closed** | `TD_DAILY_CREDIT_BUDGET="720"` documented with the live/demo asymmetry spelled out at `.env.example:105-111`. (NOVA's file; I did not touch it.) |
| A-4 | **closed** | 404 + `code: "ACCOUNT_NOT_AVAILABLE"` + `source: "rejected"` for an unknown/foreign id (`feed-context.ts:47`) **and** for `?account` on an anonymous request (`:42`). I specified a plain 404; the distinct `rejected` source is better — a payload can now say "you asked, you were refused" rather than looking like a fallback. The anonymous extension is in the same spirit and I agree with it. |
| A-5 | **permission shipped, gate absent** | `PERMISSIONS.degraded = ["manage", "close"]` (`types.ts:113`), tested at `feeds.test.ts:313-335`. **The `!simulatedMarks` gate INFINITY accepted is not implemented**: `permits()` is a pure table lookup (`feed.ts:132-135`) and `simulatedMarks` (`:447`) is consumed only by logging and the payload. See the finding below. |
| A-6 | **mostly closed** | `src/server/scripts/yahoo-probe.mjs` makes the provider assertion reproducible and band-checked, `--full` covers all 10 pairs. It is **not** wired into `package.json` scripts or CI, and it still does not drive `/api/prices` — the route half of T8 stays open. |
| A-7 | **closed** | shared-upstream warning no longer conditioned on `yahoo` only (plan-derived); two `twelvedata` slots now say so. |
| A-8 | **closed, superseded by a better fix** | I asked to delete the dead `PRICE_FEED_ON_FAILURE` key from the HMR signature. NOVA replaced the whole input: `envSignature` hashes the **built plan** (`registry.ts:82`), per-slot including `capped` (`:99`). A dead key can no longer appear in a signature at all, and a knob that changes nothing can never mask a restart. Accept — this closes the class, not the instance. |
| A-9 | **closed** | `FeedErrorCode` typing on `isTradable` (`feed.ts:136`) and `code: FeedErrorCode` in the status/error shapes. |
| A-10 | **closed at the final gate** *(was: open, assigned at pass 4)* | See §10.10. The `feed.ts:290` / `:196` / no-print-age-in-`status()` triple measured here was the 18:15 tree and no longer exists in this form. |

**NOVA's own catch, recorded because it was mine to specify and I did not.** The TD budget guard read
`TD_POLL_MS` without checking the slot's mode, so `LIVE_FEED=yahoo` plus a small `TD_POLL_MS` parked
the live slot `misconfigured` over a cadence it was never going to use. She found and fixed it. A
guard that inspects an *unused* knob is the same failure family as F12/C-1: configuration that
pretends to be behaviour. **Confirmed hers, not a correction of mine — I never filed it.**

### 10.9 What pass 4 flagged, and how each one resolved

1. **The A-5 gate — RESOLVED at the final gate.** Filed here as "missing"; NOVA built it while this
   section was being written. As built: `permitted(state, action, marksAreReal)` with a documented
   exception table `DEGRADED_ON_SIMULATED_MARKS = ["manage"]` (`types.ts:159-172`), applied at the
   single money gate `permits()` with `!this.simulatedMarks` (`feed.ts:149`). `degraded` on simulated
   marks → manage only; `close` refused with its own text (*"opening or closing on a price this
   system invented would book P&L that never happened"*, `feed.ts:185-187`); `modify` still refused;
   `PERMISSIONS` remains the source of truth and the exception is one named constant, not an
   `if`-spray. **Closed.**
2. **The age-floor trap — DID NOT MATERIALISE, and the reason is worth keeping.** My reasoning about
   the naive fix was right (print-ageing against `staleMs=15_000`/`pauseMs=60_000` would have held a
   healthy ~60 s Yahoo feed permanently stale), but NOVA avoided it structurally: market freshness
   got **its own floors** — `MARKET_STALE_MS=300_000`, `MARKET_PAUSE_MS=1_200_000` (`config.ts:156-157`)
   with per-role overrides `DEMO_MARKET_*` falling back to `LIVE_MARKET_*` (`:166-169`) — so the two
   clocks are independent and a one-minute print cadence sits comfortably inside `running`. Her live
   evidence, and the shape of the check I would have asked for: a default boot reporting
   `running, marketAgeMs 18965, transportAgeMs 720`, and a tightened boot
   (`LIVE_MARKET_STALE_MS=1000 LIVE_MARKET_PAUSE_MS=5000`) reporting `paused` with a reason naming the
   print age **while the host kept answering**. **Closed, by a better structure than my proposal.**
3. **My capped-slot over-claim — CORRECTED.** `feeds.test.ts:418-426` asserts `permits("open") === true`
   for a live slot *booted* on simulated marks; the guide's "never `running`" was wrong and is fixed
   in guide §3/§6, `README.md`, `SETUP_COMPLETE.md`, `DEMO_QUICK_REFERENCE.md` (see C-6). The related
   ruling on the `manage`-vs-`close` asymmetry is recorded in §10.10 item 2.

**Still genuinely open after pass 5, with where each one landed.** **A-11** (§10.3, F19/K12) — the
batch-level market clock, then the head of the ship-blocker list: **CLOSED at pass 6** by
`quoteAgeMs()`/`tradeQuotes()`/`assertSymbolTradable()` (`feed.ts:491-533`), §10.10.
**O2** (Twelve Data free-tier quote quality and per-minute limit — unmeasured,
reachable only with a key) — **still open**, and unmeasurable without a key; A-11 does not change it,
because a TD payload carries no print stamp so the per-symbol gate degenerates to transport age.
**O3** (Yahoo batch ceiling — 10 confirmed live repeatedly; beyond that undocumented) — **still open**.
**A-6 remainder** — `src/server/scripts/yahoo-probe.mjs` proves the provider and prints the quote
timestamp and its age; at pass 6 it is a **real npm script** (`npm run probe:yahoo`,
`npm run probe:yahoo:full`, `package.json:14-15`). Still not in CI **by scope** — there is no
repo-owned CI config, and I am not inventing one — and no automated test drives a *real* print through
`/api/prices`; that half of T8 remains a written pre-demo step. **D1/D3/D4** — deferred by design:
per-account demo books, Twelve Data as an execution source (paid tier), persistent candle history.

### 10.10 Pass 5 (final gate) and pass 6 (A-11): as-built, and the rulings that closed my objections

**Pass-6 numbers re-run by me on this tree:** `tsc --noEmit --incremental false` → **0 errors**;
`vitest run` → **106 tests / 5 files** (80 in `feeds.test.ts`, up from 99/73); `npm run lint` → the two
pre-existing `prisma/seed.js` errors; `HEAD` still `5f2d2c1`; `.env` untouched. **A-1 … A-11 are
closed** (§10.3, §10.8, and this section). Pass-5 numbers, kept as the record of that gate:
**99 tests / 5 files** (73 in `feeds.test.ts`); `node src/server/scripts/yahoo-probe.mjs --full` →
**`PASS 10/10`** at 16:52:44Z with per-symbol print stamps (`EURGBP 0.8349 … age 1s`).

**Ruling 1 — my weekend-demo objection was answered in code, not overridden.** I argued that making
market age independent of `ENFORCE_MARKET_HOURS` would silently untrade a `DEMO_FEED=yahoo` install
every weekend. The resolution is better than either position: **freshness is a property of the print,
not of the account looking at it**, so `LIVE_MARKET_*` is one policy for both slots — which is why a
demo reading a real provider is *not* exempt from a dead price — and a demo that needs more latitude
raises `DEMO_MARKET_*` (`config.ts:168-170`). A simulated tape is immune by construction because its
prints are stamped `now` (`feed.ts:702`, `:738`). I accept this as the right resolution of our disagreement, and
record it that way: the objection was answered, not lost.

**Ruling 2 — the `manage`/`close` asymmetry in `degraded` is deliberate, and the consent boundary is
the mark's origin, not its age.** An opted-in `LIVE_ALLOW_SIMULATED` slot stays fully tradable
including `close` (it is `running`, and `DEGRADED_ON_SIMULATED_MARKS` only bites in `degraded`):
refusing `close` there would trap real positions with no exit and break the §8.3 back-compat promise
on the `PRICE_FEED=simulated` inheritance path. `manage` stays unconditional on simulated marks
because a refused stop-out is a position left running unprotected. I accept both. **What I still wanted
pinned is now pinned:** `feeds.test.ts:426` — *"an opted-in simulated live slot RUNS on simulated marks
and keeps closing (ruling)"* — alongside `:476` (degraded on simulated marks manages but closes nothing)
and `:297` (degraded on real marks closes). The asymmetry is defined by *which state you are in* and by
*who consented to the tape*; that is now a test, not a comment.

**Ruling 3 — NOVA's deviations-from-letter are FINAL, accepted as better than my spec:** the
`closeAction(reason)` split (§10.8/A-5), `source: "rejected"` (§10.8/A-4), `envSignature` hashing the
built plan (§10.8/A-8), and the `LiveFeed`/`DemoFeed` subclasses (§10.8/A-1). The TD mode-scoping
catch is hers (§10.8). Pass 6 adds two more, **final for the same reason**: the full-map `marginUSD`/
`pnlUSD` read (ruling 5) and the decision to share `marketStaleMs` rather than mint a second knob
(ruling 6). She also fixed a flake she had introduced — an A-10 payload assertion comparing two
`Date.now()` reads with a 2 ms bound; it now allows 1 s and proves the fields are not swapped by
asserting `marketAgeMs > 5 min` against `transportAgeMs < 5 s` (`feeds.test.ts:841-852`), which is a
stronger test than the brittle one it replaced.

**A-11, as built — the fix shipped in the shape I asked for, with one part of my ask overruled.**
Per-symbol print-age gating sits on the **trading surface** (`tradeQuotes(action)`, `feed.ts:508-516`),
not in the slot verdict: one dead pair does not stop nine healthy ones, the display keeps showing it
(`ticks()`/`displayQuotes()` unchanged), and only the tradeable map drops it. My reason-discipline
addition shipped verbatim: `agedSymbol()` names the pair, its print age and the threshold, and says the
held positions are still managed and closable (`:519-527`) — not a bare `FEED_STALE`. My point 2 (payload
visibility) was accepted outright: `staleSymbols()` (`:541`) → `FeedStatus` (`types.ts:95`) →
`feedPayload` (`feed-context.ts:99`) → `FeedView` (`usePrices.ts:57,80,120`, `?? []` so an old SSE frame
cannot crash the board) → `LiveTicker.tsx:21-41` naming the pairs in the header and tagging the cell
`frozen`. Additive; no existing field changed.

**Ruling 4 (pass 6) — my point 1, engine settlement, is resolved by logging rather than gating, and I
record that as INFINITY overruling me, correctly.** I asked that SL/TP and stop-out also respect the
per-symbol clock. The counter-argument is the stronger one and is the same one §5.3 and A-5 already used
on the slot table: refusing to *manage* a frozen pair leaves the position running with **no stop at all**,
and gating `close` per-symbol would contradict the ruling that stale-but-real marks may close. So
`tradeQuotes()` returns the full map for `close`/`manage` (`feed.ts:510`), `agedMarkNote()` composes the
wording (`:559-564`), and `closePositionLocked()` emits a `console.warn` **after the transaction settles**
and only when `closeAction(reason)` is `manage` (`trading.ts:296-301`) — so a refused or failed close can
never log a claim it did not make. I accept the reasoning; the sequencing detail (log after settlement,
not before) is what makes it honest, and it is exactly the shape I would have specified.

**Ruling 5 (pass 6) — NOVA's `marginUSD`/`pnlUSD` deviation is accepted, and it is the right call.**
Those read the **full** mark set, not the gated map, because dropping a dead pair makes an unrelated
fill throw `No conversion rate for JPY`: one frozen symbol becoming an outage on nine is precisely the
failure A-11 exists to prevent. The principle that resolves it — and I adopt it as the design's own — is
**the price that decides a trade is gated; the rate that only scales it is last-known**, which is
already how the equity display behaves. Recorded in §10.2's accepted-deviation list.

**Ruling 6 (pass 6) — one threshold, one physical quantity.** The per-symbol gate deliberately shares
`marketStaleMs`; there is **no** `LIVE_SYMBOL_STALE_MS`. I support this and file it against myself: my
pass-5 note anticipated a second knob. A separate symbol-level floor would have invited an operator to
set the two inconsistently, and the quantity being measured — how long since this pair printed — is the
same one the slot clock measures across the batch. Fewer knobs, no new env surface, no new way to
misconfigure (§8.2).

**Accepted residual risks (pass 6).** These are sign-offs, not open items; each is deliberate and each is
visible somewhere:
1. **A protective close on a frozen pair is logged, not blocked** — a stop or TP priced off a mark past
   `marketStaleMs` may have fired **late, early or not at all**; the log line names the pair, the age and
   the settled price (`trading.ts:296-301`). Accepted because an unmanaged position is the worse harm.
2. **Conversion rates for margin/P&L are last-known**, so a scale factor can be minutes stale while the
   traded price is gated (ruling 5).
3. **A Twelve Data payload has no print stamp** (`twelvedata.ts:49-55`), so per-symbol market age equals
   transport age and the print-age gate is inert there. Not a hole in practice — that tier pauses on
   transport first — but it is why TD is a backfill source, not an execution source.
4. **`LIVE_ALLOW_SIMULATED=true` is a staging-only switch.** A live slot booted on invented marks is
   `running` and tradable, and it marks the **house's own b-book exposure** with prices nobody made (K2).
   The consent boundary is the operator's opt-in and the only guard is visibility: `simulatedMarks`,
   `mode: "simulated"`, the `SIMULATED live prices` boot line and the UI's "Simulated" label. This is the
   risk I would still want a named human to sign before a real account uses it.
5. **No repo-owned CI.** The gate is: typecheck 0 errors, 106 tests, probe `PASS 10/10` **run by hand**.
   `npm run probe:yahoo:full` is now the scripted step; a machine that runs it on every push is not.

**Twelve Data, and why this matters twice.** `/price` carries **no print timestamp**
(`twelvedata.ts:49-55`), so this mode stamps arrival: market age equals transport age and the
print-age guard is inert there. It costs nothing in practice, because the cheapest cadence a free key
can afford (20 min) already exceeds `LIVE_PAUSE_MS` — a Twelve Data live slot pauses on transport
alone. That is a second, independent reason the free tier is a **backfill source and not an execution
source** (§6, guide §5).

---

**Design status: decision-complete for §1–§8, with O1–O5 flagged, and reconciled to the shipped
tree.** §1–§9 were written 2026-11-02 before any implementation and ruled NOVA's work; **§10 is the
as-built audit** of `src/server/feeds/**`, `feed-context.ts`, `{prices,trading,engine,bootstrap}.ts`
and the prices/candles/admin routes, re-verified by me on the pass-6 tree (**0 type errors / 106 tests
across 5 files, 80 in `feeds.test.ts` / 2 pre-existing lint errors / probe `PASS 10/10` with print ages /
`HEAD` still `5f2d2c1`**).
**A-1 … A-11 are CLOSED** — §10.8 for A-1…A-9, §10.10 for the A-5 gate, A-10 and A-11 — and every
contested ruling (O1, the asymmetric Twelve Data budget guard, degraded-`close`, the
`ENFORCE_MARKET_HOURS` independence, per-symbol gating and the deliberately ungated conversion rates) is
settled in §2.6/§8.5/§10.7/§10.10, including the places where my own text was wrong (§10.4 C-1, C-6,
C-7) and the one ask of mine that was overruled on better reasoning (ruling 4).
**Nothing in this document asks a live account to wait.** For the shape this repo's `.env` actually runs
(`DEMO_FEED=simulated` + `LIVE_FEED=yahoo`), the design is built, tested and gated: a frozen pair is
dropped from `open`/`modify` by name, published as `staleSymbols`, tagged `frozen` in the ticker, and
still closable and still managed. What remains is **not** an open defect. It is (a) the five accepted
residual risks in §10.10 — chief among them that `LIVE_ALLOW_SIMULATED=true` marks the house's own
b-book exposure with prices nobody made, which needs a named human's sign-off rather than a checkbox;
(b) an evidence gate that is still manual: `npm run probe:yahoo:full` before a client demo, because there
is no repo-owned CI and I will not invent one; (c) provider unknowns that need a key or a longer
watchlist (O2, O3); and (d) the deliberate deferrals D1/D3/D4.
A `running` slot is still not, by itself, proof that *this pair* is alive — but the build now says so for
you: `staleSymbols`, the per-symbol `Tick.time`, and a refusal that names the pair and its age while the
other nine fill normally.
Operator-facing truth lives in `DUAL_FEED_GUIDE.md`; this file is the design and the review record,
not a runbook.
