"use strict";

// Pure decision helpers used by the live position manager and unit tests.
// These functions never call cTrader and never submit orders.

function hasValidProtection(position, direction = null, entry = null) {
  const tradeData = position?.tradeData || {};
  const rawSL = position?.stopLoss ?? tradeData.stopLoss;
  const rawTP = position?.takeProfit ?? tradeData.takeProfit;
  const sl = rawSL == null || rawSL === "" ? NaN : Number(rawSL);
  const tp = rawTP == null || rawTP === "" ? NaN : Number(rawTP);
  if (!(Number.isFinite(sl) && sl > 0 && Number.isFinite(tp) && tp > 0)) return false;

  const side = direction || (Number(tradeData.tradeSide ?? position?.tradeSide) === 1
    ? "BUY"
    : Number(tradeData.tradeSide ?? position?.tradeSide) === 2 ? "SELL" : null);
  const rawEntry = entry ?? position?.price ?? tradeData.openPrice ?? tradeData.price ??
    position?.openPrice ?? tradeData.entryPrice;
  const e = rawEntry == null || rawEntry === "" ? NaN : Number(rawEntry);
  // If side/entry are available, presence alone is not enough: the stop and
  // target must protect the correct side of the actual fill price.
  if (side === "BUY" && Number.isFinite(e) && e > 0) return sl < e && tp > e;
  if (side === "SELL" && Number.isFinite(e) && e > 0) return sl > e && tp < e;
  return true;
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

function shouldImproveStop(direction, candidate, existingStop) {
  const next = Number(candidate);
  if (!["BUY", "SELL"].includes(direction) || !Number.isFinite(next) || next <= 0) return false;
  const old = existingStop == null || existingStop === "" ? NaN : Number(existingStop);
  if (!Number.isFinite(old) || old <= 0) return true;
  return direction === "BUY" ? next > old : next < old;
}

module.exports = {
  hasValidProtection,
  classifyPositionRisk,
  shouldExitOnReversal,
  isBrokerCloseConfirmed,
  shouldImproveStop
};
