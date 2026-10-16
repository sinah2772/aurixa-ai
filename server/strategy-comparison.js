"use strict";

// Offline, non-executing comparison of the production V1 signal engine and a
// research-only trend/pullback candidate. Uses the same candles and explicit
// per-symbol costs for both. It never sends orders or changes trading settings.
const { decide } = require("./ai-trader-engine");

function num(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return tr.slice(-period).reduce((a, b) => a + b, 0) / period;
}
function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}
function candidateSignal(candles) {
  if (candles.length < 55) return null;
  const closes = candles.map(c => c.close);
  const e9 = ema(closes, 9), e20 = ema(closes, 20), e50 = ema(closes, 50);
  const a = atr(candles), r = rsi(closes), last = candles.at(-1), prev = candles.at(-2);
  if (![e9, e20, e50, a, r].every(Number.isFinite) || a <= 0) return null;
  const recent = candles.slice(-10);
  const high = Math.max(...recent.map(c => c.high)), low = Math.min(...recent.map(c => c.low));
  // Pullback then close back through EMA9 in the direction of the aligned trend.
  const pullback = candles.slice(-4, -1);
  const buyPullback = pullback.some(c => c.low <= e9 + a * 0.15) && last.close > e9 && last.close > prev.close;
  const sellPullback = pullback.some(c => c.high >= e9 - a * 0.15) && last.close < e9 && last.close < prev.close;
  let side = null;
  if (e9 > e20 && e20 > e50 && buyPullback && r >= 50 && r <= 70 && (last.close - e9) / a <= 1.5) side = "BUY";
  if (e9 < e20 && e20 < e50 && sellPullback && r >= 30 && r <= 50 && (e9 - last.close) / a <= 1.5) side = "SELL";
  if (!side) return null;
  const entry = last.close;
  const stop = side === "BUY" ? low - a * 0.15 : high + a * 0.15;
  const risk = Math.abs(entry - stop);
  if (!Number.isFinite(risk) || risk < a * 0.5) return null;
  return { side, stop, target: side === "BUY" ? entry + 2 * risk : entry - 2 * risk, risk };
}
function summarize(trades, costs) {
  const wins = trades.filter(t => t.netR > 1e-9), losses = trades.filter(t => t.netR < -1e-9);
  const grossWin = wins.reduce((s, t) => s + t.netR, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.netR, 0);
  let equity = 0, peak = 0, maxDrawdownR = 0;
  for (const t of trades) { equity += t.netR; peak = Math.max(peak, equity); maxDrawdownR = Math.max(maxDrawdownR, peak - equity); }
  return {
    trades: trades.length, wins: wins.length, losses: losses.length,
    breakeven: trades.length - wins.length - losses.length,
    winRatePct: trades.length ? Number((wins.length / trades.length * 100).toFixed(2)) : null,
    netR: Number(trades.reduce((s, t) => s + t.netR, 0).toFixed(3)),
    expectancyR: trades.length ? Number((trades.reduce((s, t) => s + t.netR, 0) / trades.length).toFixed(4)) : null,
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(3)) : grossWin > 0 ? "infinite" : null,
    maxDrawdownR: Number(maxDrawdownR.toFixed(3)),
    costs: { spreadPrice: costs.spreadPrice, slippagePricePerSide: costs.slippagePricePerSide, commissionRPerTrade: costs.commissionRPerTrade }
  };
}
function runOne(candles, symbol, costs, strategy, options = {}) {
  const trades = [];
  let skippedInvalidatedSetups = 0;
  const startIndex = Math.max(54, Math.floor(Number(options.startIndex) || 54));
  const endIndex = Math.min(candles.length - 1,
    Number.isInteger(options.endIndex) ? options.endIndex : candles.length - 1);
  let i = startIndex;
  while (i < endIndex) {
    const history = candles.slice(0, i + 1), bar = candles[i], next = candles[i + 1];
    let setup;
    if (strategy === "V1") {
      const half = costs.spreadPrice / 2;
      const quote = {
        symbolName: symbol, bid: bar.close - half, ask: bar.close + half,
        lastUpdate: new Date().toISOString(), connected: true, authorized: true,
        account: { isLive: false }
      };
      const d = decide(history, quote);
      if (d.executionEligible && ["BUY", "SELL"].includes(d.signal)) setup = {
        side: d.signal, stop: d.stopLoss, target: d.takeProfit,
        risk: Math.abs(d.entry - d.stopLoss)
      };
    } else setup = candidateSignal(history);
    if (!setup || !Number.isFinite(setup.risk) || setup.risk <= 0) { i++; continue; }
    const side = setup.side, halfSpread = costs.spreadPrice / 2, slip = costs.slippagePricePerSide;
    // Signal is known only after bar i closes; fill at next bar open, never at bar i.
    const entry = next.open + (side === "BUY" ? halfSpread + slip : -halfSpread - slip);
    const stop = Number(setup.stop), target = Number(setup.target);
    // Measure R from the simulated fill, not the previous candle's signal
    // close. If a gap means the fill is already beyond the planned stop/target,
    // the setup is invalidated and must not be counted as a zero-risk trade.
    const actualRisk = Math.abs(entry - stop);
    const validGeometry = side === "BUY"
      ? Number.isFinite(stop) && Number.isFinite(target) && stop < entry && target > entry
      : Number.isFinite(stop) && Number.isFinite(target) && stop > entry && target < entry;
    if (!validGeometry || !Number.isFinite(actualRisk) || actualRisk <= 0) {
      skippedInvalidatedSetups++;
      i++;
      continue;
    }
    // If a later candle gaps through protection, use its open as the adverse exit.
    let exit = null, exitIndex = i + 1, reason = null;
    for (let j = i + 1; j <= endIndex; j++) {
      const c = candles[j];
      if (side === "BUY") {
        if (c.open <= stop) { exit = c.open; reason = "GAP_STOP"; }
        else if (c.open >= target) { exit = c.open; reason = "GAP_TARGET"; }
        else if (c.low <= stop) { exit = stop; reason = "STOP"; }
        else if (c.high >= target) { exit = target; reason = "TARGET"; }
      } else {
        if (c.open >= stop) { exit = c.open; reason = "GAP_STOP"; }
        else if (c.open <= target) { exit = c.open; reason = "GAP_TARGET"; }
        else if (c.high >= stop) { exit = stop; reason = "STOP"; }
        else if (c.low <= target) { exit = target; reason = "TARGET"; }
      }
      if (exit !== null) { exitIndex = j; break; }
    }
    if (exit === null) { exitIndex = endIndex; exit = candles[exitIndex].close; reason = "DATA_END"; }
    // Exit cost is applied adversely to both systems. Commission is supplied in R
    // units because contract value varies by broker symbol and account currency.
    exit += side === "BUY" ? -halfSpread - slip : halfSpread + slip;
    const grossR = (side === "BUY" ? exit - entry : entry - exit) / actualRisk;
    const netR = grossR - costs.commissionRPerTrade;
    trades.push({ symbol, strategy, side, signalTime: bar.time ?? i, entryIndex: i + 1, exitIndex, entry, exit, stop, target, risk: actualRisk, reason, grossR: Number(grossR.toFixed(4)), netR: Number(netR.toFixed(4)) });
    i = Math.max(i + 1, exitIndex); // one position at a time per strategy
  }
  return { summary: summarize(trades, costs), trades, skippedInvalidatedSetups };
}
function compareStrategies(input = {}) {
  const candles = Array.isArray(input.candles) ? input.candles : [];
  const symbol = String(input.symbol || "XAUUSD").toUpperCase();
  const raw = input.costs || {};
  const costs = {
    spreadPrice: num(raw.spreadPrice),
    slippagePricePerSide: num(raw.slippagePricePerSide),
    commissionRPerTrade: num(raw.commissionRPerTrade)
  };
  if (candles.length < 100) throw new Error("At least 100 chronological M5 candles are required for a meaningful comparison.");
  for (const [key, value] of Object.entries(costs)) {
    if (value === null || value < 0) throw new Error("Explicit non-negative costs required: spreadPrice, slippagePricePerSide, commissionRPerTrade.");
  }
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (![c?.open, c?.high, c?.low, c?.close].every(v => Number.isFinite(Number(v)) && Number(v) > 0) ||
        Number(c.high) < Math.max(Number(c.open), Number(c.close), Number(c.low)) ||
        Number(c.low) > Math.min(Number(c.open), Number(c.close), Number(c.high)) ||
        (i > 0 && Number(c.time ?? i) <= Number(candles[i - 1].time ?? i - 1))) {
      throw new Error("Candles must be valid and chronological with open/high/low/close and increasing time.");
    }
  }
  const v1 = runOne(candles, symbol, costs, "V1");
  const candidate = runOne(candles, symbol, costs, "TREND_PULLBACK");
  // Use a strictly chronological 70/30 split when enough candles are available.
  // The holdout uses earlier candles only as indicator warm-up; no holdout bar
  // contributes to in-sample fills or exits.
  const holdoutAvailable = candles.length >= 200;
  const splitIndex = Math.floor(candles.length * 0.7);
  const inSample = holdoutAvailable ? {
    v1: runOne(candles, symbol, costs, "V1", { startIndex: 54, endIndex: splitIndex - 1 }),
    trendPullback: runOne(candles, symbol, costs, "TREND_PULLBACK", { startIndex: 54, endIndex: splitIndex - 1 })
  } : null;
  const outOfSample = holdoutAvailable ? {
    v1: runOne(candles, symbol, costs, "V1", { startIndex: splitIndex, endIndex: candles.length - 1 }),
    trendPullback: runOne(candles, symbol, costs, "TREND_PULLBACK", { startIndex: splitIndex, endIndex: candles.length - 1 })
  } : null;
  const oosRecommendation = !outOfSample ? "NEED_AT_LEAST_200_CANDLES" :
    outOfSample.v1.summary.trades < 5 || outOfSample.trendPullback.summary.trades < 5
      ? "INSUFFICIENT_OUT_OF_SAMPLE_TRADES"
      : outOfSample.trendPullback.summary.expectancyR > outOfSample.v1.summary.expectancyR
        ? "TREND_PULLBACK_BETTER_ON_HOLDOUT_ONLY"
        : outOfSample.trendPullback.summary.expectancyR < outOfSample.v1.summary.expectancyR
          ? "V1_BETTER_ON_HOLDOUT_ONLY" : "TIE_ON_HOLDOUT_ONLY";
  return {
    ok: true, mode: "offline_comparison_only", liveTradingChanged: false,
    symbol, timeframe: "M5", candles: candles.length,
    evaluationSplit: holdoutAvailable ? {
      method: "chronological_70_30",
      inSampleRange: { startIndex: 54, endIndex: splitIndex - 1, candles: splitIndex - 54 },
      outOfSampleRange: { startIndex: splitIndex, endIndex: candles.length - 1, candles: candles.length - splitIndex },
      outOfSampleRecommendation: oosRecommendation,
      deploymentRecommendation: "DO_NOT_SWITCH_FROM_THIS_REPORT_ALONE"
    } : {
      method: "not_available",
      requiredCandles: 200,
      reason: "At least 200 candles are required to reserve a meaningful chronological holdout."
    },
    inSampleResults: inSample ? {
      v1: inSample.v1.summary,
      trendPullback: inSample.trendPullback.summary
    } : null,
    outOfSampleResults: outOfSample ? {
      v1: outOfSample.v1.summary,
      trendPullback: outOfSample.trendPullback.summary
    } : null,
    costModel: "Explicit spread and per-side slippage in symbol price units; commission in R per completed trade. Broker-specific cost assumptions must be supplied.",
    assumptions: [
      "Both strategies see the same chronological candles and costs.",
      "Signals are generated at a candle close and enter no earlier than the next candle open.",
      "If stop and target are both touched in one candle, stop is assumed first (conservative).",
      "One open position per strategy at a time; no portfolio/correlation simulation.",
      "V1 quote freshness is synthesized for offline replay; live execution eligibility is not being tested."
    ],
    results: { v1: v1.summary, trendPullback: candidate.summary },
    skippedInvalidatedSetups: {
      v1: v1.skippedInvalidatedSetups,
      trendPullback: candidate.skippedInvalidatedSetups
    },
    comparison: {
      expectancyDeltaR: v1.summary.expectancyR === null || candidate.summary.expectancyR === null ? null : Number((candidate.summary.expectancyR - v1.summary.expectancyR).toFixed(4)),
      netRDelta: Number((candidate.summary.netR - v1.summary.netR).toFixed(3)),
      betterOnThisSample: candidate.summary.expectancyR === null || v1.summary.expectancyR === null ? "INSUFFICIENT_TRADES" : candidate.summary.expectancyR > v1.summary.expectancyR ? "TREND_PULLBACK" : candidate.summary.expectancyR < v1.summary.expectancyR ? "V1" : "TIE",
      deploymentRecommendation: "DO_NOT_SWITCH_FROM_THIS_REPORT_ALONE"
    },
    trades: { v1: v1.trades, trendPullback: candidate.trades }
  };
}
module.exports = { compareStrategies, candidateSignal };
