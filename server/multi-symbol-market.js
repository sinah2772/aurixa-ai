"use strict";

// In-memory per-symbol market cache. Only broker-discovered whitelisted
// symbols are registered; quote/candle freshness is evaluated independently.
const { normalizeSymbolName, isSupportedSymbol } = require("./symbol-support");
const markets = new Map();
const byId = new Map();
const QUOTE_MAX_AGE_MS = 30000;
function timestampMs(value) {
  if (value === null || value === undefined || value === "") return Date.now();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e11 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Date.now();
}
function quoteFresh(market, now = Date.now()) {
  // A partial spot event refreshes only the side actually received. Keep the
  // market stale until BOTH sides have recent broker timestamps; otherwise a
  // fresh bid could mask an old ask (or vice versa) and produce a bad spread.
  const bidAt = Number(market?.bidUpdatedAt);
  const askAt = Number(market?.askUpdatedAt);
  const freshSide = at => Number.isFinite(at) && at > 0 &&
    now - at >= 0 && now - at <= QUOTE_MAX_AGE_MS;
  return freshSide(bidAt) && freshSide(askAt);
}

function registerSymbols(symbols) {
  for (const item of Array.isArray(symbols) ? symbols : []) {
    const symbol = normalizeSymbolName(item.canonicalName || item.symbolName);
    const symbolId = Number(item.symbolId);
    if (!isSupportedSymbol(symbol) || !Number.isInteger(symbolId) || symbolId <= 0) continue;
    const previous = markets.get(symbol) || { candles: [], bid: null, ask: null, lastUpdate: null, bidUpdatedAt: null, askUpdatedAt: null };
    Object.assign(previous, { symbol, symbolName: String(item.symbolName || symbol), symbolId,
      digits: item.digits != null && Number.isInteger(Number(item.digits)) ? Number(item.digits) : null });
    markets.set(symbol, previous);
    byId.set(symbolId, symbol);
  }
  return list();
}

function list() {
  return [...markets.values()].map(m => ({
    symbol: m.symbol, symbolName: m.symbolName, symbolId: m.symbolId,
    digits: m.digits, bid: m.bid, ask: m.ask, lastUpdate: m.lastUpdate,
    bidUpdatedAt: m.bidUpdatedAt ? new Date(m.bidUpdatedAt).toISOString() : null,
    askUpdatedAt: m.askUpdatedAt ? new Date(m.askUpdatedAt).toISOString() : null,
    quoteFresh: quoteFresh(m), candleCount: m.candles.length,
    ready: Number.isFinite(m.bid) && Number.isFinite(m.ask) && m.ask > m.bid &&
      Array.isArray(m.candles) && m.candles.length >= 50 && quoteFresh(m)
  }));
}

function resolve(key) {
  const symbol = typeof key === "number" ? byId.get(key) : normalizeSymbolName(key);
  return symbol ? markets.get(symbol) || null : null;
}

function normalizeCandle(c) {
  if (!c) return null;
  const rawTime = Number(c.time);
  const time = rawTime > 0 && rawTime < 100000000000 ? rawTime * 60000 : rawTime;
  const open = Number(c.open), high = Number(c.high), low = Number(c.low), close = Number(c.close);
  if (![time, open, high, low, close].every(Number.isFinite) || time <= 0 || high < low) return null;
  return { time, open, high, low, close, volume: c.volume == null ? null : Number(c.volume) };
}

function setHistory(key, candles) {
  const market = resolve(key);
  if (!market || !Array.isArray(candles)) return false;
  const sorted = candles.map(normalizeCandle).filter(Boolean).sort((a,b) => a.time-b.time);
  const unique = new Map(sorted.map(c => [String(c.time), c]));
  market.candles = [...unique.values()].slice(-300);
  return true;
}

function updateQuote(key, bid, ask, timestamp) {
  const market = resolve(key);
  if (!market) return false;
  const receivedAt = timestampMs(timestamp);
  const b = bid == null || bid === "" ? NaN : Number(bid);
  const a = ask == null || ask === "" ? NaN : Number(ask);
  // cTrader spot events can contain only one side. Do not refresh the age of
  // the opposite side unless that side was actually received in this event.
  let changed = false;
  if (Number.isFinite(b) && b > 0 && (!Number.isFinite(Number(market.bidUpdatedAt)) || receivedAt >= Number(market.bidUpdatedAt))) {
    market.bid = b; market.bidUpdatedAt = receivedAt; changed = true;
  }
  if (Number.isFinite(a) && a > 0 && (!Number.isFinite(Number(market.askUpdatedAt)) || receivedAt >= Number(market.askUpdatedAt))) {
    market.ask = a; market.askUpdatedAt = receivedAt; changed = true;
  }
  if (changed) {
    const previous = Date.parse(market.lastUpdate || "");
    market.lastUpdate = new Date(Math.max(Number.isFinite(previous) ? previous : 0, receivedAt)).toISOString();
  }
  return true;
}

function updateCandle(key, candle) {
  const market = resolve(key);
  const c = normalizeCandle(candle);
  if (!market || !c) return false;
  const idx = market.candles.findIndex(x => Number(x.time) === Number(c.time));
  if (idx >= 0) market.candles[idx] = { ...market.candles[idx], ...c };
  else market.candles.push(c);
  market.candles.sort((a,b) => a.time-b.time);
  if (market.candles.length > 300) market.candles = market.candles.slice(-300);
  return true;
}

function getSnapshot(key) {
  const m = resolve(key);
  if (!m) return null;
  return { ...m, candles: m.candles.slice(), quoteFresh: quoteFresh(m), mid: Number.isFinite(m.bid) && Number.isFinite(m.ask) ? (m.bid+m.ask)/2 : null };
}

module.exports = { registerSymbols, list, setHistory, updateQuote, updateCandle, getSnapshot, quoteFresh };
