import { afterEach, describe, expect, it, vi } from "vitest";
import type { SimCandle } from "@/lib/trading/fxSim";
import { feedPlan, tdCreditsPerDay, resolveFeedMode } from "./config";
import { asDemoFeed, buildFeed, DemoFeed, LiveFeed, type Feed, type FeedOverrides } from "./feed";
import { CandleStore } from "./candles";
import { createRegistry, feedFor, feeds } from "./registry";
import { dedicatedUpstream, upstreamForMode } from "./upstream";
import { asAccountType, closeAction, FeedError, permitted, permittedActions, type AccountType, type FeedRole } from "./types";
import { ProviderError, TIMEFRAMES } from "./provider";
import { outcomeForPosition } from "@/lib/trading/demoOutcome";
import { feedPayload } from "../feed-context";
import type { PriceProvider, ProviderQuote, Timeframe } from "./provider";

/** Deterministic stream so two feeds seeded with the same value are comparable. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * A print that is fresh *when it is served*, not when the module was imported:
 * the market-age guard (A-10) compares this stamp with the clock, so a fixture
 * frozen at import time would look days old to any test using fake timers.
 */
const EUR: ProviderQuote = { mid: 1.1215, prevClose: 1.12, get time() { return Date.now(); } };
/** The same print with a stamp the test chooses. */
const printAt = (at: number): ProviderQuote => ({ mid: EUR.mid, prevClose: EUR.prevClose, time: at });

function fakeProvider(overrides: Partial<PriceProvider> = {}): PriceProvider {
  return {
    mode: "yahoo",
    isConfigured: () => true,
    async fetchQuotes() {
      return new Map<string, ProviderQuote>([["EURUSD", EUR]]);
    },
    async fetchCandles() {
      return [] as SimCandle[];
    },
    ...overrides,
  };
}

const dualEnv: NodeJS.ProcessEnv = { NODE_ENV: "test", DEMO_FEED: "simulated", LIVE_FEED: "yahoo" };
/** The legacy single-switch install ATLAS ruled must no longer collapse (SB1). */
const legacyEnv: NodeJS.ProcessEnv = { NODE_ENV: "test", PRICE_FEED: "simulated" };
const FRAME: Timeframe = TIMEFRAMES["1m"];

const tracked: Feed[] = [];
function keep(feed: Feed): Feed {
  tracked.push(feed);
  return feed;
}

afterEach(() => {
  while (tracked.length) tracked.pop()?.stop();
  vi.useRealTimers();
});

/** Restores env keys after the callback, whether they were set or not. */
function withEnv<T>(values: Record<string, string>, run: () => T): T {
  const keys = Object.keys(values);
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  Object.assign(process.env, values);
  delete (globalThis as Record<string, unknown>).__feedRegistry;
  try {
    return run();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete (globalThis as Record<string, unknown>).__feedRegistry;
  }
}

const NO_SESSION = { respectMarketHours: false, pollMs: 60_000, historyMinutes: 0, tickMs: 250 } as FeedOverrides;

/** A slot built from env, with the surface its config deserves: a demo role is steerable (A-1). */
function feedForRole(env: Record<string, string | undefined>, role: "demo", overrides?: FeedOverrides): DemoFeed;
function feedForRole(env: Record<string, string | undefined>, role: "live", overrides?: FeedOverrides): LiveFeed;
function feedForRole(env: Record<string, string | undefined>, role: FeedRole, overrides: FeedOverrides = {}): Feed {
  return keep(buildFeed(feedPlan(env)[role], { ...NO_SESSION, ...overrides }));
}

const mid = (feed: Feed, symbol: string) => feed.ticks().find((t) => t.symbol === symbol)?.mid ?? 0;

describe("§8.2 environment precedence", () => {
  it("resolves each role from its own switch first", () => {
    expect(resolveFeedMode("DEMO", dualEnv)).toBe("simulated");
    expect(resolveFeedMode("LIVE", dualEnv)).toBe("yahoo");
    expect(resolveFeedMode("DEMO", { DEMO_FEED: "twelvedata", PRICE_FEED: "yahoo" })).toBe("twelvedata");
    expect(resolveFeedMode("LIVE", { LIVE_FEED: "simulated", DEMO_FEED: "twelvedata", LIVE_ALLOW_SIMULATED: "true" })).toBe("simulated");
  });

  it("falls back to PRICE_FEED per role, then to the role default", () => {
    expect(resolveFeedMode("DEMO", { PRICE_FEED: "yahoo" })).toBe("yahoo");
    expect(resolveFeedMode("LIVE", { PRICE_FEED: "yahoo" })).toBe("yahoo");
    expect(resolveFeedMode("LIVE", { PRICE_FEED: "yahoo", LIVE_FEED: "twelvedata", TWELVE_DATA_API_KEY: "k" })).toBe("twelvedata");
    expect(resolveFeedMode("DEMO", {})).toBe("simulated");
    expect(resolveFeedMode("LIVE", {})).toBe("yahoo");
  });

  it("treats an unknown feed name as unset rather than a typo that changes the tape", () => {
    expect(resolveFeedMode("LIVE", { PRICE_FEED: "simulated", LIVE_FEED: "alphavantage" })).toBe("simulated");
    expect(resolveFeedMode("DEMO", { DEMO_FEED: " Simulated " })).toBe("simulated");
    expect(resolveFeedMode("LIVE", { LIVE_FEED: "SIMULATED", LIVE_ALLOW_SIMULATED: "true" })).toBe("simulated");
  });

  it("T9: DEMO_WIN_RATE selects no provider and never steers the live slot", () => {
    const plan = feedPlan({ PRICE_FEED: "simulated", DEMO_WIN_RATE: "0.6" });
    expect(plan.demo.mode).toBe("simulated");
    expect(plan.live.mode).toBe("simulated");
    expect(plan.demo.steering).toEqual({ allowed: true, winRate: 0.6 });
    expect(plan.live.steering.allowed).toBe(false);
    expect(plan.live.steering.winRate).toBeNull();
    expect(plan.live.onFailure).toBe("pause");
    // A win rate on its own is not a provider switch: roles keep their defaults.
    expect(feedPlan({ DEMO_WIN_RATE: "0.6" }).live.mode).toBe("yahoo");
    expect(feedPlan({ DEMO_WIN_RATE: "0.6", PRICE_FEED: "yahoo" }).demo.mode).toBe("yahoo");
    // INVARIANT: no steerable config may serve LIVE, in any of these plans.
    for (const env of [dualEnv, legacyEnv, { DEMO_WIN_RATE: "0.6" }, { PRICE_FEED: "simulated", DEMO_WIN_RATE: "0.9" }]) {
      for (const cfg of [feedPlan(env).demo, feedPlan(env).live]) {
        if (cfg.steering.allowed) expect(cfg.purpose).toBe("DEMO");
      }
    }
  });

  it("R5: an unopted-in live simulation is illegal, an opted-in one is capped, an inherited one warns", () => {
    expect(feedPlan({ LIVE_FEED: "simulated" }).live.illegal).toMatch(/LIVE_ALLOW_SIMULATED/);
    const opted = feedPlan({ LIVE_FEED: "simulated", LIVE_ALLOW_SIMULATED: "true" });
    expect(opted.live.illegal).toBeNull();
    expect(opted.live.capped).toMatch(/LIVE_ALLOW_SIMULATED/);
    const inherited = feedPlan({ PRICE_FEED: "simulated" });
    expect(inherited.live.illegal).toBeNull();
    expect(inherited.live.capped).toMatch(/PRICE_FEED/);
    expect(inherited.warnings.join("\n")).toMatch(/SIMULATED/);
    expect(inherited.warnings.join("\n")).toMatch(/legacy switch/);
  });

  it("R4: a live simulate policy needs both switches and names the missing one", () => {
    const single = feedPlan({ LIVE_FEED: "yahoo", LIVE_FEED_ON_FAILURE: "simulate" });
    expect(single.live.onFailure).toBe("pause");
    expect(single.warnings.join("\n")).toMatch(/LIVE_ALLOW_SIMULATED/);
    expect(feedPlan({ LIVE_FEED: "yahoo", LIVE_FEED_ON_FAILURE: "simulate", LIVE_ALLOW_SIMULATED: "true" }).live.onFailure).toBe("simulate");
    expect(feedPlan({ DEMO_FEED: "yahoo" }).demo.onFailure).toBe("simulate");
    expect(feedPlan({ DEMO_FEED: "yahoo", DEMO_FEED_ON_FAILURE: "pause" }).demo.onFailure).toBe("pause");
    expect(feedPlan({}).live.staleMs).toBe(15_000);
    expect(feedPlan({}).live.pauseMs).toBe(60_000);
    expect(feedPlan({ LIVE_STALE_MS: "900" }).live.staleMs).toBe(900);
  });

  it("a keyless twelvedata live slot is illegal, not simulated", () => {
    expect(feedPlan({ LIVE_FEED: "twelvedata", TWELVE_DATA_API_KEY: " " }).live.illegal).toMatch(/TWELVE_DATA_API_KEY/);
    expect(feedPlan({ LIVE_FEED: "twelvedata", TWELVE_DATA_API_KEY: "secret" }).live.illegal).toBeNull();
  });
});

