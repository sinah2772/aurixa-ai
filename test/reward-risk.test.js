"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluatePlannedRewardRisk, normalizeTargetPrice } = require("../server/reward-risk");

test("accepts a planned 2R target short by exactly one BTCUSD tick and flags rounding", () => {
  const result = evaluatePlannedRewardRisk({
    signal: "SELL", entry: 80993.14, stop: 81643.94, target: 79691.55, digits: 2
  });
  assert.equal(result.allowed, true);
  assert.equal(result.roundedToTickOnly, true);
  assert.ok(Math.abs(result.signalRewardShortfall - 0.01) < 1e-8);
});

test("rejects a target that is more than one price tick below 2R", () => {
  const result = evaluatePlannedRewardRisk({
    signal: "SELL", entry: 80993.14, stop: 81643.94, target: 79691.57, digits: 2
  });
  assert.equal(result.allowed, false);
  assert.equal(result.roundedToTickOnly, false);
});

test("accepts an exact 2R plan without using rounding tolerance", () => {
  const result = evaluatePlannedRewardRisk({
    signal: "SELL", entry: 80993.14, stop: 81643.94, target: 79691.54, digits: 2
  });
  assert.equal(result.allowed, true);
  assert.equal(result.roundedToTickOnly, false);
});

test("rounds normalized take-profit away from entry to preserve at least 2R", () => {
  const sellEntry = 80993.13;
  const stop = 81643.94;
  const sellTarget = normalizeTargetPrice({ signal: "SELL", entry: sellEntry, stop, digits: 2 });
  assert.ok(sellTarget <= sellEntry - Math.abs(sellEntry - stop) * 2 + 1e-9);
  assert.equal(Number.isFinite(sellTarget), true);

  const buyEntry = 100.01;
  const buyStop = 99.34;
  const buyTarget = normalizeTargetPrice({ signal: "BUY", entry: buyEntry, stop: buyStop, digits: 2 });
  assert.ok(buyTarget >= buyEntry + Math.abs(buyEntry - buyStop) * 2 - 1e-9);
  assert.equal(Number.isFinite(buyTarget), true);
});

const { decide } = require("../server/ai-trader-engine");

test("AI strategy rounds directional take-profit outward to preserve minimum 2R", () => {
  const candles = [];
  for (let i = 0; i < 100; i++) {
    const open = 2000 + i * 0.18 + Math.sin((i - 1) * 0.7) * 0.2;
    const close = 2000 + i * 0.18 + Math.sin(i * 0.7) * 0.2;
    candles.push({
      time: new Date(Date.now() - (99 - i) * 5 * 60_000).toISOString(),
      open,
      high: Math.max(open, close) + 0.3,
      low: Math.min(open, close) - 0.3,
      close,
      volume: 100 + (i % 9) * 10
    });
  }

  const last = candles.at(-1).close;
  const decision = decide(candles, {
    symbolName: "XAUUSD",
    symbolDigits: 2,
    bid: last - 0.1,
    ask: last + 0.1,
    lastUpdate: new Date().toISOString(),
    connected: true,
    authorized: true,
    account: { isLive: false }
  });

  assert.ok(["BUY", "SELL"].includes(decision.signalConfirmation?.mainSignal), "test market should produce a directional main-strategy bias");
  const risk = Math.abs(decision.entry - decision.stopLoss);
  const reward = Math.abs(decision.takeProfit - decision.entry);
  assert.ok(risk > 0, "stop distance must be positive");
  assert.ok(reward + 1e-9 >= risk * 2, `expected at least 2R, got reward=${reward}, risk=${risk}`);
});
