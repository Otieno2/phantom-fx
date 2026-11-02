"use client";

import { useEffect, useState } from "react";

export interface Tick {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  changePct: number;
  time: number;
}

/** The feed machine state, as the server reports it. */
export type FeedStateName = "idle" | "starting" | "running" | "degraded" | "paused" | "misconfigured" | "stopped";

/** How the server resolved the feed. `"rejected"` only ever appears in an error body. */
export type FeedSourceName = "account" | "session-default" | "anonymous" | "rejected";

export interface FeedView {
  ticks: Record<string, Tick>;
  mode: string;
  /** Which account type is pricing this view; null for a logged-out ticker. */
  feed: string | null;
  /** How the server picked the feed: an owned account, the session default, or anonymous. */
  source: FeedSourceName | "";
  /** The `?account=` this view was resolved for, or null. A refusal names it too. */
  account: string | null;
  /** Which slot answered, for display only — the client never chooses it. */
  feedKey: string;
  state: FeedStateName;
  /** Marks are old: held positions are still protected, new orders are refused. */
  degraded: boolean;
  /** Nothing executes on this feed. */
  paused: boolean;
  stale: boolean;
  /** A held position may still be closed here, even while `degraded` refuses new orders. */
  closable: boolean;
  /** A live slot whose marks come from a simulation — always worth saying out loud. */
  simulatedMarks: boolean;
  lastMarkAt: number;
  /**
   * When the market last printed (A-10). `Tick.time` carries the same stamp per
   * symbol; this is the newest of them, so an "as of" label has one place to come
   * from. `marketAgeMs` is how long ago that was, `transportAgeMs` how long since
   * the host answered at all — over a weekend the second is small and the first
   * is days, which is exactly the difference the feed refuses to trade on.
   */
  lastQuoteMarketTime: number;
  marketAgeMs: number | null;
  transportAgeMs: number | null;
  /**
   * Pairs the server refuses to trade because THEIR OWN print aged out while the
   * slot stayed live (A-11). Additive: a board marks exactly these cells
   * untradeable and leaves the rest of the quotes alone.
   */
  staleSymbols: string[];
  reason: string;
  marketOpen: boolean;
  connected: boolean;
}

const EMPTY: FeedView = {
  ticks: {},
  mode: "",
  feed: null,
  source: "",
  account: null,
  feedKey: "",
  state: "idle",
  degraded: false,
  paused: false,
  stale: false,
  closable: false,
  simulatedMarks: false,
  lastMarkAt: 0,
  lastQuoteMarketTime: 0,
  marketAgeMs: null,
  transportAgeMs: null,
  staleSymbols: [],
  reason: "",
  marketOpen: true,
  connected: false,
};

type Wire = Omit<FeedView, "ticks" | "connected"> & { ticks?: Tick[] };

/**
 * Subscribes to the feed of the given account. `accountId` is only an account
 * identifier: the server checks that the caller owns it and reads its type from
 * the database, so the feed can never be picked by name from the client. An id
 * that is not the caller's is refused outright (404 on both `/api/prices` and
 * the stream) instead of quietly serving the demo tape — so a wrong id shows up
 * as a disconnected terminal, which is honest, not as someone else's prices.
 */
export function usePrices(accountId?: string): FeedView {
  const [state, setState] = useState<FeedView>(EMPTY);

  useEffect(() => {
    const query = accountId ? `?account=${encodeURIComponent(accountId)}` : "";
    const es = new EventSource(`/api/prices/stream${query}`);

    const apply = (data: Wire, incoming: Tick[] | undefined, previous: FeedView): FeedView => {
      const flags = {
        mode: data.mode,
        feed: data.feed,
        source: data.source,
        account: data.account ?? null,
        feedKey: data.feedKey,
        state: data.state,
        degraded: data.degraded,
        paused: data.paused,
        stale: data.stale,
        closable: data.closable,
        simulatedMarks: data.simulatedMarks,
        lastMarkAt: data.lastMarkAt,
        lastQuoteMarketTime: data.lastQuoteMarketTime,
        marketAgeMs: data.marketAgeMs,
        transportAgeMs: data.transportAgeMs,
        staleSymbols: data.staleSymbols ?? [],
        reason: data.reason,
        marketOpen: data.marketOpen,
        connected: true,
      };
      if (!incoming) return { ...previous, ...flags };
      const bySymbol: Record<string, Tick> = {};
      for (const t of incoming) bySymbol[t.symbol] = t;
      // A different feed means a different tape: start clean so live and demo
      // views never display each other's prices side by side.
      const ticks = previous.feedKey === data.feedKey && previous.feed === data.feed ? { ...previous.ticks, ...bySymbol } : bySymbol;
      return { ...flags, ticks };
    };

    es.onmessage = (e) => {
      const data = JSON.parse(e.data) as Wire;
      setState((prev) => apply(data, data.ticks ?? [], prev));
    };
    // A paused feed emits no ticks, so state changes arrive on their own event.
    es.addEventListener("status", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as Wire;
      setState((prev) => apply(data, undefined, prev));
    });
    es.onerror = () => setState((s) => ({ ...s, connected: false }));
    return () => es.close();
  }, [accountId]);

  return state;
}
