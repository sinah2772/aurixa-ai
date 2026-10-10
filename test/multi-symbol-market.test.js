"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const markets = require("../server/multi-symbol-market");

test("broker-discovered markets keep independent quotes and M5 history", () => {
  markets.registerSymbols([
    { symbolName: "EURUSD", canonicalName: "EURUSD", symbolId: 11, digits: 5 },
    { symbolName: "BITCOIN", canonicalName: "BTCUSD", symbolId: 12, digits: 2 }
  ]);
  const candles = Array.from({ length: 60 }, (_, i) => ({
    time: 1_800_000_000 + i * 5,
    open: 1.1 + i * 0.00001,
    high: 1.101 + i * 0.00001,
    low: 1.099 + i * 0.00001,
    close: 1.1005 + i * 0.00001,
    volume: 1
  }));
  markets.setHistory("EURUSD", candles);
  markets.setHistory("BITCOIN", candles);
  markets.updateQuote(11, 1.1, 1.1002);
  markets.updateQuote("BTCUSD", 65000, 65010);

  const eur = markets.getSnapshot("EURUSD");
  const btc = markets.getSnapshot("BTCUSD");
  assert.equal(eur.symbolId, 11);
  assert.equal(eur.bid, 1.1);
  assert.equal(eur.candles.length, 60);
  assert.equal(btc.symbolName, "BITCOIN");
  assert.equal(btc.symbolId, 12);
  assert.equal(btc.bid, 65000);
  assert.equal(btc.candles.length, 60);
  assert.notEqual(eur.bid, btc.bid);
});

test("unknown broker symbols are never registered for execution", () => {
  markets.registerSymbols([{ symbolName: "ETHUSD", canonicalName: "ETHUSD", symbolId: 99 }]);
  assert.equal(markets.getSnapshot("ETHUSD"), null);
});
