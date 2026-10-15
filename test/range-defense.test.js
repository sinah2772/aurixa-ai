"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeRangeDefense } = require("../server/range-defense");

function rangeCandles(count = 20) {
  return Array.from({ length: count }, (_, i) => ({
    time: i + 1,
    open: 104,
    high: 110,
    low: 100,
    close: i % 2 ? 104.5 : 103.5
  }));
}

test("insufficient candles are reported as unavailable, not as a trade signal", () => {
  const result = analyzeRangeDefense(rangeCandles(4));
  assert.equal(result.available, false);
  assert.equal(result.analysisOnly, true);
  assert.equal(result.state, "INSUFFICIENT_CANDLES");
});

test("detects bullish rejection near prior range support", () => {
  const candles = rangeCandles();
  candles.push({ time: 21, open: 101, high: 102, low: 99.8, close: 101.2 });
  const result = analyzeRangeDefense(candles, { lookback: 20, atr: 1 });
  assert.equal(result.available, true);
  assert.equal(result.bullishRejection, true);
  assert.equal(result.state, "BULLISH_SUPPORT_REJECTION");
  assert.equal(result.support, 100);
  assert.equal(result.analysisOnly, true);
});

test("detects a failed upside breakout when price closes back below resistance", () => {
  const candles = rangeCandles();
  candles.push({ time: 21, open: 109.5, high: 111, low: 108.5, close: 109 });
  const result = analyzeRangeDefense(candles, { lookback: 20, atr: 1 });
  assert.equal(result.failedBreakoutUp, true);
  assert.equal(result.state, "FAILED_BREAKOUT_UP");
});

test("labels a close beyond resistance as breakout not yet confirmed by retest", () => {
  const candles = rangeCandles();
  candles.push({ time: 21, open: 109.5, high: 112, low: 109, close: 111 });
  const result = analyzeRangeDefense(candles, { lookback: 20, atr: 1 });
  assert.equal(result.confirmedBreakoutUp, true);
  assert.equal(result.state, "BREAKOUT_UP_UNCONFIRMED");
});

test("range diagnostics never claim execution approval", () => {
  const candles = rangeCandles();
  candles.push({ time: 21, open: 104, high: 105, low: 103, close: 104.5 });
  const result = analyzeRangeDefense(candles, { lookback: 20, atr: 1 });
  assert.equal(result.analysisOnly, true);
  assert.equal(Object.hasOwn(result, "executionEligible"), false);
  assert.equal(Object.hasOwn(result, "signal"), false);
});
