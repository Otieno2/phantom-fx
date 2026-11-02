"use client";

import { createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import type { Tick } from "@/lib/client/usePrices";

const TFS = [
  { key: "1m", seconds: 60 },
  { key: "5m", seconds: 300 },
  { key: "15m", seconds: 900 },
  { key: "1h", seconds: 3600 },
  { key: "1d", seconds: 86400 },
];

interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export function PriceChart({
  symbol,
  digits,
  tick,
  accountId,
}: {
  symbol: string;
  digits: number;
  tick?: Tick;
  accountId?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lastBar = useRef<Bar | null>(null);
  const [tf, setTf] = useState("1m");
  const [loadedKey, setLoadedKey] = useState("");
  const loading = loadedKey !== `${symbol}:${tf}`;

  useEffect(() => {
    if (!container.current) return;
    const c = createChart(container.current, {
      autoSize: true,
      layout: { background: { color: "#0d1320" }, textColor: "#94a3b8" },
      grid: { vertLines: { color: "#131b2c" }, horzLines: { color: "#131b2c" } },
      rightPriceScale: { borderColor: "#1c2639" },
      timeScale: { borderColor: "#1c2639", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    series.current = c.addCandlestickSeries({
      upColor: "#16b979",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#16b979",
      wickDownColor: "#ef4444",
    });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  useEffect(() => {
    series.current?.applyOptions({ priceFormat: { type: "price", precision: digits, minMove: 1 / 10 ** digits } });
  }, [digits]);

  useEffect(() => {
    let cancelled = false;
    const key = `${symbol}:${tf}`;
    const account = accountId ? `&account=${encodeURIComponent(accountId)}` : "";
    fetch(`/api/candles?symbol=${symbol}&tf=${tf}${account}`)
      .then((r) => r.json())
      .then((d: { candles: Bar[] }) => {
        if (cancelled || !series.current) return;
        series.current.setData(d.candles.map((b) => ({ ...b, time: b.time as UTCTimestamp })));
        lastBar.current = d.candles[d.candles.length - 1] ?? null;
        chart.current?.timeScale().scrollToRealTime();
        setLoadedKey(key);
      })
      .catch(() => setLoadedKey(key));
    return () => {
      cancelled = true;
    };
  }, [symbol, tf, accountId]);

  useEffect(() => {
    if (!tick || !series.current || loading) return;
    const seconds = TFS.find((t) => t.key === tf)!.seconds;
    const t = Math.floor(Date.now() / 1000 / seconds) * seconds;
    const prev = lastBar.current;
    const px = tick.mid;
    let bar: Bar;
    if (prev && prev.time === t) bar = { ...prev, high: Math.max(prev.high, px), low: Math.min(prev.low, px), close: px };
    else if (prev && prev.time > t) return;
    else bar = { time: t, open: prev?.close ?? px, high: px, low: px, close: px };
    lastBar.current = bar;
    series.current.update({ ...bar, time: bar.time as UTCTimestamp });
  }, [tick, tf, loading]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-ink-700 px-3 py-1.5">
        <span className="mr-3 text-sm font-semibold text-white">{symbol}</span>
        {TFS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTf(t.key)}
            className={`rounded px-2 py-0.5 text-xs ${tf === t.key ? "bg-ink-700 text-white" : "text-slate-400 hover:text-white"}`}
          >
            {t.key}
          </button>
        ))}
        {loading && <span className="ml-auto text-xs text-slate-500">Loading…</span>}
      </div>
      <div ref={container} className="min-h-0 flex-1" />
    </div>
  );
}
