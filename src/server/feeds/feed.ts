import { EventEmitter } from "node:events";
import { INSTRUMENT_META, INSTRUMENTS } from "@/lib/instruments";
import { outcomeForPosition, stepTowardTarget, targetMidForDemo, type DemoOutcome } from "@/lib/trading/demoOutcome";
import { generateHistory, midsFromBook, pairMid, setPairMid, stepUsdBook, type UsdBook } from "@/lib/trading/fxSim";
import { quoteFromMid, isFxMarketOpen, roundTo, type QuoteMap, type Side } from "@/lib/trading/math";
import { instrumentsSync } from "../instrumentCache";
import type { FeedConfig } from "./config";
import { CandleStore, type Candle } from "./candles";
import type { PriceProvider, Timeframe } from "./provider";
import type { ProviderQuote } from "./provider";
import type { Upstream, UpstreamHandlers } from "./upstream";
import { dedicatedUpstream, upstreamForMode } from "./upstream";
import {
  humanAge,
  permitted,
  FeedError,
  type AccountType,
  type DemoPositionTrack,
  type FeedAction,
  type FeedErrorCode,
  type FeedMode,
  type FeedRole,
  type FeedState,
  type FeedStatus,
  type Tick,
} from "./types";

export type { AccountType, Candle, DemoPositionTrack, FeedMode, Tick };

interface Mid {
  mid: number;
  prevClose: number;
  time: number;
}

interface DemoTarget {
  id: string;
  accountId: string;
  symbol: string;
  side: Side;
  openPrice: number;
  pipSize: number;
  spreadPips: number;
  outcome: DemoOutcome;
  targetMid: number;
}

const SIM_HISTORY_MINUTES = 500;
/** Leaving `paused` takes two consecutive good polls, so a flapping host cannot thrash. */
const RECOVERY_POLLS = 2;

export interface FeedOverrides {
  /** Injected in tests so a feed can be driven without timers or network. */
  provider?: PriceProvider | null;
  rand?: () => number;
  tickMs?: number;
  pollMs?: number;
  historyMinutes?: number;
  /**
   * Tests set this false to keep a remote-mode feed deterministic: otherwise a
   * suite run on a Sunday asserts a different state than one run on a Tuesday.
   * `ENFORCE_MARKET_HOURS` itself is resolved into the plan (A-2), so production
   * behaviour never depends on this override.
   */
  respectMarketHours?: boolean;
}

/**
 * One independent price source: its own mode, mid map, currency book, candle
 * store and state machine. Two Feed instances share only the upstream poll loop,
 * which is what keeps a steered demo tape and a real live tape from contaminating
 * each other.
 *
 * This base class is the surface **both** slots have, and it deliberately owns
 * no steering methods: `trackDemoPosition` and friends live on `DemoFeed` only,
 * so `live.trackDemoPosition(…)` is a compile error rather than a runtime
 * discovery (design A-1). The runtime guard stays as well — see `asDemoFeed`.
 */
export class Feed extends EventEmitter {
  readonly key: FeedRole;
  /** The only account type these marks may price. Implied by `key` (SB1). */
  readonly servedType: AccountType;
  mode: FeedMode;
  lastMarkAt = 0;
  /**
   * The newest *market* timestamp among accepted quotes — the provider's own
   * stamp for a real feed (`regularMarketTime`), `now` for a simulated one. This
   * is what A-10 ages against; `lastMarkAt` only proves we reached the host.
   */
  lastQuoteMarketTime = 0;
  started = false;

  protected readonly config: FeedConfig;
  private readonly upstream: Upstream | null;
  private readonly store = new CandleStore();
  protected readonly rand: () => number;
  private readonly tickMs: number;
  private readonly historyMinutes: number;
  private readonly mids = new Map<string, Mid>();
  protected book: UsdBook = {};
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private feedState: FeedState = "idle";
  private reason = "";
  private goodPolls = 0;
  private readonly respectsHours: boolean;
  /** Live marks that came from the failure fallback: management only, forever. */
  private fellBack = false;

  constructor(config: FeedConfig, overrides: FeedOverrides = {}) {
    super();
    this.config = config;
    this.key = config.key;
    this.servedType = config.purpose;
    this.mode = config.mode;
    this.rand = overrides.rand ?? Math.random;
    this.tickMs = overrides.tickMs ?? config.pollMs;
    this.historyMinutes = overrides.historyMinutes ?? SIM_HISTORY_MINUTES;
    this.respectsHours = overrides.respectMarketHours ?? true;

    const pollMs = overrides.pollMs ?? config.pollMs;
    if (overrides.provider !== undefined) {
      this.upstream = overrides.provider ? dedicatedUpstream(overrides.provider, pollMs, config.key) : null;
    } else if (config.mode === "simulated") {
      this.upstream = null;
    } else {
      this.upstream = upstreamForMode(config.mode, pollMs);
    }
    this.setMaxListeners(1000);
  }

