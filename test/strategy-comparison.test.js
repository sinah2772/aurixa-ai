"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { compareStrategies, candidateSignal } = require("../server/strategy-comparison");

function sampleCandles(count = 180) {
  const out = [];
  let close = 2000;
  for (let i = 0; i < count; i++) {
    const wave = Math.sin(i / 4) * 0.8;
    const next = close + 0.12 + wave * 0.12;
    out.push({ time: 1_700_000_000_000 + i * 300_000, open: close, high: Math.max(close, next) + 0.6, low: Math.min(close, next) - 0.6, close: next });
    close = next;
  }
  return out;
}
const costs = { spreadPrice: 0.25, slippagePricePerSide: 0.05, commissionRPerTrade: 0.02 };

test("comparison requires explicit non-negative costs", () => {
  assert.throws(() => compareStrategies({ candles: sampleCandles(), costs: {} }), /Explicit non-negative costs/);
  assert.throws(() => compareStrategies({ candles: sampleCandles(), costs: { ...costs, spreadPrice: -1 } }), /Explicit non-negative costs/);
});

test("comparison replays both strategies on same chronological candles without live execution", () => {
  const result = compareStrategies({ symbol: "XAUUSD", candles: sampleCandles(), costs });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "offline_comparison_only");
  assert.equal(result.liveTradingChanged, false);
  assert.equal(result.candles, 180);
  assert.ok(result.results.v1);
  assert.ok(result.results.trendPullback);
  assert.ok(Number.isFinite(result.comparison.netRDelta));
  assert.equal(result.comparison.deploymentRecommendation, "DO_NOT_SWITCH_FROM_THIS_REPORT_ALONE");
  assert.ok(Array.isArray(result.trades.v1));
});

test("comparison rejects invalid, unordered, and short datasets", () => {
  assert.throws(() => compareStrategies({ candles: sampleCandles(99), costs }), /At least 100/);
  const invalid = sampleCandles();
  invalid[20].high = invalid[20].low - 1;
  assert.throws(() => compareStrategies({ candles: invalid, costs }), /valid and chronological/);
  const unordered = sampleCandles();
  unordered[50].time = unordered[49].time;
  assert.throws(() => compareStrategies({ candles: unordered, costs }), /valid and chronological/);
});

test("candidate emits no setup on insufficient candles", () => {
  assert.equal(candidateSignal(sampleCandles(40)), null);
});
