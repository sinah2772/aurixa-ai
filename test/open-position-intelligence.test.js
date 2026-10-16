"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluatePosition } = require("../server/open-position-intelligence");

const base = {
  positionId: "123", symbol: "XAUUSD", direction: "BUY",
  entry: 100, current: 99, pnl: -10, stopLoss: 98, takeProfit: 104,
  initialRisk: 2, quoteFresh: true, tracked: true, partialTaken: false,
  demoAccount: true,
  mainDecision: { signal: "SELL", confidence: 82, trend: "BEARISH", executionEligible: true,
    signalConfirmation: { confirmed: true, status: "CONFIRMED" } }
};

test("holds rather than taking action on stale quotes", () => {
  const d = evaluatePosition({ ...base, quoteFresh: false });
  assert.equal(d.action, "HOLD");
  assert.match(d.reason, /STALE|INCOMPLETE/i);
});

test("requests protection when broker stop loss is missing", () => {
  const d = evaluatePosition({ ...base, stopLoss: null });
  assert.equal(d.action, "PROTECT");
  assert.ok(d.protectionIssues.includes("STOP_LOSS_MISSING"));
});

test("reduces only a tracked demo position after a confirmed 0.5R loss", () => {
  const d = evaluatePosition({ ...base, current: 98.9, initialRisk: 2 });
  assert.equal(d.action, "REDUCE");
  assert.equal(d.of1Confirmed, true);
});

test("does not reduce an untracked/manual position", () => {
  const d = evaluatePosition({ ...base, tracked: false });
  assert.equal(d.action, "HOLD");
});

test("does not reduce when OF1 has not confirmed the opposite signal", () => {
  const d = evaluatePosition({ ...base, current: 98.9,
    mainDecision: { ...base.mainDecision, signalConfirmation: { confirmed: false } } });
  assert.equal(d.action, "HOLD");
});

test("never automates actions unless demo account is verified", () => {
  const d = evaluatePosition({ ...base, demoAccount: false, stopLoss: null });
  assert.equal(d.action, "HOLD");
  assert.match(d.reason, /DEMO_ACCOUNT_NOT_VERIFIED/);
});

test("holds when the opposite signal is not execution eligible", () => {
  const d = evaluatePosition({ ...base, current: 98.9,
    mainDecision: { ...base.mainDecision, executionEligible: false } });
  assert.equal(d.action, "HOLD");
});
