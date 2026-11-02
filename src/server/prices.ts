import { getInstruments } from "./instrumentCache";
import type { Feed } from "./feeds/feed";
import { TIMEFRAMES } from "./feeds/provider";

export { TIMEFRAMES };
export * from "./feeds/registry";
export type {
  AccountType,
  CloseReason,
  DemoPositionTrack,
  FeedAction,
  FeedErrorCode,
  FeedMode,
  FeedRole,
  FeedState,
  FeedStatus,
  Tick,
} from "./feeds/types";
export { FeedError, asAccountType, closeAction, permitted, permittedActions, roleFor, servedType } from "./feeds/types";
export { asDemoFeed, buildFeed } from "./feeds/feed";
export type { DemoFeed, Feed, LiveFeed, Candle } from "./feeds/feed";

/**
 * Market hours belong to the source: a simulated tape has no session, a real
 * provider does. `ENFORCE_MARKET_HOURS=false` opens both, as before. The feed
 * owns the rule because its state machine has to apply the same answer.
 */
export function marketOpen(feed: Feed): boolean {
  return feed.marketOpen();
}

/** Candles come from the feed that is answering, so each feed serves its own series. */
export async function getCandles(feed: Feed, symbol: string, tf: string) {
  if (!(await getInstruments()).has(symbol)) return [];
  return feed.candles(symbol, TIMEFRAMES[tf] ?? TIMEFRAMES["1m"]);
}
