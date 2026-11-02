import type { Side } from "./math";

export type DemoOutcome = "WIN" | "LOSS";

export function demoWinRateFromEnv(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.DEMO_WIN_RATE;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

/** Stable 0..1 from an id so restarting the server does not flip a trade's outcome. */
export function stableUnit(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0x100000000;
}

export function outcomeForPosition(id: string, winRate: number): DemoOutcome {
  return stableUnit(id) < winRate ? "WIN" : "LOSS";
}

export interface DemoSteerSpec {
  side: Side;
  openPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  pipSize: number;
  spreadPips: number;
}

/** Mid price that makes bid/ask print through the intended SL or TP. */
export function targetMidForDemo(spec: DemoSteerSpec, outcome: DemoOutcome): number {
  const half = (spec.spreadPips * spec.pipSize) / 2;
  const cushion = spec.pipSize * 0.4;
  const synthetic = spec.pipSize * 18;

  if (outcome === "WIN") {
    if (spec.takeProfit != null) {
      return spec.side === "BUY" ? spec.takeProfit + half + cushion : spec.takeProfit - half - cushion;
    }
    return spec.side === "BUY" ? spec.openPrice + synthetic : spec.openPrice - synthetic;
  }

  if (spec.stopLoss != null) {
    return spec.side === "BUY" ? spec.stopLoss + half - cushion : spec.stopLoss - half + cushion;
  }
  return spec.side === "BUY" ? spec.openPrice - synthetic : spec.openPrice + synthetic;
}

/**
 * Walk toward a target with occasional retracements so the path looks like a
 * tape, not a line.
 *
 * Inside `RELEASE` of the target the price is left exactly where the random
 * step put it. Snapping to the target instead would, one tick later, overwrite
 * the new step with the same number and the symbol would flat-line for as long
 * as the position is open: a chart that stops moving, a P/L that never changes,
 * and a take-profit that only fires because the pin happens to sit past it.
 * Steering is a pull, not a clamp.
 */
const RELEASE = 0.2;

export function stepTowardTarget(mid: number, target: number, pipSize: number, rand = Math.random): number {
  const gap = target - mid;
  if (Math.abs(gap) < pipSize * RELEASE) return mid;
  const against = rand() < 0.25;
  // Reduced step size from 0.12-0.82 to 0.08-0.45 for gentler movement
  const pips = (0.08 + rand() * 0.37) * (against ? -0.4 : 1);
  const next = mid + Math.sign(gap) * pips * pipSize;
  if (Math.sign(target - next) !== Math.sign(gap)) return target;
  return next;
}
