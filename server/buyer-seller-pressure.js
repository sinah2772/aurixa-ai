"use strict";

/*
 * AURIXA Buyer/Seller Pressure — observation-only v1.
 * This module never approves or submits orders.
 * cTrader quote/candle activity is an ESTIMATE, not aggressor-side executed volume.
 * Level II depth remains unavailable until a verified broker depth feed is connected.
 */

const MAX_TICKS = 120;
const MAX_CANDLES = 60;
const symbols = new Map();

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stateFor(symbol) {
  const key = String(symbol || "").trim().toUpperCase();
  if (!symbols.has(key)) {
    symbols.set(key, { symbol: key, ticks: [], candles: [], updatedAt: null });
  }
  return symbols.get(key);
}

function observeQuote(symbol, bid, ask, timestamp = Date.now()) {
  const b = number(bid);
  const a = number(ask);
  if (!symbol || b === null || a === null || b <= 0 || a < b) return false;
  const s = stateFor(symbol);
  const mid = (b + a) / 2;
  const tsNumber = number(timestamp);
  // cTrader timestamps are commonly milliseconds; normalize seconds if necessary.
  const ts = tsNumber !== null ? (tsNumber < 1e12 ? tsNumber * 1000 : tsNumber) : Date.now();
  const previous = s.ticks[s.ticks.length - 1];
  if (previous && previous.ts === ts && previous.bid === b && previous.ask === a) return true;
  s.ticks.push({ ts, bid: b, ask: a, mid });
  if (s.ticks.length > MAX_TICKS) s.ticks.splice(0, s.ticks.length - MAX_TICKS);
  s.updatedAt = new Date(ts).toISOString();
  return true;
}

function observeCandle(symbol, candle) {
  if (!symbol || !candle) return false;
  const time = number(candle.time);
  const close = number(candle.close);
  const volume = number(candle.volume);
  if (time === null || close === null || close <= 0) return false;
  const s = stateFor(symbol);
  const normalizedTime = time < 1e12 ? time * 60000 : time;
  const item = { time: normalizedTime, close, volume };
  const existing = s.candles.findIndex(c => c.time === normalizedTime);
  if (existing >= 0) s.candles[existing] = item;
  else s.candles.push(item);
  s.candles.sort((x, y) => x.time - y.time);
  if (s.candles.length > MAX_CANDLES) s.candles.splice(0, s.candles.length - MAX_CANDLES);
  s.updatedAt = new Date().toISOString();
  return true;
}

function getSnapshot(symbol) {
  const s = symbols.get(String(symbol || "").trim().toUpperCase());
  if (!s) {
    return {
      symbol: String(symbol || "").trim().toUpperCase() || null,
      mode: "OBSERVE_ONLY",
      status: "WAITING_FOR_MARKET_DATA",
      depthAvailable: false,
      depthStatus: "NOT_CONNECTED",
      pressureType: "ESTIMATED_FROM_QUOTES_AND_CANDLES",
      buyerPressure: null,
      sellerPressure: null,
      pressureScore: null,
      tickCount: 0,
      candleCount: 0,
      lastUpdate: null,
      warnings: ["No market observations received yet", "Executed buyer/seller volume is not available from this estimate"]
    };
  }

  const ticks = s.ticks;
  const first = ticks.length ? ticks[Math.max(0, ticks.length - 12)] : null;
  const last = ticks.length ? ticks[ticks.length - 1] : null;
  const ageMs = last ? Math.max(0, Date.now() - last.ts) : Infinity;
  const momentum = first && last ? last.mid - first.mid : null;
  const changes = ticks.slice(1).map((tick, i) => tick.mid - ticks[i].mid);
  const up = changes.filter(v => v > 0).length;
  const down = changes.filter(v => v < 0).length;
  const totalMoves = up + down;
  const movementPressure = totalMoves ? ((up - down) / totalMoves) * 100 : 0;
  const candle = s.candles[s.candles.length - 1];
  const prior = s.candles.length > 1 ? s.candles[s.candles.length - 2] : null;
  const candleDirection = candle && prior
    ? (candle.close > prior.close ? 1 : candle.close < prior.close ? -1 : 0)
    : 0;
  const score = ticks.length >= 3 && totalMoves >= 2
    ? Math.max(-100, Math.min(100, Math.round(movementPressure * 0.7 + candleDirection * 30)))
    : null;
  const buyer = score === null ? null : Math.round((score + 100) / 2);
  const seller = score === null ? null : 100 - buyer;

  return {
    symbol: s.symbol,
    mode: "OBSERVE_ONLY",
    status: ageMs > 30000 ? "STALE" : ticks.length >= 3 ? "ESTIMATE_READY" : "COLLECTING",
    depthAvailable: false,
    depthStatus: "NOT_CONNECTED",
    pressureType: "ESTIMATED_FROM_QUOTES_AND_CANDLES",
    buyerPressure: buyer,
    sellerPressure: seller,
    pressureScore: score,
    quote: last ? { bid: last.bid, ask: last.ask, mid: last.mid, spread: last.ask - last.bid } : null,
    shortTermMidChange: momentum,
    tickCount: ticks.length,
    candleCount: s.candles.length,
    latestTickActivity: totalMoves,
    lastUpdate: s.updatedAt,
    dataAgeMs: Number.isFinite(ageMs) ? ageMs : null,
    warnings: [
      "Buyer/seller percentages are estimated from quote movement, not real executed buyer/seller volume",
      "Level II depth is not connected; no actual bid/ask order quantities are shown",
      "Observation-only: these values do not affect trade approval or execution"
    ]
  };
}

function getAllSnapshots() {
  return [...symbols.keys()].map(getSnapshot);
}

module.exports = { observeQuote, observeCandle, getSnapshot, getAllSnapshots };
