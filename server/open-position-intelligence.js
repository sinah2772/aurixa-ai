"use strict";

// Per-position decision logic. Pure evaluation only: execution and broker
// verification remain in auto-trader.js / ctrader.js.
const ACTIONS = Object.freeze(["HOLD", "PROTECT", "REDUCE", "CLOSE"]);

function finite(value) {
  if (value === null || value === undefined || value === "") return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function evaluatePosition(input = {}) {
  const {
    positionId = null, symbol = null, direction = null,
    entry: rawEntry, current: rawCurrent, pnl: rawPnl,
    stopLoss: rawStopLoss, takeProfit: rawTakeProfit,
    initialRisk: rawInitialRisk, quoteFresh = false,
    tracked = false, partialTaken = false, demoAccount = false,
    mainDecision = null, closeConfirmed = false, now = Date.now()
  } = input;
  const entry = finite(rawEntry);
  const current = finite(rawCurrent);
  const pnl = finite(rawPnl);
  const stopLoss = finite(rawStopLoss);
  const takeProfit = finite(rawTakeProfit);
  const configuredRisk = finite(rawInitialRisk);
  const initialRisk = Number.isFinite(configuredRisk) && configuredRisk > 0
    ? configuredRisk
    : (Number.isFinite(entry) && Number.isFinite(stopLoss) && stopLoss > 0
      ? Math.abs(entry - stopLoss) : NaN);
  const move = direction === "BUY" ? current - entry
    : direction === "SELL" ? entry - current : NaN;
  const rMultiple = Number.isFinite(move) && Number.isFinite(initialRisk) && initialRisk > 0
    ? move / initialRisk : null;
  const issues = [];
  if (!positionId) issues.push("POSITION_ID_UNAVAILABLE");
  if (!["BUY", "SELL"].includes(direction)) issues.push("DIRECTION_UNAVAILABLE");
  if (!Number.isFinite(entry) || entry <= 0) issues.push("ENTRY_PRICE_UNAVAILABLE");
  if (!Number.isFinite(current) || current <= 0) issues.push("CURRENT_PRICE_UNAVAILABLE");
  if (!Number.isFinite(pnl)) issues.push("BROKER_UNREALIZED_PNL_UNAVAILABLE");
  if (!quoteFresh) issues.push("QUOTE_STALE_OR_UNVERIFIED");

  const slMissing = !Number.isFinite(stopLoss) || stopLoss <= 0;
  const tpMissing = !Number.isFinite(takeProfit) || takeProfit <= 0;
  const slWrongSide = Number.isFinite(stopLoss) && Number.isFinite(current) &&
    (direction === "BUY" ? stopLoss >= current : direction === "SELL" ? stopLoss <= current : false);
  const tpWrongSide = Number.isFinite(takeProfit) && Number.isFinite(entry) &&
    (direction === "BUY" ? takeProfit <= entry : direction === "SELL" ? takeProfit >= entry : false);
  const protectionIssues = [];
  if (slMissing) protectionIssues.push("STOP_LOSS_MISSING");
  if (tpMissing) protectionIssues.push("TAKE_PROFIT_MISSING");
  if (slWrongSide) protectionIssues.push("STOP_LOSS_INVALID_FOR_MARKET");
  if (tpWrongSide) protectionIssues.push("TAKE_PROFIT_INVALID_FOR_ENTRY");

  const signal = String(mainDecision?.signal || "WAIT").toUpperCase();
  const confidence = finite(mainDecision?.confidence);
  const trend = String(mainDecision?.trend || "").toUpperCase();
  const opposingSignal = ["BUY", "SELL"].includes(signal) &&
    ["BUY", "SELL"].includes(direction) && signal !== direction;
  const trendAligned = (signal === "BUY" && trend === "BULLISH") ||
    (signal === "SELL" && trend === "BEARISH");
  const strategyEligible = mainDecision?.executionEligible === true &&
    opposingSignal && trendAligned && Number.isFinite(confidence) && confidence >= 70;
  const of1Confirmed = mainDecision?.signalConfirmation?.confirmed === true;
  const adverse = Number.isFinite(rMultiple) && rMultiple < 0;
  const result = (action, reason, extra = {}) => ({
    positionId, symbol, direction, action, reason, pnl: Number.isFinite(pnl) ? pnl : null,
    rMultiple: rMultiple === null ? null : Number(rMultiple.toFixed(3)),
    signal: signal || "WAIT", confidence: Number.isFinite(confidence) ? confidence : null,
    of1Confirmed, opposingSignal: strategyEligible, protectionIssues,
    quoteFresh: quoteFresh === true, demoAccount: demoAccount === true,
    tracked: tracked === true, checkedAt: new Date(now).toISOString(),
    brokerActionStatus: "NOT_REQUIRED", ...extra
  });

  // Never send automated position-changing commands if the account environment
  // is unknown/live, the quote is stale, or the position cannot be identified.
  if (!demoAccount) return result("HOLD", "DEMO_ACCOUNT_NOT_VERIFIED; no automated position action allowed");
  if (!positionId || !["BUY", "SELL"].includes(direction) ||
      !Number.isFinite(entry) || !Number.isFinite(current) || !quoteFresh) {
    return result("HOLD", issues.join(", ") || "LIVE_POSITION_DATA_INCOMPLETE");
  }
  if (protectionIssues.length) {
    return result("PROTECT", tracked
      ? "Broker SL/TP protection needs verification or repair"
      : "Broker protection issue detected; untracked position requires operator review");
  }
  if (closeConfirmed === true) {
    return result("CLOSE", "Opposing strategy signal passed the configured confirmation window");
  }

  // Partial reduction is intentionally conservative: only an AURIXA-tracked
  // position, a loss of at least 0.5R, an eligible opposite main-strategy signal,
  // and explicit OF1 confirmation can trigger it. Never reduce manual positions.
  if (tracked && !partialTaken && adverse && Number(rMultiple) <= -0.5 &&
      strategyEligible && of1Confirmed) {
    return result("REDUCE", "Loss reached 0.5R and opposing main-strategy direction is confirmed by OF1");
  }
  if (adverse && strategyEligible && !of1Confirmed) {
    return result("HOLD", "Opposing signal detected, but OF1 confirmation is incomplete; keep hard SL active");
  }
  if (adverse) {
    return result("HOLD", "Position is losing; no sufficiently confirmed invalidation. Keep broker SL active");
  }
  if (Number.isFinite(pnl) && pnl > 0) {
    return result("HOLD", "Position remains profitable; existing protection and trailing rules remain in control");
  }
  return result("HOLD", "Original position risk remains within the current decision rules");
}

module.exports = { ACTIONS, evaluatePosition };
