"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateEntryCluster } = require("../server/entry-cluster-guard");

test("blocks same-direction position within default 0.25 percent price zone", () => {
  const result = evaluateEntryCluster({
    symbol: "BTCUSD",
    direction: "SELL",
    entry: 80945,
    positions: [{ positionId: 123, symbolName: "BTCUSD", tradeSide: 2, price: 80790 }]
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "SAME_DIRECTION_ENTRY_PRICE_ZONE_OCCUPIED");
  assert.equal(result.positionId, 123);
});

test("blocks using ATR zone when it is wider than percentage zone", () => {
  const result = evaluateEntryCluster({
    symbol: "BTCUSD",
    direction: "SELL",
    entry: 81000,
    atr: 500,
    positions: [{ positionId: 7, tradeSide: 2, price: 80750 }]
  });
  assert.equal(result.allowed, false);
  assert.equal(result.zone, 250);
});

test("does not block opposite-direction positions", () => {
  const result = evaluateEntryCluster({
    symbol: "BTCUSD",
    direction: "BUY",
    entry: 81000,
    positions: [{ positionId: 7, tradeSide: 2, price: 81010 }]
  });
  assert.equal(result.allowed, true);
});

test("does not block same direction outside the entry zone", () => {
  const result = evaluateEntryCluster({
    symbol: "BTCUSD",
    direction: "SELL",
    entry: 81000,
    positions: [{ positionId: 7, tradeSide: 2, price: 80700 }]
  });
  assert.equal(result.allowed, true);
});

test("ignores positions explicitly belonging to another symbol", () => {
  const result = evaluateEntryCluster({
    symbol: "BTCUSD",
    direction: "SELL",
    entry: 81000,
    positions: [{ positionId: 7, symbolName: "XAUUSD", tradeSide: 2, price: 81010 }]
  });
  assert.equal(result.allowed, true);
});

test("fails open only when candidate entry is not usable, leaving existing gates to reject it", () => {
  const result = evaluateEntryCluster({
    symbol: "BTCUSD",
    direction: "SELL",
    entry: NaN,
    positions: [{ positionId: 7, tradeSide: 2, price: 81000 }]
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "ENTRY_CLUSTER_CHECK_NOT_APPLICABLE");
});