describe("SB1: there are always two slots", () => {
  it("gives demo and live separate instances even in a legacy single-switch install", () => {
    const registry = createRegistry(legacyEnv);
    expect(registry.instances()).toHaveLength(2);
    expect(registry.for("DEMO")).not.toBe(registry.for("LIVE"));
    expect(registry.for("DEMO").key).toBe("demo");
    expect(registry.for("DEMO").servedType).toBe("DEMO");
    expect(registry.for("LIVE").key).toBe("live");
    expect(registry.for("LIVE").servedType).toBe("LIVE");
  });

  it("carries no `serves` list at all, so no feed can claim both account types", () => {
    const registry = createRegistry(dualEnv);
    expect("serves" in registry.demo).toBe(false);
    expect("serves" in registry.live).toBe(false);
    expect(registry.live.steerable).toBe(false);
  });

  it("reports which slot the public ticker reads, defaulting to live", () => {
    expect(createRegistry(dualEnv).publicRole).toBe("live");
    expect(createRegistry({ PUBLIC_FEED: "demo" }).publicRole).toBe("demo");
    expect(createRegistry({ PUBLIC_FEED: "nonsense" }).publicRole).toBe("live");
  });
});

describe("R12: fail closed on Account.type", () => {
  const bogus: (string | null | undefined)[] = ["live", "Live", "REAL", "demo", "", "  ", "LIVE2", "DEMO ", null, undefined];

  it("accepts only the two exact values", () => {
    expect(asAccountType("DEMO", "a")).toBe("DEMO");
    expect(asAccountType("LIVE", "a")).toBe("LIVE");
  });

  it("T10: throws for every other value instead of guessing DEMO", () => {
    for (const value of bogus) {
      let thrown: unknown;
      try {
        asAccountType(value, `account acct-1`);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, String(value)).toBeInstanceOf(FeedError);
      const feed = thrown as FeedError;
      expect(feed.code).toBe("FEED_MISCONFIGURED");
      // A refusal is a configuration fault, so 400 — and it names the row.
      expect(feed.status).toBe(400);
      expect(feed.message).toContain("account acct-1");
      expect(feed.message).toContain('expected "DEMO" or "LIVE"');
    }
  });

  it("refuses at the selection call too, so no path can coerce its way onto the steered tape", () => {
    withEnv({ ...legacyEnv, DEMO_FEED: "simulated", LIVE_FEED: "yahoo", DEMO_WIN_RATE: "0.6" }, () => {
      expect(feeds().for("LIVE")).toBe(feeds().live);
      for (const value of bogus) expect(() => feedFor(value as AccountType), String(value)).toThrow(FeedError);
      expect(feedFor("DEMO").mode).toBe("simulated");
      expect(feedFor("LIVE").mode).toBe("yahoo");
      expect(feedFor("DEMO")).not.toBe(feedFor("LIVE"));
    });
  });
});

describe("R2: steering a feed that cannot steer throws", () => {
  const winSpec = {
    id: "pos-win",
    accountId: "acct-1",
    symbol: "EURUSD",
    side: "BUY" as const,
    openPrice: 1.1,
    stopLoss: 1.098,
    takeProfit: 1.104,
    pipSize: 0.0001,
    spreadPips: 1.2,
  };

  it("refuses to be steered, by type first and by runtime check second (A-1, R2)", () => {
    const env = { DEMO_WIN_RATE: "0.6", LIVE_FEED: "yahoo" };
    const live = feedForRole(env, "live", { provider: fakeProvider() });
    // Narrowing a live feed to the steering surface throws and names the slot —
    // the guard a caller meets when it only holds a `Feed`.
    expect(() => asDemoFeed(live, winSpec.id)).toThrow(FeedError);
    expect(() => asDemoFeed(live, winSpec.id)).toThrow(/steering is not available on the "live" feed/);
    expect(live.status().trackedDemoPositions).toBe(0);
    // The surface genuinely is not there, not merely forbidden.
    expect("trackDemoPosition" in live).toBe(false);
    expect("clearAccount" in live).toBe(false);
    expect(typeof DemoFeed.prototype.trackDemoPosition).toBe("function");
    // A steerable class built from a non-steerable config is refused at construction.
    expect(() => new DemoFeed(feedPlan(env).live, NO_SESSION)).toThrow(/DemoFeed needs a steerable config/);
  });

  it("does not compile a steering call against a live feed, in any of the four methods (A-1)", () => {
    const live = feedForRole({ DEMO_WIN_RATE: "0.6", LIVE_FEED: "yahoo" }, "live", { provider: fakeProvider() });
    // Never executed — it exists so `npm run typecheck` has to reject these four
    // lines. If the surfaces ever merge again, the unused `@ts-expect-error`
    // directives fail the build instead of this promise quietly disappearing.
    const wouldSteer = () => {
      // @ts-expect-error A-1: LiveFeed has no trackDemoPosition to call.
      live.trackDemoPosition(winSpec);
      // @ts-expect-error A-1: LiveFeed has no updateDemoStops to call.
      live.updateDemoStops(winSpec.id, 1.1, 1.2);
      // @ts-expect-error A-1: LiveFeed has no untrackDemoPosition to call.
      live.untrackDemoPosition(winSpec.id);
      // @ts-expect-error A-1: LiveFeed has no clearAccount to call.
      live.clearAccount(winSpec.accountId);
    };
    expect(wouldSteer).toBeTypeOf("function");
  });

  it("registers on the demo feed and counts the target in status", () => {
    const demo = feedForRole({ DEMO_FEED: "simulated", DEMO_WIN_RATE: "0.6" }, "demo");
    demo.seedSim();
    demo.trackDemoPosition(winSpec);
    expect(demo.status().trackedDemoPositions).toBe(1);
    expect(demo.status().winRate).toBe(0.6);
    expect(demo.status().steerable).toBe(true);
    demo.clearAccount(winSpec.accountId);
    expect(demo.status().trackedDemoPositions).toBe(0);
  });
});

