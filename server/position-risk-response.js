"use strict";

// Pure decision helpers used by the live position manager and unit tests.
// These functions never call cTrader and never submit orders.

function protectionIssues(position, direction = null, entry = null, current = null) {
  const tradeData = position?.tradeData || {};
  const rawSL = position?.stopLoss ?? tradeData.stopLoss;
  const rawTP = position?.takeProfit ?? tradeData.takeProfit;
  const sl = rawSL == null || rawSL === "" ? NaN : Number(rawSL);
  const tp = rawTP == null || rawTP === "" ? NaN : Number(rawTP);
  const sideValue = Number(tradeData.tradeSide ?? position?.tradeSide);
  const side = direction || (sideValue === 1 ? "BUY" : sideValue === 2 ? "SELL" : null);
  const rawEntry = entry ?? position?.price ?? tradeData.openPrice ?? tradeData.price ??
    position?.openPrice ?? tradeData.entryPrice;
  const e = rawEntry == null || rawEntry === "" ? NaN : Number(rawEntry);
  const rawCurrent = current ?? position?.currentPrice ?? tradeData.currentPrice;
  const market = rawCurrent == null || rawCurrent === "" ? NaN : Number(rawCurrent);
  const issues = [];
  if (!(Number.isFinite(sl) && sl > 0)) issues.push("MISSING_STOP_LOSS");
  if (!(Number.isFinite(tp) && tp > 0)) issues.push("MISSING_TAKE_PROFIT");
  if (!side) issues.push("TRADE_DIRECTION_UNAVAILABLE");
  if (side && (!Number.isFinite(market) || market <= 0)) issues.push("STOP_LOSS_MARKET_UNAVAILABLE");
  if (side && (!Number.isFinite(e) || e <= 0)) issues.push("ENTRY_PRICE_UNAVAILABLE");
  // A trailing SL may legitimately cross the entry price into profit. Check
  // it against current market, not entry, so valid profit-locking stops survive.
  if (Number.isFinite(sl) && sl > 0 && side === "BUY" && Number.isFinite(market) && sl >= market) issues.push("STOP_LOSS_NOT_BELOW_MARKET");
  if (Number.isFinite(sl) && sl > 0 && side === "SELL" && Number.isFinite(market) && sl <= market) issues.push("STOP_LOSS_NOT_ABOVE_MARKET");
  // Targets must remain on the favorable side of the original fill.
  if (Number.isFinite(tp) && tp > 0 && side === "BUY" && Number.isFinite(e) && tp <= e) issues.push("TAKE_PROFIT_NOT_ABOVE_ENTRY");
  if (Number.isFinite(tp) && tp > 0 && side === "SELL" && Number.isFinite(e) && tp >= e) issues.push("TAKE_PROFIT_NOT_BELOW_ENTRY");
  return issues;
}

function hasValidProtection(position, direction = null, entry = null, current = null) {
  return protectionIssues(position, direction, entry, current).length === 0;
}

function classifyPositionRisk(direction, entry, current) {
  const e = Number(entry);
  const c = Number(current);
  if (!["BUY", "SELL"].includes(direction) || !Number.isFinite(e) || e <= 0 ||
      !Number.isFinite(c) || c <= 0) return "UNKNOWN";
  const move = direction === "BUY" ? c - e : e - c;
  return move < 0 ? "ADVERSE" : "NORMAL";
}

function shouldExitOnReversal({ tracked, enabled, eligible, signal, direction } = {}) {
  return tracked === true && enabled === true && eligible === true &&
    ["BUY", "SELL"].includes(signal) && ["BUY", "SELL"].includes(direction) &&
    signal !== direction;
}

function isBrokerCloseConfirmed(result) {
  return result?.brokerConfirmed === true;
}

function shouldEmergencyCloseAfterProtectionFailure({ status, positionId } = {}) {
  return ["OPEN", "PARTIAL"].includes(status) &&
    positionId != null && String(positionId).trim() !== "";
}

function shouldImproveStop(direction, candidate, existingStop) {
  const next = Number(candidate);
  if (!["BUY", "SELL"].includes(direction) || !Number.isFinite(next) || next <= 0) return false;
  const old = existingStop == null || existingStop === "" ? NaN : Number(existingStop);
  if (!Number.isFinite(old) || old <= 0) return true;
  return direction === "BUY" ? next > old : next < old;
}

module.exports = {
  hasValidProtection,
  protectionIssues,
  classifyPositionRisk,
  shouldExitOnReversal,
  shouldEmergencyCloseAfterProtectionFailure,
  isBrokerCloseConfirmed,
  shouldImproveStop
};
