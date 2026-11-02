"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { usePrices } from "@/lib/client/usePrices";
import { AccountBar } from "./AccountBar";
import { OrderTicket } from "./OrderTicket";
import { PositionsPanel } from "./PositionsPanel";
import { PriceChart } from "./PriceChart";
import { Watchlist } from "./Watchlist";
import type { AccountState, AccountSummary, InstrumentInfo } from "./types";

export function TradeTerminal() {
  const [instruments, setInstruments] = useState<InstrumentInfo[]>([]);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  // The active account selects the feed: demo reads the steered simulation,
  // live reads the real provider.
  const feed = usePrices(activeId || undefined);
  const [state, setState] = useState<AccountState | null>(null);
  const [symbol, setSymbol] = useState("EURUSD");
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);

  useEffect(() => {
    api<{ instruments: InstrumentInfo[] }>("/api/prices").then((d) => setInstruments(d.instruments));
    api<{ accounts: AccountSummary[] }>("/api/accounts").then((d) => {
      setAccounts(d.accounts);
      const saved = typeof window !== "undefined" ? localStorage.getItem("pfx_account") : null;
      const pick = d.accounts.find((a) => a.id === saved) ?? d.accounts.find((a) => a.type === "DEMO") ?? d.accounts[0];
      if (pick) setActiveId(pick.id);
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!activeId) return;
    try {
      setState(await api<AccountState>(`/api/accounts/${activeId}`));
    } catch {
      /* transient */
    }
  }, [activeId]);

  useEffect(() => {
    if (!activeId) return;
    localStorage.setItem("pfx_account", activeId);
    const first = setTimeout(refresh, 0);
    const t = setInterval(refresh, 1500);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [activeId, refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const notify = (msg?: string) => {
    if (msg) setToast({ msg });
    void refresh();
  };

  const resetDemo = async () => {
    if (!confirm("Reset demo account? All positions and orders will be cleared.")) return;
    await api(`/api/accounts/${activeId}/reset`, { method: "POST" });
    notify("Demo account reset");
  };

  const instrument = instruments.find((i) => i.symbol === symbol) ?? instruments[0];
  const active = accounts.find((a) => a.id === activeId);
  const who = feed.feed === "LIVE" ? "Live" : "Demo";
  // Paused and degraded are not the same warning: in degraded the client's
  // protective orders still run, and saying so is the whole point of the split.
  const disabled = !feed.marketOpen
    ? "The FX market is closed (opens Sunday 22:00 UTC)"
    : feed.paused
      ? `${who} prices are unavailable (${feed.reason || "no trustworthy marks"}), trading is paused — open positions are not being closed either`
      : feed.degraded
        ? `${who} prices are stale (${feed.reason || "last mark is old"}) — new orders are refused, but stop-loss and take-profit on your open positions still run`
        : active?.type === "LIVE" && (state?.metrics.balance ?? 0) <= 0 && (state?.positions.length ?? 0) === 0
          ? "Your live account has no funds. Deposit from the Wallet to start trading."
          : null;

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col">
      <AccountBar
        accounts={accounts}
        activeId={activeId}
        metrics={state?.metrics}
        onSwitch={setActiveId}
        onResetDemo={resetDemo}
        feed={feed}
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[280px_1fr_300px]">
        <aside className="hidden border-r border-ink-700 bg-ink-900 lg:block">
          <Watchlist instruments={instruments} ticks={feed.ticks} selected={symbol} onSelect={setSymbol} />
        </aside>
        <section className="flex min-h-0 flex-col">
          <div className="min-h-[300px] flex-[3] border-b border-ink-700 bg-ink-900">
            {instrument && <PriceChart symbol={instrument.symbol} digits={instrument.digits} tick={feed.ticks[instrument.symbol]} accountId={activeId || undefined} />}
          </div>
          <div className="min-h-[200px] flex-[2] bg-ink-900">
            <PositionsPanel
              positions={state?.positions ?? []}
              orders={state?.orders ?? []}
              onChange={notify}
              onError={(msg) => setToast({ msg, error: true })}
            />
          </div>
        </section>
        <aside className="border-l border-ink-700 bg-ink-900">
          <div className="border-b border-ink-700 p-2 lg:hidden">
            <select className="input" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {instruments.map((i) => (
                <option key={i.symbol}>{i.symbol}</option>
              ))}
            </select>
          </div>
          {instrument && activeId && (
            <OrderTicket
              accountId={activeId}
              leverage={state?.account.leverage ?? active?.leverage ?? 100}
              instrument={instrument}
              tick={feed.ticks[instrument.symbol]}
              disabled={disabled}
              onPlaced={notify}
            />
          )}
        </aside>
      </div>
      {toast && (
        <div
          className={`fixed bottom-4 right-4 z-50 rounded-md px-4 py-3 text-sm shadow-lg ${toast.error ? "bg-down text-white" : "bg-ink-700 text-white"}`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}