  // ---------- state machine ----------

  state(): FeedState {
    this.settleAge();
    return this.feedState;
  }

  /**
   * Does this feed allow `action` right now? Two halves, in this order:
   * 1. the state's own permissions (`degraded` still manages and closes);
   * 2. the A-5 refinement: `close` additionally requires **real** marks. A
   *    degraded slot running on simulated prices — through `LIVE_ALLOW_SIMULATED`
   *    or the failure fallback — would book P&L from a number this system
   *    invented, which is the very thing the feature exists to prevent. `manage`
   *    stays unconditional, because a refused stop-out is a position left to run.
   */
  permits(action: FeedAction): boolean {
    return permitted(this.state(), action, !this.simulatedMarks);
  }

  isTradable(action: FeedAction): { ok: true } | { ok: false; code: FeedErrorCode; reason: string } {
    if (this.permits(action)) return { ok: true };
    return { ok: false, code: this.errorCode(), reason: this.refusal(action) };
  }

  /** THE money gate: anything the current state forbids throws before a cent moves. */
  assertTradable(action: FeedAction): void {
    if (this.permits(action)) return;
    throw new FeedError(this.errorCode(), this.refusal(action));
  }

  private errorCode(): FeedErrorCode {
    switch (this.state()) {
      case "misconfigured":
        return "FEED_MISCONFIGURED";
      case "degraded":
        return "FEED_STALE";
      case "paused":
        return "FEED_PAUSED";
      case "stopped":
        return "FEED_STOPPED";
      default:
        return "FEED_STARTING";
    }
  }

  private refusal(action: FeedAction): string {
    const who = this.servedType === "LIVE" ? "Live" : "Demo";
    const state = this.state();
    if (state === "misconfigured") return `${who} feed is misconfigured: ${this.reason}`;
    if (state === "degraded") {
      // The A-5 refinement's own words: on simulated marks even a close is
      // refused, and saying only "prices are stale" would hide the real reason.
      if (this.simulatedMarks) {
        return `${who} marks are SIMULATED (${this.reason || "no real prices available"}) — held positions are still managed, but opening or closing on a price this system invented would book P&L that never happened, so both are refused until real marks return`;
      }
      return action === "manage" || action === "close"
        ? `${who} feed cannot ${action} positions: ${this.reason}`
        : `${who} prices are stale (${this.reason}) — held positions are still managed and closable, new orders are refused`;
    }
    if (state === "paused") {
      return `${who} trading is paused: ${this.reason}. Open positions are safe and no new trades will be filled.`;
    }
    if (state === "stopped") return `${who} feed is stopped`;
    return `${who} feed has not produced prices yet`;
  }

  private setState(next: FeedState, reason: string) {
    if (this.feedState === next && this.reason === reason) return;
    this.feedState = next;
    this.reason = reason;
    if (next === "paused" || next === "misconfigured") console.warn(`[prices:${this.key}] ${this.refusal("open")}`);
    this.emit("status", this.status());
  }

  /**
   * Age-based transitions, evaluated on read so a stalled loop still degrades.
   *
   * Two ages are measured, and the worse verdict decides (A-10):
   * - **transport age** — how long since the source last answered. That is what
   *   `lastMarkAt` has always recorded, and it is a *connectivity* number;
   * - **market age** — how long since the newest print the source actually
   *   served, read from the provider's own timestamp. A host answering HTTP 200
   *   with Friday's close has transport age ~0 and market age of days.
   *
   * Judging only the first lets a 200 response keep a dead tape `running` and
   * fill live orders at a price the market abandoned (§5.2, A-10).
   */
  private settleAge() {
    if (this.feedState !== "running" && this.feedState !== "degraded") return;
    if (!this.lastMarkAt) return;
    const verdict = this.ageVerdict();
    if (verdict.state !== "running") this.setState(verdict.state, verdict.reason);
  }

