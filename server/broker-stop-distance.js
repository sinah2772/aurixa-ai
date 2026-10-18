"use strict";

// Convert cTrader ProtoOASymbol stop distances into absolute price distances.
// ProtoOASymbol.slDistance/tpDistance are interpreted according to distanceSetIn:
// 1 = points (one point is 10^-digits); 2 = percentage of current price.
// For percentage mode cTrader stores hundredths of a percent (100 = 1%).
function getMinimumStopDistance({ symbol = {}, digits, referencePrice } = {}) {
  const mode = Number(symbol.distanceSetIn ?? 1);
  const priceDigits = Number(digits ?? symbol.digits);
  const slRaw = symbol.slDistance == null ? null : Number(symbol.slDistance);
  const tpRaw = symbol.tpDistance == null ? null : Number(symbol.tpDistance);

  const validDistance = value => value !== null && Number.isFinite(value) && value >= 0;
  if (!validDistance(slRaw) && !validDistance(tpRaw)) {
    return { minStopDistance: null, reason: "SL_TP_DISTANCE_METADATA_MISSING", mode };
  }

  let toPrice;
  if (mode === 1) {
    if (!Number.isInteger(priceDigits) || priceDigits < 0 || priceDigits > 10) {
      return { minStopDistance: null, reason: "SYMBOL_DIGITS_UNAVAILABLE", mode };
    }
    toPrice = value => value * Math.pow(10, -priceDigits);
  } else if (mode === 2) {
    const price = Number(referencePrice);
    if (!Number.isFinite(price) || price <= 0) {
      return { minStopDistance: null, reason: "REFERENCE_PRICE_REQUIRED_FOR_PERCENT_DISTANCE", mode };
    }
    toPrice = value => price * value / 10000;
  } else {
    return { minStopDistance: null, reason: "UNSUPPORTED_DISTANCE_SET_IN", mode };
  }

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
    digits: Number.isInteger(priceDigits) ? priceDigits : null,
    referencePrice: mode === 2 ? Number(referencePrice) : null,
    source: "ctrader-symbol-slDistance-tpDistance"
  };
}

module.exports = { getMinimumStopDistance };
