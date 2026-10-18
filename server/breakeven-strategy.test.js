"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateBreakeven } = require("./breakeven-strategy");

test("BUY triggers at 1R and offsets stop by observed spread", () => {
  const result = evaluateBreakeven({
    direction: "BUY", entryPrice: 100, currentPrice: 110, initialRisk: 10,
    triggerR: 1, bid: 109.9, ask: 110.1, existingStopLoss: 90
  });
  assert.equal(result.triggered, true);
  assert.equal(result.shouldMove, true);
  assert.ok(Math.abs(result.targetStopLoss - 100.2) < 1e-8);
  assert.ok(Math.abs(result.spreadAllowance - 0.2) < 1e-8);
});

test("SELL triggers at 1R and offsets stop below entry by observed spread", () => {
  const result = evaluateBreakeven({
    direction: "SELL", entryPrice: 100, currentPrice: 90, initialRisk: 10,
    triggerR: 1, bid: 89.9, ask: 90.1, existingStopLoss: 110
  });
  assert.equal(result.triggered, true);
  assert.equal(result.shouldMove, true);
  assert.ok(Math.abs(result.targetStopLoss - 99.8) < 1e-8);
});

test("does not trigger before the configured R threshold", () => {
  const result = evaluateBreakeven({
    direction: "BUY", entryPrice: 100, currentPrice: 109.9, initialRisk: 10,
    triggerR: 1, bid: 109.8, ask: 110, existingStopLoss: 90
  });
  assert.equal(result.triggered, false);
  assert.equal(result.reason, "PROFIT_BELOW_BREAKEVEN_TRIGGER");
});

test("does not loosen a stop that already protects more than breakeven", () => {
  const result = evaluateBreakeven({
    direction: "BUY", entryPrice: 100, currentPrice: 112, initialRisk: 10,
    triggerR: 1, bid: 111.9, ask: 112.1, existingStopLoss: 103
  });
  assert.equal(result.alreadyProtected, true);
  assert.equal(result.shouldMove, false);
});

test("moves an entry stop forward by spread when trigger is reached", () => {
  const result = evaluateBreakeven({
    direction: "BUY", entryPrice: 100, currentPrice: 112, initialRisk: 10,
    triggerR: 1, bid: 111.9, ask: 112.1, existingStopLoss: 100
  });
  assert.equal(result.shouldMove, true);
  assert.ok(Math.abs(result.targetStopLoss - 100.2) < 1e-8);
});

test("fails closed for invalid direction or missing initial risk", () => {
  assert.equal(evaluateBreakeven({direction:"LONG",entryPrice:100,currentPrice:120,initialRisk:10}).valid, false);
  assert.equal(evaluateBreakeven({direction:"BUY",entryPrice:100,currentPrice:120}).reason, "BREAKEVEN_INPUT_UNAVAILABLE");
});
