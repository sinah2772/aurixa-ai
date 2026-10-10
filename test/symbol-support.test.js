"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SUPPORTED_SYMBOLS,
  normalizeSymbolName,
  isSupportedSymbol,
  getSymbolProfile
} = require("../server/symbol-support");

test("the requested ten symbols are supported exactly", () => {
  assert.deepEqual(SUPPORTED_SYMBOLS, [
    "XAUUSD", "EURUSD", "NZDUSD", "USDCHF", "USDCAD",
    "AUDUSD", "USDJPY", "GBPUSD", "XAGUSD", "BTCUSD"
  ]);
  for (const symbol of SUPPORTED_SYMBOLS) assert.equal(isSupportedSymbol(symbol), true, symbol);
});

test("broker separators normalize without accepting suffix variants", () => {
  assert.equal(normalizeSymbolName("EUR/USD"), "EURUSD");
  assert.equal(normalizeSymbolName("usd_jpy"), "USDJPY");
  assert.equal(normalizeSymbolName("BITCOIN"), "BTCUSD");
  assert.equal(isSupportedSymbol("BITCOIN"), true);
  assert.equal(getSymbolProfile("BITCOIN"), getSymbolProfile("BTCUSD"));
  assert.equal(isSupportedSymbol("EUR/USD"), true);
  assert.equal(isSupportedSymbol("EURUSD.raw"), false);
  assert.equal(isSupportedSymbol("BTC"), false);
  assert.equal(isSupportedSymbol("ETHUSD"), false);
});

test("every supported symbol has a positive market-specific risk profile", () => {
  for (const symbol of SUPPORTED_SYMBOLS) {
    const profile = getSymbolProfile(symbol);
    assert.ok(profile, symbol);
    assert.ok(profile.minAtr > 0, symbol);
    assert.ok(profile.maxAtr > profile.minAtr, symbol);
    assert.ok(profile.maxSpread > 0, symbol);
    assert.ok(profile.stopBuffer > 0, symbol);
    assert.ok(profile.minStopAtr > 0, symbol);
  }
});

test("unsupported symbols have no profile", () => {
  assert.equal(getSymbolProfile("ETHUSD"), null);
});
