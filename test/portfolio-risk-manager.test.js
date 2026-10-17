"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluatePortfolioRisk } = require("../server/portfolio-risk-manager");

test("allows entry below explicitly configured limits", () => {
  const result = evaluatePortfolioRisk({
    openPositionCount: 2, dailyTradeCount: 3,
    maxOpenPositions: 5, maxTradesPerDay: 4, enforceDailyLimit: true
  });
  assert.equal(result.allowed, true);
});

test("blocks when supported-symbol open-position cap is reached", () => {
  const result = evaluatePortfolioRisk({
    openPositionCount: 5, dailyTradeCount: 0, maxOpenPositions: 5
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "MAX_OPEN_POSITIONS_REACHED");
});

test("daily limit is opt-in and blocks at configured boundary", () => {
  const disabled = evaluatePortfolioRisk({
    openPositionCount: 0, dailyTradeCount: 2, maxTradesPerDay: 2, enforceDailyLimit: false
  });
  const enabled = evaluatePortfolioRisk({
    openPositionCount: 0, dailyTradeCount: 2, maxTradesPerDay: 2, enforceDailyLimit: true
  });
  assert.equal(disabled.allowed, true);
  assert.equal(enabled.allowed, false);
  assert.equal(enabled.reason, "DAILY_TRADE_LIMIT_REACHED");
});

test("fails closed if a configured position cap cannot be assessed", () => {
  assert.equal(evaluatePortfolioRisk({
    openPositionCount: null, maxOpenPositions: 3
  }).reason, "PORTFOLIO_POSITION_SNAPSHOT_UNAVAILABLE");
});

test("fails closed if an enabled daily cap cannot be assessed", () => {
  assert.equal(evaluatePortfolioRisk({
    dailyTradeCount: null, maxTradesPerDay: 3, enforceDailyLimit: true
  }).reason, "DAILY_TRADE_COUNT_UNAVAILABLE");
});

test("does not require snapshots when limits are not configured", () => {
  const result = evaluatePortfolioRisk({});
  assert.equal(result.allowed, true);
});