  /**
   * The age verdict on its own, so the poll path can weigh it *before* writing
   * state — leaving `paused` is gated by the recovery hysteresis, and a feed that
   * is merely answering again is not yet a feed whose prices are alive (A-10).
   */
  private ageVerdict(): { state: "paused" | "degraded" | "running"; reason: string } {
    // A scheduled closure parks the machine exactly like an outage (§5.2): no
    // marks are trustworthy when there is no market. This is the session clock,
    // and `ENFORCE_MARKET_HOURS=false` turns only this branch off — never the
    // print-age guard below, which asks whether a price is still alive.
    if (this.hoursClosed()) return { state: "paused", reason: "the FX market is closed" };
    const now = Date.now();
    const transportMs = this.lastMarkAt ? now - this.lastMarkAt : 0;
    const quoteMs = this.marketAgeMs(now);
    const paused = transportMs > this.config.pauseMs || quoteMs > this.config.marketPauseMs;
    const degraded = transportMs > this.config.staleMs || quoteMs > this.config.marketStaleMs;
    // The market story wins when it is guilty on its own: "no fresh prices"
    // sends an operator hunting for a network fault, and there isn't one.
    const byQuote = quoteMs > (paused ? this.config.marketPauseMs : this.config.marketStaleMs);
    const aged = byQuote ? this.agedReason(quoteMs, transportMs) : null;
    if (paused) return { state: "paused", reason: aged ?? `no fresh prices for ${humanAge(transportMs)}` };
    if (degraded) return { state: "degraded", reason: aged ?? `last mark ${humanAge(transportMs)} old` };
    return { state: "running", reason: "" };
  }

  /**
   * Why the market went bad rather than the connection. Naming the host's
   * behaviour is what makes the state credible: the provider is still answering,
   * and its prices are not.
   */
  private agedReason(quoteMs: number, transportMs: number): string {
    return `the newest quote is ${humanAge(quoteMs)} old while the host keeps answering (transport ${humanAge(transportMs)})`;
  }

  /** How long ago the newest print this slot accepted was made on the market. */
  marketAgeMs(now = Date.now()): number {
    return this.lastQuoteMarketTime ? Math.max(0, now - this.lastQuoteMarketTime) : 0;
  }

  /**
   * Transport freshness: how long since this feed last *received* something.
   * Kept because the payloads and the admin panel already read it — but it is
   * only half of "is this price alive", which is the whole of A-10.
   */
  markAgeMs(now = Date.now()): number {
    return this.lastMarkAt ? Math.max(0, now - this.lastMarkAt) : 0;
  }

  /**
   * Market hours belong to the source: a simulated tape has no session, a real
   * provider does. `ENFORCE_MARKET_HOURS=false` opens both — and is resolved into
   * the plan at boot, so this reads configuration, never `process.env`, and a
   * feed built from an env object behaves exactly as that object says (A-2, §8.2).
   */
  marketOpen(): boolean {
    if (!this.config.enforceMarketHours) return true;
    return this.respectsMarketHours() ? isFxMarketOpen() : true;
  }

  /** Session closure that stops trading through this feed, honouring the test override. */
  private hoursClosed(): boolean {
    return this.respectsHours && !this.marketOpen();
  }

  // ---------- lifecycle ----------

  start() {
    if (this.started) return;
    this.started = true;

    if (this.config.illegal) {
      this.setState("misconfigured", this.config.illegal);
      return;
    }
    if (this.mode === "simulated") {
      this.startSimulated();
      return;
    }
    if (!this.upstream) {
      this.setState("misconfigured", `no provider implementation for mode "${this.mode}"`);
      return;
    }
    if (!this.upstream.provider.isConfigured()) {
      // A missing key is a misconfigured state, never a reason to invent prices (R5).
      // Only a demo slot may take its own simulation instead, and it says so loudly.
      if (this.config.onFailure === "simulate" && this.servedType === "DEMO") {
        console.warn(
          `[prices:${this.key}] ${this.mode} provider is not configured — the DEMO role runs its own simulation instead (set DEMO_FEED_ON_FAILURE=pause to refuse)`,
        );
        this.startSimulated();
        return;
      }
      this.setState("misconfigured", `${this.mode} provider is not configured (see TWELVE_DATA_API_KEY)`);
      return;
    }
    this.setState("starting", `waiting for the first ${this.mode} poll`);
    if (!this.unsubscribe) this.unsubscribe = this.upstream.subscribe(this.handlers());
    void this.upstream.pollOnce();
  }

  stop() {
    this.started = false;
    this.stopSim();
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    if (this.feedState !== "idle") this.setState("stopped", "feed stopped");
  }

  /** True while this feed is driving its own tape. */
  private simulating() {
    return this.timer !== null;
  }

  private stopSim() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private handlers(): UpstreamHandlers {
    return {
      onQuotes: (quotes) => this.applyQuotes(quotes),
      onFailure: (failure) => this.recordFailure(failure.message, failure.failures, failure.blocking),
    };
  }

