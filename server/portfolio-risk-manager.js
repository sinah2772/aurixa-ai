"use strict";

// Pure, deterministic portfolio gates. No broker calls and no order side effects.
function evaluatePortfolioRisk({
  openPositionCount,
  dailyTradeCount,
  maxOpenPositions = 0,
  maxTradesPerDay = 0,
  enforceDailyLimit = false
}) {
  const open = Number(openPositionCount);
  const daily = Number(dailyTradeCount);
  const maxOpen = Number(maxOpenPositions);
  const maxDaily = Number(maxTradesPerDay);

  if (!Number.isInteger(open) || open < 0) {
    return { allowed: false, reason: "PORTFOLIO_POSITION_SNAPSHOT_INVALID" };
  }
  if (!Number.isInteger(daily) || daily < 0) {
    return { allowed: false, reason: "PORTFOLIO_DAILY_COUNT_INVALID" };
  }
  if (maxOpen > 0 && open >= maxOpen) {
    return { allowed: false, reason: "MAX_OPEN_POSITIONS_REACHED", openPositionCount: open, maxOpenPositions: maxOpen };
  }
  if (enforceDailyLimit && maxDaily > 0 && daily >= maxDaily) {
    return { allowed: false, reason: "DAILY_TRADE_LIMIT_REACHED", dailyTradeCount: daily, maxTradesPerDay: maxDaily };
  }
  return {
    allowed: true,
    reason: null,
    openPositionCount: open,
    maxOpenPositions: maxOpen > 0 ? maxOpen : null,
    dailyTradeCount: daily,
    dailyLimitEnforced: Boolean(enforceDailyLimit && maxDaily > 0),
    maxTradesPerDay: enforceDailyLimit && maxDaily > 0 ? maxDaily : null
  };
}

module.exports = { evaluatePortfolioRisk };
