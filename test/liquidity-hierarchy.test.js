"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeLiquidity, conflictsWithSignal } = require("../server/liquidity-hierarchy");

function candlesWithSweep(kind = "low") {
  const bars = [];
  for (let i = 0; i < 40; i++) {
    bars.push({ time: i, open: 100.5, high: 102, low: 100, close: 101 });
  }
  if (kind === "low") bars.push({ time: 40, open: 100.1, high: 101.5, low: 98.8, close: 101.3 });
  else bars.push({ time: 40, open: 101.8, high: 103.2, low: 100.5, close: 100.6 });
  return bars;
}

test("detects a sell-side liquidity sweep with bullish displacement", () => {
  const result = analyzeLiquidity(candlesWithSweep("low"), { lookback: 24 });
  assert.equal(result.dataReady, true);
  assert.equal(result.sweep.detected, true);
  assert.equal(result.sweep.type, "SELL_SIDE_SWEEP");
  assert.equal(result.sweep.direction, "BUY");
  assert.equal(result.sweep.confirmed, true);
  assert.equal(conflictsWithSignal(result, "SELL"), true);
  assert.equal(conflictsWithSignal(result, "BUY"), false);
});

test("detects a buy-side liquidity sweep with bearish displacement", () => {
  const result = analyzeLiquidity(candlesWithSweep("high"), { lookback: 24 });
  assert.equal(result.sweep.type, "BUY_SIDE_SWEEP");
  assert.equal(result.sweep.direction, "SELL");
  assert.equal(result.sweep.confirmed, true);
  assert.equal(conflictsWithSignal(result, "BUY"), true);
});

test("does not treat an unconfirmed sweep as a directional conflict", () => {
  const bars = candlesWithSweep("low");
  bars[bars.length - 1] = { time: 40, open: 100.5, high: 101, low: 99, close: 100.6 };
  const result = analyzeLiquidity(bars, { lookback: 24 });
  assert.equal(result.sweep.detected, true);
  assert.equal(result.sweep.confirmed, false);
  assert.equal(conflictsWithSignal(result, "SELL"), false);
});

test("fails closed with insufficient candles", () => {
  const result = analyzeLiquidity(candlesWithSweep().slice(0, 10));
  assert.equal(result.dataReady, false);
  assert.equal(result.sweep.detected, false);
  assert.equal(conflictsWithSignal(result, "BUY"), false);
});
