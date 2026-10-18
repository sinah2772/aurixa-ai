"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { detectFalseBreakout, detectBreakoutRetest } = require("./server/ai-trader-engine");

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


function candlesWithBreakout(afterBars) {
  const bars = [];
  for (let i = 0; i < 30; i++) bars.push({ open: 95, high: 100, low: 90, close: 95, time: i });
  bars.push({ open: 99, high: 103, low: 95, close: 102, time: 30 });
  afterBars.forEach((bar, i) => bars.push({ open: 102, high: 104, low: 101, close: 103, time: 31 + i, ...bar }));
  return bars;
}

test("confirms BUY only after a retest holds above broken resistance", () => {
  const result = detectBreakoutRetest(candlesWithBreakout([
    { low: 99.8, high: 104, close: 101 },
    { low: 100.5, high: 103, close: 102 },
    { low: 101, high: 104, close: 103 }
  ]), "BUY", 2, 24, 3);
  assert.equal(result.required, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.blocked, false);
  assert.equal(result.reason, "BREAKOUT_RETEST_HELD");
});

test("blocks BUY while a recent breakout has not retested", () => {
  const result = detectBreakoutRetest(candlesWithBreakout([
    { low: 101.2, high: 104, close: 103 },
    { low: 101.5, high: 105, close: 104 },
    { low: 102, high: 106, close: 105 }
  ]), "BUY", 2, 24, 3);
  assert.equal(result.required, true);
  assert.equal(result.confirmed, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "WAITING_FOR_BREAKOUT_RETEST");
});

test("blocks a BUY when the retest loses the broken level", () => {
  const result = detectBreakoutRetest(candlesWithBreakout([
    { low: 98, high: 102, close: 99 },
    { low: 97, high: 100, close: 98 },
    { low: 96, high: 99, close: 97 }
  ]), "BUY", 2, 24, 3);
  assert.equal(result.required, true);
  assert.equal(result.blocked, true);
});