  private applyQuotes(quotes: Map<string, ProviderQuote>) {
    if (this.feedState === "stopped") return;
    // A provider answer outranks the failure fallback: retire the tape and mark
    // from real quotes again, otherwise a recovered host and a simulation would
    // both write to `mids` and the last one to tick would win.
    this.stopSim();
    this.mode = this.config.mode;
    const now = Date.now();
    for (const [symbol, q] of quotes) {
      const prev = this.mids.get(symbol);
      // `q.time` is the provider's own print stamp and travels two places: into
      // the mark (and so into `Tick.time` for the UI's as-of) and into the market
      // clock below, which is what the state machine ages on (A-10).
      this.mids.set(symbol, { mid: q.mid, prevClose: q.prevClose ?? prev?.prevClose ?? q.mid, time: q.time });
    }
    this.lastMarkAt = now;
    // The market clock is the NEWEST stamp among the marks this feed now holds,
    // recomputed on every poll (A-10). Recomputing rather than carrying a maximum
    // forward matters: a host that begins replaying older prints — a cache, a
    // failover mirror, a series that halted — has to age out exactly like one that
    // stops answering, and a monotonic max would hide that behind the last print
    // that *was* live. A stamp in the future is host clock skew and is clamped to
    // the moment of arrival; a payload with no usable stamp at all (Twelve Data's
    // `/price` carries none) falls back to transport age, which is what this feed
    // did before A-10 and says so in `twelvedata.ts`.
    let newest = 0;
    for (const m of this.mids.values()) newest = Math.max(newest, Math.min(m.time, now));
    this.lastQuoteMarketTime = newest > 0 ? newest : now;
    this.goodPolls += 1;
    // A successful poll does not by itself mean these marks are alive: the age
    // verdict still decides, and `running` is only reached when both ages pass.
    const before = this.feedState;
    const verdict = this.ageVerdict();
    if (before === "paused") {
      if (this.goodPolls < RECOVERY_POLLS) return;
      if (verdict.state !== "running") {
        this.fellBack = false;
        this.setState(verdict.state, verdict.reason);
        // Loud, because "the host came back" and "the prices came back" are not
        // the same event and only the second one restarts new orders.
        console.warn(`[prices:${this.key}] ${this.mode} answers, but its marks are not alive: managing only (${this.reason})`);
        this.publish();
        return;
      }
      console.log(`[prices:${this.key}] ${this.mode} provider recovered`);
    }
    this.fellBack = false;
    this.setState(verdict.state, verdict.reason);
    this.publish();
  }

  private recordFailure(message: string, failures: number, blocking: boolean) {
    if (this.feedState === "stopped") return;
    this.goodPolls = 0;
    const maySimulate = this.config.onFailure === "simulate";

    if (failures >= this.config.failureThreshold || blocking) {
      // Already on the fallback tape: re-seeding it every poll would teleport the
      // market, so the fallback is armed once and holds until a poll recovers.
      if (this.simulating()) return;
      if (maySimulate && this.servedType === "DEMO") {
        console.warn(`[prices:${this.key}] ${this.mode} provider unavailable, falling back to simulated prices`);
        this.startSimulated();
        return;
      }
      if (maySimulate && this.servedType === "LIVE") {
        console.warn(
          `[prices:${this.key}] ${this.mode} provider unavailable — LIVE falls back to simulated marks under LIVE_ALLOW_SIMULATED: held positions are managed, no new position opens`,
        );
        this.fellBack = true;
        this.startSimulated();
        this.setState("degraded", `${message} (live marks are simulated after a provider failure)`);
        return;
      }
      this.setState("paused", blocking ? `${message} — the provider rejected this client` : message);
      return;
    }
    if (failures >= 2 && this.feedState === "running") {
      this.setState("degraded", `${message} (${failures} consecutive failures)`);
    }
  }

  // ---------- marks ----------

  /**
   * Display surface: the last marks this feed produced, even when they are too
   * old to trade. A frozen tape that admits it is frozen beats a hidden one.
   */
  ticks(): Tick[] {
    const insts = instrumentsSync();
    const out: Tick[] = [];
    for (const [symbol, m] of this.mids) {
      const inst = insts.get(symbol);
      if (!inst) continue;
      const { bid, ask } = quoteFromMid(m.mid, inst.spreadPips, inst.pipSize, inst.digits);
      out.push({
        symbol,
        bid,
        ask,
        mid: roundTo(m.mid, inst.digits + 1),
        changePct: m.prevClose ? roundTo(((m.mid - m.prevClose) / m.prevClose) * 100, 3) : 0,
        time: m.time,
      });
    }
    return out;
  }

