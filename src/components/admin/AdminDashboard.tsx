"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { dateTime, digitsFor, pnlClass, price, signedUsd, usd } from "@/lib/client/format";

type Tab = "overview" | "transactions" | "users" | "positions" | "instruments" | "audit";

interface FeedStatus {
  role: string;
  purpose: string;
  mode: string;
  provider: string;
  state: string;
  started: boolean;
  lastMarkAt: number;
  failures: number;
  stale: boolean;
  /** Marks are old: held positions are still managed, new orders are refused. */
  degraded: boolean;
  /** Nothing executes. */
  paused: boolean;
  simulatedMarks: boolean;
  reason: string;
  steerable: boolean;
  winRate: number | null;
  trackedDemoPositions: number;
  symbols: number;
}

/** Degraded and paused read differently: one still protects open trades. */
function feedTone(f: FeedStatus): string {
  if (f.paused) return "text-down";
  if (f.degraded || f.simulatedMarks) return "text-yellow-400";
  if (f.state === "running") return "text-up";
  return "text-slate-400";
}

function feedLabel(f: FeedStatus): string {
  const flags = [
    f.state !== "running" ? (f.reason ? `${f.state}: ${f.reason}` : f.state) : "",
    f.degraded ? "stale marks — management only" : "",
    f.simulatedMarks ? "SIMULATED live prices" : "",
    f.steerable ? `win-rate steered (${Math.round((f.winRate ?? 0) * 100)}%)` : "",
  ].filter(Boolean);
  return `${f.mode}${flags.length ? ` · ${flags.join(" · ")}` : ""}`;
}

interface Overview {
  users: number;
  newUsers: number;
  liveBalances: number;
  pendingDeposits: number;
  pendingWithdrawals: number;
  totalDeposits: number;
  totalWithdrawals: number;
  openLivePositions: number;
  clientFloatingPnl: number;
  brokerPnl24h: number;
  trades24h: number;
  feeds: FeedStatus[];
  feedWarnings: string[];
}

function useToast() {
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  const node = toast && (
    <div className={`fixed bottom-4 right-4 z-50 rounded-md px-4 py-3 text-sm shadow-lg ${toast.error ? "bg-down" : "bg-ink-700"} text-white`}>
      {toast.msg}
    </div>
  );
  return { node, ok: (msg: string) => setToast({ msg }), fail: (e: unknown) => setToast({ msg: (e as Error).message, error: true }) };
}

