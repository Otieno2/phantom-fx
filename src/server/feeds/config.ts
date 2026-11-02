import { demoWinRateFromEnv } from "@/lib/trading/demoOutcome";
import { INSTRUMENTS } from "@/lib/instruments";
import {
  humanAge,
  roleFor,
  servedType,
  type AccountType,
  type FailurePolicy,
  type FeedMode,
  type FeedRole,
} from "./types";

export type { AccountType, FailurePolicy, FeedMode, FeedRole };

const MODES: FeedMode[] = ["yahoo", "simulated", "twelvedata"];
/** Which upstream a public (anonymous) viewer is served from. */
const ROLES: FeedRole[] = ["demo", "live"];

function parseMode(raw: string | undefined | null): FeedMode | null {
  const value = (raw ?? "").trim().toLowerCase();
  return MODES.find((m) => m === value) ?? null;
}

function parseRole(raw: string | undefined | null, fallback: FeedRole): FeedRole {
  const value = (raw ?? "").trim().toLowerCase();
  return ROLES.find((r) => r === value) ?? fallback;
}

function policy(raw: string | undefined | null, fallback: FailurePolicy): FailurePolicy {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "pause" || value === "simulate" ? value : fallback;
}

function flag(raw: string | undefined | null): boolean {
  return (raw ?? "").trim().toLowerCase() === "true";
}

/**
 * `ENFORCE_MARKET_HOURS=false` is the documented around-the-clock switch; any
 * other value — including nonsense — keeps the FX session. Resolved into the
 * plan so a feed never reads `process.env` while it runs (A-2, §8.2).
 */
function enforceMarketHours(raw: string | undefined | null): boolean {
  return (raw ?? "").trim().toLowerCase() !== "false";
}

