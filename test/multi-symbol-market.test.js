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
    time: 29_000_000 + i * 5,
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


test("partial spot updates refresh only the received side; stale opposite side blocks readiness", () => {
  markets.registerSymbols([{ symbolName: "GBPUSD", canonicalName: "GBPUSD", symbolId: 13 }]);
  const old = Date.now() - 60000;
  markets.updateQuote(13, 1.25, 1.2502, old);
  assert.equal(markets.getSnapshot("GBPUSD").quoteFresh, false);

  markets.updateQuote(13, undefined, undefined, Date.now());
  assert.equal(markets.getSnapshot("GBPUSD").quoteFresh, false);

  const bidTime = Date.now();
  markets.updateQuote(13, 1.251, undefined, bidTime);
  let snapshot = markets.getSnapshot("GBPUSD");
  assert.equal(snapshot.bid, 1.251);
  assert.equal(snapshot.ask, 1.2502);
  assert.equal(snapshot.quoteFresh, false, "fresh bid must not mask stale ask");

  markets.updateQuote(13, undefined, 1.2512, Date.now());
  snapshot = markets.getSnapshot("GBPUSD");
  assert.equal(snapshot.quoteFresh, true, "both bid and ask are now fresh");
});

test("out-of-order side updates cannot make a market quote fresh", () => {
  markets.registerSymbols([{ symbolName: "USDCHF", canonicalName: "USDCHF", symbolId: 14 }]);
  const now = Date.now();
  markets.updateQuote(14, 0.9, 0.9002, now);
  markets.updateQuote(14, 0.899, undefined, now - 60000);
  const snapshot = markets.getSnapshot("USDCHF");
  assert.equal(snapshot.bid, 0.9);
  assert.equal(snapshot.quoteFresh, true);
});
