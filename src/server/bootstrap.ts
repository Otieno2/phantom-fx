import { prisma } from "@/lib/db";
import { startEngine } from "./engine";
import { instrumentsSync, reloadInstruments } from "./instrumentCache";
import { feedFor, feeds } from "./prices";

export async function startServices() {
  try {
    await reloadInstruments();
  } catch (err) {
    console.warn("[bootstrap] could not load instruments from DB (run `npm run setup`):", (err as Error).message);
  }

  const registry = feeds();
  registry.start();
  await hydrateDemoTargets();
  startEngine();

  const summary = registry
    .instances()
    .map((feed) => {
      const s = feed.status();
      return `${feed.key}=${s.mode} (${s.state}${s.degraded ? ", stale marks: management only" : ""}${s.paused ? `, refused: ${s.reason}` : ""}${s.simulatedMarks ? ", SIMULATED live prices" : ""})`;
    })
    .join(" ");
  console.log(`[bootstrap] price feeds: ${summary}, trading engine running`);
  for (const warning of registry.warnings) console.warn(`[bootstrap] feed config: ${warning}`);
}

/** Re-attach demo win-rate targeting after a process restart. Live positions need no hydration. */
async function hydrateDemoTargets() {
  try {
    const open = await prisma.position.findMany({
      where: { status: "OPEN", account: { type: "DEMO" } },
      select: { id: true, accountId: true, symbol: true, side: true, openPrice: true, stopLoss: true, takeProfit: true },
    });
    const insts = instrumentsSync();
    const demo = feedFor("DEMO");
    for (const p of open) {
      const inst = insts.get(p.symbol);
      demo.trackDemoPosition({
        id: p.id,
        accountId: p.accountId,
        symbol: p.symbol,
        side: p.side as "BUY" | "SELL",
        openPrice: p.openPrice,
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
        pipSize: inst?.pipSize ?? 0.0001,
        spreadPips: inst?.spreadPips ?? 1.2,
      });
    }
    if (open.length) console.log(`[bootstrap] re-attached win-rate targeting to ${open.length} open demo position(s)`);
  } catch (err) {
    console.warn("[bootstrap] could not hydrate open positions:", (err as Error).message);
  }
}