  /**
   * Display surface: marks as numbers, last-known even when they are too old or
   * absent to trade. A frozen tape that admits it is frozen beats a hidden one,
   * and an open position must still show its Friday P/L over the weekend.
   */
  displayQuotes(): QuoteMap {
    const q: QuoteMap = {};
    for (const t of this.ticks()) q[t.symbol] = { bid: t.bid, ask: t.ask, time: t.time };
    return q;
  }

  /**
   * Trading surface: marks only while this feed can act on them at all. A paused
   * or misconfigured feed returns nothing, so even a caller that forgot to ask
   * the gate cannot price a trade.
   *
   * This is the SLOT-level verdict. `close` and `manage` read it as-is; new or
   * edited risk reads `tradeQuotes()`, which ages every symbol on its own print
   * (A-11). The engine's protective loop deliberately uses this ungated map.
   */
  quotes(): QuoteMap {
    const state = this.state();
    if (state !== "running" && state !== "degraded") return {};
    return this.displayQuotes();
  }

  /**
   * How long ago THIS SYMBOL printed (A-11). The slot clock is the newest stamp
   * on the tape, so one frozen pair inside an otherwise healthy batch never moves
   * the slot: nine fresh prints mask a Friday close, and `running` would fill the
   * dead one. Null when the feed has no mark for the symbol at all.
   */
  quoteAgeMs(symbol: string, now = Date.now()): number | null {
    const m = this.mids.get(symbol);
    if (!m) return null;
    // Clamped exactly like the slot clock: a stamp from the future is host skew
    // and must not let a symbol claim freshness it cannot prove.
    return Math.max(0, now - Math.min(m.time, now));
  }

  /**
   * The trading surface for one action, gated per symbol on top of the slot
   * verdict (A-11). `open` and `modify` price new or edited risk, so they lose
   * every symbol whose own print is older than `marketStaleMs`. `close` and
   * `manage` keep them: a frozen pair is exactly the one whose stop or whose
   * owner wants out, and refusing that traps the position (§5.3, A-5). Aged
   * symbols stay in `ticks()`/`displayQuotes()` — a frozen tape that admits it is
   * frozen beats one that hides the pair.
   */
  tradeQuotes(action: FeedAction, now = Date.now()): QuoteMap {
    const q = this.quotes();
    if (action === "close" || action === "manage") return q;
    for (const symbol of Object.keys(q)) {
      const age = this.quoteAgeMs(symbol, now);
      if (age !== null && age > this.config.marketStaleMs) delete q[symbol];
    }
    return q;
  }

  /** Why one tradeable slot refuses ONE symbol; null when it may be traded. */
  agedSymbol(symbol: string, action: FeedAction, now = Date.now()): string | null {
    if (action === "close" || action === "manage") return null;
    const age = this.quoteAgeMs(symbol, now);
    if (age === null || age <= this.config.marketStaleMs) return null;
    const who = this.servedType === "LIVE" ? "Live" : "Demo";
    // Names the symbol and its age: "prices are stale" would be a lie when the
    // rest of the tape is live, and the client needs to know which pair froze.
    return `${who} ${symbol} has no live quote — its print is ${humanAge(age)} old (the per-symbol gate is ${humanAge(this.config.marketStaleMs)}) while the rest of the tape is live, so ${action} would price risk off a dead quote. Held ${symbol} positions are still marked, managed and closable.`;
  }

  /** The per-symbol half of the money gate, said out loud instead of as a missing price. */
  assertSymbolTradable(symbol: string, action: FeedAction, now = Date.now()): void {
    const reason = this.agedSymbol(symbol, action, now);
    if (reason) throw new FeedError("FEED_STALE", reason);
  }

  /**
   * Every pair whose OWN print is past `marketStaleMs`, sorted (A-11). This is
   * payload vocabulary, not a gate: `state` still answers for the tape, and an
   * entry here is exactly a cell the client should mark untradeable while the rest
   * of the board stays live. Empty on a healthy batch.
   */
  staleSymbols(now = Date.now()): string[] {
    const aged: string[] = [];
    for (const symbol of this.mids.keys()) {
      const age = this.quoteAgeMs(symbol, now);
      if (age !== null && age > this.config.marketStaleMs) aged.push(symbol);
    }
    return aged.sort();
  }

