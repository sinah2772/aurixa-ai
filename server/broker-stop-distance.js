"use strict";

// Convert cTrader ProtoOASymbol stop distances into absolute price distances.
// ProtoOASymbol.slDistance/tpDistance use distanceSetIn:
// 1 = points (one point is 10^-digits); 2 = percentage of price.
// Percentage mode is deliberately fail-closed until the broker's exact scaling
// convention is verified from live symbol metadata; never guess a stop distance.
function getMinimumStopDistance({ symbol = {}, digits } = {}) {
  const mode = Number(symbol.distanceSetIn ?? 1);
  const priceDigits = Number(digits ?? symbol.digits);
  const slRaw = symbol.slDistance == null ? null : Number(symbol.slDistance);
  const tpRaw = symbol.tpDistance == null ? null : Number(symbol.tpDistance);
  const validDistance = value => value !== null && Number.isFinite(value) && value >= 0;

  if (!validDistance(slRaw) && !validDistance(tpRaw)) {
    return { minStopDistance: null, reason: "SL_TP_DISTANCE_METADATA_MISSING", mode };
  }
  if (mode !== 1) {
    return {
      minStopDistance: null,
      reason: mode === 2 ? "PERCENT_DISTANCE_UNIT_UNVERIFIED" : "UNSUPPORTED_DISTANCE_SET_IN",
      mode
    };
  }
  if (!Number.isInteger(priceDigits) || priceDigits < 0 || priceDigits > 10) {
    return { minStopDistance: null, reason: "SYMBOL_DIGITS_UNAVAILABLE", mode };
  }

  const toPrice = value => value * Math.pow(10, -priceDigits);
  const distances = [slRaw, tpRaw].filter(validDistance).map(toPrice);
  if (!distances.length || distances.some(value => !Number.isFinite(value) || value < 0)) {
    return { minStopDistance: null, reason: "INVALID_SL_TP_DISTANCE_METADATA", mode };
  }
  return {
    minStopDistance: Math.max(...distances),
    slDistancePrice: validDistance(slRaw) ? toPrice(slRaw) : null,
    tpDistancePrice: validDistance(tpRaw) ? toPrice(tpRaw) : null,
    slDistanceRaw: slRaw,
    tpDistanceRaw: tpRaw,
    distanceSetIn: mode,
    digits: priceDigits,
    source: "ctrader-symbol-slDistance-tpDistance"
  };
}

module.exports = { getMinimumStopDistance };
