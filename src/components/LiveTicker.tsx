"use client";

import { digitsFor, price } from "@/lib/client/format";
import { usePrices } from "@/lib/client/usePrices";

export function LiveTicker() {
  const { ticks, mode, simulatedMarks, stale, reason, staleSymbols } = usePrices();
  const list = Object.values(ticks);
  // A public page may show a synthetic tape, but never unlabelled (§3.4).
  // "Stale" is two different failures since A-10 — the source stopped answering,
  // or it answers and carries an old print — so quote the feed's own verdict
  // rather than inventing a second explanation here.
  const caveat =
    mode === "simulated" || simulatedMarks
      ? "Simulated prices"
      : stale
        ? `Prices are stale — ${reason || "the feed has no live mark"}`
        : // A-11: the tape is live and ONE pair is not. Name it instead of letting
          // the board look uniformly tradeable; the server refuses it for new and
          // edited risk, which is the one thing this cell cannot show by price.
          staleSymbols.length
          ? `No live quote for ${staleSymbols.join(", ")} — held positions still marked and closable`
          : "";
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-ink-700 px-4 py-2 text-xs text-slate-400">
        <span>Market watch</span>
        {caveat && <span className="text-yellow-400">{caveat}</span>}
      </div>
      <div className="grid grid-cols-2 divide-ink-700 sm:grid-cols-5">
      {list.length === 0 && <div className="col-span-full p-4 text-center text-sm text-slate-500">Connecting to price feed…</div>}
      {list.slice(0, 10).map((t) => (
        <div key={t.symbol} className="border-b border-r border-ink-800 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-300">
              {t.symbol}
              {staleSymbols.includes(t.symbol) && (
                // Shown, not hidden: a frozen pair that admits it is frozen is the
                // whole point of keeping it on the board (A-11).
                <span className="ml-1 text-yellow-400" title={reason || "This pair's own print is past the gate; it cannot be opened or modified"}>
                  frozen
                </span>
              )}
            </span>
            <span className={t.changePct >= 0 ? "text-up" : "text-down"}>
              {t.changePct >= 0 ? "+" : ""}
              {t.changePct.toFixed(2)}%
            </span>
          </div>
          <div className="mt-1 font-mono text-lg text-white">{price(t.mid, digitsFor(t.symbol))}</div>
        </div>
      ))}
      </div>
    </div>
  );
}
