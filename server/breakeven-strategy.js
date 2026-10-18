"use strict";

// Cost-aware breakeven management for AURIXA tracked positions.
// Spread is the observable price-side allowance; commissions and swap are not
// available in a consistently normalized per-price-unit form here.
function finitePositive(value) {
  if (value === null || value === undefined || value === "") return NaN;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

function evaluateBreakeven({
  direction,
  entryPrice,
  currentPrice,
  initialRisk,
  triggerR = 1,
  bid,
  ask,
  existingStopLoss
} = {}) {
  const side = String(direction || "").toUpperCase();
  const entry = finitePositive(entryPrice);
  const current = finitePositive(currentPrice);
  const risk = finitePositive(initialRisk);
  const trigger = Number(triggerR);
  const rawBid = finitePositive(bid);
  const rawAsk = finitePositive(ask);
  const rawStop = finitePositive(existingStopLoss);
  const validDirection = side === "BUY" || side === "SELL";
  const valid = validDirection && Number.isFinite(entry) &&
    Number.isFinite(current) && Number.isFinite(risk) &&
    Number.isFinite(trigger) && trigger > 0;
  if (!valid) {
    return {
      valid: false, triggered: false, shouldMove: false, alreadyProtected: false,
      targetStopLoss: null, spreadAllowance: 0, favorableMove: null,
      reason: "BREAKEVEN_INPUT_UNAVAILABLE"
    };
  }

  const favorableMove = side === "BUY" ? current - entry : entry - current;
  const triggerDistance = risk * trigger;
  const spreadAllowance = Number.isFinite(rawBid) && Number.isFinite(rawAsk) && rawAsk >= rawBid
    ? rawAsk - rawBid : 0;
  const targetStopLoss = side === "BUY"
    ? entry + spreadAllowance
    : entry - spreadAllowance;
  const triggered = favorableMove >= triggerDistance;
  const alreadyProtected = Number.isFinite(rawStop) && rawStop > 0 &&
    (side === "BUY"
      ? rawStop >= targetStopLoss - 1e-8
      : rawStop <= targetStopLoss + 1e-8);
  const improves = !Number.isFinite(rawStop) ||
    (side === "BUY" ? targetStopLoss > rawStop + 1e-8 : targetStopLoss < rawStop - 1e-8);
  const shouldMove = triggered && !alreadyProtected && improves;
  return {
    valid: true, triggered, shouldMove, alreadyProtected,
    targetStopLoss, spreadAllowance, favorableMove, triggerDistance,
    reason: !triggered ? "PROFIT_BELOW_BREAKEVEN_TRIGGER"
      : alreadyProtected ? "STOP_ALREADY_AT_OR_BEYOND_COST_AWARE_BREAKEVEN"
      : shouldMove ? "BREAKEVEN_TRIGGER_REACHED"
      : "BREAKEVEN_STOP_WOULD_NOT_IMPROVE_EXISTING_STOP"
  };
}

module.exports = { evaluateBreakeven };
