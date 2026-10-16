"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const risk = require("../server/position-risk-response");

test("a losing position is classified as adverse without automatically reversing it", () => {
  assert.equal(risk.classifyPositionRisk("BUY", 2000, 1995), "ADVERSE");
  assert.equal(risk.classifyPositionRisk("SELL", 2000, 2005), "ADVERSE");
  assert.equal(risk.classifyPositionRisk("BUY", 2000, 2005), "NORMAL");
  assert.equal(risk.classifyPositionRisk("SELL", 2000, 1995), "NORMAL");
  assert.equal(risk.classifyPositionRisk("BUY", NaN, 1995), "UNKNOWN");
  assert.equal(risk.shouldExitOnReversal({
    tracked: true, enabled: true, eligible: false, signal: "SELL", direction: "BUY"
  }), false);
});

test("a reversal can request exit only for a tracked position and a qualified opposite signal", () => {
  assert.equal(risk.shouldExitOnReversal({
    tracked: true, enabled: true, eligible: true, signal: "SELL", direction: "BUY"
  }), true);
  assert.equal(risk.shouldExitOnReversal({
    tracked: false, enabled: true, eligible: true, signal: "SELL", direction: "BUY"
  }), false);
  assert.equal(risk.shouldExitOnReversal({
    tracked: true, enabled: false, eligible: true, signal: "SELL", direction: "BUY"
  }), false);
  assert.equal(risk.shouldExitOnReversal({
    tracked: true, enabled: true, eligible: true, signal: "BUY", direction: "BUY"
  }), false);
});

test("a rejected or unconfirmed close is never treated as broker-confirmed", () => {
  assert.equal(risk.isBrokerCloseConfirmed({ brokerConfirmed: false, status: "REJECTED" }), false);
  assert.equal(risk.isBrokerCloseConfirmed({ status: "CLOSED" }), false);
  assert.equal(risk.isBrokerCloseConfirmed(null), false);
  assert.equal(risk.isBrokerCloseConfirmed({ brokerConfirmed: true }), true);
});

test("missing and directionally invalid protection is detected", () => {
  assert.equal(risk.hasValidProtection({ stopLoss: 2000, takeProfit: 2020 }), true);
  assert.equal(risk.hasValidProtection({ stopLoss: null, takeProfit: 2020 }), false);
  assert.equal(risk.hasValidProtection({ stopLoss: 1990, takeProfit: "" }), false);
  assert.equal(risk.hasValidProtection({ tradeData: { stopLoss: 1990, takeProfit: 2020 } }), true);
  assert.equal(risk.hasValidProtection({ price: 2000, tradeData: { tradeSide: 1, stopLoss: 1990, takeProfit: 2020 } }), true);
  assert.equal(risk.hasValidProtection({ price: 2000, tradeData: { tradeSide: 1, stopLoss: 2010, takeProfit: 2020 } }), false);
  assert.equal(risk.hasValidProtection({ price: 2000, tradeData: { tradeSide: 2, stopLoss: 2010, takeProfit: 1980 } }), true);
  assert.equal(risk.hasValidProtection({ price: 2000, tradeData: { tradeSide: 2, stopLoss: 1990, takeProfit: 1980 } }), false);
});

test("trailing stops can only move protectively and can initialize a missing stop", () => {
  assert.equal(risk.shouldImproveStop("BUY", 2010, 2005), true);
  assert.equal(risk.shouldImproveStop("BUY", 2000, 2005), false);
  assert.equal(risk.shouldImproveStop("SELL", 1990, 1995), true);
  assert.equal(risk.shouldImproveStop("SELL", 2000, 1995), false);
  assert.equal(risk.shouldImproveStop("SELL", 1990, null), true);
  assert.equal(risk.shouldImproveStop("BUY", NaN, 2000), false);
});
