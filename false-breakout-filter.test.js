"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { detectFalseBreakout } = require("./server/ai-trader-engine");

function candlesWithLatest(latest) {
  const bars = [];
  for (let i = 0; i < 25; i++) {
    bars.push({ open: 95, high: 100, low: 90, close: 95, time: i });
  }
  bars.push({ open: 99, high: 100, low: 90, close: 95, time: 25, ...latest });
  return bars;
}

test("rejects BUY after resistance is swept and candle closes back below", () => {
  const result = detectFalseBreakout(candlesWithLatest({ high: 102, close: 99 }), "BUY", 2, 24);
  assert.equal(result.detected, true);
  assert.equal(result.reason, "RESISTANCE_SWEEP_CLOSED_BACK_INSIDE");
  assert.equal(result.sweptLevel, 100);
});

test("rejects SELL after support is swept and candle closes back above", () => {
  const result = detectFalseBreakout(candlesWithLatest({ low: 88, close: 91 }), "SELL", 2, 24);
  assert.equal(result.detected, true);
  assert.equal(result.reason, "SUPPORT_SWEEP_CLOSED_BACK_INSIDE");
  assert.equal(result.sweptLevel, 90);
});

test("does not reject a breakout that closes beyond the level", () => {
  const result = detectFalseBreakout(candlesWithLatest({ high: 102, close: 101 }), "BUY", 2, 24);
  assert.equal(result.detected, false);
});

test("does not apply a directional false-breakout decision to WAIT", () => {
  const result = detectFalseBreakout(candlesWithLatest({ high: 102, low: 88, close: 95 }), "WAIT", 2, 24);
  assert.equal(result.detected, false);
});
