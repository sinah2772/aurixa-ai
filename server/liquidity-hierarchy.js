"use strict";

// AURIXA liquidity hierarchy: internal structure, external targets and sweep confirmation.
// Uses OHLC only; it does not claim access to true order-book/footprint liquidity.
function num(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function analyzeLiquidity(candles, options = {}) {
  const bars = Array.isArray(candles) ? candles.filter(c =>
    c && [c.open, c.high, c.low, c.close].every(v => num(v) !== null)
  ) : [];
  const lookback = Math.max(12, Math.min(48, Number(options.lookback) || 24));
  if (bars.length < lookback + 5) {
    return { dataReady: false, status: "INSUFFICIENT_DATA", internal: null, external: null,
      sweep: { detected: false, direction: null, type: null, confirmed: false },
      alignment: "UNKNOWN", reasons: ["Insufficient candles for liquidity analysis"] };
  }
  const current = bars[bars.length - 1];
  const previous = bars.slice(-(lookback + 1), -1);
  const atrBars = bars.slice(-15);
  let trSum = 0, trCount = 0;
  for (let i = 1; i < atrBars.length; i++) {
    const c = atrBars[i], p = atrBars[i - 1];
    trSum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    trCount++;
  }
  const atr = trCount ? trSum / trCount : 0;
  if (!(atr > 0)) return { dataReady: false, status: "INVALID_ATR", internal: null, external: null,
    sweep: { detected: false, direction: null, type: null, confirmed: false },
    alignment: "UNKNOWN", reasons: ["ATR unavailable"] };

  const internalHigh = Math.max(...previous.map(c => num(c.high)));
  const internalLow = Math.min(...previous.map(c => num(c.low)));
  const older = bars.slice(Math.max(0, bars.length - 100), Math.max(0, bars.length - lookback - 1));
  const externalHigh = older.length ? Math.max(...older.map(c => num(c.high))) : null;
  const externalLow = older.length ? Math.min(...older.map(c => num(c.low))) : null;
  const tolerance = Math.max(atr * 0.12, 1e-8);
  const highs = previous.map(c => num(c.high));
  const lows = previous.map(c => num(c.low));
  const equalHighs = highs.filter(h => highs.some(other => other !== h && Math.abs(other - h) <= tolerance)).length >= 2;
  const equalLows = lows.filter(l => lows.some(other => other !== l && Math.abs(other - l) <= tolerance)).length >= 2;

  const sweptHigh = num(current.high) > internalHigh && num(current.close) < internalHigh;
  const sweptLow = num(current.low) < internalLow && num(current.close) > internalLow;
  const body = Math.abs(num(current.close) - num(current.open));
  const bearishDisplacement = num(current.close) < num(current.open) && body / atr >= 0.5;
  const bullishDisplacement = num(current.close) > num(current.open) && body / atr >= 0.5;
  let direction = null, type = null, confirmed = false;
  if (sweptLow && !sweptHigh) {
    direction = "BUY"; type = "SELL_SIDE_SWEEP"; confirmed = bullishDisplacement;
  } else if (sweptHigh && !sweptLow) {
    direction = "SELL"; type = "BUY_SIDE_SWEEP"; confirmed = bearishDisplacement;
  } else if (sweptHigh && sweptLow) {
    type = "DUAL_SWEEP"; // ambiguous candle: never use as directional confirmation
  }
  const sweepDetected = Boolean(sweptHigh || sweptLow);
  const reasons = [];
  if (equalHighs) reasons.push("Equal highs detected: potential buy-side internal liquidity");
  if (equalLows) reasons.push("Equal lows detected: potential sell-side internal liquidity");
  if (sweepDetected) reasons.push(type === "DUAL_SWEEP" ? "Both sides swept in one candle; directional read is ambiguous" :
    (confirmed ? type + " with displacement confirmation" : type + " without displacement confirmation"));
  else reasons.push("No confirmed internal liquidity sweep on the latest candle");
  return {
    dataReady: true, status: sweepDetected ? (confirmed ? "SWEEP_CONFIRMED" : "SWEEP_UNCONFIRMED") : "NO_SWEEP",
    timeframe: String(options.timeframe || "M5").toUpperCase(), lookback, atr,
    internal: { high: internalHigh, low: internalLow, equalHighs, equalLows },
    external: { high: externalHigh, low: externalLow,
      highAvailable: Number.isFinite(externalHigh), lowAvailable: Number.isFinite(externalLow) },
    sweep: { detected: sweepDetected, direction, type, confirmed,
      sweptHigh: Boolean(sweptHigh), sweptLow: Boolean(sweptLow),
      candleClose: num(current.close), candleTime: current.time ?? null },
    alignment: confirmed ? direction : "UNCONFIRMED",
    reasons
  };
}
function conflictsWithSignal(liquidity, signal) {
  return Boolean(liquidity?.dataReady && liquidity?.sweep?.confirmed &&
    (signal === "BUY" || signal === "SELL") &&
    liquidity.sweep.direction && liquidity.sweep.direction !== signal);
}
module.exports = { analyzeLiquidity, conflictsWithSignal };
