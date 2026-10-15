"use strict";
// Durable diagnostic telemetry only. This module never calls the execution engine.
let queryDatabase = null;
let schemaPromise = null;
let lastPruneAt = 0;
function configure(queryFn) { queryDatabase = typeof queryFn === "function" ? queryFn : null; }
async function ensureSchema() {
  if (!queryDatabase) throw new Error("Quality Check V2 database query is not configured");
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await queryDatabase("CREATE SCHEMA IF NOT EXISTS aurixa");
      await queryDatabase("CREATE TABLE IF NOT EXISTS aurixa.ai_quality_check_v2_observations (symbol TEXT NOT NULL, evaluated_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), payload JSONB NOT NULL, PRIMARY KEY (symbol, evaluated_at))");
      await queryDatabase("CREATE INDEX IF NOT EXISTS ai_quality_check_v2_observations_evaluated_at_idx ON aurixa.ai_quality_check_v2_observations (evaluated_at DESC)");
    })().catch(error => { schemaPromise = null; throw error; });
  }
  return schemaPromise;
}
function observationIdentity(candidate) {
  const report = candidate?.qualityCheckV2;
  const symbol = String(candidate?.symbol || report?.symbol || "UNKNOWN").toUpperCase();
  const evaluatedAt = report?.evaluatedAt || candidate?.checkedAt;
  const timestamp = Date.parse(evaluatedAt || "");
  if (!Number.isFinite(timestamp)) return null;
  return { symbol, evaluatedAt: new Date(timestamp).toISOString() };
}
async function persist(candidate) {
  if (!candidate?.qualityCheckV2 || candidate.qualityCheckV2.mode !== "observe_only") return false;
  const identity = observationIdentity(candidate);
  if (!identity) return false;
  await ensureSchema();
  await queryDatabase(
    "INSERT INTO aurixa.ai_quality_check_v2_observations(symbol, evaluated_at, payload) VALUES($1, $2, $3::jsonb) ON CONFLICT(symbol, evaluated_at) DO UPDATE SET updated_at = NOW(), payload = EXCLUDED.payload",
    [identity.symbol, identity.evaluatedAt, JSON.stringify(candidate)]
  );
  const now = Date.now();
  if (now - lastPruneAt > 60 * 60 * 1000) {
    lastPruneAt = now;
    await queryDatabase("DELETE FROM aurixa.ai_quality_check_v2_observations WHERE evaluated_at < NOW() - INTERVAL '48 hours'");
  }
  return true;
}
async function loadRecent(limit = 2000) {
  await ensureSchema();
  const safeLimit = Math.max(1, Math.min(2000, Math.floor(Number(limit) || 2000)));
  const result = await queryDatabase(
    "SELECT payload FROM aurixa.ai_quality_check_v2_observations WHERE evaluated_at >= NOW() - INTERVAL '24 hours' ORDER BY evaluated_at DESC LIMIT $1",
    [safeLimit]
  );
  return (result?.rows || []).map(row => row.payload).filter(value => value && typeof value === "object");
}
module.exports = { configure, persist, loadRecent };
