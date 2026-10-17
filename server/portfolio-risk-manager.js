"use strict";

// Deterministic portfolio gate. It has no broker or database side effects.
function evaluatePortfolioRisk({
  openPositionCount = null,
  dailyTradeCount = null,
  maxOpenPositions = 0,
  maxTradesPerDay = 0,
  enforceDailyLimit = false
}) {
  const maxOpen = Number(maxOpenPositions);
  const maxDaily = Number(maxTradesPerDay);
  const positionCapEnabled = Number.isInteger(maxOpen) && maxOpen > 0;
  const dailyCapEnabled = Boolean(enforceDailyLimit && Number.isInteger(maxDaily) && maxDaily > 0);

  if (positionCapEnabled) {
    if (!Number.isInteger(openPositionCount) || openPositionCount < 0) {
      return { allowed: false, reason: "PORTFOLIO_POSITION_SNAPSHOT_UNAVAILABLE" };
    }
    if (openPositionCount >= maxOpen) {
      return {
        allowed: false,
        reason: "MAX_OPEN_POSITIONS_REACHED",
        openPositionCount,
        maxOpenPositions: maxOpen
      };
    }
  }

  if (dailyCapEnabled) {
    if (!Number.isInteger(dailyTradeCount) || dailyTradeCount < 0) {
      return { allowed: false, reason: "DAILY_TRADE_COUNT_UNAVAILABLE" };
    }
    if (dailyTradeCount >= maxDaily) {
      return {
        allowed: false,
        reason: "DAILY_TRADE_LIMIT_REACHED",
        dailyTradeCount,
        maxTradesPerDay: maxDaily
      };
    }
  }

  return {
    allowed: true,
    reason: null,
    openPositionCount: Number.isInteger(openPositionCount) ? openPositionCount : null,
    maxOpenPositions: positionCapEnabled ? maxOpen : null,
    dailyTradeCount: Number.isInteger(dailyTradeCount) ? dailyTradeCount : null,
    dailyLimitEnforced: dailyCapEnabled,
    maxTradesPerDay: dailyCapEnabled ? maxDaily : null
  };
}

module.exports = { evaluatePortfolioRisk };