  /**
   * The residual hazard of "manage always runs", said out loud (steering §1). A
   * protective close priced off a 20-minute-old mark can fire late, early or not
   * at all; refusing it would leave the position running with no stop, which the
   * slot table already rejects as the larger harm. So it executes, and the log
   * records which pair and how stale, for anyone reading mispriced stop-outs
   * after the fact. The settlement path emits this; it is composed here so the
   * wording is one place and unit-testable without a database.
   */
  agedMarkNote(symbol: string, action: FeedAction, now = Date.now()): string | null {
    if (action !== "manage") return null;
    const age = this.quoteAgeMs(symbol, now);
    if (age === null || age <= this.config.marketStaleMs) return null;
    return `[prices:${this.key}] protective close on ${symbol} priced off a mark ${humanAge(age)} old (per-symbol gate is ${humanAge(this.config.marketStaleMs)}) — the level may have fired late, early or not at all; accepted rather than leaving the position unmanaged`;
  }

  /**
   * Last mark for one symbol, slot-gated only. This is the DISPLAY/management
   * accessor — it deliberately does not apply the per-symbol gate, so nothing
   * that prices a fill may read it: the trading path goes through
   * `tradeQuotes()`/`assertSymbolTradable()` (A-11).
   */
  quoteFor(symbol: string) {
    return this.quotes()[symbol] ?? null;
  }

  /**
   * The poll loop this feed reads. Shared with every other feed of the same
   * provider mode, which is how two slots cost one upstream request (§2.6-R7).
   */
  get poller(): Upstream | null {
    return this.upstream;
  }

  get failures(): number {
    return this.upstream?.failures ?? 0;
  }

  isStale(): boolean {
    const state = this.state();
    return state === "degraded" || state === "paused" || state === "misconfigured";
  }

  /** Marks exist but are too old for new orders; held positions are still managed. */
  isDegraded(): boolean {
    return this.state() === "degraded";
  }

  /** Why this feed is not trading, in its own words. */
  pauseReason(): string {
    this.state();
    return this.reason;
  }

  status(): FeedStatus {
    const state = this.state();
    const now = Date.now();
    return {
      role: this.key,
      purpose: this.servedType,
      mode: this.mode,
      provider: state === "degraded" && this.fellBack ? `${this.mode} (fallback)` : this.mode === "simulated" ? "internal simulation" : this.mode,
      state,
      started: this.started,
      lastMarkAt: this.lastMarkAt,
      // The two ages, side by side (A-10): `transportAgeMs` is when we last heard
      // from the host, `marketAgeMs` is when the market last printed. A UI that
      // only shows the first will say "live" over a weekend.
      lastQuoteMarketTime: this.lastQuoteMarketTime,
      marketAgeMs: this.lastQuoteMarketTime ? this.marketAgeMs(now) : null,
      transportAgeMs: this.lastMarkAt ? this.markAgeMs(now) : null,
      // Which pairs the per-symbol gate is currently refusing (A-11), so the UI
      // can mark one cell untradeable instead of saying "prices are stale".
      staleSymbols: this.staleSymbols(now),
      failures: this.failures,
      stale: state === "degraded" || state === "paused" || state === "misconfigured",
      degraded: state === "degraded",
      paused: state === "paused" || state === "misconfigured",
      reason: this.reason,
      steerable: this.steerable,
      winRate: this.winRate,
      simulatedMarks: this.simulatedMarks,
      trackedDemoPositions: this.trackCount(),
      symbols: this.mids.size,
    };
  }

  /** The win rate steering targets, or null when steering is switched off. */
  get winRate(): number | null {
    return this.config.steering.allowed ? this.config.steering.winRate : null;
  }

  /**
   * Steering is configured AND is moving this feed's marks. A demo slot priced
   * by a real provider registers targets but cannot bend anyone's prices, so it
   * reports false here even though `winRate` is set.
   */
  get steerable(): boolean {
    return this.config.steering.allowed && this.winRate != null && this.mode === "simulated";
  }

  /** Live marks that are simulated — by config or after a provider failure. */
  get simulatedMarks(): boolean {
    return this.servedType === "LIVE" && this.mode === "simulated";
  }

  /** Market hours are a property of the source: a simulation has no session. */
  respectsMarketHours(): boolean {
    return this.mode !== "simulated";
  }

  candles(symbol: string, frame: Timeframe): Promise<Candle[]> {
    if (this.mode === "simulated") return Promise.resolve(this.store.bars(symbol, frame.seconds));
    if (!this.upstream) return Promise.resolve([]);
    return this.store.fetched(symbol, frame, (sym) => this.upstream!.provider.fetchCandles(sym, frame), (message) =>
      console.warn(`[prices:${this.key}] ${message}`),
    );
  }

  // ---------- steering hooks (overridden by the demo slot only) ----------

  /**
   * A base feed walks its own tape and nothing else. `DemoFeed` overrides this to
   * drag the book toward the nearest tracked target (§4.3) — which is why the
   * live slot can be steered by construction, not by convention (A-1).
   */
  protected steerBook(book: UsdBook): UsdBook {
    return book;
  }