export function AdminDashboard() {
  const [tab, setTab] = useState<Tab>("overview");
  const toast = useToast();
  const tabs: [Tab, string][] = [
    ["overview", "Overview"],
    ["transactions", "Deposits & withdrawals"],
    ["users", "Clients"],
    ["positions", "Positions & exposure"],
    ["instruments", "Instruments"],
    ["audit", "Audit log"],
  ];
  return (
    <div className="mx-auto max-w-7xl space-y-5 p-6">
      <h1 className="text-xl font-semibold text-white">Back office</h1>
      <div className="flex flex-wrap border-b border-ink-700">
        {tabs.map(([k, label]) => (
          <button key={k} className={`tab ${tab === k ? "tab-active" : ""}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === "overview" && <OverviewTab />}
      {tab === "transactions" && <TransactionsTab toast={toast} />}
      {tab === "users" && <UsersTab toast={toast} />}
      {tab === "positions" && <PositionsTab toast={toast} />}
      {tab === "instruments" && <InstrumentsTab toast={toast} />}
      {tab === "audit" && <AuditTab />}
      {toast.node}
    </div>
  );
}

type Toast = ReturnType<typeof useToast>;

function Stat({ label, value, cls = "text-white" }: { label: string; value: React.ReactNode; cls?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 font-mono text-xl ${cls}`}>{value}</div>
    </div>
  );
}

function OverviewTab() {
  const [o, setO] = useState<Overview | null>(null);
  useEffect(() => {
    const load = () => api<Overview>("/api/admin/overview").then(setO).catch(() => undefined);
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  if (!o) return <p className="text-slate-500">Loading…</p>;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Clients" value={`${o.users} (+${o.newUsers} today)`} />
        <Stat label="Live client balances" value={usd(o.liveBalances)} />
        <Stat label="Total deposits" value={usd(o.totalDeposits)} />
        <Stat label="Total withdrawals" value={usd(o.totalWithdrawals)} />
        <Stat label="Pending deposits" value={o.pendingDeposits} cls={o.pendingDeposits ? "text-yellow-400" : "text-white"} />
        <Stat label="Pending withdrawals" value={o.pendingWithdrawals} cls={o.pendingWithdrawals ? "text-yellow-400" : "text-white"} />
        <Stat label="Open live positions" value={o.openLivePositions} />
        <Stat label="Client floating P/L" value={signedUsd(o.clientFloatingPnl)} cls={pnlClass(o.clientFloatingPnl)} />
        <Stat label="Broker P/L (24h)" value={signedUsd(o.brokerPnl24h)} cls={pnlClass(o.brokerPnl24h)} />
        <Stat label="Live trades closed (24h)" value={o.trades24h} />
        {o.feeds.map((f) => (
          <Stat
            key={f.role}
            label={`${f.purpose} accounts · ${f.role} feed`}
            value={feedLabel(f)}
            cls={feedTone(f)}
          />
        ))}
      </div>
      {o.feedWarnings?.length > 0 && (
        <div className="card space-y-1 p-4">
          <div className="text-xs uppercase tracking-wide text-yellow-400">Feed configuration warnings</div>
          {o.feedWarnings.map((w) => (
            <p key={w} className="font-mono text-xs text-slate-300">{w}</p>
          ))}
        </div>
      )}
    </div>
  );
}

interface AdminTx {
  id: string;
  type: string;
  amount: number;
  status: string;
  method: string | null;
  reference: string | null;
  note: string | null;
  createdAt: string;
  account: { login: number; user: { name: string; email: string; phone: string | null } };
}

function TransactionsTab({ toast }: { toast: Toast }) {
  const [status, setStatus] = useState("PENDING");
  const [rows, setRows] = useState<AdminTx[]>([]);
  const load = useCallback(() => api<{ transactions: AdminTx[] }>(`/api/admin/transactions?status=${status}`).then((d) => setRows(d.transactions)), [status]);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (id: string, action: "approve" | "reject") => {
    const note = action === "reject" ? prompt("Reason for rejection (shown to client):") ?? undefined : undefined;
    try {
      await api(`/api/admin/transactions/${id}`, { body: { action, note } });
      toast.ok(`Transaction ${action}d`);
      await load();
    } catch (e) {
      toast.fail(e);
    }
  };
  return (
    <div className="card overflow-hidden">
      <div className="flex gap-2 border-b border-ink-700 p-3">
        {["PENDING", "COMPLETED", "REJECTED", "ALL"].map((s) => (
          <button key={s} onClick={() => setStatus(s)} className={`rounded px-3 py-1 text-xs ${status === s ? "bg-ink-700 text-white" : "text-slate-400"}`}>{s}</button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="table">
          <thead><tr><th>Date</th><th>Client</th><th>Account</th><th>Type</th><th>Method</th><th>Reference</th><th>Status</th><th className="text-right">Amount</th><th /></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={9} className="py-6 text-center text-slate-500">Nothing here</td></tr>}
            {rows.map((t) => (
              <tr key={t.id}>
                <td className="text-xs text-slate-400">{dateTime(t.createdAt)}</td>
                <td><div className="text-white">{t.account.user.name}</div><div className="text-xs text-slate-500">{t.account.user.email} {t.account.user.phone ?? ""}</div></td>
                <td className="font-mono">#{t.account.login}</td>
                <td>{t.type}</td>
                <td>{t.method ?? "—"}</td>
                <td className="max-w-[200px] truncate text-xs" title={t.reference ?? t.note ?? ""}>{t.reference ?? t.note ?? "—"}</td>
                <td className="text-xs">{t.status}</td>
                <td className={`text-right font-mono ${t.amount >= 0 ? "text-up" : "text-down"}`}>{usd(t.amount)}</td>
                <td className="space-x-2 text-right">
                  {t.status === "PENDING" && (
                    <>
                      <button className="rounded bg-up px-2 py-1 text-xs text-white" onClick={() => act(t.id, "approve")}>Approve</button>
                      <button className="rounded bg-down px-2 py-1 text-xs text-white" onClick={() => act(t.id, "reject")}>Reject</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface AdminUser {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  country: string | null;
  role: string;
  status: string;
  createdAt: string;
  accounts: { id: string; login: number; type: string; balance: number; leverage: number }[];
}

function UsersTab({ toast }: { toast: Toast }) {
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const load = useCallback(() => api<{ users: AdminUser[] }>(`/api/admin/users?q=${encodeURIComponent(q)}`).then((d) => setUsers(d.users)), [q]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);
  const update = async (id: string, body: Record<string, string>) => {
    try {
      await api(`/api/admin/users/${id}`, { method: "PATCH", body });
      toast.ok("Client updated");
      await load();
    } catch (e) {
      toast.fail(e);
    }
  };
  const adjust = async (accountId: string) => {
    const amount = Number(prompt("Adjustment amount in USD (negative to debit):"));
    if (!amount) return;
    const note = prompt("Reason (required):");
    if (!note) return;
    try {
      await api(`/api/admin/accounts/${accountId}/adjust`, { body: { amount, note } });
      toast.ok("Balance adjusted");
      await load();
    } catch (e) {
      toast.fail(e);
    }
  };
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-ink-700 p-3">
        <input className="input max-w-sm" placeholder="Search name, email or phone" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="overflow-x-auto">
        <table className="table">
          <thead><tr><th>Client</th><th>Phone / country</th><th>Joined</th><th>Accounts</th><th>Role</th><th>Status</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td><div className="text-white">{u.name}</div><div className="text-xs text-slate-500">{u.email}</div></td>
                <td className="text-xs">{u.phone ?? "—"}<br />{u.country ?? ""}</td>
                <td className="text-xs text-slate-400">{dateTime(u.createdAt)}</td>
                <td className="space-y-1">
                  {u.accounts.map((a) => (
                    <div key={a.id} className="flex items-center gap-2 text-xs">
                      <span className={`badge ${a.type === "LIVE" ? "bg-up/15 text-up" : "bg-brand-500/15 text-brand-400"}`}>{a.type}</span>
                      <span className="font-mono">#{a.login}</span>
                      <span className="font-mono">{usd(a.balance)}</span>
                      <span className="text-slate-500">1:{a.leverage}</span>
                      <button className="text-brand-400 hover:underline" onClick={() => adjust(a.id)}>adjust</button>
                    </div>
                  ))}
                </td>
                <td className="text-xs">{u.role}</td>
                <td><span className={`badge ${u.status === "ACTIVE" ? "bg-up/15 text-up" : "bg-down/15 text-down"}`}>{u.status}</span></td>
                <td className="text-right">
                  <button
                    className="text-xs text-slate-400 hover:text-white"
                    onClick={() => update(u.id, { status: u.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE" })}
                  >
                    {u.status === "ACTIVE" ? "Suspend" : "Reactivate"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface AdminPosition {
  id: string;
  symbol: string;
  side: string;
  volume: number;
  openPrice: number;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  profit: number;
  openedAt: string;
  account: { login: number; user: { name: string; email: string } };
}

function PositionsTab({ toast }: { toast: Toast }) {
  const [type, setType] = useState("LIVE");
  const [data, setData] = useState<{ positions: AdminPosition[]; exposure: { symbol: string; netLots: number; buyLots: number; sellLots: number; clientPnl: number }[] } | null>(null);
  const load = useCallback(() => api<typeof data>(`/api/admin/positions?type=${type}`).then(setData).catch(() => undefined), [type]);
  useEffect(() => {
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);
  const close = async (id: string) => {
    if (!confirm("Force-close this client position at market?")) return;
    try {
      await api(`/api/admin/positions/${id}/close`, { method: "POST" });
      toast.ok("Position closed");
      await load();
    } catch (e) {
      toast.fail(e);
    }
  };
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {["LIVE", "DEMO"].map((t) => (
          <button key={t} onClick={() => setType(t)} className={`rounded px-3 py-1 text-xs ${type === t ? "bg-ink-700 text-white" : "text-slate-400"}`}>{t} accounts</button>
        ))}
      </div>
      <div className="card overflow-hidden">
        <div className="border-b border-ink-700 px-4 py-3 text-sm font-semibold text-white">Net exposure (house is counterparty)</div>
        <table className="table">
          <thead><tr><th>Symbol</th><th>Client buy lots</th><th>Client sell lots</th><th>Client net</th><th className="text-right">Client P/L</th><th className="text-right">House P/L</th></tr></thead>
          <tbody>
            {data?.exposure.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-slate-500">No open exposure</td></tr>}
            {data?.exposure.map((e) => (
              <tr key={e.symbol}>
                <td className="font-semibold text-white">{e.symbol}</td>
                <td className="font-mono">{e.buyLots.toFixed(2)}</td>
                <td className="font-mono">{e.sellLots.toFixed(2)}</td>
                <td className={`font-mono ${e.netLots >= 0 ? "text-up" : "text-down"}`}>{e.netLots.toFixed(2)}</td>
                <td className={`text-right font-mono ${pnlClass(e.clientPnl)}`}>{signedUsd(e.clientPnl)}</td>
                <td className={`text-right font-mono ${pnlClass(-e.clientPnl)}`}>{signedUsd(-e.clientPnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Client</th><th>Account</th><th>Symbol</th><th>Side</th><th>Lots</th><th>Open</th><th>Current</th><th>S/L</th><th>T/P</th><th>Opened</th><th className="text-right">Profit</th><th /></tr></thead>
          <tbody>
            {data?.positions.map((p) => (
              <tr key={p.id}>
                <td><div className="text-white">{p.account.user.name}</div><div className="text-xs text-slate-500">{p.account.user.email}</div></td>
                <td className="font-mono">#{p.account.login}</td>
                <td className="font-semibold text-white">{p.symbol}</td>
                <td className={p.side === "BUY" ? "text-up" : "text-down"}>{p.side}</td>
                <td className="font-mono">{p.volume.toFixed(2)}</td>
                <td className="font-mono">{price(p.openPrice, digitsFor(p.symbol))}</td>
                <td className="font-mono">{price(p.currentPrice, digitsFor(p.symbol))}</td>
                <td className="font-mono">{price(p.stopLoss, digitsFor(p.symbol))}</td>
                <td className="font-mono">{price(p.takeProfit, digitsFor(p.symbol))}</td>
                <td className="text-xs text-slate-400">{dateTime(p.openedAt)}</td>
                <td className={`text-right font-mono ${pnlClass(p.profit)}`}>{signedUsd(p.profit)}</td>
                <td className="text-right"><button className="rounded bg-ink-700 px-2 py-1 text-xs text-white" onClick={() => close(p.id)}>Close</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface InstrumentRow {
  symbol: string;
  description: string;
  spreadPips: number;
  commissionPerLot: number;
  minLot: number;
  maxLot: number;
  enabled: boolean;
}

function InstrumentsTab({ toast }: { toast: Toast }) {
  const [rows, setRows] = useState<InstrumentRow[]>([]);
  const load = useCallback(() => api<{ instruments: InstrumentRow[] }>("/api/admin/instruments").then((d) => setRows(d.instruments)), []);
  useEffect(() => {
    void load();
  }, [load]);
  const save = async (r: InstrumentRow) => {
    try {
      await api("/api/admin/instruments", {
        method: "PATCH",
        body: { symbol: r.symbol, spreadPips: r.spreadPips, commissionPerLot: r.commissionPerLot, minLot: r.minLot, maxLot: r.maxLot, enabled: r.enabled },
      });
      toast.ok(`${r.symbol} saved`);
      await load();
    } catch (e) {
      toast.fail(e);
    }
  };
  const edit = (symbol: string, patch: Partial<InstrumentRow>) => setRows((rs) => rs.map((r) => (r.symbol === symbol ? { ...r, ...patch } : r)));
  const numInput = (r: InstrumentRow, key: "spreadPips" | "commissionPerLot" | "minLot" | "maxLot") => (
    <input
      className="input w-24 px-2 py-1 font-mono text-xs"
      type="number"
      step="0.01"
      value={r[key]}
      onChange={(e) => edit(r.symbol, { [key]: Number(e.target.value) })}
    />
  );
  return (
    <div className="card overflow-x-auto">
      <table className="table">
        <thead><tr><th>Symbol</th><th>Description</th><th>Spread (pips)</th><th>Commission / lot</th><th>Min lot</th><th>Max lot</th><th>Enabled</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol}>
              <td className="font-semibold text-white">{r.symbol}</td>
              <td className="text-xs text-slate-400">{r.description}</td>
              <td>{numInput(r, "spreadPips")}</td>
              <td>{numInput(r, "commissionPerLot")}</td>
              <td>{numInput(r, "minLot")}</td>
              <td>{numInput(r, "maxLot")}</td>
              <td><input type="checkbox" checked={r.enabled} onChange={(e) => edit(r.symbol, { enabled: e.target.checked })} /></td>
              <td className="text-right"><button className="rounded bg-brand-500 px-3 py-1 text-xs text-white" onClick={() => save(r)}>Save</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AuditTab() {
  const [logs, setLogs] = useState<{ id: string; actor: string; action: string; entity: string | null; entityId: string | null; details: string | null; createdAt: string }[]>([]);
  useEffect(() => {
    api<{ logs: typeof logs }>("/api/admin/audit").then((d) => setLogs(d.logs));
  }, []);
  return (
    <div className="card overflow-x-auto">
      <table className="table">
        <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.id}>
              <td className="text-xs text-slate-400">{dateTime(l.createdAt)}</td>
              <td className="text-xs">{l.actor}</td>
              <td className="text-xs text-white">{l.action}</td>
              <td className="text-xs text-slate-400">{l.entity} {l.entityId?.slice(-8)}</td>
              <td className="max-w-md truncate font-mono text-xs text-slate-500" title={l.details ?? ""}>{l.details}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
