import type { Position } from "@prisma/client";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/http";
import {
  accountMetrics,
  closePriceFor,
  isValidLot,
  marginUSD,
  openPriceFor,
  pnlUSD,
  round2,
  roundTo,
  validatePendingPrice,
  validateStops,
  validateStopsForOpen,
  type OrderType,
  type QuoteMap,
  type Side,
} from "@/lib/trading/math";
import { getInstrument, getInstruments, type Instrument } from "./instrumentCache";
import { withLock } from "./lock";
import {
  asAccountType,
  asDemoFeed,
  closeAction,
  feedFor,
  marketOpen,
  FeedError,
  roleFor,
  type AccountType,
  type CloseReason,
  type Feed,
  type FeedAction,
} from "./prices";

export type { CloseReason };

export class TradeError extends HttpError {
  constructor(message: string) {
    super(400, message);
  }
}

/** Fail closed: `Account.type` is an unconstrained column, so anything but DEMO/LIVE throws (R12). */
export const accountTypeOf = (type: string | null | undefined, context = "account"): AccountType =>
  asAccountType(type, context);

async function loadAccountType(accountId: string): Promise<AccountType> {
  const account = await prisma.account.findUnique({ where: { id: accountId }, select: { type: true } });
  if (!account) throw new TradeError("Account not found");
  return asAccountType(account.type, `account ${accountId}`);
}

/**
 * Marks for an account always come from that account's feed, and only while the
 * feed permits the action being taken. A live account can therefore never be
 * filled, marked or closed on the steered simulation.
 *
 * `symbol` is what the caller is about to PRICE, and that is where A-11 bites:
 * the slot verdict says the tape is alive, the per-symbol gate says whether
 * THIS pair's own print is. `open`/`modify` on a pair whose print is older than
 * `marketStaleMs` throw even while nine other pairs stream; `close`/`manage`
 * never do, because the frozen pair is exactly the one whose stop or whose owner
 * wants out. Conversion rates deliberately read the full marks
 * (`feed.quotes()`), not this map — a missing helper rate must not turn into an
 * obscure 500, and last-known-rate is what the equity display already uses.
 */
function quotesFor(feed: Feed, accountType: AccountType, action: FeedAction, symbol: string): QuoteMap {
  if (feed.key !== roleFor(accountType)) {
    throw new FeedError("FEED_MISCONFIGURED", `feed "${feed.key}" cannot price ${accountType} accounts`);
  }
  feed.assertTradable(action);
  feed.assertSymbolTradable(symbol, action);
  return feed.tradeQuotes(action);
}

/** A refused feed is a service outage, not bad input: lib/http maps FeedError to 503/400. */

function quoteFor(symbol: string, quotes: QuoteMap) {
  const q = quotes[symbol];
  if (!q) throw new TradeError(`No price available for ${symbol}`);
  return q;
}

function assertTradable(inst: Instrument | null, symbol: string, feed: Feed): Instrument {
  if (!inst || !inst.enabled) throw new TradeError(`${symbol} is not available for trading`);
  if (!marketOpen(feed)) throw new TradeError("The FX market is closed");
  return inst;
}

export async function positionsWithPnl(positions: Position[], quotes: QuoteMap) {
  const insts = await getInstruments();
  return positions.map((p) => {
    const inst = insts.get(p.symbol);
    const q = quotes[p.symbol];
    if (!inst || !q) return { ...p, currentPrice: null as number | null, profit: 0 };
    const currentPrice = closePriceFor(p.side as Side, q);
    const profit = round2(pnlUSD(inst, p.side as Side, p.volume, p.openPrice, currentPrice, quotes));
    return { ...p, currentPrice, profit };
  });
}

export async function getAccountState(accountId: string) {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  // Display state uses the display surface: a blocked feed marks positions with
  // their last known price (or none at all) instead of throwing away the view.
  // Nothing here moves money — every fill and close re-prices through `quotesFor`.
  const quotes = feedFor(asAccountType(account.type, `account ${accountId}`)).displayQuotes();
  const [open, orders] = await Promise.all([
    prisma.position.findMany({ where: { accountId, status: "OPEN" }, orderBy: { openedAt: "desc" } }),
    prisma.order.findMany({ where: { accountId, status: "PENDING" }, orderBy: { createdAt: "desc" } }),
  ]);
  const positions = await positionsWithPnl(open, quotes);
  return { account, positions, orders, metrics: accountMetrics(account.balance, positions) };
}

export interface OrderInput {
  symbol: string;
  side: Side;
  type: OrderType;
  volume: number;
  price?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
}

