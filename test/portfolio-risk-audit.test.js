"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPortfolioRiskAudit } = require("../server/portfolio-risk-audit");

test("read-only audit reports a clear under-limit snapshot", () => {
  const result = buildPortfolioRiskAudit({
    positions: [{positionId:"1"},{positionId:"2"}],
    dailyTradeCount: 3,
    maxOpenPositions: 5,
    maxTradesPerDay: 8,
    dailyLimitEnabled: true
  });
  assert.equal(result.mode, "OBSERVE_ONLY");
  assert.equal(result.canAssess, true);
  assert.equal(result.openPositionCount, 2);
  assert.deepEqual(result.findings, []);
  assert.equal(result.orderActionsTaken, 0);
});

test("reports account-wide position cap finding without taking action", () => {
  const result = buildPortfolioRiskAudit({
    positions: Array.from({length: 3}, (_,i) => ({positionId:String(i)})),
    dailyTradeCount: 0,
    maxOpenPositions: 3
  });
  assert.deepEqual(result.findings, ["MAX_OPEN_POSITIONS_REACHED"]);
  assert.equal(result.orderActionsTaken, 0);
});

test("fails assessment closed when broker position snapshot is unavailable", () => {
  const result = buildPortfolioRiskAudit({
    positions: null, dailyTradeCount: 0
  });
  assert.equal(result.canAssess, false);
  assert.ok(result.findings.includes("BROKER_POSITION_SNAPSHOT_UNAVAILABLE"));
});

test("does not flag daily cap unless enforcement is enabled", () => {
  const result = buildPortfolioRiskAudit({
    positions: [], dailyTradeCount: 10, maxTradesPerDay: 2, dailyLimitEnabled: false
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.dailyLimitEnabled, false);
});