describe("§5.2 state machine permissions", () => {
  function liveFeed(config: Partial<ReturnType<typeof feedPlan>["live"]> = {}, provider?: PriceProvider) {
    const plan = feedPlan(dualEnv);
    return keep(buildFeed({ ...plan.live, ...config }, { ...NO_SESSION, provider: provider ?? fakeProvider() }));
  }

  it("running permits everything", async () => {
    const feed = liveFeed();
    await feed.pollProvider();
    expect(feed.state()).toBe("running");
    for (const action of ["open", "close", "modify", "manage"] as const) expect(feed.permits(action), action).toBe(true);
    expect(feed.status()).toMatchObject({ state: "running", degraded: false, paused: false, stale: false });
  });

  it("degraded manages and closes, but opens and modifies nothing (A-5)", async () => {
    const feed = liveFeed({ staleMs: 50, pauseMs: 600_000 });
    await feed.pollProvider();
    feed.lastMarkAt = Date.now() - 100;
    expect(feed.state()).toBe("degraded");
    expect(feed.isDegraded()).toBe(true);
    expect(feed.isStale()).toBe(true);
    // The table INFINITY ruled: stale marks may not take or edit risk, but they
    // never trap a position its owner wants out of.
    expect(permittedActions("degraded")).toEqual(["manage", "close"]);
    expect(permitted("paused", "close")).toBe(false);
    expect(permitted("misconfigured", "close")).toBe(false);
    expect(permitted("running", "close")).toBe(true);
    expect(feed.permits("manage")).toBe(true);
    expect(feed.permits("close")).toBe(true);
    for (const action of ["open", "modify"] as const) expect(feed.permits(action), action).toBe(false);
    // Degraded marks still price the close, because they are the marks the
    // position was opened at.
    expect(feed.quotes().EURUSD?.bid).toBeGreaterThan(0);
    expect(feed.isTradable("close")).toEqual({ ok: true });
    expect(feed.isTradable("open")).toMatchObject({ ok: false, code: "FEED_STALE" });
    expect((feed.isTradable("open") as { reason: string }).reason).toMatch(/new orders are refused/);
  });

  it("a degraded live feed accepts a user close and refuses a new position (A-5)", async () => {
    const feed = liveFeed({ staleMs: 50, pauseMs: 600_000 });
    await feed.pollProvider();
    feed.lastMarkAt = Date.now() - 100;
    expect(feed.state()).toBe("degraded");
    // `closePosition` gates on the reason, so a manual close is judged as `close`
    // and a protective one as `manage`. Both pass here; new risk does not.
    for (const reason of ["MANUAL", "ADMIN", "SL", "TP", "STOP_OUT"] as const) {
      expect(() => feed.assertTradable(closeAction(reason)), reason).not.toThrow();
    }
    expect(closeAction("MANUAL")).toBe("close");
    expect(closeAction("SL")).toBe("manage");
    expect(closeAction("STOP_OUT")).toBe("manage");
    expect(() => feed.assertTradable("open")).toThrow(/stale/);
    expect(() => feed.assertTradable("modify")).toThrow(FeedError);
    // One step further: paused is not degraded, and there nothing closes at all.
    const paused = liveFeed({ staleMs: 50, pauseMs: 400 });
    await paused.pollProvider();
    paused.lastMarkAt = Date.now() - 500;
    expect(paused.state()).toBe("paused");
    for (const reason of ["MANUAL", "SL"] as const) {
      expect(() => paused.assertTradable(closeAction(reason)), reason).toThrow(FeedError);
    }
  });

  it("paused executes nothing but still shows the last marks", async () => {
    const feed = liveFeed({ staleMs: 50, pauseMs: 400 });
    await feed.pollProvider();
    feed.lastMarkAt = Date.now() - 500;
    expect(feed.state()).toBe("paused");
    for (const action of ["open", "close", "modify", "manage"] as const) expect(feed.permits(action), action).toBe(false);
    expect(feed.quotes()).toEqual({});
    expect(feed.ticks().length).toBeGreaterThan(0);
    expect(feed.displayQuotes().EURUSD).toBeDefined();
    expect((feed.isTradable("open") as { reason: string }).reason).toMatch(/Open positions are safe/);
    expect(feed.isTradable("manage")).toMatchObject({ ok: false, code: "FEED_PAUSED" });
  });

  it("degrades on two consecutive provider failures while the marks are still fresh", async () => {
    let down = false;
    const feed = liveFeed(
      { failureThreshold: 9 },
      fakeProvider({
        async fetchQuotes() {
          if (down) throw new Error("timeout");
          return new Map<string, ProviderQuote>([["EURUSD", EUR]]);
        },
      }),
    );
    await feed.pollProvider();
    expect(feed.state()).toBe("running");
    down = true;
    await feed.pollProvider();
    expect(feed.state()).toBe("running");
    await feed.pollProvider();
    expect(feed.state()).toBe("degraded");
    expect(feed.status().failures).toBe(2);
    expect(feed.permits("manage")).toBe(true);
    expect(feed.permits("open")).toBe(false);
    expect(feed.quotes().EURUSD).toBeDefined();
  });

  it("pauses on the failure threshold and needs two good polls to recover", async () => {
    let down = true;
    const feed = liveFeed(
      { failureThreshold: 2 },
      fakeProvider({
        async fetchQuotes() {
          if (down) throw new Error("yahoo is down");
          return new Map<string, ProviderQuote>([["EURUSD", EUR]]);
        },
      }),
    );
    await feed.pollProvider();
    await feed.pollProvider();
    expect(feed.state()).toBe("paused");
    expect(feed.failures).toBe(2);
    expect(feed.quotes()).toEqual({});

    down = false;
    await feed.pollProvider();
    expect(feed.state()).toBe("paused");
    expect(feed.quotes()).toEqual({});
    await feed.pollProvider();
    expect(feed.state()).toBe("running");
    expect(feed.failures).toBe(0);
    expect(feed.quotes().EURUSD?.bid).toBeGreaterThan(0);
  });

  it("treats an empty response as a failure and 401/403/429 as blocking", async () => {
    const empty = liveFeed({ failureThreshold: 1 }, fakeProvider({ async fetchQuotes() { return new Map(); } }));
    await empty.pollProvider();
    expect(empty.failures).toBe(1);
    expect(empty.state()).toBe("paused");

    const denied = liveFeed({}, fakeProvider({
      async fetchQuotes() {
        throw new Error("429: too many requests");
      },
    }));
    await denied.pollProvider();
    expect(denied.state()).toBe("paused");
    expect(denied.pauseReason()).toMatch(/rejected this client/);
  });

  it("an opted-in simulated live slot RUNS on simulated marks and keeps closing (ruling)", async () => {
    const feed = feedForRole({ LIVE_FEED: "simulated", LIVE_ALLOW_SIMULATED: "true" }, "live");
    feed.start();
    expect(feed.mode).toBe("simulated");
    expect(feed.state()).toBe("running");
    expect(feed.simulatedMarks).toBe(true);
    expect(feed.permits("open")).toBe(true);
    // Pinned as a decision, not an accident: the distinction is CONSENT, not the
    // nature of the mark. A `degraded` slot on simulated prices is the system
    // covering for itself after a failure, so it may manage but may not book a
    // close (the A-5 refinement below). A `running` slot under
    // `LIVE_ALLOW_SIMULATED` is the operator's explicit choice — asked for in the
    // environment, warned about at boot, `capped` in the plan and advertised as
    // `simulatedMarks` in every payload — and refusing `close` there would trap
    // real positions with no exit at all, which is the worse harm, and would
    // break the §8.3 back-compat promise that `PRICE_FEED=simulated` still trades.
    expect(feed.permits("close")).toBe(true);
    expect(permittedActions("running", false)).toEqual(["open", "close", "modify", "manage"]);
    expect(() => feed.assertSymbolTradable("EURUSD", "open")).not.toThrow();
    expect(feed.quotes().EURUSD).toBeDefined();
    expect(feed.respectsMarketHours()).toBe(false);
    feed.stop();
  });

  it("a live slot that falls back after provider loss is pinned at degraded", async () => {
    const env: Record<string, string | undefined> = { LIVE_FEED: "yahoo", LIVE_FEED_ON_FAILURE: "simulate", LIVE_ALLOW_SIMULATED: "true" };
    const plan = feedPlan(env);
    const feed = keep(
      buildFeed(
        { ...plan.live, failureThreshold: 2 },
        {
          ...NO_SESSION,
          provider: fakeProvider({
            async fetchQuotes() {
              throw new Error("yahoo is down");
            },
          }),
        },
      ),
    );
    await feed.pollProvider();
    await feed.pollProvider();
    expect(feed.mode).toBe("simulated");
    expect(feed.simulatedMarks).toBe(true);
    // The fallback tape manages what is open and opens nothing new, forever.
    expect(feed.state()).toBe("degraded");
    expect(feed.permits("manage")).toBe(true);
    expect(feed.permits("open")).toBe(false);
  });

  it("degraded on SIMULATED marks manages but closes nothing (A-5 refinement)", async () => {
    // Same fallback, asked the second half of the question: is a close allowed?
    // Booking real P&L from a price this system invented is the thing the whole
    // feature exists to prevent, so it is not — while stop-out keeps running.
    const env: Record<string, string | undefined> = { LIVE_FEED: "yahoo", LIVE_FEED_ON_FAILURE: "simulate", LIVE_ALLOW_SIMULATED: "true" };
    const feed = keep(
      buildFeed(
        { ...feedPlan(env).live, failureThreshold: 2 },
        {
          ...NO_SESSION,
          provider: fakeProvider({
            async fetchQuotes() {
              throw new Error("yahoo is down");
            },
          }),
        },
      ),
    );
    await feed.pollProvider();
    await feed.pollProvider();
    expect(feed.state()).toBe("degraded");
    expect(feed.simulatedMarks).toBe(true);
    expect(feed.permits("manage")).toBe(true);
    expect(feed.permits("close")).toBe(false);
    // The table is still the only source of truth, and this is its one derivation.
    expect(permittedActions("degraded")).toEqual(["manage", "close"]);
    expect(permittedActions("degraded", false)).toEqual(["manage"]);
    for (const action of ["open", "modify"] as const) expect(permitted("degraded", action, false), action).toBe(false);
    expect(permitted("degraded", "manage", false)).toBe(true);
    // The gate is a `degraded` rule, as ruled: it does not reach into `running`,
    // where an operator who chose `LIVE_ALLOW_SIMULATED` still trades on purpose.
    expect(permitted("running", "close", false)).toBe(true);
    // Protective closes run; a manual close is refused, in its own words.
    for (const reason of ["SL", "TP", "STOP_OUT"] as const) {
      expect(() => feed.assertTradable(closeAction(reason)), reason).not.toThrow();
    }
    expect(() => feed.assertTradable(closeAction("MANUAL"))).toThrow(/SIMULATED/);
    expect(feed.isTradable("close")).toMatchObject({ ok: false, code: "FEED_STALE" });
    expect((feed.isTradable("close") as { reason: string }).reason).toMatch(/book P&L that never happened/);
    // And the same state reached on *real* aged marks still closes: see A-10 below.
    const real = liveFeed({ staleMs: 50, pauseMs: 600_000 });
    await real.pollProvider();
    real.lastMarkAt = Date.now() - 100;
    expect(real.state()).toBe("degraded");
    expect(real.simulatedMarks).toBe(false);
    expect(real.permits("close")).toBe(true);
  });

  it("misconfigures an illegal slot instead of inventing prices", () => {
    const feed = keep(buildFeed(feedPlan({ LIVE_FEED: "simulated" }).live, NO_SESSION));
    feed.start();
    expect(feed.state()).toBe("misconfigured");
    expect(feed.ticks()).toEqual([]);
    expect(feed.quotes()).toEqual({});
    expect(() => feed.assertTradable("manage")).toThrow(FeedError);
    expect(feed.isTradable("open")).toMatchObject({ ok: false, code: "FEED_MISCONFIGURED" });
  });

  it("refuses to price live accounts through an unconfigured provider (R5)", () => {
    // Config time: the key is simply absent.
    withEnv({ TWELVE_DATA_API_KEY: "", DEMO_FEED: "simulated", LIVE_FEED: "twelvedata", PRICE_FEED: "" }, () => {
      const feed = feedForRole(process.env, "live");
      feed.start();
      expect(feed.mode).toBe("twelvedata");
      expect(feed.state()).toBe("misconfigured");
      expect(feed.pauseReason()).toMatch(/TWELVE_DATA_API_KEY/);
      expect(feed.ticks()).toEqual([]);
    });
    // Run time: a key is present but the provider still says it is unusable.
    // Starting a simulation here would be the old bug wearing a new hat.
    const feed = keep(
      buildFeed(
        feedPlan({ TWELVE_DATA_API_KEY: "looks-fine", LIVE_FEED: "twelvedata", PRICE_FEED: "" }).live,
        { ...NO_SESSION, provider: fakeProvider({ mode: "twelvedata", isConfigured: () => false }) },
      ),
    );
    feed.start();
    expect(feed.mode).toBe("twelvedata");
    expect(feed.state()).toBe("misconfigured");
    expect(feed.ticks()).toEqual([]);
    expect(feed.quotes()).toEqual({});
  });

  it("lets an unconfigured demo slot run its own simulation, but says so loudly", () => {
    withEnv({ TWELVE_DATA_API_KEY: "", DEMO_FEED: "twelvedata", LIVE_FEED: "yahoo", PRICE_FEED: "" }, () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const feed = feedForRole(process.env, "demo");
      feed.start();
      expect(feed.mode).toBe("simulated");
      expect(feed.state()).toBe("running");
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/not configured/);
      warn.mockRestore();
    });
  });

  it("reports starting before the first mark and stopped after shutdown", () => {
    const feed = keep(buildFeed(feedPlan(dualEnv).live, { ...NO_SESSION, provider: fakeProvider() }));
    feed.start();
    expect(feed.state()).toBe("starting");
    expect(feed.isTradable("open")).toMatchObject({ ok: false, code: "FEED_STARTING" });
    feed.stop();
    expect(feed.state()).toBe("stopped");
    expect(feed.isTradable("manage")).toMatchObject({ code: "FEED_STOPPED" });
  });

  it("consults the trading session before it trades, and a simulation has no session", async () => {
    const remote = keep(buildFeed(feedPlan(dualEnv).live, { ...NO_SESSION, respectMarketHours: true, provider: fakeProvider() }));
    await remote.pollProvider();
    if (remote.marketOpen()) {
      expect(remote.state()).toBe("running");
    } else {
      // §5.2 "any → paused": a closed session is not a time to accept fills.
      expect(remote.state()).toBe("paused");
      expect(remote.pauseReason()).toMatch(/market is closed/);
    }
    const sim = feedForRole(dualEnv, "demo");
    sim.seedSim();
    expect(sim.respectsMarketHours()).toBe(false);
    expect(sim.marketOpen()).toBe(true);
    expect(sim.state()).toBe("idle");
  });

  it("ENFORCE_MARKET_HOURS is resolved into the plan, never read at call time (A-2)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T09:00:00Z")); // a Saturday: the FX week is shut
    const off = feedPlan({ ...dualEnv, ENFORCE_MARKET_HOURS: "false" });
    expect(off.live.enforceMarketHours).toBe(false);
    expect(off.demo.enforceMarketHours).toBe(false);
    expect(feedPlan(dualEnv).live.enforceMarketHours).toBe(true);
    expect(feedPlan({ ...dualEnv, ENFORCE_MARKET_HOURS: "nonsense" }).live.enforceMarketHours).toBe(true);

    const switchedOff = keep(buildFeed(off.live, { ...NO_SESSION, respectMarketHours: true, provider: fakeProvider() }));
    const enforcing = keep(buildFeed(feedPlan(dualEnv).live, { ...NO_SESSION, respectMarketHours: true, provider: fakeProvider() }));
    expect(switchedOff.marketOpen()).toBe(true);
    expect(enforcing.marketOpen()).toBe(false);

    // The point of A-2: a global switch no longer leaks into a feed whose plan
    // did not ask for it. `enforcing` was built from an env object that says
    // "enforce", and it keeps saying so while `process.env` says the opposite.
    withEnv({ ENFORCE_MARKET_HOURS: "false" }, () => {
      expect(enforcing.marketOpen()).toBe(false);
      expect(feedPlan({ ...dualEnv }).live.enforceMarketHours).toBe(true);
    });
  });
});