export async function placeOrder(accountId: string, input: OrderInput) {
  const accountType = await loadAccountType(accountId);
  const feed = feedFor(accountType);
  const inst = assertTradable(await getInstrument(input.symbol), input.symbol, feed);
  if (!isValidLot(input.volume, inst.minLot, inst.maxLot)) {
    throw new TradeError(`Volume must be between ${inst.minLot} and ${inst.maxLot} lots in steps of 0.01`);
  }
  const quotes = quotesFor(feed, accountType, "open", inst.symbol);
  const q = quoteFor(inst.symbol, quotes);
  const sl = input.stopLoss ? roundTo(input.stopLoss, inst.digits) : null;
  const tp = input.takeProfit ? roundTo(input.takeProfit, inst.digits) : null;

  if (input.type === "MARKET") {
    return withLock(accountId, async () => {
      const position = await openPosition(accountId, inst, input.side, input.volume, sl, tp, feed);
      return { kind: "position" as const, position };
    });
  }

  if (!input.price || input.price <= 0) throw new TradeError("A price is required for pending orders");
  const price = roundTo(input.price, inst.digits);
  const err = validatePendingPrice(input.side, input.type, price, q) ?? validateStops(input.side, price, sl, tp);
  if (err) throw new TradeError(err);
  const order = await prisma.order.create({
    data: {
      accountId,
      symbol: inst.symbol,
      side: input.side,
      type: input.type,
      volume: input.volume,
      price,
      stopLoss: sl,
      takeProfit: tp,
      status: "PENDING",
    },
  });
  return { kind: "order" as const, order };
}

/** Must be called while holding the account lock. */
export async function openPosition(
  accountId: string,
  inst: Instrument,
  side: Side,
  volume: number,
  sl: number | null,
  tp: number | null,
  feed: Feed,
  pendingOrderId?: string,
) {
  const state = await getAccountState(accountId);
  const accountType = asAccountType(state.account.type, `account ${accountId}`);
  const quotes = quotesFor(feed, accountType, "open", inst.symbol);
  const q = quoteFor(inst.symbol, quotes);
  const price = openPriceFor(side, q);
  // §4.3: synthetic stops exist only so steering has something to aim at, so
  // they are injected exactly when steering is enabled — demo role, a win rate,
  // and a simulated tape. A demo account on a real provider gets the stops it
  // asked for and nothing more, and a LIVE account never gets them.
  if (accountType === "DEMO" && sl == null && tp == null && feed.steerable) {
    const slDist = inst.pipSize * 15;
    const tpDist = inst.pipSize * 25;
    sl = side === "BUY" ? roundTo(price - slDist, inst.digits) : roundTo(price + slDist, inst.digits);
    tp = side === "BUY" ? roundTo(price + tpDist, inst.digits) : roundTo(price - tpDist, inst.digits);
  }
  const stopErr = validateStops(side, price, sl, tp);
  if (stopErr) throw new TradeError(stopErr);

  // The fill above is priced off the gated map; the margin below needs a USD
  // rate, which is a different job and reads the full marks — refusing a fresh
  // pair because an unrelated conversion pair froze would be its own outage.
  const margin = round2(marginUSD(inst, volume, state.account.leverage, feed.quotes()));
  const commission = round2(inst.commissionPerLot * volume);
  if (state.metrics.freeMargin < margin + commission) {
    throw new TradeError(
      `Not enough free margin: required $${(margin + commission).toFixed(2)}, available $${state.metrics.freeMargin.toFixed(2)}`,
    );
  }

  const position = await prisma.$transaction(async (tx) => {
    const created = await tx.position.create({
      data: { accountId, symbol: inst.symbol, side, volume, openPrice: price, stopLoss: sl, takeProfit: tp, margin, commission },
    });
    if (commission > 0) {
      await tx.account.update({ where: { id: accountId }, data: { balance: { decrement: commission } } });
      await tx.transaction.create({
        data: { accountId, type: "COMMISSION", amount: -commission, positionId: created.id, note: `Commission ${volume} lots ${inst.symbol}` },
      });
    }
    if (pendingOrderId) {
      await tx.order.update({ where: { id: pendingOrderId }, data: { status: "FILLED", positionId: created.id, reason: `Filled @ ${price}` } });
    } else {
      await tx.order.create({
        data: { accountId, symbol: inst.symbol, side, type: "MARKET", volume, price, stopLoss: sl, takeProfit: tp, status: "FILLED", positionId: created.id },
      });
    }
    return created;
  });

  // Only a demo fill is registered for win-rate steering, and the narrowing says
  // so: a live feed has no steering surface to reach (A-1), and `asDemoFeed`
  // still throws if a mis-routed instance ever gets here.
  if (accountType === "DEMO") {
    asDemoFeed(feed, `position ${position.id}`).trackDemoPosition({
      id: position.id,
      accountId,
      symbol: inst.symbol,
      side,
      openPrice: price,
      stopLoss: sl,
      takeProfit: tp,
      pipSize: inst.pipSize,
      spreadPips: inst.spreadPips,
    });
  }
  return position;
}

