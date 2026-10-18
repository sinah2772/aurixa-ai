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

test("converts percentage distances against a current reference price", () => {
  const result = getMinimumStopDistance({
    symbol: { slDistance: 100, tpDistance: 50, distanceSetIn: 2 },
    digits: 2,
    referencePrice: 50000
  });
  assert.equal(result.minStopDistance, 500);
  assert.equal(result.slDistancePrice, 500);
});

test("fails closed when percentage mode has no current reference price", () => {
  const result = getMinimumStopDistance({
    symbol: { slDistance: 100, tpDistance: 100, distanceSetIn: 2 },
    digits: 2
  });
  assert.equal(result.minStopDistance, null);
  assert.equal(result.reason, "REFERENCE_PRICE_REQUIRED_FOR_PERCENT_DISTANCE");
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