describe("A-10: market age, not only transport age", () => {
  const MIN = 60_000;
  /** Transport so patient it can never be what moved the state in these tests. */
  const PATIENT = { staleMs: 60 * MIN, pauseMs: 60 * MIN };

  /** A slot on a source that always answers 200, whose print age the test drives. */
  function served(config: Partial<ReturnType<typeof feedPlan>["live"]>, ageMs = () => 6 * MIN) {
    const plan = feedPlan(dualEnv);
    const provider = fakeProvider({
      async fetchQuotes() {
        return new Map<string, ProviderQuote>([["EURUSD", printAt(Date.now() - ageMs())]]);
      },
    });
    return keep(buildFeed({ ...plan.live, ...config }, { ...NO_SESSION, provider }));
  }

  it("a healthy 200 carrying a dead print degrades, then pauses, with zero failures", async () => {
    const feed = served({ ...PATIENT, marketStaleMs: 5 * MIN, marketPauseMs: 20 * MIN });
    await feed.pollProvider();
    expect(feed.failures).toBe(0);
    expect(feed.state()).toBe("degraded");
    expect(feed.pauseReason()).toMatch(/newest quote is 6m old while the host keeps answering/);
    // The two ages side by side: the connection is fine, the price is not.
    expect(feed.status().transportAgeMs).toBeLessThan(5_000);
    expect(feed.status().marketAgeMs).toBeGreaterThanOrEqual(6 * MIN - 5_000);
    // Aged-but-REAL marks: degraded still takes a close and protects the position.
    expect(feed.permits("close")).toBe(true);
    expect(feed.permits("manage")).toBe(true);
    expect(feed.permits("open")).toBe(false);
    expect(feed.quotes().EURUSD).toBeDefined();

    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(feed.state()).toBe("paused");
    expect(feed.pauseReason()).toMatch(/newest quote is 21m old/);
    expect(feed.quotes()).toEqual({});
    for (const action of ["open", "close", "modify", "manage"] as const) expect(feed.permits(action), action).toBe(false);
  });

  it("no number of successful polls promotes a feed whose marks are still old", async () => {
    let age = 6 * MIN;
    const feed = served({ ...PATIENT, marketStaleMs: 5 * MIN }, () => age);
    await feed.pollProvider();
    expect(feed.state()).toBe("degraded");
    // Same host, same 200, three more times. Nothing about the price changed, so
    // nothing about the state may either — this is the ruling's "a successful
    // poll must never by itself promote" half.
    await feed.pollProvider();
    await feed.pollProvider();
    await feed.pollProvider();
    expect(feed.state()).toBe("degraded");
    expect(feed.permits("open")).toBe(false);
    // The print itself goes live and the very next poll restores trading.
    age = 0;
    await feed.pollProvider();
    expect(feed.state()).toBe("running");
    expect(feed.permits("open")).toBe(true);
  });

  it("ages the tape when the host starts serving OLDER prints", async () => {
    // The mirror-failover case, and the reason the market clock is recomputed
    // from the marks each poll instead of keeping the maximum it has ever seen:
    // a monotonic max would hide a dead tape behind the last print that was live.
    let age = 0;
    const feed = served({ ...PATIENT, marketStaleMs: 5 * MIN }, () => age);
    await feed.pollProvider();
    expect(feed.state()).toBe("running");
    age = 6 * MIN;
    await feed.pollProvider();
    expect(feed.state()).toBe("degraded");
    expect(feed.pauseReason()).toMatch(/newest quote is 6m old/);
    expect(feed.permits("open")).toBe(false);
  });

  it("leaves `paused` only for alive marks, not merely for an answering host", async () => {
    let age = 45 * MIN;
    const feed = served({ ...PATIENT, marketStaleMs: 5 * MIN, marketPauseMs: 20 * MIN }, () => age);
    await feed.pollProvider();
    expect(feed.state()).toBe("paused");
    // Two good polls satisfy the hysteresis, but the marks are still 45 minutes
    // old, so the slot stays parked rather than trading on a dead price.
    await feed.pollProvider();
    expect(feed.state()).toBe("paused");
    await feed.pollProvider();
    expect(feed.state()).toBe("paused");
    // Half-alive is a half-recovery: aged marks may still be managed and closed.
    age = 8 * MIN;
    await feed.pollProvider();
    expect(feed.state()).toBe("degraded");
    expect(feed.permits("close")).toBe(true);
    expect(feed.permits("open")).toBe(false);
    age = 0;
    await feed.pollProvider();
    await feed.pollProvider();
    expect(feed.state()).toBe("running");
  });

  it("clamps a stamp from the future to the moment it arrived", async () => {
    const plan = feedPlan(dualEnv);
    const feed = keep(
      buildFeed({ ...plan.live, ...PATIENT, marketStaleMs: MIN }, {
        ...NO_SESSION,
        provider: fakeProvider({
          async fetchQuotes() {
            return new Map<string, ProviderQuote>([["EURUSD", printAt(Date.now() + 30 * MIN)]]);
          },
        }),
      }),
    );
    await feed.pollProvider();
    expect(feed.state()).toBe("running");
    expect(feed.status().marketAgeMs).toBeLessThan(1_000);
  });

  it("judges each age against its own thresholds: a stalled link pauses on transport", async () => {
    // The print is fresh; the *loop* is what died. The old wording survives here
    // because it is the accurate story, and the market reason is not invented.
    const feed = served({ staleMs: 10 * MIN, pauseMs: 20 * MIN, marketStaleMs: 5 * MIN, marketPauseMs: 60 * MIN }, () => 0);
    await feed.pollProvider();
    expect(feed.state()).toBe("running");
    feed.lastMarkAt = Date.now() - 25 * MIN;
    expect(feed.state()).toBe("paused");
    expect(feed.pauseReason()).toMatch(/no fresh prices for 25m/);
  });

  it("is independent of ENFORCE_MARKET_HOURS, as ruled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T09:00:00Z")); // a Saturday: the FX week is shut
    const plan = feedPlan({ ...dualEnv, ENFORCE_MARKET_HOURS: "false" });
    expect(plan.live.enforceMarketHours).toBe(false);
    const fridayClose = Date.parse("2026-11-06T21:00:00Z");
    const live = keep(
      buildFeed(
        { ...plan.live, ...PATIENT },
        {
          ...NO_SESSION,
          respectMarketHours: true,
          provider: fakeProvider({
            async fetchQuotes() {
              return new Map<string, ProviderQuote>([["EURUSD", printAt(fridayClose)]]);
            },
          }),
        },
      ),
    );
    await live.pollProvider();
    // The session switch is off, so `marketOpen()` is true and the closure branch
    // never runs: the *only* thing that stopped this feed is the print's age.
    expect(live.marketOpen()).toBe(true);
    expect(live.state()).toBe("paused");
    expect(live.pauseReason()).toMatch(/newest quote is/);
    expect(live.pauseReason()).not.toMatch(/market is closed/);
    expect(live.permits("open")).toBe(false);

    // The demo tape has no session and prints `now`, so it keeps moving while
    // live is parked — the money-safety answer, and the one that surprises people.
    const demo = keep(buildFeed(plan.demo, { ...NO_SESSION, tickMs: 250 }));
    demo.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(demo.state()).toBe("running");
    expect(demo.permits("open")).toBe(true);
    expect(demo.status().marketAgeMs).toBeLessThan(1_000);
  });

  it("resolves the two knobs into the plan and says what the guard does at boot", async () => {
    const plan = feedPlan(dualEnv);
    expect(plan.live.marketStaleMs).toBe(300_000);
    expect(plan.live.marketPauseMs).toBe(1_200_000);
    // One policy for both slots: market freshness belongs to the price.
    expect(plan.demo.marketStaleMs).toBe(300_000);
    expect(plan.demo.marketPauseMs).toBe(1_200_000);

    const raised = feedPlan({ ...dualEnv, LIVE_MARKET_STALE_MS: "900000", LIVE_MARKET_PAUSE_MS: "1800000" });
    expect(raised.live.marketStaleMs).toBe(900_000);
    expect(raised.demo.marketPauseMs).toBe(1_800_000);
    const demoOwn = feedPlan({ ...dualEnv, DEMO_MARKET_STALE_MS: "60000" });
    expect(demoOwn.demo.marketStaleMs).toBe(60_000);
    expect(demoOwn.live.marketStaleMs).toBe(300_000);

    // The knob is not decoration: an aged print under a raised limit still trades.
    const patient = keep(
      buildFeed({ ...raised.live, ...PATIENT }, {
        ...NO_SESSION,
        provider: fakeProvider({
          async fetchQuotes() {
            return new Map<string, ProviderQuote>([["EURUSD", printAt(Date.now() - 6 * MIN)]]);
          },
        }),
      }),
    );
    await patient.pollProvider();
    expect(patient.state()).toBe("running");

    const warning = plan.warnings.find((w) => /market-age guard/.test(w));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/older than 5m degrade/);
    expect(warning).toMatch(/older than 20m pause/);
    expect(warning).toMatch(/ENFORCE_MARKET_HOURS=false/);
    expect(warning).toMatch(/LIVE_MARKET_PAUSE_MS/);
    // A live slot with no provider to age is not claimed to be guarded.
    const simOnly = feedPlan({ DEMO_FEED: "simulated", LIVE_FEED: "simulated", LIVE_ALLOW_SIMULATED: "true", PRICE_FEED: "" });
    expect(simOnly.warnings.join(" ")).not.toMatch(/market-age guard/);
  });

  it("exposes both ages and the print time, in status and in the payload", async () => {
    const empty = feedForRole(dualEnv, "live", { provider: fakeProvider() });
    expect(empty.status()).toMatchObject({ lastQuoteMarketTime: 0, marketAgeMs: null, transportAgeMs: null });

    const feed = served({ ...PATIENT, marketStaleMs: 5 * MIN });
    await feed.pollProvider();
    const status = feed.status();
    expect(status.state).toBe("degraded");
    expect(status.lastQuoteMarketTime).toBeGreaterThan(0);
    expect(status.marketAgeMs).toBeGreaterThanOrEqual(6 * MIN - 5_000);
    expect(status.transportAgeMs).toBeLessThan(5_000);
    // The tick carries the same stamp, so the UI can say "as of" per symbol.
    expect(feed.ticks()[0].time).toBe(status.lastQuoteMarketTime);

    const payload = feedPayload(feed, { accountType: "LIVE", source: "account", accountId: "acct_1" });
    // The payload re-measures `Date.now()` a moment after `status()` did, so the
    // ages agree within a second rather than to the byte — under a cold, isolated
    // worker the gap between two reads is scheduling, not arithmetic, and a
    // two-millisecond bound flaked on exactly that. What must match exactly is the
    // print itself, and what keeps the tolerance honest is the fixture: this tape
    // is 6 minutes old in the market and ~0 in transport, so a swapped field could
    // not hide inside one second.
    expect(payload.lastQuoteMarketTime).toBe(status.lastQuoteMarketTime);
    expect(Math.abs((payload.marketAgeMs ?? 0) - (status.marketAgeMs ?? 0))).toBeLessThan(1000);
    expect(Math.abs((payload.transportAgeMs ?? 0) - (status.transportAgeMs ?? 0))).toBeLessThan(1000);
    expect(payload.marketAgeMs ?? 0).toBeGreaterThan(5 * MIN);
    expect(payload.transportAgeMs ?? 0).toBeLessThan(5_000);
    expect(payload.closable).toBe(true);
    expect(payload.reason).toMatch(/newest quote is/);
  });
});

