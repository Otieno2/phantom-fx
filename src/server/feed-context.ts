import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/http";
import type { Feed } from "./feeds/feed";
import { demoFeed, feedFor, publicFeed } from "./feeds/registry";
import { asAccountType, permitted, type AccountType } from "./feeds/types";
import { marketOpen } from "./prices";

export type FeedSelectionSource = "account" | "session-default" | "anonymous" | "rejected";

export interface FeedSelection {
  feed: Feed;
  /** null for an anonymous viewer: there is no account behind these marks. */
  accountType: AccountType | null;
  /** How the feed was pinned, so a payload can say which it is serving. */
  source: FeedSelectionSource;
  /** The `?account=<id>` the caller asked for, echoed back so a view is attributable (A-4). */
  accountId: string | null;
}

/** `?account=<id>` that resolves to no feed of ours: 404, never a silent demo tape. */
const UNKNOWN_ACCOUNT = (id: string) =>
  `?account=${id} is not an account of this session, so no feed was selected — an unknown or unowned id is refused rather than priced on the demo tape`;

/**
 * Resolves the feed for an HTTP request from the session, never from a feed
 * name. `?account=<id>` may only name an account the caller owns; its type is
 * read back from the database row and an unrecognised value throws rather than
 * defaulting to the steered tape (§2.6-R12). Asking for an account that does not
 * belong to the caller is refused the same way (A-4): silently serving DEMO made
 * the terminal show a tape the user never asked for. A genuinely anonymous
 * request still gets the public ticker. This value never prices a trade — the
 * trading path resolves the account it is trading.
 */
export async function feedForRequest(req: Request): Promise<FeedSelection> {
  const user = await getCurrentUser();
  const params = new URL(req.url).searchParams;
  const accountId = params.get("account") ?? params.get("accountId");
  if (!user) {
    // No session, no account: the marketing ticker. An `?account=` on an
    // anonymous request is meaningless, so it is refused too rather than ignored.
    if (accountId) throw new HttpError(404, UNKNOWN_ACCOUNT(accountId), { code: "ACCOUNT_NOT_AVAILABLE", source: "rejected" });
    return { feed: publicFeed(), accountType: null, source: "anonymous", accountId: null };
  }

  if (accountId) {
    const account = await prisma.account.findFirst({ where: { id: accountId, userId: user.id }, select: { type: true } });
    if (!account) throw new HttpError(404, UNKNOWN_ACCOUNT(accountId), { code: "ACCOUNT_NOT_AVAILABLE", source: "rejected" });
    const accountType = asAccountType(account.type, `account ${accountId}`);
    return { feed: feedFor(accountType), accountType, source: "account", accountId };
  }
  // A signed-in terminal with no selected account opens on demo (design §3.2).
  return { feed: demoFeed(), accountType: "DEMO", source: "session-default", accountId: null };
}

/** The feed that prices an account of a known type. Unknown types throw (R12). */
export function feedForAccountType(type: string | null | undefined, context: string): Feed {
  return feedFor(asAccountType(type, context));
}

/**
 * What every price-bearing response says about the feed that answered it.
 * `degraded` and `paused` are separate fields on purpose: one still manages and
 * closes held positions, the other manages nothing (§2.6-R6, A-5).
 */
export function feedPayload(feed: Feed, selection: Pick<FeedSelection, "accountType" | "source" | "accountId">) {
  const status = feed.status();
  return {
    feed: selection.accountType,
    source: selection.source,
    // Which slot answered. The client never picks it; it only reports it.
    feedKey: status.role,
    /** The account this view was resolved for, or null when nothing was asked for. */
    account: selection.accountId,
    mode: status.mode,
    state: status.state,
    degraded: status.degraded,
    paused: status.paused,
    stale: status.stale,
    /** Stale-but-real marks still close held positions; simulated ones do not (A-5). */
    closable: permitted(status.state, "close", !status.simulatedMarks),
    simulatedMarks: status.simulatedMarks,
    lastMarkAt: status.lastMarkAt,
    /**
     * The two ages (A-10). `transportAgeMs` is when the host last answered;
     * `marketAgeMs` is when the market last printed. The second is what explains
     * a weekend, and `lastQuoteMarketTime` is what an "as of" is drawn from —
     * every `Tick.time` carries the same stamp, per symbol.
     */
    lastQuoteMarketTime: status.lastQuoteMarketTime,
    marketAgeMs: status.marketAgeMs,
    transportAgeMs: status.transportAgeMs,
    /**
     * Pairs the per-symbol gate is refusing while this slot may still read
     * `running` (A-11). Additive, and named rather than flagged: a client
     * conversation needs "we will not trade USDJPY, its print is 20m old", not a
     * second `FEED_STALE` that looks identical to a tape-wide outage.
     */
    staleSymbols: status.staleSymbols,
    reason: status.reason,
    marketOpen: marketOpen(feed),
  };
}
