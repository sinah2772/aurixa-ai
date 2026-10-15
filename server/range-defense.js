"use strict";

/**
 * AURIXA AI — candle-range defense diagnostics.
 *
 * This module is analysis-only: it identifies range boundaries, rejection
 * candles, and failed breaks. It does not approve trades or change risk gates.
 */
function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function averageTrueRange(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const ranges = [];
  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i];
    const previous = candles[i - 1];
    const high = finite(current.high);
    const low = finite(current.low);
    const close = finite(previous.close);
    if (high === null || low === null || close === null) continue;
    ranges.push(Math.max(high - low, Math.abs(high - close), Math.abs(low - close)));
  }
  const recent = ranges.slice(-period);
  return recent.length ? recent.reduce((sum, value) => sum + value, 0) / recent.length : null;
}

function analyzeRangeDefense(candles, options = {}) {
  const lookback = Math.max(5, Math.min(100, Math.floor(Number(options.lookback) || 20)));
  const clean = (Array.isArray(candles) ? candles : [])
    .filter(c => c && [c.open, c.high, c.low, c.close].every(v => finite(v) !== null))
    .slice(-lookback - 1);

  if (clean.length < Math.min(lookback + 1, 10)) {
    return {
      available: false,
      analysisOnly: true,
      state: "INSUFFICIENT_CANDLES",
      reason: "Waiting for enough candles to assess range defense",
      candlesAnalyzed: clean.length,
      support: null,
      resistance: null,
      bullishRejection: false,
      bearishRejection: false,
      failedBreakoutUp: false,
      failedBreakdown: false
    };
  }

  // Boundaries come from preceding candles; the latest candle is evaluated
  // against them rather than being allowed to move the boundaries itself.
  const current = clean[clean.length - 1];
  const prior = clean.slice(0, -1);
  const support = Math.min(...prior.map(c => Number(c.low)));
  const resistance = Math.max(...prior.map(c => Number(c.high)));
  const atr = finite(options.atr) ?? averageTrueRange(clean);
  const candleRange = Math.max(0, Number(current.high) - Number(current.low));
  const body = Math.abs(Number(current.close) - Number(current.open));
  const upperWick = Number(current.high) - Math.max(Number(current.open), Number(current.close));
  const lowerWick = Math.min(Number(current.open), Number(current.close)) - Number(current.low);
  const tolerance = Math.max((atr && atr > 0 ? atr : candleRange) * 0.15, Number.EPSILON);
  const close = Number(current.close);
  const open = Number(current.open);
  const high = Number(current.high);
  const low = Number(current.low);

  const bullishRejection = low <= support + tolerance &&
    close > open && lowerWick >= Math.max(body * 1.2, tolerance * 0.5) &&
    (candleRange === 0 || (close - low) / candleRange >= 0.6);
  const bearishRejection = high >= resistance - tolerance &&
    close < open && upperWick >= Math.max(body * 1.2, tolerance * 0.5) &&
    (candleRange === 0 || (close - low) / candleRange <= 0.4);
  const failedBreakoutUp = high > resistance + tolerance && close < resistance;
  const failedBreakdown = low < support - tolerance && close > support;
  const confirmedBreakoutUp = close > resistance + tolerance;
  const confirmedBreakdown = close < support - tolerance;

  let state = "INSIDE_RANGE";
  let reason = "Latest candle remains inside the prior range";
  if (failedBreakoutUp) {
    state = "FAILED_BREAKOUT_UP";
    reason = "Price traded above resistance but closed back below it";
  } else if (failedBreakdown) {
    state = "FAILED_BREAKDOWN";
    reason = "Price traded below support but closed back above it";
  } else if (bullishRejection) {
    state = "BULLISH_SUPPORT_REJECTION";
    reason = "Lower-wick rejection near prior range support";
  } else if (bearishRejection) {
    state = "BEARISH_RESISTANCE_REJECTION";
    reason = "Upper-wick rejection near prior range resistance";
  } else if (confirmedBreakoutUp) {
    state = "BREAKOUT_UP_UNCONFIRMED";
    reason = "Latest close is above prior resistance; retest is not assessed";
  } else if (confirmedBreakdown) {
    state = "BREAKDOWN_UNCONFIRMED";
    reason = "Latest close is below prior support; retest is not assessed";
  }

  return {
    available: true,
    analysisOnly: true,
    state,
    reason,
    candlesAnalyzed: clean.length,
    lookback: prior.length,
    support,
    resistance,
    tolerance,
    atr,
    latestCandleTime: current.time ?? null,
    bullishRejection,
    bearishRejection,
    failedBreakoutUp,
    failedBreakdown,
    confirmedBreakoutUp,
    confirmedBreakdown
  };
}

module.exports = { analyzeRangeDefense };
