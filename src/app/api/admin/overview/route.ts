import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { json, route } from "@/lib/http";
import { round2 } from "@/lib/trading/math";
import { feedFor, feeds } from "@/server/prices";
import { positionsWithPnl } from "@/server/trading";
export const GET = route(async () => {
  await requireAdmin();
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [users, newUsers, liveAgg, pendingDeposits, pendingWithdrawals, deposits, withdrawals, openLive, closedLive24h] =
    await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: since } } }),
      prisma.account.aggregate({ where: { type: "LIVE" }, _sum: { balance: true } }),
      prisma.transaction.count({ where: { type: "DEPOSIT", status: "PENDING" } }),
      prisma.transaction.count({ where: { type: "WITHDRAWAL", status: "PENDING" } }),
      prisma.transaction.aggregate({ where: { type: "DEPOSIT", status: "COMPLETED", account: { type: "LIVE" } }, _sum: { amount: true } }),
      prisma.transaction.aggregate({ where: { type: "WITHDRAWAL", status: "COMPLETED", account: { type: "LIVE" } }, _sum: { amount: true } }),
      prisma.position.findMany({ where: { status: "OPEN", account: { type: "LIVE" } } }),
      prisma.position.aggregate({
        where: { status: "CLOSED", closedAt: { gte: since }, account: { type: "LIVE" } },
        _sum: { profit: true, commission: true },
        _count: true,
      }),
    ]);
  // Live exposure is marked by the live feed only, on its display surface.
  const live = feedFor("LIVE");
  const open = await positionsWithPnl(openLive, live.displayQuotes());
  const floating = open.reduce((s, p) => s + p.profit, 0);
  return json({
    users,
    newUsers,
    liveBalances: round2(liveAgg._sum.balance ?? 0),
    pendingDeposits,
    pendingWithdrawals,
    totalDeposits: round2(deposits._sum.amount ?? 0),
    totalWithdrawals: round2(-(withdrawals._sum.amount ?? 0)),
    openLivePositions: open.length,
    clientFloatingPnl: round2(floating),
    // The house is the counterparty on live trades (B-book): client losses are broker revenue.
    brokerPnl24h: round2(-(closedLive24h._sum.profit ?? 0) + (closedLive24h._sum.commission ?? 0)),
    trades24h: closedLive24h._count,
    // Both slots, each with its own state machine: the panel must be able to see
    // a degraded live feed next to a healthy demo tape, and say which is which.
    feeds: feeds().instances().map((feed) => feed.status()),
    feedWarnings: feeds().warnings,
  });
});