describe("A-11: one frozen pair inside a healthy batch", () => {
  const MIN = 60_000;
  /** The §8 defaults, named here so the numbers under test are unmistakable. */
  const env = {
    NODE_ENV: "test",
    DEMO_FEED: "simulated",
    LIVE_FEED: "yahoo",
    PRICE_FEED: "",
    LIVE_MARKET_STALE_MS: "300000",
    LIVE_MARKET_PAUSE_MS: "1200000",
  };
  /** A second pair, so the batch is mixed: one live print and one `agedMs` old. */
  const jpyAt = (agedMs: number): ProviderQuote => ({ mid: 157.84, prevClose: 157.6, time: Date.now() - agedMs });

  function batch(carryJpy: () => boolean, agedMs: () => number) {
    return fakeProvider({
      async fetchQuotes() {
        const quotes = new Map<string, ProviderQuote>([["EURUSD", EUR]]);
        if (carryJpy()) quotes.set("USDJPY", jpyAt(agedMs()));
        return quotes;
      },
    });
  }

  /**
   * A frozen instant, so "fresh" and "20 minutes old" mean exactly what the test
   * says. These assertions compare provider stamps with the clock, and on a cold
   * isolated worker a real clock drifts by more than the point being made.
   */
  const FROZEN = new Date("2026-11-02T12:00:00Z");

  async function tape(agedMs: number) {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN);
    const feed = feedForRole(env, "live", { provider: batch(() => true, () => agedMs) });
    await feed.pollProvider();
    return feed;
  }

  it("ages ONE symbol without aging the slot", async () => {
    const feed = await tape(20 * MIN);
    // The slot clock is the NEWEST print on the tape, so the A-10 verdict is
    // untouched by one dead pair: the slot stays `running` and `permits` keeps
    // answering for the tape as a whole. The gate is per symbol, by design.
    expect(feed.state()).toBe("running");
    expect(feed.permits("open")).toBe(true);
    expect(feed.status().marketAgeMs).toBeLessThan(5 * MIN);
    expect(feed.status().state).toBe("running");

    expect(feed.quoteAgeMs("USDJPY")).toBeGreaterThanOrEqual(20 * MIN - 5_000);
    expect(feed.quoteAgeMs("EURUSD")).toBeLessThan(5_000);
    // Absent is not the same as fresh: null lets the caller fail loudly rather
    // than read a frozen pair as a live one.
    expect(feed.quoteAgeMs("GBPUSD")).toBeNull();
  });

  it("drops the aged symbol from new and edited risk, and from nothing else", async () => {
    const feed = await tape(20 * MIN);
    expect(feed.tradeQuotes("open").EURUSD).toBeDefined();
    expect(feed.tradeQuotes("open").USDJPY).toBeUndefined();
    // `modify` is edited risk, so it is gated exactly like `open`: the gate cannot
    // be walked around by re-framing the trade as a stop edit on the frozen pair.
    expect(feed.tradeQuotes("modify").USDJPY).toBeUndefined();
    // `close` and `manage` keep it. A frozen pair is precisely the one whose stop
    // or whose owner wants out, and the A-5 reasoning does not expire at symbol
    // granularity: trapping the position is the larger harm.
    expect(feed.tradeQuotes("close").USDJPY).toBeDefined();
    expect(feed.tradeQuotes("manage").USDJPY).toBeDefined();
    expect(feed.quotes().USDJPY).toBeDefined(); // the engine's protective surface is ungated
    // Display keeps the number, stamped with its own time, so a client can see the
    // pair froze instead of finding it missing (§3.4: a frozen tape that admits it).
    expect(feed.displayQuotes().USDJPY).toBeDefined();
    expect(feed.ticks().find((t) => t.symbol === "USDJPY")?.time).toBeLessThan(Date.now() - 19 * MIN);
    expect(Object.keys(feed.tradeQuotes("open")).sort()).toEqual(["EURUSD"]);
  });

  it("refuses by name, and says which pair and how old", async () => {
    const feed = await tape(20 * MIN);
    expect(() => feed.assertSymbolTradable("USDJPY", "open")).toThrow(FeedError);
    // "prices are stale" would be a lie while EURUSD is live, and the client needs
    // to know which pair froze and how far — so the refusal carries both.
    expect(() => feed.assertSymbolTradable("USDJPY", "open")).toThrow(/USDJPY has no live quote — its print is 20m old/);
    expect(() => feed.assertSymbolTradable("USDJPY", "modify")).toThrow(/USDJPY/);
    expect(() => feed.assertSymbolTradable("EURUSD", "open")).not.toThrow();
    expect(() => feed.assertSymbolTradable("USDJPY", "close")).not.toThrow();
    expect(() => feed.assertSymbolTradable("USDJPY", "manage")).not.toThrow();
    expect(feed.agedSymbol("GBPUSD", "open")).toBeNull();
  });

  it("names the frozen pairs in the status and the payload, additively", async () => {
    const feed = await tape(20 * MIN);
    expect(feed.status().staleSymbols).toEqual(["USDJPY"]);
    const payload = feedPayload(feed, { accountType: "LIVE", source: "account", accountId: "acct_1" });
    expect(payload.staleSymbols).toEqual(["USDJPY"]);
    // Vocabulary, not a second gate: the slot verdict is untouched by the list.
    expect(payload.state).toBe("running");
    expect(payload.stale).toBe(false);
    const clean = await tape(0);
    expect(clean.status().staleSymbols).toEqual([]);
    expect(clean.tradeQuotes("open").USDJPY).toBeDefined();
  });

  it("warns instead of refusing when a protective close settles on an aged mark", async () => {
    const feed = await tape(20 * MIN);
    // `manage` is NEVER gated per symbol (steering §1): refusing it leaves the
    // position running with no stop at all, the same reasoning that keeps it
    // unconditional in the slot table. The residual hazard — a level firing late,
    // early or not at all off a 20-minute-old mark — is logged instead, and the
    // wording is composed here so it is one place and testable without a database;
    // `closePositionLocked` emits it once the close has actually settled.
    expect(feed.tradeQuotes("manage").USDJPY).toBeDefined();
    expect(() => feed.assertSymbolTradable("USDJPY", "manage")).not.toThrow();
    expect(feed.agedMarkNote("USDJPY", "manage")).toMatch(/protective close on USDJPY priced off a mark 20m old/);
    expect(feed.agedMarkNote("USDJPY", "manage")).toMatch(/accepted rather than leaving the position unmanaged/);
    expect(feed.agedMarkNote("EURUSD", "manage")).toBeNull();
    // Only the protective half asks for a note; `open` is refused outright, and a
    // manual close is a `close` action, priced off the same mark by A-5's ruling.
    expect(feed.agedMarkNote("USDJPY", "open")).toBeNull();
    expect(feed.agedMarkNote("USDJPY", "close")).toBeNull();
  });

  it("bites when a healthy batch simply stops carrying the pair", async () => {
    // The realistic shape: Yahoo answers 200 for nine of ten symbols. The dropped
    // mark keeps its last stamp, so it ages on its own while the tape stays live.
    vi.useFakeTimers();
    let carry = true;
    const feed = feedForRole(env, "live", { provider: batch(() => carry, () => 0) });
    carry = true;
    await feed.pollProvider();
    expect(feed.tradeQuotes("open").USDJPY).toBeDefined();

    carry = false;
    await vi.advanceTimersByTimeAsync(6 * MIN);
    await feed.pollProvider();
    expect(feed.state()).toBe("running"); // the slot never noticed
    expect(feed.tradeQuotes("open").USDJPY).toBeUndefined();
    expect(feed.tradeQuotes("close").USDJPY).toBeDefined();
    expect(feed.quoteAgeMs("USDJPY")).toBeGreaterThanOrEqual(6 * MIN - 5_000);
  });

  it("follows the knob that raises it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN);
    const feed = feedForRole({ ...env, LIVE_MARKET_STALE_MS: "1800000" }, "live", { provider: batch(() => true, () => 20 * MIN) });
    await feed.pollProvider();
    expect(feed.tradeQuotes("open").USDJPY).toBeDefined();
    expect(() => feed.assertSymbolTradable("USDJPY", "open")).not.toThrow();
  });
});

