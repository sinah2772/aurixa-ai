"use strict";

// Canonical symbols supported by AURIXA's multi-symbol execution path.
// Broker symbol IDs are discovered at runtime; never hard-code broker IDs.
const SUPPORTED_SYMBOLS = Object.freeze([
  "XAUUSD", "EURUSD", "NZDUSD", "USDCHF", "USDCAD",
  "AUDUSD", "USDJPY", "GBPUSD", "XAGUSD", "BTCUSD"
]);

const PROFILES = Object.freeze({
  XAUUSD: { minAtr: 0.8, maxAtr: 15, maxSpread: 0.60, stopBuffer: 0.25, minStopAtr: 1.2, digits: 2 },
  EURUSD: { minAtr: 0.00015, maxAtr: 0.02, maxSpread: 0.001, stopBuffer: 0.00005, minStopAtr: 1.2, digits: 5 },
  NZDUSD: { minAtr: 0.00015, maxAtr: 0.02, maxSpread: 0.0015, stopBuffer: 0.00005, minStopAtr: 1.2, digits: 5 },
  USDCHF: { minAtr: 0.00015, maxAtr: 0.02, maxSpread: 0.0015, stopBuffer: 0.00005, minStopAtr: 1.2, digits: 5 },
  USDCAD: { minAtr: 0.00015, maxAtr: 0.02, maxSpread: 0.0015, stopBuffer: 0.00005, minStopAtr: 1.2, digits: 5 },
  AUDUSD: { minAtr: 0.00015, maxAtr: 0.02, maxSpread: 0.0015, stopBuffer: 0.00005, minStopAtr: 1.2, digits: 5 },
  USDJPY: { minAtr: 0.015, maxAtr: 2.5, maxSpread: 0.05, stopBuffer: 0.005, minStopAtr: 1.2, digits: 3 },
  GBPUSD: { minAtr: 0.0002, maxAtr: 0.025, maxSpread: 0.002, stopBuffer: 0.00005, minStopAtr: 1.2, digits: 5 },
  XAGUSD: { minAtr: 0.02, maxAtr: 1.5, maxSpread: 0.08, stopBuffer: 0.01, minStopAtr: 1.2, digits: 3 },
  BTCUSD: { minAtr: 5, maxAtr: 5000, maxSpread: 100, stopBuffer: 1, minStopAtr: 1.2, digits: 2 }
});

function normalizeSymbolName(value) {
  const normalized = String(value || "").trim().toUpperCase().replace(/[\/\s_-]/g, "");
  // FxPro cTrader exposes its Bitcoin-vs-USD instrument as "BITCOIN".
  // Keep BTCUSD as AURIXA's canonical name while preserving the broker's
  // actual symbolName and symbolId for all cTrader requests.
  if (normalized === "BITCOIN") return "BTCUSD";
  return normalized;
}

function isSupportedSymbol(value) {
  return SUPPORTED_SYMBOLS.includes(normalizeSymbolName(value));
}

function getSymbolProfile(value) {
  const symbol = normalizeSymbolName(value);
  return PROFILES[symbol] || null;
}

module.exports = {
  SUPPORTED_SYMBOLS,
  normalizeSymbolName,
  isSupportedSymbol,
  getSymbolProfile
};
