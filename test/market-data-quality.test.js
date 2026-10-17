"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { auditMarketSnapshot } = require("../server/market-data-quality");

function makeMarket(now = Date.now()) {
  const candles = Array.from({ length: 60 }, (_, i) => {
    const close = 100 + i * 0.1;
    return { time: now - (59 - i) * 5 * 60_000, open: close - 0.05, high: close + 0.1, low: close - 0.1, close, volume: 10 };
  });
  return {
    symbol: "EURUSD", symbolName: "EURUSD", symbolId: 11,
    bid: 1.1, ask: 1.1002,
    bidUpdatedAt: new Date(now - 1000).toISOString(),
    askUpdatedAt: new Date(now - 1500).toISOString(),
    candles
  };
}

test("complete fresh market snapshot passes data integrity checks", () => {
  const now = Date.now();
  const report = auditMarketSnapshot(makeMarket(now), now);
  assert.equal(report.ready, true);
  assert.deepEqual(report.reasons, []);
  assert.equal(report.candles.valid, 60);
  assert.equal(report.quote.fresh, true);
});

test("stale ask cannot be hidden by a fresh bid", () => {
  const now = Date.now();
  const market = makeMarket(now);
  market.askUpdatedAt = new Date(now - 60_000).toISOString();
  const report = auditMarketSnapshot(market, now);
  assert.equal(report.ready, false);
  assert.ok(report.reasons.includes("QUOTE_STALE_OR_TIMESTAMP_MISSING"));
});

test("malformed candles and duplicate timestamps are reported", () => {
  const now = Date.now();
  const market = makeMarket(now);
  market.candles[2] = { ...market.candles[2], high: 1, low: 5 };
  market.candles[4] = { ...market.candles[3] };
  const report = auditMarketSnapshot(market, now);
  assert.equal(report.ready, false);
  assert.ok(report.reasons.includes("INVALID_OHLC_CANDLES"));
  assert.ok(report.reasons.includes("DUPLICATE_CANDLE_TIMESTAMPS"));
});

test("missing history and invalid spread fail closed with explicit reasons", () => {
  const now = Date.now();
  const market = makeMarket(now);
  market.candles = market.candles.slice(-10);
  market.ask = market.bid;
  const report = auditMarketSnapshot(market, now);
  assert.equal(report.ready, false);
  assert.ok(report.reasons.includes("INVALID_OR_MISSING_BID_ASK"));
  assert.ok(report.reasons.includes("INSUFFICIENT_M5_HISTORY"));
});

test("candle gap is reported as context without silently inventing candles", () => {
  const now = Date.now();
  const market = makeMarket(now);
  market.candles[30].time += 10 * 60_000;
  const report = auditMarketSnapshot(market, now);
  assert.ok(report.candles.detectedGaps >= 1);
});