describe("tape independence", () => {
  const winSpec = {
    id: "pos-win",
    accountId: "acct-1",
    symbol: "EURUSD",
    side: "BUY" as const,
    openPrice: 1.1,
    stopLoss: 1.098,
    takeProfit: 1.104,
    pipSize: 0.0001,
    spreadPips: 1.2,
  };

  it("steers only a demo tape, and a win rate is what moves it", () => {
    const steered = feedForRole({ DEMO_FEED: "simulated", DEMO_WIN_RATE: "0.6" }, "demo", { rand: seeded(42) });
    const control = feedForRole({ DEMO_FEED: "simulated" }, "demo", { rand: seeded(42) });
    steered.trackDemoPosition(winSpec);
    const t = 1_800_000_000_000;
    steered.seedSim(t);
    control.seedSim(t);
    for (let i = 1; i <= 400; i++) {
      steered.stepSim(250, t + i * 250);
      control.stepSim(250, t + i * 250);
    }
    // Steering is real: it dragged the demo tape toward take-profit.
    expect(mid(steered, "EURUSD")).toBeGreaterThan(mid(control, "EURUSD") + 0.0005);
    // The same seed with no win rate reproduces the unsteered tape exactly.
    const twin = feedForRole({ DEMO_FEED: "simulated" }, "demo", { rand: seeded(42) });
    twin.seedSim(t);
    for (let i = 1; i <= 400; i++) twin.stepSim(250, t + i * 250);
    expect(twin.ticks().map((x) => x.mid)).toEqual(control.ticks().map((x) => x.mid));
  });

  it("releases the tape at its target instead of pinning it there", () => {
    // Regression. Steering used to snap the mid onto the target and keep
    // re-applying it, so a steered demo position that reached its target froze
    // its symbol for as long as it stayed open: a flat-line chart, a P/L that
    // never moved, and with no SL/TP a position that could never be closed.
    const feed = feedForRole({ DEMO_FEED: "simulated", DEMO_WIN_RATE: "0.6" }, "demo", { rand: seeded(9) });
    feed.trackDemoPosition({ ...winSpec, takeProfit: 1.1006 });
    const t = 1_800_000_000_000;
    feed.seedSim(t);
    const seen: number[] = [];
    for (let i = 1; i <= 800; i++) {
      feed.stepSim(250, t + i * 250);
      seen.push(mid(feed, "EURUSD"));
    }
    // The drag is still real: it walked all the way to the take-profit target.
    expect(seen[seen.length - 1]).toBeGreaterThan(1.1004);
    // And once it arrived the tape kept printing new prices.
    expect(new Set(seen.slice(-300)).size).toBeGreaterThan(3);
  });

  it("serves its own candles per feed", async () => {
    const plan = feedPlan(dualEnv);
    const demo = keep(buildFeed({ ...plan.demo, mode: "simulated" }, { rand: seeded(7), tickMs: 250, historyMinutes: 30 }));
    const live = keep(buildFeed(plan.live, { ...NO_SESSION, provider: fakeProvider(), historyMinutes: 30 }));
    demo.seedSim();

    expect((await demo.candles("EURUSD", FRAME)).length).toBe(30);
    // A provider feed asks its provider and never reads the simulation's history.
    expect(await live.candles("EURUSD", FRAME)).toEqual([]);
  });
});

describe("R7: one upstream poll loop per provider mode", () => {
  it("memoizes per (mode, pollMs)", () => {
    const a = upstreamForMode("yahoo", 2_500);
    expect(a).toBe(upstreamForMode("yahoo", 2_500));
    expect(upstreamForMode("yahoo", 5_000)).not.toBe(a);
    expect(upstreamForMode("simulated", 250)).toBeNull();
  });

  it("two slots on the same mode share the loop but keep separate state", () => {
    const env: Record<string, string | undefined> = { DEMO_FEED: "yahoo", LIVE_FEED: "yahoo", PRICE_FEED: "" };
    const registry = createRegistry(env);
    expect(registry.demo).not.toBe(registry.live);
    expect(registry.demo.poller).toBe(registry.live.poller);
    expect(registry.demo.poller).toBe(upstreamForMode("yahoo", registry.demo.poller!.pollMs));
    expect(registry.instances()).toHaveLength(2);
    expect(registry.live.servedType).toBe("LIVE");
    expect(registry.demo.servedType).toBe("DEMO");
  });

  it("a simulated slot has no upstream at all", () => {
    const registry = createRegistry(dualEnv);
    expect(registry.demo.poller).toBeNull();
    expect(registry.live.poller).not.toBeNull();
  });

  it("delivers one poll to every subscriber and stops when the last one leaves", async () => {
    vi.useFakeTimers();
    const upstream = dedicatedUpstream(fakeProvider(), 1_000, "shared");
    const seen: number[] = [];
    const off1 = upstream.subscribe({ onQuotes: () => seen.push(1), onFailure: () => {} });
    const off2 = upstream.subscribe({ onQuotes: () => seen.push(2), onFailure: () => {} });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(seen.filter((s) => s === 1).length).toBeGreaterThan(0);
    expect(seen.filter((s) => s === 2).length).toBe(seen.filter((s) => s === 1).length);
    // One round-trip, two feeds: the request count is the whole point of R7.
    expect(upstream.polls).toBe(3);
    seen.length = 0;
    off1();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(seen).toEqual([2, 2, 2]);
    off2();
    seen.length = 0;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(seen).toEqual([]);
  });

  it("never overlaps two in-flight polls of the same upstream", async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let max = 0;
    const upstream = dedicatedUpstream(
      fakeProvider({
        async fetchQuotes() {
          inFlight += 1;
          max = Math.max(max, inFlight);
          await new Promise((r) => setTimeout(r, 5_000));
          inFlight -= 1;
          return new Map<string, ProviderQuote>([["EURUSD", EUR]]);
        },
      }),
      1_000,
      "slow",
    );
    const off = upstream.subscribe({ onQuotes: () => {}, onFailure: () => {} });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(max).toBe(1);
    off();
  });
});

