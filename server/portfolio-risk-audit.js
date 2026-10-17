"use strict";

// Read-only portfolio risk audit. This module never submits, modifies, or closes orders.
function buildPortfolioRiskAudit({ positions, dailyTradeCount, maxOpenPositions = 0, maxTradesPerDay = 0, dailyLimitEnabled = false }) {
  const validPositions = Array.isArray(positions);
  const daily = Number(dailyTradeCount);
  const maxOpen = Number(maxOpenPositions);
  const maxDaily = Number(maxTradesPerDay);
  const reasons = [];
  if (!validPositions) reasons.push("BROKER_POSITION_SNAPSHOT_UNAVAILABLE");
  if (!Number.isInteger(daily) || daily < 0) reasons.push("DAILY_TRADE_COUNT_UNAVAILABLE");
  const openCount = validPositions ? positions.length : null;
  if (validPositions && maxOpen > 0 && openCount >= maxOpen) reasons.push("MAX_OPEN_POSITIONS_REACHED");
  if (dailyLimitEnabled && maxDaily > 0 && Number.isInteger(daily) && daily >= maxDaily) reasons.push("DAILY_TRADE_LIMIT_REACHED");
  return {
    mode: "OBSERVE_ONLY",
    canAssess: validPositions && Number.isInteger(daily) && daily >= 0,
    openPositionCount: openCount,
    maxOpenPositions: maxOpen > 0 ? maxOpen : null,
    dailyTradeCount: Number.isInteger(daily) && daily >= 0 ? daily : null,
    maxTradesPerDay: dailyLimitEnabled && maxDaily > 0 ? maxDaily : null,
    dailyLimitEnabled: Boolean(dailyLimitEnabled && maxDaily > 0),
    findings: reasons,
    orderActionsTaken: 0
  };
}
module.exports = { buildPortfolioRiskAudit };
