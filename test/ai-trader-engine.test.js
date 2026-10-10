"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ai = require("../server/ai-trader-engine");

test("AI decision keeps the selected supported symbol while waiting for candles", () => {
  for (const symbol of ["XAUUSD", "EURUSD", "NZDUSD", "USDCHF", "USDCAD", "AUDUSD", "USDJPY", "GBPUSD", "XAGUSD", "BTCUSD"]) {
    const decision = ai.decide([], { symbol, symbolDigits: 3 });
    assert.equal(decision.symbol, symbol, symbol);
    assert.equal(decision.signal, "WAIT", symbol);
    assert.equal(decision.executionEligible, false, symbol);
  }
});

test("AI decision fails closed for an unsupported symbol", () => {
  const decision = ai.decide([], { symbol: "ETHUSD" });
  assert.equal(decision.signal, "WAIT");
  assert.equal(decision.executionEligible, false);
  assert.ok(decision.blockedBy.includes("Unsupported trading symbol"));
});
