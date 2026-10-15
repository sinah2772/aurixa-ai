"use strict";
// Read-only Quality Check V2 monitor. History is bounded in-memory telemetry only.
const MAX_HISTORY = 2000;
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const observations = [];
const observationKeys = new Map();

function record(candidate, now = Date.now()) {
  if (!candidate || typeof candidate !== "object") return;
  const report = candidate.qualityCheckV2;
  if (!report || report.mode !== "observe_only") return;
  const symbol = String(candidate.symbol || report.symbol || "UNKNOWN").toUpperCase();
  const evaluatedAt = report.evaluatedAt || candidate.checkedAt || new Date(now).toISOString();
  const key = symbol + "|" + evaluatedAt;
  const checks = report.checks && typeof report.checks === "object" ? report.checks : {};
  const warnings = Object.entries(checks)
    .filter(([, value]) => value?.status === "warning" || value?.status === "fail")
    .map(([name]) => name);
  const item = {
    key, symbol, evaluatedAt, recordedAt: new Date(now).toISOString(),
    signal: candidate.signal || report.signalObserved || "WAIT",
    v1ExecutionEligible: candidate.executionEligible === true || report.v1ExecutionEligible === true,
    warnings,
    checks: Object.fromEntries(Object.entries(checks).map(([name, value]) => [name, value?.status || "unknown"])),
    executionObservation: report.executionObservation ? { ...report.executionObservation } : null,
    executionDecisionUnaffected: report.executionDecisionUnaffected === true
  };
  const existingIndex = observationKeys.get(key);
  if (existingIndex !== undefined) {
    // Scanner writes the same evaluation again after execution returns. Update
    // that observation rather than counting it twice.
    const previous = observations.findIndex(row => row.key === key);
    if (previous >= 0) observations[previous] = item;
    else observations.push(item);
  } else {
    observations.push(item);
    observationKeys.set(key, true);
  }
  while (observations.length > MAX_HISTORY) {
    const removed = observations.shift();
    if (removed) observationKeys.delete(removed.key);
  }
}

function summarize(candidates, now=Date.now()) {
  const items = (Array.isArray(candidates) ? candidates : []).map(item => {
    const checkedAt = Date.parse(item?.checkedAt || "");
    const ageMs = Number.isFinite(checkedAt) ? Math.max(0, now - checkedAt) : null;
    const fresh = ageMs !== null && ageMs <= 45000;
    const report = item?.qualityCheckV2 || null;
    const checks = report?.checks && typeof report.checks === "object" ? report.checks : {};
    const counts = { pass: 0, warning: 0, unknown: 0 };
    for (const value of Object.values(checks)) {
      const status = value?.status;
      if (status === "pass") counts.pass++;
      else if (status === "warning" || status === "fail") counts.warning++;
      else counts.unknown++;
    }
    if (!fresh) counts.warning++;
    return {
      symbol: item?.symbol || null,
      signal: item?.signal || "WAIT",
      v1ExecutionEligible: item?.executionEligible === true,
      observationMode: report?.mode || "observe_only",
      evaluatedAt: report?.evaluatedAt || item?.checkedAt || null,
      checkedAt: item?.checkedAt || null,
      ageMs,
      fresh,
      status: !fresh ? "STALE" : counts.warning ? "WARNING" : counts.unknown ? "UNKNOWN" : "PASS",
      counts,
      wouldFlag: [...new Set([...(Array.isArray(report?.wouldFlag) ? report.wouldFlag : []), ...(!fresh ? ["scannerFreshness"] : [])])],
      checks,
      executionObservation: report?.executionObservation || null,
      executionDecisionUnaffected: report?.executionDecisionUnaffected === true
    };
  });
  const summary = { symbols: items.length, fresh: 0, stale: 0, pass: 0, warning: 0, unknown: 0, executionDecisionUnaffected: true };
  for (const item of items) {
    if (item.fresh) summary.fresh++; else summary.stale++;
    if (item.status === "PASS") summary.pass++;
    else if (item.status === "WARNING" || item.status === "STALE") summary.warning++;
    else summary.unknown++;
    if (!item.executionDecisionUnaffected) summary.executionDecisionUnaffected = false;
  }
  return { mode: "observe_only", version: "2.1.0", generatedAt: new Date(now).toISOString(), summary, markets: items };
}

function summarizeHistory(now = Date.now()) {
  const sinceMs = now - HISTORY_WINDOW_MS;
  const recent = observations.filter(row => {
    const time = Date.parse(row.evaluatedAt);
    return Number.isFinite(time) && time >= sinceMs && time <= now;
  });
  const warningTypes = new Map();
  const markets = new Map();
  let eligibleSignals = 0, executionObserved = 0, executed = 0, executionOff = 0;
  for (const row of recent) {
    if (row.v1ExecutionEligible) eligibleSignals++;
    const market = markets.get(row.symbol) || { symbol: row.symbol, evaluations: 0, warningEvaluations: 0, eligibleSignals: 0, executionObserved: 0, executed: 0, warningTypes: {} };
    market.evaluations++;
    if (row.warnings.length) market.warningEvaluations++;
    if (row.v1ExecutionEligible) market.eligibleSignals++;
    for (const warning of row.warnings) {
      market.warningTypes[warning] = (market.warningTypes[warning] || 0) + 1;
      const type = warningTypes.get(warning) || { type: warning, occurrences: 0, symbols: new Set() };
      type.occurrences++;
      type.symbols.add(row.symbol);
      warningTypes.set(warning, type);
    }
    if (row.executionObservation) {
      executionObserved++;
      market.executionObserved++;
      if (row.executionObservation.executed === true) { executed++; market.executed++; }
      if (row.executionObservation.executionReason === "AUTO_TRADING_DISABLED") executionOff++;
    }
    markets.set(row.symbol, market);
  }
  return {
    windowHours: 24,
    retention: "bounded in-memory; resets when the service restarts or deploys",
    sampleCount: recent.length,
    maxSamples: MAX_HISTORY,
    eligibleSignals,
    executionObserved,
    executed,
    executionOff,
    warningTypes: [...warningTypes.values()]
      .map(row => ({ type: row.type, occurrences: row.occurrences, symbolCount: row.symbols.size }))
      .sort((a, b) => b.occurrences - a.occurrences || a.type.localeCompare(b.type)),
    markets: [...markets.values()].map(row => ({
      ...row,
      warningRate: row.evaluations ? Number((row.warningEvaluations / row.evaluations).toFixed(3)) : 0
    })).sort((a, b) => b.evaluations - a.evaluations || a.symbol.localeCompare(b.symbol)),
    note: "Historical diagnostics only. Counts are observations, not trades or profitability. Missing execution observations are not assumed to be rejected or executed."
  };
}

module.exports = { summarize, record, summarizeHistory };
