"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getMinimumStopDistance } = require("./broker-stop-distance");

test("converts cTrader point distances using symbol digits", () => {
  const result = getMinimumStopDistance({
    symbol: { slDistance: 25, tpDistance: 40, distanceSetIn: 1 },
    digits: 2
  });
  assert.equal(result.minStopDistance, 0.4);
  assert.equal(result.slDistancePrice, 0.25);
  assert.equal(result.tpDistancePrice, 0.4);
});

test("uses the available distance when only one cTrader constraint is present", () => {
  const result = getMinimumStopDistance({
    symbol: { slDistance: 15, distanceSetIn: 1 },
    digits: 3
  });
  assert.equal(result.minStopDistance, 0.015);
});

test("fails closed for percentage mode until broker scaling is verified", () => {
  const result = getMinimumStopDistance({
    symbol: { slDistance: 100, tpDistance: 50, distanceSetIn: 2 },
    digits: 2
  });
  assert.equal(result.minStopDistance, null);
  assert.equal(result.reason, "PERCENT_DISTANCE_UNIT_UNVERIFIED");
});

test("fails closed when broker SL/TP distance metadata is missing", () => {
  const result = getMinimumStopDistance({ symbol: { digits: 2 }, digits: 2 });
  assert.equal(result.minStopDistance, null);
  assert.equal(result.reason, "SL_TP_DISTANCE_METADATA_MISSING");
});

test("fails closed for unsupported distance units", () => {
  const result = getMinimumStopDistance({
    symbol: { slDistance: 10, tpDistance: 10, distanceSetIn: 9 },
    digits: 2
  });
  assert.equal(result.minStopDistance, null);
  assert.equal(result.reason, "UNSUPPORTED_DISTANCE_SET_IN");
});
