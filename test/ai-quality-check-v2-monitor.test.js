"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const monitor = require("../server/ai-quality-check-v2-monitor");
const { summarize, record, summarizeHistory } = monitor;

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

test("history groups recurring warnings by type and market without mutating candidates", () => {
  const now = Date.now();
  const make = (symbol, at, warnings, eligible = false, executionObservation = null) => ({
    symbol, signal: eligible ? "BUY" : "WAIT", executionEligible: eligible,
    checkedAt: new Date(at).toISOString(),
    qualityCheckV2: {
      mode: "observe_only", evaluatedAt: new Date(at).toISOString(),
      executionDecisionUnaffected: true,
      checks: {
        spreadToAtr: { status: warnings.includes("spreadToAtr") ? "warning" : "pass" },
        entryCandleBody: { status: warnings.includes("entryCandleBody") ? "warning" : "pass" }
      },
      executionObservation
    }
  });
  const first = make("BTCUSD", now - 1000, ["spreadToAtr"], false);
  const second = make("BTCUSD", now, ["spreadToAtr", "entryCandleBody"], true, { executed: false, executionReason: "AUTO_TRADING_DISABLED" });
  const before = JSON.stringify([first, second]);
  record(first, now);
  record(second, now);
  // Recording the same evaluation after execution updates it, rather than double-counting.
  second.qualityCheckV2.executionObservation = { executed: false, executionReason: "AUTO_TRADING_DISABLED" };
  record(second, now);
  const history = summarizeHistory(now);
  assert.equal(history.sampleCount, 2);
  assert.equal(history.warningTypes.find(x => x.type === "spreadToAtr").occurrences, 2);
  assert.equal(history.warningTypes.find(x => x.type === "entryCandleBody").occurrences, 1);
  assert.equal(history.markets.find(x => x.symbol === "BTCUSD").evaluations, 2);
  assert.equal(history.eligibleSignals, 1);
  assert.equal(history.executionObserved, 1);
  assert.equal(history.executionOff, 1);
  assert.equal(JSON.stringify([first, second]), before);
});

test("empty scanner report is safe and serializable", () => {
  const report = summarize([], Date.now());
  assert.equal(report.summary.symbols, 0);
  assert.equal(report.summary.executionDecisionUnaffected, true);
  assert.deepEqual(report.markets, []);
});

test("durable history hydration replaces transient samples without duplicating evaluations", () => {
  const now = Date.now();
  const candidate = {
    symbol: "XAUUSD", signal: "BUY", executionEligible: true,
    checkedAt: new Date(now).toISOString(),
    qualityCheckV2: {
      mode: "observe_only", evaluatedAt: new Date(now).toISOString(),
      executionDecisionUnaffected: true, checks: { entryCandleBody: { status: "warning" } }
    }
  };
  monitor.replaceHistory([candidate], now);
  const history = summarizeHistory(now);
  assert.equal(history.sampleCount, 1);
  assert.equal(history.eligibleSignals, 1);
  assert.equal(history.warningTypes[0].type, "entryCandleBody");
});
