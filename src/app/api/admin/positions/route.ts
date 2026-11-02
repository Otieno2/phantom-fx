import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { json, route } from "@/lib/http";
import { round2 } from "@/lib/trading/math";
import { asAccountType, feedFor } from "@/server/prices";
import { positionsWithPnl } from "@/server/trading";

export const GET = route(async (req: Request) => {
  await requireAdmin();
  const rawType = new URL(req.url).searchParams.get("type") ?? "LIVE";
  // An admin asking for `type=live` gets a refusal, not the demo tape: the query
  // parameter is resolved through the same fail-closed converter the money path
  // uses (§2.6-R12), so no spelling of "live" can quietly reach simulated marks.
  const accountType = asAccountType(rawType, `admin positions type=${JSON.stringify(rawType)}`);
  const rows = await prisma.position.findMany({
    where: { status: "OPEN", account: { type: accountType } },
    orderBy: { openedAt: "desc" },
    include: { account: { select: { login: true, user: { select: { name: true, email: true } } } } },
  });
  // Whatever the admin asked to see, each row is marked by its own account type's feed.
  const positions = await positionsWithPnl(rows, feedFor(accountType).displayQuotes());
  const exposure: Record<string, { symbol: string; netLots: number; buyLots: number; sellLots: number; clientPnl: number }> = {};
  for (const p of positions) {
    const e = (exposure[p.symbol] ??= { symbol: p.symbol, netLots: 0, buyLots: 0, sellLots: 0, clientPnl: 0 });
    if (p.side === "BUY") e.buyLots += p.volume;
    else e.sellLots += p.volume;
    e.netLots = round2(e.buyLots - e.sellLots);
    e.clientPnl = round2(e.clientPnl + p.profit);
  }
  return json({ positions, exposure: Object.values(exposure) });
});
