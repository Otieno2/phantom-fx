import { describe, expect, it } from "vitest";
import {
  demoWinRateFromEnv,
  outcomeForPosition,
  stepTowardTarget,
  targetMidForDemo,
} from "./demoOutcome";

describe("demoWinRateFromEnv", () => {
  const env = (values: Record<string, string>): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...values });

  it("reads 60% and ignores an empty value", () => {
    expect(demoWinRateFromEnv(env({ DEMO_WIN_RATE: "0.6" }))).toBe(0.6);
    expect(demoWinRateFromEnv(env({}))).toBeNull();
    expect(demoWinRateFromEnv(env({ DEMO_WIN_RATE: "" }))).toBeNull();
  });
});

describe("outcomeForPosition", () => {
  it("is stable for the same id and near the requested rate across many ids", () => {
    expect(outcomeForPosition("pos-a", 0.6)).toBe(outcomeForPosition("pos-a", 0.6));
    let wins = 0;
    for (let i = 0; i < 4000; i++) {
      if (outcomeForPosition(`id-${i}`, 0.6) === "WIN") wins += 1;
    }
    const rate = wins / 4000;
    expect(rate).toBeGreaterThan(0.55);
    expect(rate).toBeLessThan(0.65);
  });
});

describe("targetMidForDemo", () => {
  const buy = {
    side: "BUY" as const,
    openPrice: 1.1,
    stopLoss: 1.098,
    takeProfit: 1.104,
    pipSize: 0.0001,
    spreadPips: 2,
  };

  it("aims through take-profit on a winning BUY and through stop-loss on a loser", () => {
    const win = targetMidForDemo(buy, "WIN");
    const loss = targetMidForDemo(buy, "LOSS");
    expect(win).toBeGreaterThan(buy.takeProfit);
    expect(loss).toBeLessThan(buy.stopLoss! + 0.0002);
  });

  it("uses a synthetic 18-pip move when stops are missing", () => {
    const spec = { ...buy, stopLoss: null, takeProfit: null };
    expect(targetMidForDemo(spec, "WIN")).toBeCloseTo(1.1 + 0.0018);
    expect(targetMidForDemo(spec, "LOSS")).toBeCloseTo(1.1 - 0.0018);
  });
});

describe("stepTowardTarget", () => {
  it("closes the gap over many steps", () => {
    let mid = 1.1;
    const target = 1.103;
    for (let i = 0; i < 400; i++) mid = stepTowardTarget(mid, target, 0.0001, () => 0.5);
    expect(Math.abs(mid - target)).toBeLessThan(0.0003);
  });
});
