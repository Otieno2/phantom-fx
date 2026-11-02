import { prisma } from "@/lib/db";
import { STOP_OUT_LEVEL } from "@/lib/instruments";
import { shouldTriggerPending, stopHit, type OrderType, type Side } from "@/lib/trading/math";
import { getInstrument } from "./instrumentCache";
import { withLock } from "./lock";
import { feeds, marketOpen, type Feed } from "./prices";
import { closePositionLocked, getAccountState, openPosition } from "./trading";

const busy = new Set<Feed>();

/**
 * Runs on one feed's price update. Which actions execute depends on that feed's
 * state (design §5.2, A-5): `running` fills pending orders, executes SL/TP and
 * enforces stop-out; `degraded` still manages and closes what is already open,
 * because a stale mark is better than leaving a client's protective orders unrun
 * or their position uncloseable, but it opens nothing and edits nothing;
 * anything else does nothing. A demo tick can never touch a live account.
 */
export async function processTick(feed: Feed) {
  if (!marketOpen(feed)) return;
  const mayOpen = feed.permits("open");
  const mayManage = feed.permits("manage");
  if (!mayOpen && !mayManage) return;

  // Two surfaces on purpose (A-11). Fills read the per-symbol-gated map, so one
  // frozen pair inside an otherwise healthy batch cannot open a position at a
  // dead price; protective exits read the slot's marks, because a frozen pair is
  // precisely the one whose stop is about to be hit.
  const fills = mayOpen ? feed.tradeQuotes("open") : {};
  const marks = feed.quotes();
  const accountType = feed.servedType;

  if (mayOpen) {
    const pending = await prisma.order.findMany({ where: { status: "PENDING", account: { type: accountType } } });
    for (const o of pending) {
      const q = fills[o.symbol];
      if (!q || o.price == null) continue;
      if (!shouldTriggerPending({ side: o.side as Side, type: o.type as OrderType, price: o.price }, q)) continue;
      await withLock(o.accountId, async () => {
        const fresh = await prisma.order.findUnique({ where: { id: o.id } });
        if (fresh?.status !== "PENDING") return;
        const inst = await getInstrument(o.symbol);
        try {
          if (!inst?.enabled) throw new Error(`${o.symbol} is disabled`);
          await openPosition(o.accountId, inst, o.side as Side, o.volume, o.stopLoss, o.takeProfit, feed, o.id);
        } catch (err) {
          await prisma.order.update({ where: { id: o.id }, data: { status: "REJECTED", reason: (err as Error).message } });
        }
      });
    }
  }

  if (!mayManage) return;

  const open = await prisma.position.findMany({ where: { status: "OPEN", account: { type: accountType } } });
  const accounts = new Set<string>();
  for (const p of open) {
    accounts.add(p.accountId);
    const q = marks[p.symbol];
    if (!q) continue;
    const hit = stopHit({ side: p.side as Side, stopLoss: p.stopLoss, takeProfit: p.takeProfit }, q);
    if (!hit) continue;
    await withLock(p.accountId, () => closePositionLocked(p.id, hit, feed)).catch(() => undefined);
  }

  for (const accountId of accounts) {
    await withLock(accountId, async () => {
      for (let i = 0; i < 100; i++) {
        const state = await getAccountState(accountId);
        if (state.metrics.marginLevel === null || state.metrics.marginLevel > STOP_OUT_LEVEL) return;
        const worst = [...state.positions].sort((a, b) => a.profit - b.profit)[0];
        if (!worst) return;
        console.warn(`[engine] Stop-out account ${accountId} at margin level ${state.metrics.marginLevel}%`);
        await closePositionLocked(worst.id, "STOP_OUT", feed);
      }
    });
  }
}

export function startEngine() {
  const g = globalThis as unknown as { __engineStarted?: boolean };
  if (g.__engineStarted) return;
  g.__engineStarted = true;
  // One subscription per distinct instance. There are always two slots, so a
  // demo tick and a live tick drive separate state machines and separate fills.
  for (const feed of feeds().instances()) {
    feed.on("ticks", () => {
      if (busy.has(feed)) return;
      busy.add(feed);
      processTick(feed)
        .catch((err) => console.error("[engine] tick failed", err))
        .finally(() => busy.delete(feed));
    });
  }
}
