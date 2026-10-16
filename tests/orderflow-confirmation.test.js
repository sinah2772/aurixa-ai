"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const of1 = require("../server/chris-creamer-orderflow");

test("OF1 fails closed when candle history is insufficient", () => {
  const result = of1.analyze([]);
  assert.equal(result.signal, "WAIT");
  assert.equal(result.dataReady, false);
  assert.equal(result.trueFootprint, false);
  assert.equal(result.gex, false);
});

test("OF1 never claims institutional footprint or GEX data from OHLC candles", () => {
  const candles = Array.from({ length: 20 }, (_, i) => ({
    time: 1_790_000_000_000 + i * 300_000,
    open: 2000 + i,
    high: 2002 + i,
    low: 1999 + i,
    close: 2001 + i,
    volume: 100 + i
  }));
  const result = of1.analyze(candles);
  assert.equal(result.signal, "WAIT");
  assert.equal(result.trueFootprint, false);
  assert.equal(result.gex, false);
});
