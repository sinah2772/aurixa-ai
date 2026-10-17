"use strict";

function evaluatePlannedRewardRisk({ signal, entry, stop, target, digits = 2, minRewardRisk = 2 }) {
  const signalEntry = Number(entry);
  const stopPrice = Number(stop);
  const targetPrice = Number(target);
  const precision = Number.isInteger(digits) ? Math.max(0, Math.min(10, digits)) : 2;
  const minimum = Number(minRewardRisk);
  const riskDistance = Math.abs(signalEntry - stopPrice);
  const rewardDistance = Math.abs(targetPrice - signalEntry);
  const priceTick = 10 ** (-precision);
  const requiredReward = riskDistance * minimum;
  const rewardShortfall = requiredReward - rewardDistance;
  const tickTolerance = priceTick + Math.max(1e-10, priceTick * 1e-8);
  const plannedRR = rewardDistance / Math.max(Number.EPSILON, riskDistance);
  const roundedToTickOnly = rewardShortfall > 0 && rewardShortfall <= tickTolerance;
  const valid = Number.isFinite(signalEntry) && signalEntry > 0
    && Number.isFinite(stopPrice) && Number.isFinite(targetPrice)
    && Number.isFinite(riskDistance) && riskDistance > 0
    && Number.isFinite(rewardDistance) && rewardDistance > 0
    && Number.isFinite(minimum) && minimum > 0;
  return {
    allowed: valid && (plannedRR >= minimum || roundedToTickOnly),
    signalRiskDistance: riskDistance,
    signalTargetDistance: rewardDistance,
    signalRR: plannedRR,
    signalRewardShortfall: rewardShortfall,
    priceTick,
    tickTolerance,
    roundedToTickOnly,
    minRewardRisk: minimum
  };
}

function normalizeTargetPrice({ signal, entry, stop, digits = 2, minRewardRisk = 2 }) {
  const precision = Number.isInteger(digits) ? Math.max(0, Math.min(10, digits)) : 2;
  const tick = 10 ** (-precision);
  const riskDistance = Math.abs(Number(entry) - Number(stop));
  if (!Number.isFinite(riskDistance) || riskDistance <= 0 ||
      !Number.isFinite(Number(entry)) || Number(entry) <= 0 ||
      !["BUY", "SELL"].includes(signal)) {
    throw new Error("INVALID_REWARD_RISK_TARGET_INPUT");
  }
  const rawTarget = Number(entry) + (signal === "BUY" ? 1 : -1) * riskDistance * Number(minRewardRisk);
  const tickUnits = rawTarget / tick;
  const roundedUnits = signal === "BUY"
    ? Math.ceil(tickUnits - 1e-9)
    : Math.floor(tickUnits + 1e-9);
  return Number((roundedUnits * tick).toFixed(precision));
}

module.exports = { evaluatePlannedRewardRisk, normalizeTargetPrice };