  /** How many steering targets this slot holds: always zero outside the demo feed. */
  protected trackCount(): number {
    return 0;
  }

  // ---------- tapes ----------

  /**
   * Build this feed's simulated tape — its own book, candle store and mid map —
   * without arming a timer. Public so tests can advance tapes by hand.
   */
  seedSim(now = Date.now()) {
    this.mode = "simulated";
    const generated = generateHistory(this.historyMinutes, this.rand);
    this.book = generated.book;
    this.store.load(generated.bars);

    const mids = midsFromBook(this.book);
    for (const inst of INSTRUMENTS) {
      const mid = mids[inst.symbol] ?? inst.seedPrice;
      const bars = generated.bars.get(inst.symbol);
      const prevClose = bars && bars.length ? bars[Math.max(0, bars.length - 390)].close : mid;
      this.mids.set(inst.symbol, { mid, prevClose, time: now });
    }
    this.lastMarkAt = now;
    // A simulated print is made now, by definition: the market-age guard has
    // nothing to complain about on a tape this process generates (A-10).
    this.lastQuoteMarketTime = now;
    this.goodPolls = 0;
  }

  private startSimulated(now = Date.now()) {
    const winRate = this.config.steering.winRate;
    this.seedSim(now);
    if (this.config.steering.allowed) {
      console.log(
        winRate != null
          ? `[prices:${this.key}] simulated FX tape (${this.tickMs}ms). Win-rate targeting ${(winRate * 100).toFixed(0)}%, steering demo accounts only`
          : `[prices:${this.key}] simulated FX tape (${this.tickMs}ms ticks, session volatility, correlated crosses)`,
      );
    } else {
      console.warn(
        `[prices:${this.key}] LIVE tape is running on SIMULATED marks (${this.config.capped ?? this.reason}) — held positions are marked, no new risk is taken on a real account`,
      );
    }
    this.stopSim();
    this.timer = setInterval(() => this.stepSim(), this.tickMs);
    this.setState(this.fellBack ? "degraded" : "running", this.fellBack ? this.reason : "");
    this.stepSim();
  }

  /** Advance one simulation step. Exposed for tests that assert tape independence. */
  stepSim(dtMs = this.tickMs, now = Date.now()) {
    this.book = stepUsdBook(this.book, dtMs / 1000, new Date(now), this.rand);
    this.book = this.steerBook(this.book);
    const nextMids = midsFromBook(this.book);
    for (const [symbol, m] of this.mids) {
      const mid = nextMids[symbol] ?? m.mid;
      this.mids.set(symbol, { ...m, mid, time: now });
      this.store.push(symbol, mid, now);
    }
    this.lastMarkAt = now;
    // A simulated print is made now, by definition: nothing on a tape this
    // process generates can be "stale" in the A-10 sense while it is stepping.
    this.lastQuoteMarketTime = now;
    if (this.feedState === "starting") this.setState("running", "");
    this.publish();
  }

  /**
   * One provider round-trip, delivered through this feed's handlers. It
   * subscribes first if the loop has not been armed yet, so a hand-driven feed
   * runs its own state machine instead of polling into the void.
   */
  async pollProvider(): Promise<void> {
    if (!this.upstream) return;
    if (!this.unsubscribe) this.unsubscribe = this.upstream.subscribe(this.handlers());
    await this.upstream.pollOnce();
  }

  private publish() {
    this.emit("ticks", this.ticks());
  }
}

/**
 * The live slot. It is `Feed` and nothing more: no steering surface exists on it,
 * so `live.trackDemoPosition(…)` does not typecheck and a real account cannot be
 * steered by accident, by refactor, or by an optimistic cast (design A-1).
 */
export class LiveFeed extends Feed {}

/**
 * The demo slot: the only feed that owns steering targets. Registering a
 * position here is what makes a win rate mean anything, and it is unreachable
 * from a live feed by construction. The runtime guard is kept as well, so a
 * `DemoFeed` built from a config that forbids steering still throws (R2).
 */
export class DemoFeed extends Feed {
  private readonly targets = new Map<string, DemoTarget>();

  constructor(config: FeedConfig, overrides: FeedOverrides = {}) {
    super(config, overrides);
    if (!config.steering.allowed) {
      throw new FeedError("FEED_MISCONFIGURED", `DemoFeed needs a steerable config (slot "${config.key}")`);
    }
  }

