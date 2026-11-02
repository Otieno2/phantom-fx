import type { Side } from "@/lib/trading/math";

/**
 * The vocabulary every feed module shares. Declared once, imported everywhere:
 * duplicated `Tick`/`FeedMode`/`AccountType` declarations are drift waiting to
 * happen (design §2.6-R9).
 */
export type AccountType = "DEMO" | "LIVE";
export type FeedRole = "demo" | "live";
export type FeedMode = "simulated" | "yahoo" | "twelvedata";
/** What a feed does once its real provider is confirmed unavailable. */
export type FailurePolicy = "pause" | "simulate";

export type FeedState =
  | "idle"
  /** started, no marks yet */
  | "starting"
  /** fresh marks; every action permitted */
  | "running"
  /** marks exist but are older than `staleMs` — in either of the two ways A-10
   *  separates: since the source last answered, or since the newest print it
   *  served. Held positions are managed and closed, nothing new is opened and no
   *  stops are edited */
  | "degraded"
  /** no trustworthy marks — nothing executes */
  | "paused"
  /** the environment cannot produce a legal feed for this role */
  | "misconfigured"
  | "stopped";

export type FeedAction = "open" | "close" | "modify" | "manage";

export type FeedErrorCode = "FEED_PAUSED" | "FEED_STALE" | "FEED_MISCONFIGURED" | "FEED_STARTING" | "FEED_STOPPED";

export class FeedError extends Error {
  readonly code: FeedErrorCode;
  /** 503 while prices are untrustworthy, 400 when the install itself is illegal. */
  readonly status: 400 | 503;
  constructor(code: FeedErrorCode, message: string) {
    super(message);
    this.name = "FeedError";
    this.code = code;
    this.status = code === "FEED_MISCONFIGURED" ? 400 : 503;
  }
}

/** Field-for-field the shape `usePrices.ts` and `trade/types.ts` already consume. */
export interface Tick {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  changePct: number;
  time: number;
}

export interface DemoPositionTrack {
  id: string;
  accountId: string;
  symbol: string;
  side: Side;
  openPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  pipSize: number;
  spreadPips: number;
}

export interface FeedStatus {
  role: FeedRole;
  /** Which account type this feed's marks belong to. Implied by `role` (SB1). */
  purpose: AccountType;
  mode: FeedMode;
  provider: string;
  state: FeedState;
  started: boolean;
  lastMarkAt: number;
  /**
   * Newest provider print this slot accepted, in the provider's own clock
   * (A-10). `lastMarkAt` says when we heard from the host; this says how alive
   * the price actually is, and only the worse of the two decides the state.
   */
  lastQuoteMarketTime: number;
  /** ms since that print; null while the feed has never carried one. */
  marketAgeMs: number | null;
  /** ms since the source last answered; null before the first mark. */
  transportAgeMs: number | null;
  /**
   * Pairs whose OWN print is past `marketStaleMs` while the slot may still read
   * `running` (A-11). Additive, sorted, and deliberately a list of symbols rather
   * than a flag: the client has to name the one pair it will not trade while the
   * rest of the board stays live. Empty on a healthy tape, and it is not a slot
   * verdict — `state`/`stale` above stay the authority on what the feed permits.
   */
  staleSymbols: string[];
  failures: number;
  stale: boolean;
  degraded: boolean;
  paused: boolean;
  reason: string;
  steerable: boolean;
  winRate: number | null;
  /** True when a LIVE slot's marks come from a simulation, by config or after a failure. */
  simulatedMarks: boolean;
  trackedDemoPositions: number;
  symbols: number;
}

/** Why a position went away, and therefore what it cost to allow (design §5.3). */
export type CloseReason = "MANUAL" | "SL" | "TP" | "STOP_OUT" | "ADMIN";

/**
 * A protective close (SL, TP, stop-out) is management: it was accepted against
 * these marks and must still run when they age. A manual or administrative close
 * is a fresh decision. Both are permitted while `degraded`; neither is permitted
 * while `paused` or `misconfigured`, where nothing executes at all.
 */
export function closeAction(reason: CloseReason): FeedAction {
  return reason === "SL" || reason === "TP" || reason === "STOP_OUT" ? "manage" : "close";
}

/**
 * An age a human can read: seconds under two minutes, then minutes, then hours.
 * Shared because both the refusal an operator logs and the warning that raises
 * the knob have to say the same number the guard acted on (A-10).
 */
export function humanAge(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes}m` : `${(minutes / 60).toFixed(1)}h`;
}

/**
 * What each feed state permits. `degraded` manages **and closes**: a client who
 * clicks Close on a held position is getting money out of a trade they already
 * have, and refusing that because the tape lagged would trap the position (R6,
 * A-5). What degraded still refuses is new risk (`open`) and edited risk
 * (`modify`). `paused` and `misconfigured` execute nothing.
 */
const PERMISSIONS: Record<FeedState, readonly FeedAction[]> = {
  idle: [],
  starting: [],
  running: ["open", "close", "modify", "manage"],
  degraded: ["manage", "close"],
  paused: [],
  misconfigured: [],
  stopped: [],
};

/**
 * The A-5 refinement: `degraded` while the marks themselves are simulated
 * (`LIVE_ALLOW_SIMULATED`, or the failure fallback). Stale-but-real marks still
 * belong to the market the position was opened in; a simulated one is a number
 * this system invented, and booking a close against it would write real P&L that
 * never happened. `manage` stays unconditional — a stop-out refused is a position
 * left running unprotected, which is the larger harm either way.
 */
const DEGRADED_ON_SIMULATED_MARKS: readonly FeedAction[] = ["manage"];

/**
 * The table and its one documented exception, asked together so no caller has to
 * know where the gate lives. `marksAreReal` defaults to true: a feed that cannot
 * say otherwise gets the plain table (design A-5, A-10).
 */
export function permittedActions(state: FeedState, marksAreReal = true): readonly FeedAction[] {
  return state === "degraded" && !marksAreReal ? DEGRADED_ON_SIMULATED_MARKS : PERMISSIONS[state];
}

export function permitted(state: FeedState, action: FeedAction, marksAreReal = true): boolean {
  return permittedActions(state, marksAreReal).includes(action);
}

export function servedType(role: FeedRole): AccountType {
  return role === "live" ? "LIVE" : "DEMO";
}

export function roleFor(accountType: AccountType): FeedRole {
  return accountType === "LIVE" ? "live" : "demo";
}

/**
 * Fail closed on the money path. `Account.type` is an unconstrained String
 * column, so `"live"`, `"Live"`, `"REAL"` or `""` must never be guessed into
 * DEMO — that would price real money on the steered simulation (§2.6-R12).
 */
export function asAccountType(raw: string | null | undefined, context: string): AccountType {
  if (raw === "DEMO") return "DEMO";
  if (raw === "LIVE") return "LIVE";
  throw new FeedError(
    "FEED_MISCONFIGURED",
    `Account.type on ${context} is ${JSON.stringify(raw ?? "")}, expected "DEMO" or "LIVE" — that account cannot be priced`,
  );
}
