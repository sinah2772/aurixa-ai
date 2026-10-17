"use strict";

const M5_MS = 5 * 60 * 1000;
const MAX_QUOTE_AGE_MS = 30 * 1000;
const MAX_CANDLE_AGE_MS = 15 * 60 * 1000;
const MIN_CANDLES = 50;

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function parseTime(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" || (typeof value === "string" && /^\d+(\.\d+)?$/.test(value))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e11 ? n * 60000 : n;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function auditMarketSnapshot(market, now = Date.now()) {
  const source = market || {};
  const bid = Number(source.bid);
  const ask = Number(source.ask);
  const bidAt = parseTime(source.bidUpdatedAt);
  const askAt = parseTime(source.askUpdatedAt);
  const bidAgeMs = bidAt == null ? null : now - bidAt;
  const askAgeMs = askAt == null ? null : now - askAt;
  const quoteSidesValid = finitePositive(bid) && finitePositive(ask) && ask > bid;
  const quoteFresh = [bidAgeMs, askAgeMs].every(age =>
    age !== null && age >= 0 && age <= MAX_QUOTE_AGE_MS
  );

  const candles = Array.isArray(source.candles) ? source.candles : [];
  const invalidCandleIndexes = [];
  const duplicateTimes = [];
  const seenTimes = new Set();
  const times = [];
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i] || {};
    const time = parseTime(c.time);
    const o = Number(c.open), h = Number(c.high), l = Number(c.low), close = Number(c.close);
    const valid = time !== null &&
      [o, h, l, close].every(Number.isFinite) &&
      o > 0 && h > 0 && l > 0 && close > 0 &&
      h >= Math.max(o, l, close) && l <= Math.min(o, h, close) &&
      time <= now + M5_MS;
    if (!valid) {
      invalidCandleIndexes.push(i);
      continue;
    }
    const key = String(time);
    if (seenTimes.has(key)) duplicateTimes.push(new Date(time).toISOString());
    seenTimes.add(key);
    times.push(time);
  }

  const sortedTimes = [...new Set(times)].sort((a, b) => a - b);
  let gaps = 0;
  for (let i = 1; i < sortedTimes.length; i += 1) {
    if (sortedTimes[i] - sortedTimes[i - 1] > M5_MS * 1.5) gaps += 1;
  }
  const latestCandleTime = sortedTimes.length ? sortedTimes[sortedTimes.length - 1] : null;
  const latestCandleAgeMs = latestCandleTime == null ? null : now - latestCandleTime;
  const candleHistoryFresh = latestCandleAgeMs !== null &&
    latestCandleAgeMs >= -M5_MS && latestCandleAgeMs <= MAX_CANDLE_AGE_MS;
  const reasons = [];
  if (!quoteSidesValid) reasons.push("INVALID_OR_MISSING_BID_ASK");
  if (!quoteFresh) reasons.push("QUOTE_STALE_OR_TIMESTAMP_MISSING");
  if (candles.length < MIN_CANDLES) reasons.push("INSUFFICIENT_M5_HISTORY");
  if (invalidCandleIndexes.length) reasons.push("INVALID_OHLC_CANDLES");
  if (duplicateTimes.length) reasons.push("DUPLICATE_CANDLE_TIMESTAMPS");
  if (!candleHistoryFresh) reasons.push("LATEST_M5_CANDLE_STALE_OR_MISSING");

  return {
    symbol: String(source.symbol || source.canonicalName || "UNKNOWN"),
    brokerSymbol: source.symbolName || null,
    symbolId: source.symbolId ?? null,
    bid: finitePositive(bid) ? bid : null,
    ask: finitePositive(ask) ? ask : null,
    spread: quoteSidesValid ? Number((ask - bid).toFixed(10)) : null,
    quote: {
      valid: quoteSidesValid,
      fresh: quoteFresh,
      bidAgeMs,
      askAgeMs,
      maxAgeMs: MAX_QUOTE_AGE_MS
    },
    candles: {
      timeframe: "M5",
      received: candles.length,
      valid: times.length,
      required: MIN_CANDLES,
      latestTime: latestCandleTime == null ? null : new Date(latestCandleTime).toISOString(),
      latestAgeMs: latestCandleAgeMs,
      fresh: candleHistoryFresh,
      invalidIndexes: invalidCandleIndexes,
      duplicateTimes,
      detectedGaps: gaps
    },
    ready: reasons.length === 0,
    reasons
  };
}

module.exports = { auditMarketSnapshot, parseTime, MAX_QUOTE_AGE_MS, MAX_CANDLE_AGE_MS, MIN_CANDLES };
