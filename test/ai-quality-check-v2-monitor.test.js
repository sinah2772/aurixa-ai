"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { summarize } = require("../server/ai-quality-check-v2-monitor");

test("monitor summarizes per-symbol diagnostics without changing execution eligibility", () => {
  const now = Date.now();
  const candidate = {
    symbol: "EURUSD", signal: "BUY", executionEligible: true,
    checkedAt: new Date(now).toISOString(),
    qualityCheckV2: {
      mode: "observe_only", evaluatedAt: new Date(now).toISOString(),
      executionDecisionUnaffected: true, wouldFlag: ["spreadToAtr"],
      checks: { candleHistory: { status: "pass" }, spreadToAtr: { status: "warning" }, brokerProtection: { status: "unknown" } }
    }
  };
  const before = JSON.stringify(candidate);
  const report = summarize([candidate], now);
  assert.equal(report.mode, "observe_only");
  assert.equal(report.summary.fresh, 1);
  assert.equal(report.summary.warning, 1);
  assert.equal(report.markets[0].status, "WARNING");
  assert.equal(report.markets[0].v1ExecutionEligible, true);
  assert.equal(report.markets[0].executionDecisionUnaffected, true);
  assert.equal(JSON.stringify(candidate), before);
});

test("monitor marks missing or stale evaluations as stale without treating them as order blocks", () => {
  const report = summarize([{ symbol: "BTCUSD", signal: "WAIT", executionEligible: false, checkedAt: "2000-01-01T00:00:00.000Z" }], Date.now());
  assert.equal(report.markets[0].status, "STALE");
  assert.ok(report.markets[0].wouldFlag.includes("scannerFreshness"));
  assert.equal(report.markets[0].v1ExecutionEligible, false);
  assert.equal(report.mode, "observe_only");
});

test("empty scanner report is safe and serializable", () => {
  const report = summarize([], Date.now());
  assert.equal(report.summary.symbols, 0);
  assert.equal(report.summary.executionDecisionUnaffected, true);
  assert.deepEqual(report.markets, []);
});