/** Must be called while holding the account lock. */
export async function closePositionLocked(positionId: string, reason: CloseReason, feed: Feed) {
  const pos = await prisma.position.findUnique({ where: { id: positionId } });
  if (!pos || pos.status !== "OPEN") throw new TradeError("Position is not open");
  const inst = await getInstrument(pos.symbol);
  if (!inst) throw new TradeError("Unknown instrument");
  const accountType = asAccountType(
    (await prisma.account.findUnique({ where: { id: pos.accountId }, select: { type: true } }))?.type,
    `account ${pos.accountId}`,
  );
  // SL / TP / stop-out are protective management; a manual or administrative
  // close is a fresh decision. The reason picks the permission, and `degraded`
  // answers for both: stale marks may not open or edit risk, but they never
  // trap a position that its owner (or its stop) wants out of (A-5, §5.3).
  const quotes = quotesFor(feed, accountType, closeAction(reason), pos.symbol);
  const q = quoteFor(pos.symbol, quotes);
  const side = pos.side as Side;
  const closePrice = closePriceFor(side, q);
  // Same split as the fill path: the exit price comes off the gated mark, the
  // currency conversion off the full marks.
  const profit = round2(pnlUSD(inst, side, pos.volume, pos.openPrice, closePrice, feed.quotes()));

  const closedAt = new Date();

  const closed = await prisma.$transaction(async (tx) => {
    const updated = await tx.position.updateMany({
      where: { id: pos.id, status: "OPEN" },
      data: { status: "CLOSED", closePrice, closeReason: reason, profit, closedAt },
    });
    if (updated.count === 0) throw new TradeError("Position is not open");
    const account = await tx.account.update({ where: { id: pos.accountId }, data: { balance: { increment: profit } } });
    await tx.transaction.create({
      data: {
        accountId: pos.accountId,
        type: "TRADE",
        amount: profit,
        positionId: pos.id,
        note: `Close ${pos.side} ${pos.volume} ${pos.symbol} @ ${closePrice} (${reason})`,
      },
    });
    // Negative balance protection: clients can never lose more than they deposited.
    const stillOpen = await tx.position.count({ where: { accountId: pos.accountId, status: "OPEN" } });
    if (account.balance < 0 && stillOpen === 0) {
      await tx.account.update({ where: { id: pos.accountId }, data: { balance: 0 } });
      await tx.transaction.create({
        data: { accountId: pos.accountId, type: "ADJUSTMENT", amount: round2(-account.balance), note: "Negative balance protection" },
      });
    }
    return { ...pos, status: "CLOSED" as const, closePrice, closeReason: reason, profit, closedAt };
  });

  // The residual hazard of "manage always runs" (A-11, steering §1): a protective
  // level on a frozen pair may have fired late, early or not at all. It still
  // fires, because an unmanaged position is the worse harm — but it is logged,
  // once the close has actually settled, with the pair and the age of the mark.
  const agedNote = feed.agedMarkNote(pos.symbol, closeAction(reason));
  if (agedNote) console.warn(`${agedNote} — settled at ${closePrice}`);

  if (accountType === "DEMO") asDemoFeed(feed, `position ${pos.id}`).untrackDemoPosition(pos.id);
  return closed;
}

/**
 * A user- or admin-initiated close. The gate is the one the reason needs, not a
 * blanket `close` checked before the reason is even known: gating everything on
 * `close` used to refuse protective semantics outright (A-5). `closePositionLocked`
 * re-checks under the account lock, which is where the decision is actually made.
 */
export async function closePosition(positionId: string, accountId: string, reason: CloseReason) {
  const accountType = await loadAccountType(accountId);
  const feed = feedFor(accountType);
  if (!marketOpen(feed)) throw new TradeError("The FX market is closed");
  // The slot-level half of the gate, with the reason-picked action. The symbol's
  // own print is checked by `closePositionLocked` under the lock, where the
  // position (and therefore the pair) is actually known — and neither half
  // refuses a protective close (A-11).
  feed.assertTradable(closeAction(reason));
  return withLock(accountId, () => closePositionLocked(positionId, reason, feed));
}

export async function modifyPosition(positionId: string, accountId: string, sl: number | null, tp: number | null) {
  return withLock(accountId, async () => {
    const pos = await prisma.position.findFirst({
      where: { id: positionId, accountId, status: "OPEN" },
      include: { account: { select: { type: true } } },
    });
    if (!pos) throw new TradeError("Position is not open");
    const inst = await getInstrument(pos.symbol);
    if (!inst) throw new TradeError("Unknown instrument");
    const accountType = asAccountType(pos.account.type, `account ${pos.accountId}`);
    const feed = feedFor(accountType);
    const q = quoteFor(pos.symbol, quotesFor(feed, accountType, "modify", pos.symbol));
    const nsl = sl ? roundTo(sl, inst.digits) : null;
    const ntp = tp ? roundTo(tp, inst.digits) : null;
    const err = validateStopsForOpen(pos.side as Side, q, nsl, ntp);
    if (err) throw new TradeError(err);
    const updated = await prisma.position.update({ where: { id: pos.id }, data: { stopLoss: nsl, takeProfit: ntp } });
    if (accountType === "DEMO") asDemoFeed(feed, `position ${pos.id}`).updateDemoStops(pos.id, nsl, ntp);
    return updated;
  });
}

export async function cancelOrder(orderId: string, accountId: string) {
  return withLock(accountId, async () => {
    const res = await prisma.order.updateMany({
      where: { id: orderId, accountId, status: "PENDING" },
      data: { status: "CANCELLED", reason: "Cancelled by client" },
    });
    if (res.count === 0) throw new TradeError("Order is not pending");
  });
}