describe("R8: per-timeframe candle budget", () => {
  const bars = (n: number, at: number): SimCandle[] =>
    Array.from({ length: n }, (_, i) => ({ time: at - (n - i) * 60, open: 1, high: 2, low: 0.5, close: 1 }));

  it("serves a cache hit inside the TTL and refetches beyond it", async () => {
    vi.useFakeTimers();
    const loader = vi.fn(async () => bars(3, 1_000));
    const store = new CandleStore();
    await store.fetched("EURUSD", TIMEFRAMES["1m"], loader, () => {});
    await store.fetched("EURUSD", TIMEFRAMES["1m"], loader, () => {});
    expect(loader).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_001);
    await store.fetched("EURUSD", TIMEFRAMES["1m"], loader, () => {});
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("gives each timeframe its own entry and its own TTL", async () => {
    const loader = vi.fn(async () => bars(2, 120));
    const store = new CandleStore();
    await store.fetched("EURUSD", TIMEFRAMES["1m"], loader, () => {});
    await store.fetched("EURUSD", TIMEFRAMES["1h"], loader, () => {});
    expect(loader).toHaveBeenCalledTimes(2);
    expect(store.cached("EURUSD", 60)).toHaveLength(2);
    expect(store.cached("EURUSD", 3600)).toHaveLength(2);
  });

  it("coalesces concurrent requests for one frame into a single call", async () => {
    let resolve!: (value: SimCandle[]) => void;
    const loader = vi.fn(() => new Promise<SimCandle[]>((r) => (resolve = r)));
    const store = new CandleStore();
    const calls = Array.from({ length: 25 }, () => store.fetched("EURUSD", TIMEFRAMES["1m"], loader, () => {}));
    resolve(bars(4, 240));
    const results = await Promise.all(calls);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.length === 4)).toBe(true);
  });

  it("keeps the previous frame when the provider fails, and never rejects", async () => {
    const good = bars(5, 300);
    let failing = false;
    const loader = async () => {
      if (failing) throw new Error("socket hang up");
      return good;
    };
    const store = new CandleStore();
    const onError = vi.fn();
    const expired = { ...TIMEFRAMES["1m"], candleTtlMs: -1 };
    expect(await store.fetched("EURUSD", expired, loader, onError)).toEqual(good);
    failing = true;
    expect(await store.fetched("EURUSD", expired, loader, onError)).toEqual(good);
    expect(onError.mock.calls.map((c) => c[0]).join(" ")).toMatch(/socket hang up/);
    expect(await store.fetched("GBPUSD", expired, loader, () => {})).toEqual([]);
  });

  it("caps stored bars and serves the last ones", async () => {
    const store = new CandleStore();
    const got = await store.fetched("EURUSD", TIMEFRAMES["1m"], () => Promise.resolve(bars(9_000, 9_000 * 60)), () => {});
    expect(got).toHaveLength(5_000);
    expect(got[got.length - 1].time).toBe(9_000 * 60 - 60);
  });

  it("aggregates its own tape up to the cap", () => {
    const store = new CandleStore();
    const frames = new Map<string, SimCandle[]>([["EURUSD", []]]);
    store.load(frames);
    for (let i = 0; i < 6_000; i++) store.push("EURUSD", 1 + i / 10_000, i * 60_000);
    const bars1m = store.bars("EURUSD", 60);
    expect(bars1m.length).toBeLessThanOrEqual(5_000);
    expect(store.bars("EURUSD", 300)).toHaveLength(Math.ceil(bars1m.length / 5));
  });
});

describe("status payload", () => {
  it("says what each slot is, in its own words", async () => {
    const plan = feedPlan(dualEnv);
    const live = keep(buildFeed(plan.live, { ...NO_SESSION, provider: fakeProvider() }));
    await live.pollProvider();
    expect(live.status()).toMatchObject({
      role: "live",
      purpose: "LIVE",
      mode: "yahoo",
      state: "running",
      steerable: false,
      winRate: null,
      simulatedMarks: false,
      started: false,
    });
    expect(live.status().lastMarkAt).toBeGreaterThan(0);
    expect(live.status().symbols).toBe(1);

    const demo = feedForRole({ DEMO_FEED: "simulated", DEMO_WIN_RATE: "0.55" }, "demo");
    demo.seedSim();
    expect(demo.status()).toMatchObject({
      role: "demo",
      purpose: "DEMO",
      mode: "simulated",
      steerable: true,
      winRate: 0.55,
      simulatedMarks: false,
      provider: "internal simulation",
    });
  });

  it("emits a status event when the machine moves", async () => {
    const feed = keep(buildFeed(feedPlan(dualEnv).live, { ...NO_SESSION, provider: fakeProvider() }));
    const events: string[] = [];
    feed.on("status", (s: { state: string }) => events.push(s.state));
    await feed.pollProvider();
    feed.lastMarkAt = Date.now() - 90_000;
    feed.state();
    expect(events).toContain("running");
    expect(events[events.length - 1]).toBe("paused");
  });

  it("keeps the Tick shape the client already reads", () => {
    const feed = feedForRole(dualEnv, "demo");
    feed.seedSim();
    feed.stepSim();
    const [tick] = feed.ticks();
    expect(Object.keys(tick).sort()).toEqual(["ask", "bid", "changePct", "mid", "symbol", "time"]);
    expect(tick.ask).toBeGreaterThanOrEqual(tick.bid);
  });
});

describe("§6 provider politeness: exponential backoff, jitter and Retry-After", () => {
  /** A 0.5 draw lands on the exact no-jitter ladder: 0.75 + 0.5*0.5 = 1.0. */
  const delay = (failures: number, rand = () => 0.5, poll = 2_500) => {
    const upstream = dedicatedUpstream(fakeProvider(), poll, "backoff", rand);
    upstream.failures = failures;
    return upstream.nextDelayMs;
  };

  it("doubles the wait per consecutive failure and caps at 60 s", () => {
    expect(delay(0)).toBe(2_500);
    expect([1, 2, 3, 4, 5, 6, 12].map((f) => delay(f))).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  });

  it("jitters the ladder by 25 percent either way so feeds do not return in lockstep", () => {
    expect(delay(2, () => 0)).toBe(7_500);
    expect(delay(2, () => 1)).toBe(12_500);
  });

  it("honours Retry-After over its own arithmetic, then forgets it", async () => {
    let down = true;
    const upstream = dedicatedUpstream(
      fakeProvider({
        async fetchQuotes() {
          if (down) throw new ProviderError("429: too many requests", 429, 45_000);
          return new Map<string, ProviderQuote>([["EURUSD", EUR]]);
        },
      }),
      2_500,
      "retry",
      () => 0.5,
    );
    await upstream.pollOnce();
    expect(upstream.failures).toBe(1);
    expect(upstream.nextDelayMs).toBe(45_000);
    down = false;
    await upstream.pollOnce();
    expect(upstream.failures).toBe(0);
    expect(upstream.nextDelayMs).toBe(2_500);
  });

  it("the running loop actually slows down and returns to cadence on recovery", async () => {
    vi.useFakeTimers();
    let down = true;
    let calls = 0;
    const upstream = dedicatedUpstream(
      fakeProvider({
        async fetchQuotes() {
          calls += 1;
          if (down) throw new Error("yahoo 503");
          return new Map<string, ProviderQuote>([["EURUSD", EUR]]);
        },
      }),
      2_500,
      "pace",
      () => 0.5,
    );
    const off = upstream.subscribe({ onQuotes: () => {}, onFailure: () => {} });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(calls).toBe(1); // failure 1 -> next wait 5 s, not 2.5
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(2); // failure 2 -> next wait 10 s
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(3); // failure 3 -> next wait 20 s
    down = false;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toBe(4);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(calls).toBe(5); // healthy again: straight back to the configured cadence
    off();
    upstream.stop();
  });
});

