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
  assert.equal(risk.hasValidProtection({ stopLoss: 2000, takeProfit: 2020 }), false, "presence alone is not proof without direction, entry, and live price");
  assert.equal(risk.hasValidProtection({ stopLoss: null, takeProfit: 2020 }), false);
  assert.equal(risk.hasValidProtection({ stopLoss: 1990, takeProfit: "" }), false);
  assert.equal(risk.hasValidProtection({ tradeData: { stopLoss: 1990, takeProfit: 2020 } }), false, "unknown side and missing prices fail closed");
  assert.equal(risk.hasValidProtection({ price: 2000, tradeData: { tradeSide: 1, stopLoss: 1990, takeProfit: 2020 } }), false, "missing live price cannot verify stop placement");
  assert.equal(risk.hasValidProtection({ price: 2000, currentPrice: 2010, tradeData: { tradeSide: 1, stopLoss: 2005, takeProfit: 2020 } }), true);
  assert.equal(risk.hasValidProtection({ price: 2000, currentPrice: 2010, tradeData: { tradeSide: 1, stopLoss: 2010, takeProfit: 2020 } }), false);
  assert.equal(risk.hasValidProtection({ price: 2000, currentPrice: 2020, tradeData: { tradeSide: 1, stopLoss: 2010, takeProfit: 2020 } }), true, "profitable BUY trailing stop above entry remains valid while below market");
  assert.equal(risk.hasValidProtection({ price: 2000, currentPrice: 1990, tradeData: { tradeSide: 1, stopLoss: 1995, takeProfit: 2020 } }), false);
  assert.equal(risk.hasValidProtection({ price: 2000, currentPrice: 1990, tradeData: { tradeSide: 2, stopLoss: 2010, takeProfit: 1980 } }), true);
  assert.equal(risk.hasValidProtection({ price: 2000, currentPrice: 1990, tradeData: { tradeSide: 2, stopLoss: 1985, takeProfit: 1980 } }), false);
  assert.equal(risk.hasValidProtection({ price: 2000, currentPrice: 1980, tradeData: { tradeSide: 2, stopLoss: 1985, takeProfit: 1980 } }), true, "profitable SELL trailing stop below entry remains valid while above market");
  assert.equal(risk.hasValidProtection({ price: 2000, currentPrice: 2020, tradeData: { tradeSide: 2, stopLoss: 2015, takeProfit: 1980 } }), false);
});

test("protection audit checks SL against live market and TP against actual entry", () => {
  assert.deepEqual(
    risk.protectionIssues({ price: 2000, currentPrice: 2010, tradeData: { tradeSide: 1, stopLoss: 2011, takeProfit: 2020 } }),
    ["STOP_LOSS_NOT_BELOW_MARKET"]
  );
  assert.deepEqual(
    risk.protectionIssues({ price: 2000, currentPrice: 2010, tradeData: { tradeSide: 1, stopLoss: 2005, takeProfit: 1995 } }),
    ["TAKE_PROFIT_NOT_ABOVE_ENTRY"]
  );
  assert.deepEqual(
    risk.protectionIssues({ price: 2000, currentPrice: 1990, tradeData: { tradeSide: 2, stopLoss: 1989, takeProfit: 1980 } }),
    ["STOP_LOSS_NOT_ABOVE_MARKET"]
  );
  assert.deepEqual(
    risk.protectionIssues({ price: 2000, currentPrice: 1990, tradeData: { tradeSide: 2, stopLoss: 1995, takeProfit: 2005 } }),
    ["TAKE_PROFIT_NOT_BELOW_ENTRY"]
  );
  assert.deepEqual(
    risk.protectionIssues({ price: 2000, currentPrice: 2020, tradeData: { tradeSide: 1, stopLoss: 2010, takeProfit: 2030 } }),
    [],
    "a trailing stop locked above entry is valid while it remains below the live market"
  );
});

test("trailing stops can only move protectively and can initialize a missing stop", () => {
  assert.equal(risk.shouldImproveStop("BUY", 2010, 2005), true);
  assert.equal(risk.shouldImproveStop("BUY", 2000, 2005), false);
  assert.equal(risk.shouldImproveStop("SELL", 1990, 1995), true);
  assert.equal(risk.shouldImproveStop("SELL", 2000, 1995), false);
  assert.equal(risk.shouldImproveStop("SELL", 1990, null), true);
  assert.equal(risk.shouldImproveStop("BUY", NaN, 2000), false);
});

test("protection failure can request emergency close only for a real open tracked position", () => {
  assert.equal(risk.shouldEmergencyCloseAfterProtectionFailure({ status: "OPEN", positionId: "123" }), true);
  assert.equal(risk.shouldEmergencyCloseAfterProtectionFailure({ status: "PARTIAL", positionId: 123 }), true);
  assert.equal(risk.shouldEmergencyCloseAfterProtectionFailure({ status: "REJECTED", positionId: "123" }), false);
  assert.equal(risk.shouldEmergencyCloseAfterProtectionFailure({ status: "OPEN", positionId: null }), false);
  assert.equal(risk.shouldEmergencyCloseAfterProtectionFailure({ status: "CLOSED", positionId: "123" }), false);
});
