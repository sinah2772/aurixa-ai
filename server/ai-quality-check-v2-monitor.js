"use strict";
// Read-only summary for Quality Check V2 live monitoring.
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
  return { mode: "observe_only", version: "2.0.0", generatedAt: new Date(now).toISOString(), summary, markets: items };
}
module.exports = { summarize };