  trackDemoPosition(pos: DemoPositionTrack) {
    this.assertSteerable(pos.id);
    const winRate = this.config.steering.winRate;
    if (winRate == null) return;
    const inst = INSTRUMENT_META[pos.symbol];
    const pipSize = pos.pipSize || inst?.pipSize || 0.0001;
    const spreadPips = pos.spreadPips || inst?.spreadPips || 1.2;
    const outcome = outcomeForPosition(pos.id, winRate);
    const targetMid = targetMidForDemo(
      { side: pos.side, openPrice: pos.openPrice, stopLoss: pos.stopLoss, takeProfit: pos.takeProfit, pipSize, spreadPips },
      outcome,
    );
    this.targets.set(pos.id, {
      id: pos.id,
      accountId: pos.accountId,
      symbol: pos.symbol,
      side: pos.side,
      openPrice: pos.openPrice,
      pipSize,
      spreadPips,
      outcome,
      targetMid,
    });
  }

  updateDemoStops(id: string, sl: number | null, tp: number | null) {
    this.assertSteerable(id);
    const cur = this.targets.get(id);
    if (!cur) return;
    this.trackDemoPosition({
      id: cur.id,
      accountId: cur.accountId,
      symbol: cur.symbol,
      side: cur.side,
      openPrice: cur.openPrice,
      stopLoss: sl,
      takeProfit: tp,
      pipSize: cur.pipSize,
      spreadPips: cur.spreadPips,
    });
  }

  untrackDemoPosition(id: string) {
    this.assertSteerable(id);
    this.targets.delete(id);
  }

  clearAccount(accountId: string) {
    this.assertSteerable(accountId);
    for (const [id, t] of this.targets) {
      if (t.accountId === accountId) this.targets.delete(id);
    }
  }

  /** R2: reaching a feed whose config forbids steering is a routing defect, not a no-op. */
  private assertSteerable(id: string): void {
    if (!this.config.steering.allowed) {
      throw new FeedError("FEED_MISCONFIGURED", `steering is not available on the "${this.key}" feed (attempted for ${id})`);
    }
  }

  protected override trackCount(): number {
    return this.targets.size;
  }

  /**
   * Design §4.3: several demo accounts can hold the same pair with opposite
   * intended outcomes, and one shared tape cannot deliver all of them. Arbitrate
   * by proximity — steer toward the tracked target whose `targetMid` is nearest
   * the current mid — which is deterministic, independent of who registered
   * first, and starves nobody permanently: as the tape sweeps toward one target
   * another becomes the nearest and takes over. Win-rate accuracy still degrades
   * with concurrency; this makes the degradation fair instead of arbitrary, and
   * per-account demo books (design D1) remain the real fix.
   */
  private nearestTargets(book: UsdBook): DemoTarget[] {
    const chosen = new Map<string, { target: DemoTarget; distance: number }>();
    for (const t of this.targets.values()) {
      const inst = INSTRUMENT_META[t.symbol];
      if (!inst) continue;
      const distance = Math.abs(t.targetMid - pairMid(inst.base, inst.quote, book));
      const best = chosen.get(t.symbol);
      if (!best || distance < best.distance) chosen.set(t.symbol, { target: t, distance });
    }
    return [...chosen.values()].map((c) => c.target);
  }

  protected override steerBook(book: UsdBook): UsdBook {
    const winRate = this.config.steering.winRate;
    if (winRate == null || this.targets.size === 0) return book;
    let next = book;
    for (const t of this.nearestTargets(next)) {
      const inst = INSTRUMENT_META[t.symbol];
      if (!inst) continue;
      const current = pairMid(inst.base, inst.quote, next);
      const stepped = stepTowardTarget(current, t.targetMid, t.pipSize, this.rand);
      // Inside the release band the step is the natural walk: writing it back
      // through `setPairMid` would clamp the symbol to a fixed mid forever.
      if (stepped === current) continue;
      next = setPairMid(next, inst.base, inst.quote, stepped);
    }
    return next;
  }
}

/**
 * The class a config deserves: steering exists only where the plan allowed it,
 * so the type follows the configuration instead of trusting the caller (A-1).
 */
export function buildFeed(config: FeedConfig, overrides: FeedOverrides = {}): Feed {
  return config.steering.allowed ? new DemoFeed(config, overrides) : new LiveFeed(config, overrides);
}

/**
 * Narrow a feed you only know as `Feed` to the steering surface. Compile-time
 * proof would be `feedFor("DEMO")`; this is the runtime half, so a cast or a
 * mis-routed instance still cannot bend a live tape (A-1, R2).
 */
export function asDemoFeed(feed: Feed, context: string): DemoFeed {
  if (!(feed instanceof DemoFeed)) {
    throw new FeedError("FEED_MISCONFIGURED", `steering is not available on the "${feed.key}" feed (attempted for ${context})`);
  }
  return feed;
}