describe("§6 Twelve Data credit budget", () => {
  const tdEnv = (poll: string | undefined, extra: Record<string, string | undefined> = {}) => ({
    DEMO_FEED: "simulated",
    LIVE_FEED: "twelvedata",
    TWELVE_DATA_API_KEY: "k",
    PRICE_FEED: "",
    TD_POLL_MS: poll,
    ...extra,
  });

  it("refuses a live twelve-data cadence the free tier cannot pay for, with the arithmetic", () => {
    const plan = feedPlan(tdEnv("3000"));
    expect(plan.live.illegal).toContain("288000 credits/day");
    expect(plan.live.illegal).toContain("TD_DAILY_CREDIT_BUDGET=720");
    expect(plan.live.illegal).toContain("TD_POLL_MS=1200000");

    const feed = keep(buildFeed(plan.live, NO_SESSION));
    feed.start();
    expect(feed.state()).toBe("misconfigured");
    expect(feed.pauseReason()).toContain("unaffordable");
    expect(feed.quotes()).toEqual({});
    expect(() => feed.assertTradable("open")).toThrow(FeedError);
  });

  it("accepts the cadence that fits, and the built-in default is exactly that", () => {
    expect(feedPlan(tdEnv("1200000")).live.illegal).toBeNull();
    const dflt = feedPlan(tdEnv(undefined));
    expect(dflt.live.pollMs).toBe(1_200_000);
    expect(dflt.live.illegal).toBeNull();
    expect(tdCreditsPerDay(1_200_000)).toBe(720);
    expect(tdCreditsPerDay(3_000)).toBe(288_000);
  });

  it("a paid plan raises the ceiling instead of silencing the guard", () => {
    expect(feedPlan(tdEnv("3000", { TD_DAILY_CREDIT_BUDGET: "300000" })).live.illegal).toBeNull();
    expect(feedPlan(tdEnv("3000", { TD_DAILY_CREDIT_BUDGET: "1000" })).live.illegal).toContain("credits/day");
  });

  it("an unaffordable demo slot keeps its own tape rather than the key", () => {
    const plan = feedPlan({
      DEMO_FEED: "twelvedata",
      TD_POLL_MS: "3000",
      TWELVE_DATA_API_KEY: "k",
      LIVE_FEED: "yahoo",
      PRICE_FEED: "",
    });
    expect(plan.demo.mode).toBe("simulated");
    expect(plan.warnings.join(" ")).toContain("credits/day");
    const demo = keep(buildFeed(plan.demo, NO_SESSION));
    demo.start();
    expect(demo.state()).toBe("running");
    expect(demo.status().symbols).toBeGreaterThan(0);
  });
});

describe("§4.3 F6: several demo accounts on one symbol", () => {
  const PIP = 0.0001;
  const OPEN = 1.1;
  const WIN_RATE = 0.6;
  const idWith = (winRate: number, want: "WIN" | "LOSS") => {
    for (let i = 0; i < 5_000; i++) if (outcomeForPosition(`demo-${i}`, winRate) === want) return `demo-${i}`;
    throw new Error(`no id hashes to ${want}`);
  };
  const track = (id: string, takeProfitPips: number, stopLossPips: number) => ({
    id,
    accountId: `acct-${id}`,
    symbol: "EURUSD",
    side: "BUY" as const,
    openPrice: OPEN,
    stopLoss: OPEN + stopLossPips * PIP,
    takeProfit: OPEN + takeProfitPips * PIP,
    pipSize: PIP,
    spreadPips: 1.2,
  });
  // User A is destined to lose about 1 pip under the open; user B to win 60 above.
  const loser = track(idWith(WIN_RATE, "LOSS"), 120, -1);
  const winner = track(idWith(WIN_RATE, "WIN"), 60, -40);

  const walk = (feed: Feed, from: number, to: number, path?: number[]) => {
    const t = 1_800_000_000_000;
    for (let i = from; i <= to; i++) {
      feed.stepSim(250, t + i * 250);
      path?.push(mid(feed, "EURUSD"));
    }
  };

  const settle = (first: typeof winner, second: typeof winner, steps: number) => {
    const feed = feedForRole({ DEMO_FEED: "simulated", DEMO_WIN_RATE: "0.6" }, "demo", { rand: seeded(5) });
    feed.seedSim(1_800_000_000_000);
    feed.trackDemoPosition(first);
    feed.trackDemoPosition(second);
    const path: number[] = [];
    walk(feed, 1, steps, path);
    return { feed, path };
  };

  it("picks the nearest target, whoever registered first", () => {
    const a = settle(winner, loser, 400);
    const b = settle(loser, winner, 400);
    // Deterministic and insertion-order independent: identical trajectories.
    expect(a.path).toEqual(b.path);
    // Both accounts are tracked; one shared tape can only aim at one of them.
    expect(a.feed.status().trackedDemoPositions).toBe(2);
    // The near target wins the symbol, and defends it while it is open.
    expect(a.path[9]).toBeLessThan(OPEN);
    expect(a.path[399]).toBeLessThan(OPEN);
    // The far account is not served — this is the approximation §4.3 accepts.
    expect(a.path[399]).toBeLessThan(OPEN + 30 * PIP);
  });

  it("hands the symbol to the other account once the served position closes", () => {
    const feed = feedForRole({ DEMO_FEED: "simulated", DEMO_WIN_RATE: "0.6" }, "demo", { rand: seeded(5) });
    feed.seedSim(1_800_000_000_000);
    feed.trackDemoPosition(winner);
    feed.trackDemoPosition(loser);
    walk(feed, 1, 60);
    expect(mid(feed, "EURUSD")).toBeLessThan(OPEN);

    // The stop is hit, the engine closes the position and releases its target.
    feed.untrackDemoPosition(loser.id);
    walk(feed, 61, 500);
    // Nothing starves permanently: the remaining claim now drives the tape.
    expect(mid(feed, "EURUSD")).toBeGreaterThan(OPEN + 30 * PIP);
  });
});

describe("§8.2 market hours per feed", () => {
  // A-2: the session switch arrives through the env the plan is built from, so
  // these tests never touch `process.env` and cannot leak into another test.
  const hoursEnv = { ...dualEnv, ENFORCE_MARKET_HOURS: "true" };

  it("pauses a remote live slot over the weekend while the demo tape keeps running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T09:00:00Z")); // a Saturday: the FX week is shut
    const plan = feedPlan(hoursEnv);
    expect(plan.live.enforceMarketHours).toBe(true);

    const live = keep(buildFeed(plan.live, { ...NO_SESSION, respectMarketHours: true, provider: fakeProvider() }));
    await live.pollProvider();
    expect(live.mode).toBe("yahoo");
    expect(live.state()).toBe("paused");
    expect(live.pauseReason()).toMatch(/market is closed/);
    expect(live.quotes()).toEqual({});
    expect(() => live.assertTradable("open")).toThrow(/market is closed/);
    // Nothing executes while the market is shut, not even a close (A-5's table:
    // `paused` is empty) — but the marks are still shown, not hidden.
    expect(() => live.assertTradable("close")).toThrow(FeedError);
    expect(live.ticks()).toHaveLength(1);

    const demo = keep(buildFeed(plan.demo, { ...NO_SESSION, tickMs: 250 }));
    demo.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(demo.state()).toBe("running");
    expect(demo.marketOpen()).toBe(true);
    expect(demo.respectsMarketHours()).toBe(false);
    expect(demo.permits("open")).toBe(true);
    expect(demo.ticks().length).toBeGreaterThan(0);
  });

  it("a midweek session leaves a remote slot tradable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T08:00:00Z")); // a Wednesday
    const live = keep(buildFeed(feedPlan(hoursEnv).live, { ...NO_SESSION, respectMarketHours: true, provider: fakeProvider() }));
    await live.pollProvider();
    expect(live.state()).toBe("running");
    expect(live.permits("open")).toBe(true);
    expect(live.permits("close")).toBe(true);
  });
});

describe("A-8: the registry rebuilds on what the plan actually reads", () => {
  it("rebuilds when the credit budget changes the plan", () => {
    // Twelve Data at 3 s is unaffordable under the default 720 and affordable
    // under 300 000, so the budget is a plan input — and was not in the old
    // hand-kept signature list at all.
    const budgetEnv = {
      DEMO_FEED: "simulated",
      LIVE_FEED: "twelvedata",
      TWELVE_DATA_API_KEY: "k",
      TD_POLL_MS: "3000",
      TD_DAILY_CREDIT_BUDGET: "720",
      PRICE_FEED: "",
      PRICE_FEED_ON_FAILURE: "",
      ENFORCE_MARKET_HOURS: "",
    };
    withEnv(budgetEnv, () => {
      expect(feedPlan(process.env).live.illegal).toContain("unaffordable");
      const refused = feeds();
      expect(feeds()).toBe(refused); // same env, same pair of tapes: no rebuild

      process.env.TD_DAILY_CREDIT_BUDGET = "300000";
      expect(feedPlan(process.env).live.illegal).toBeNull();
      const paid = feeds();
      expect(paid).not.toBe(refused); // the plan moved, so the tapes rebuild

      process.env.TD_DAILY_CREDIT_BUDGET = "720";
      expect(feeds()).not.toBe(paid);
    });
  });

  it("ignores a switch that selects nothing, and honours one that does", () => {
    const env = { DEMO_FEED: "simulated", LIVE_FEED: "yahoo", PRICE_FEED: "", PRICE_FEED_ON_FAILURE: "", ENFORCE_MARKET_HOURS: "true" };
    withEnv(env, () => {
      const first = feeds();
      expect(feeds()).toBe(first);
      // The legacy failure switch is read by nothing in `feedPlan`; hashing it
      // used to rebuild two live tapes on a key that changes no behaviour.
      process.env.PRICE_FEED_ON_FAILURE = "simulate";
      expect(feeds()).toBe(first);
      // The session switch is a plan input since A-2, so it must rebuild.
      process.env.ENFORCE_MARKET_HOURS = "false";
      const second = feeds();
      expect(second).not.toBe(first);
      expect(second.demo).toBeInstanceOf(DemoFeed);
      expect(second.live).toBeInstanceOf(LiveFeed);
      expect(second.demo).not.toBe(second.live);
    });
  });

  it("rebuilds when a market-age knob moves the plan (A-10)", () => {
    withEnv(
      { DEMO_FEED: "simulated", LIVE_FEED: "yahoo", PRICE_FEED: "", PRICE_FEED_ON_FAILURE: "", LIVE_MARKET_STALE_MS: "300000" },
      () => {
        const first = feeds();
        expect(feeds()).toBe(first);
        process.env.LIVE_MARKET_STALE_MS = "900000";
        expect(feeds()).not.toBe(first);
      },
    );
  });
});
