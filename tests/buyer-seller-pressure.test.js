"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const pressure = require("../server/buyer-seller-pressure");

test("pressure stays unavailable until enough valid quote movement arrives", () => {
  const symbol = "TEST_PRESSURE_WAIT";
  assert.equal(pressure.getSnapshot(symbol).pressureScore, null);
  pressure.observeQuote(symbol, 100, 100.1, Date.now() - 2000);
  pressure.observeQuote(symbol, 100.1, 100.2, Date.now() - 1000);
  const snapshot = pressure.getSnapshot(symbol);
  assert.equal(snapshot.mode, "OBSERVE_ONLY");
  assert.equal(snapshot.depthAvailable, false);
  assert.equal(snapshot.pressureType, "ESTIMATED_FROM_QUOTES_AND_CANDLES");
  assert.equal(snapshot.pressureScore, null);
});

test("pressure reports estimate only and never claims depth or executed volume", () => {
  const symbol = "TEST_PRESSURE_READY";
  const now = Date.now();
  pressure.observeQuote(symbol, 100, 100.1, now - 3000);
  pressure.observeQuote(symbol, 100.1, 100.2, now - 2000);
  pressure.observeQuote(symbol, 100.2, 100.3, now - 1000);
  const snapshot = pressure.getSnapshot(symbol);
  assert.equal(snapshot.mode, "OBSERVE_ONLY");
  assert.equal(snapshot.depthAvailable, false);
  assert.equal(snapshot.depthStatus, "NOT_CONNECTED");
  assert.equal(typeof snapshot.pressureScore, "number");
  assert.equal(snapshot.buyerPressure + snapshot.sellerPressure, 100);
  assert.ok(snapshot.warnings.some(w => w.includes("not real executed buyer/seller volume")));
});

test("invalid quotes are ignored", () => {
  const symbol = "TEST_PRESSURE_INVALID";
  assert.equal(pressure.observeQuote(symbol, 0, 1, Date.now()), false);
  assert.equal(pressure.observeQuote(symbol, 2, 1, Date.now()), false);
  assert.equal(pressure.getSnapshot(symbol).tickCount, 0);
});
