"use strict";

const DEFAULT_ZONE_PERCENT = 0.25;
const DEFAULT_ATR_MULTIPLIER = 0.5;

function finitePositive(value) {
  if (value === null || value === undefined || value === "") return NaN;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : NaN;
}

function getPositionDirection(position) {
  const side = Number(position?.tradeData?.tradeSide ?? position?.tradeSide);
  if (side === 1) return "BUY";
  if (side === 2) return "SELL";
  const text = String(position?.direction ?? position?.side ?? "").toUpperCase();
  return text === "BUY" || text === "SELL" ? text : null;
}

function getPositionEntry(position) {
  return finitePositive(
    position?.price ??
    position?.tradeData?.openPrice ??
    position?.tradeData?.price ??
    position?.openPrice ??
    position?.tradeData?.entryPrice ??
    position?.entryPrice
  );
}

function evaluateEntryCluster({
  symbol,
  direction,
  entry,
  atr,
  positions,
  zonePercent,
  atrMultiplier
} = {}) {
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
  const normalizedDirection = String(direction ?? "").trim().toUpperCase();
  const candidateEntry = finitePositive(entry);
  const normalizedAtr = finitePositive(atr);
  const rawPercent = Number(zonePercent);
  const percent = Number.isFinite(rawPercent) && rawPercent > 0
    ? Math.min(rawPercent, 5)
    : DEFAULT_ZONE_PERCENT;
  const rawMultiplier = Number(atrMultiplier);
  const multiplier = Number.isFinite(rawMultiplier) && rawMultiplier > 0
    ? Math.min(rawMultiplier, 5)
    : DEFAULT_ATR_MULTIPLIER;

  if (!normalizedSymbol || !["BUY", "SELL"].includes(normalizedDirection) || !Number.isFinite(candidateEntry)) {
    return { allowed: true, reason: "ENTRY_CLUSTER_CHECK_NOT_APPLICABLE" };
  }

  const percentageZone = candidateEntry * percent / 100;
  const zone = Math.max(percentageZone, Number.isFinite(normalizedAtr) ? normalizedAtr * multiplier : 0);
  for (const position of Array.isArray(positions) ? positions : []) {
    const positionSymbol = String(position?.symbolName ?? position?.symbol ?? "").trim().toUpperCase();
    if (positionSymbol && positionSymbol !== normalizedSymbol) continue;
    if (getPositionDirection(position) !== normalizedDirection) continue;
    const positionEntry = getPositionEntry(position);
    if (!Number.isFinite(positionEntry)) continue;
    const distance = Math.abs(candidateEntry - positionEntry);
    if (distance <= zone) {
      return {
        allowed: false,
        reason: "SAME_DIRECTION_ENTRY_PRICE_ZONE_OCCUPIED",
        symbol: normalizedSymbol,
        direction: normalizedDirection,
        entry: candidateEntry,
        positionId: position?.positionId ?? position?.id ?? null,
        positionEntry,
        distance: Number(distance.toFixed(8)),
        zone: Number(zone.toFixed(8)),
        zonePercent: percent,
        atrMultiplier: multiplier
      };
    }
  }
  return {
    allowed: true,
    reason: "NO_SAME_DIRECTION_POSITION_IN_ENTRY_ZONE",
    symbol: normalizedSymbol,
    direction: normalizedDirection,
    entry: candidateEntry,
    zone: Number(zone.toFixed(8)),
    zonePercent: percent,
    atrMultiplier: multiplier
  };
}

module.exports = { evaluateEntryCluster, getPositionDirection, getPositionEntry };