function ms(raw: string | undefined | null, fallback: number): number {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Per-role mode resolution (design §8.2), highest wins:
 *   1. the role's own switch (`DEMO_FEED` / `LIVE_FEED`)
 *   2. `PRICE_FEED`, as a fallback for both roles
 *   3. the role default: `simulated` for demo, `yahoo` for live
 * `DEMO_WIN_RATE` is deliberately absent: it enables steering and selects no
 * provider, ever (§2.6-R3).
 */
function roleMode(role: FeedRole, env: Record<string, string | undefined>): { mode: FeedMode; inherited: boolean } {
  const own = parseMode(role === "live" ? env.LIVE_FEED : env.DEMO_FEED);
  if (own) return { mode: own, inherited: false };
  const legacy = parseMode(env.PRICE_FEED);
  if (legacy) return { mode: legacy, inherited: true };
  return { mode: role === "live" ? "yahoo" : "simulated", inherited: false };
}

export interface SteeringConfig {
  /** Only the demo role may ever be steered. A steering call on `false` throws (R2). */
  allowed: boolean;
  /** `DEMO_WIN_RATE`, or null when steering is switched off. */
  winRate: number | null;
}

export interface FeedConfig {
  key: FeedRole;
  mode: FeedMode;
  /** The account type whose marks originate here — implied by `key`, never a list (SB1). */
  purpose: AccountType;
  steering: SteeringConfig;
  /** Real provider dead: stop trading or fall back to this feed's own simulation. */
  onFailure: FailurePolicy;
  /** `LIVE_ALLOW_SIMULATED`: the AND-gate on any simulated mark reaching the live role. */
  allowSimulated: boolean;
  failureThreshold: number;
  /** Transport age limits: how long since the source last answered. */
  staleMs: number;
  pauseMs: number;
  /**
   * Market age limits (A-10): how long since the newest *print* the source
   * served. A host can answer HTTP 200 with Friday's close, and transport age
   * alone cannot see that — these two numbers are what makes a dead price
   * visible to the state machine.
   */
  marketStaleMs: number;
  marketPauseMs: number;
  pollMs: number;
  /**
   * `ENFORCE_MARKET_HOURS`, resolved once here instead of being read off
   * `process.env` on every state transition (A-2): a feed built from an env
   * object then behaves exactly as that object says, and a test needs no global
   * mutation to prove a Sunday pause.
   */
  enforceMarketHours: boolean;
  /** Why this slot is illegal, if it is. Non-null parks the feed in `misconfigured`. */
  illegal: string | null;
  /** Live marks that are simulated by config, not by failure: never `running`. */
  capped: string | null;
}

export interface FeedPlan {
  demo: FeedConfig;
  live: FeedConfig;
  /** Which role the anonymous/public ticker reads (`PUBLIC_FEED`, default live). */
  publicRole: FeedRole;
  warnings: string[];
}

/**
 * Design §6: a Twelve Data batch costs one credit per symbol, so 10 symbols at
 * 3 s is 288 000 credits/day against an 800-credit free tier — "360 times
 * impossible". 20 min is the cadence that fits the budget (72 polls × 10 = 720
 * credits); at that rate the live slot lands in `degraded`/`paused` by §5, which
 * is the point — a free Twelve Data key is a backfill source, not an execution
 * source. Yahoo needs no such guard: it is unmetered and batched.
 */
const POLL_MS: Record<FeedMode, number> = { simulated: 250, yahoo: 2500, twelvedata: 1_200_000 };

function pollMs(mode: FeedMode, env: Record<string, string | undefined>): number {
  if (mode === "simulated") return ms(env.DEMO_POLL_MS, POLL_MS.simulated);
  if (mode === "twelvedata") return ms(env.TD_POLL_MS, POLL_MS.twelvedata);
  return ms(env.REMOTE_POLL_MS, POLL_MS.yahoo);
}

/**
 * A-10: how old a *print* may be before the slot stops trusting it, measured from
 * the provider's own timestamp rather than from our last successful request.
 *
 * In an open FX session a major pair prints every second or two, and Yahoo's
 * `regularMarketTime` moves with them. Five minutes of market silence therefore
 * does not mean "quiet" — it means the host is serving something that is no longer
 * a live quote (a cached body, a halted series, a clock that stopped). That is the
 * point where new orders must stop and only management continues: `degraded`.
 * Twenty minutes is where "the tape is behind" becomes "the tape is a museum
 * for twenty minutes, so the slot pauses and nothing executes (§5.2).
 *
 * These are deliberately larger than `staleMs`/`pauseMs` (15 s/60 s), which watch
 * the *connection*. Both ages are evaluated and the worse one wins: a healthy 200
 * response never promotes a feed whose marks are old back to `running`.
 *
 * Consequence the operator should expect: the daily rollover lull and a weekend
 * both age the real tape out, so a live slot goes degraded then paused while the
 * simulated demo tape keeps moving. `ENFORCE_MARKET_HOURS=false` does not lift
 * that — it gates the session clock, not whether a price is still alive.
 */
const MARKET_STALE_MS = 300_000;
const MARKET_PAUSE_MS = 1_200_000;

/**
 * Market freshness is a property of the print, not of the account looking at it,
 * so `LIVE_MARKET_*` is one policy for both slots: the live slot is where a dead
 * price costs real money, and that is why the knobs are named for it. A demo slot
 * reading a real provider inherits the same numbers and may raise them with
 * `DEMO_MARKET_*`; a simulated tape is unaffected either way, because its prints
 * are stamped `now` by construction.
 */
function marketAges(role: FeedRole, env: Record<string, string | undefined>): { marketStaleMs: number; marketPauseMs: number } {
  const stale = role === "live" ? env.LIVE_MARKET_STALE_MS : (env.DEMO_MARKET_STALE_MS ?? env.LIVE_MARKET_STALE_MS);
  const pause = role === "live" ? env.LIVE_MARKET_PAUSE_MS : (env.DEMO_MARKET_PAUSE_MS ?? env.LIVE_MARKET_PAUSE_MS);
  return { marketStaleMs: ms(stale, MARKET_STALE_MS), marketPauseMs: ms(pause, MARKET_PAUSE_MS) };
}

/**
 * Design §6: Twelve Data charges one credit per symbol *inside a batch*, so a
 * whole-set poll costs `INSTRUMENTS.length` credits and the free tier is a day
 * budget rather than a rate. 720 of 800 leaves headroom for candle backfill.
 */
const SYMBOLS_PER_POLL = INSTRUMENTS.length;
const TD_DEFAULT_BUDGET = 720;

export function tdCreditsPerDay(pollMsValue: number, symbols = SYMBOLS_PER_POLL): number {
  return Math.ceil((86_400_000 / pollMsValue) * symbols);
}

export function minAffordablePollMs(budget: number, symbols = SYMBOLS_PER_POLL): number {
  return Math.ceil((86_400_000 * symbols) / budget);
}

/** Why this Twelve Data cadence is unaffordable, with the arithmetic spelled out (§6). */
function creditBudgetProblem(poll: number, budget: number): string {
  const polls = Math.ceil(86_400_000 / poll);
  return (
    `${poll} ms => ${polls} polls/day x ${SYMBOLS_PER_POLL} symbols = ${polls * SYMBOLS_PER_POLL} credits/day, ` +
    `but TD_DAILY_CREDIT_BUDGET=${budget}. Cheapest cadence that fits: TD_POLL_MS=${minAffordablePollMs(budget)}.`
  );
}

/** One slot. Pure: reads nothing but `env` and its own role. */
function slot(key: FeedRole, env: Record<string, string | undefined>, warnings: string[]): FeedConfig {
  const role = key;
  const live = role === "live";
  const resolved = roleMode(role, env);
  let mode = resolved.mode;
  const { inherited } = resolved;
  const winRate = live ? null : demoWinRateFromEnv(env);
  const allowSimulated = flag(env.LIVE_ALLOW_SIMULATED);
  const threshold = ms(env.FEED_FAILURE_THRESHOLD, 3);
  const budget = ms(env.TD_DAILY_CREDIT_BUDGET, TD_DEFAULT_BUDGET);

  // A cadence the key cannot pay for is refused at boot, never discovered
  // mid-demo. A live slot is refused outright below; a demo slot instead takes
  // over its own tape, which costs zero credits and is what the demo is for.
  if (mode === "twelvedata" && !live && tdCreditsPerDay(pollMs(mode, env)) > budget) {
    warnings.push(
      `DEMO_FEED=twelvedata is unaffordable: ${creditBudgetProblem(pollMs(mode, env), budget)} ` +
        "The demo role runs its own simulated tape instead.",
    );
    mode = "simulated";
  }

  let onFailure = policy(live ? env.LIVE_FEED_ON_FAILURE : env.DEMO_FEED_ON_FAILURE, live ? "pause" : "simulate");
  // A live fallback needs BOTH switches; one alone pauses and says which is missing.
  if (live && onFailure === "simulate" && !allowSimulated) {
    warnings.push(
      'LIVE_FEED_ON_FAILURE=simulate is ignored without LIVE_ALLOW_SIMULATED=true — live trading pauses instead of simulating',
    );
    onFailure = "pause";
  }

  let illegal: string | null = null;
  let capped: string | null = null;
  if (live) {
    if (mode === "simulated") {
      if (!allowSimulated && !inherited) {
        illegal =
          'LIVE_FEED=simulated requires LIVE_ALLOW_SIMULATED=true; refusing to price live accounts with a simulation';
      } else if (inherited) {
        // The one deliberate exception (§2.6-R5): a legacy install whose only knob
        // is PRICE_FEED=simulated keeps trading, loudly.
        warnings.push(
          'LIVE slot inherited PRICE_FEED=simulated: live marks are SIMULATED. Set LIVE_ALLOW_SIMULATED=true to keep this, or LIVE_FEED to a real provider.',
        );
        capped = "live marks are simulated (inherited from PRICE_FEED)";
      } else {
        capped = "live marks are simulated (LIVE_ALLOW_SIMULATED=true)";
      }
    }
    const keyless = mode === "twelvedata" && !(env.TWELVE_DATA_API_KEY ?? "").trim();
    if (keyless) {
      illegal = "LIVE_FEED=twelvedata but TWELVE_DATA_API_KEY is empty — live trading is not possible";
    } else if (mode === "twelvedata" && tdCreditsPerDay(pollMs(mode, env)) > budget) {
      // Only a plan that actually *uses* Twelve Data can overspend its key: an
      // unaffordable `TD_POLL_MS` beside `LIVE_FEED=yahoo` must not park live.
      illegal = `LIVE_FEED=twelvedata is unaffordable: ${creditBudgetProblem(pollMs(mode, env), budget)} ` +
        "Twelve Data's free tier is a backfill source, not an execution source — set LIVE_FEED=yahoo or raise TD_DAILY_CREDIT_BUDGET with a paid plan.";
    }
  }

  const ages = marketAges(role, env);
  if (live && mode !== "simulated" && !illegal) {
    // A-10: this guard surprises operators, so it says what it does at boot
    // rather than being discovered on a Saturday. `ENFORCE_MARKET_HOURS=false`
    // does not lift it: that switch chooses which hours we trade, not whether a
    // print is still alive.
    warnings.push(
      `live market-age guard: prints older than ${humanAge(ages.marketStaleMs)} degrade the live slot and older than ${humanAge(ages.marketPauseMs)} pause it (refuses new orders), ` +
        "measured from the provider's own quote timestamp — so an HTTP 200 carrying Friday's close, or any closed session, still pauses live even with ENFORCE_MARKET_HOURS=false. " +
        "Raise LIVE_MARKET_STALE_MS / LIVE_MARKET_PAUSE_MS only if you mean to trade aged-but-real quotes.",
    );
  }

  return {
    key: role,
    mode,
    purpose: servedType(role),
    steering: { allowed: role === "demo", winRate },
    onFailure,
    allowSimulated,
    failureThreshold: threshold,
    staleMs: ms(live ? env.LIVE_STALE_MS : env.DEMO_STALE_MS, live ? 15_000 : 30_000),
    pauseMs: ms(live ? env.LIVE_PAUSE_MS : env.DEMO_PAUSE_MS, live ? 60_000 : 120_000),
    ...ages,
    pollMs: pollMs(mode, env),
    enforceMarketHours: enforceMarketHours(env.ENFORCE_MARKET_HOURS),
    illegal,
    capped,
  };
}

/**
 * Always two slots, demo and live — there is no shared-tape collapse (SB1). A
 * steerable config serving LIVE is the bug this whole exercise exists to fix, so
 * it is asserted here rather than inferred by callers.
 */
export function feedPlan(env: Record<string, string | undefined> = process.env): FeedPlan {
  const warnings: string[] = [];
  const legacy = parseMode(env.PRICE_FEED);
  const demoOwn = parseMode(env.DEMO_FEED);
  const liveOwn = parseMode(env.LIVE_FEED);
  if (legacy && (!demoOwn || !liveOwn)) {
    warnings.push(
      `PRICE_FEED=${legacy} is the legacy switch and applies to both roles ` +
        `(demo=${demoOwn ?? legacy}, live=${liveOwn ?? legacy}). Prefer DEMO_FEED and LIVE_FEED.`,
    );
  }

  const demo = slot("demo", env, warnings);
  const live = slot("live", env, warnings);

  // INVARIANT — a steerable feed may never serve LIVE.
  for (const cfg of [demo, live]) {
    if (cfg.steering.allowed && cfg.purpose === "LIVE") {
      throw new Error(`feedPlan: steering cannot serve LIVE (slot "${cfg.key}")`);
    }
  }
  if (demo.mode === live.mode && demo.mode !== "simulated" && demo.mode === "yahoo") {
    warnings.push("both roles poll the same upstream; the provider loop is shared, not duplicated (R7)");
  }

  return { demo, live, publicRole: parseRole(env.PUBLIC_FEED, "live"), warnings };
}

/** The mode resolution rule, asked one account type at a time. The type is required (R10). */
export function resolveFeedMode(accountType: AccountType, env: Record<string, string | undefined> = process.env): FeedMode {
  return feedPlan(env)[roleFor(accountType)].mode;
}
