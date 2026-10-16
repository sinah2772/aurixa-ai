"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const of1 = require("../server/chris-creamer-orderflow");

test("OF1 fails closed when candle history is insufficient", () => {
  const result = of1.analyze([]);
  assert.equal(result.signal, "WAIT");
  assert.equal(result.dataReady, false);
  assert.equal(result.trueFootprint, false);
  assert.equal(result.gex, false);
});

test("OF1 never claims institutional footprint or GEX data from OHLC candles", () => {
  const candles = Array.from({ length: 20 }, (_, i) => ({
    time: 1_790_000_000_000 + i * 300_000,
    open: 2000 + i,
    high: 2002 + i,
    low: 1999 + i,
    close: 2001 + i,
    volume: 100 + i
  }));
  const result = of1.analyze(candles);
  assert.equal(result.signal, "WAIT");
  assert.equal(result.trueFootprint, false);
  assert.equal(result.gex, false);
});

test("OF1 confirmation reports the requested symbol instead of hardcoding XAUUSD", () => {
  const candles = Array.from({ length: 120 }, (_, i) => ({
    time: 1_790_000_000_000 + i * 300_000,
    open: 1.1 + i * 0.0001,
    high: 1.1002 + i * 0.0001,
    low: 1.0999 + i * 0.0001,
    close: 1.1001 + i * 0.0001,
    volume: 100 + i
  }));
  const result = of1.analyze(candles, { symbol: "EURUSD", timeframe: "M5" });
  assert.equal(result.symbol, "EURUSD");
  assert.equal(result.timeframe, "M5");
});

test("main strategy retains V1 and exposes OF1 confirmation for the same symbol", () => {
  const main = require("../server/ai-trader-engine");
  const now = Date.now();
  const candles = Array.from({ length: 120 }, (_, i) => {
    const base = 2300 + i * 0.08 + Math.sin(i / 3) * 1.7;
    return {
      time: now - (120 - i) * 300000,
      open: base - 0.25,
      high: base + 1.0,
      low: base - 1.0,
      close: base + 0.25,
      volume: 100 + (i % 11) * 7
    };
  });
  const decision = main.decide(candles, {
    symbol: "XAUUSD",
    symbolName: "XAUUSD",
    symbolDigits: 2,
    bid: candles.at(-1).close - 0.05,
    ask: candles.at(-1).close + 0.05,
    lastUpdate: new Date(now).toISOString(),
    connected: true,
    authorized: true,
    account: { isLive: false }
  });
  assert.equal(decision.engine, "AURIXA_AI_TRADER_V1");
  assert.equal(decision.signalConfirmation.primaryEngine, "AURIXA_AI_TRADER_V1");
  assert.equal(decision.signalConfirmation.confirmationEngine, "AURIXA_OF1");
  assert.equal(decision.signalConfirmation.mode, "main_strategy_with_of1_confirmation");
  assert.equal(decision.orderFlowConfirmation.symbol, "XAUUSD");
  assert.equal(typeof decision.signalConfirmation.status, "string");
  assert.equal(typeof decision.signalConfirmation.confirmed, "boolean");
  assert.equal(decision.executionEligible, decision.signal !== "WAIT");
});

test("OF1 confirms matching main direction with multiple structural checks even when its strict entry signal is WAIT", () => {
  const { confirmOrderFlowDirection } = require("../server/ai-trader-engine");
  const result = confirmOrderFlowDirection("BUY", {
    dataReady: true, direction: "BUY", signal: "WAIT",
    fib: { inZone: true, invalidated: false },
    confirmation: { outsideValue: false, liquiditySweep: true, displacement: false, participation: true }
  });
  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.confirmed, true);
  assert.equal(result.evidenceCount, 3);
  assert.match(result.reason, /full OF1 entry signal: WAIT/);
});

test("OF1 does not confirm on direction alone or after retracement invalidation", () => {
  const { confirmOrderFlowDirection } = require("../server/ai-trader-engine");
  const directionOnly = confirmOrderFlowDirection("BUY", {
    dataReady: true, direction: "BUY", signal: "WAIT",
    fib: { inZone: false, invalidated: false },
    confirmation: { outsideValue: false, liquiditySweep: false, displacement: false, participation: false }
  });
  assert.equal(directionOnly.confirmed, false);
  const invalidated = confirmOrderFlowDirection("BUY", {
    dataReady: true, direction: "BUY", signal: "BUY",
    fib: { inZone: true, invalidated: true },
    confirmation: { outsideValue: true, liquiditySweep: true, displacement: true, participation: false }
  });
  assert.equal(invalidated.confirmed, false);
  assert.equal(invalidated.status, "OF1_WAIT");
  assert.match(invalidated.reason, /invalidation/);
});

test("OF1 cannot confirm a direction that conflicts with the main strategy", () => {
  const { confirmOrderFlowDirection } = require("../server/ai-trader-engine");
  const result = confirmOrderFlowDirection("BUY", {
    dataReady: true, direction: "SELL", signal: "WAIT",
    confirmation: { liquiditySweep: true, displacement: true }
  });
  assert.equal(result.confirmed, false);
  assert.equal(result.status, "DIRECTION_MISMATCH");
});

test("OF1 WAIT is advisory when V1 has qualified and there is no explicit conflict or invalidation", () => {
  const { orderFlowBlocksMainSignal } = require("../server/ai-trader-engine");
  assert.equal(orderFlowBlocksMainSignal("BUY", {
    dataReady: true, signal: "WAIT", direction: "BUY",
    fib: { inZone: false, invalidated: false }
  }, { status: "OF1_WAIT", confirmed: false }), false);
  assert.equal(orderFlowBlocksMainSignal("SELL", {
    dataReady: false, signal: "WAIT", direction: null
  }, { status: "OF1_DATA_UNAVAILABLE", confirmed: false }), false);
});

test("OF1 still vetoes an explicit directional conflict or breached invalidation", () => {
  const { orderFlowBlocksMainSignal } = require("../server/ai-trader-engine");
  assert.equal(orderFlowBlocksMainSignal("BUY", {
    dataReady: true, direction: "SELL", fib: { invalidated: false }
  }, { status: "DIRECTION_MISMATCH", confirmed: false }), true);
  assert.equal(orderFlowBlocksMainSignal("BUY", {
    dataReady: true, direction: "BUY", fib: { invalidated: true }
  }, { status: "OF1_WAIT", confirmed: false }), true);
});
