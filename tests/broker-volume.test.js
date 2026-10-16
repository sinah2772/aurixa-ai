"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeVolume, isValidVolume } = require("../server/broker-volume");

test("volume steps are anchored to broker minimum, not zero", () => {
  const rules = { minVolume: 1500, stepVolume: 1000, maxVolume: 4500 };
  assert.equal(normalizeVolume(3499, rules), 2500);
  assert.equal(isValidVolume(1500, rules), true);
  assert.equal(isValidVolume(2500, rules), true);
  assert.equal(isValidVolume(2000, rules), false);
});

test("volume is zero when risk sizing is below broker minimum", () => {
  assert.equal(normalizeVolume(1499, { minVolume: 1500, stepVolume: 1000, maxVolume: 4500 }), 0);
});

test("volume is capped and aligned to the last valid increment", () => {
  const rules = { minVolume: 1500, stepVolume: 1000, maxVolume: 4000 };
  assert.equal(normalizeVolume(9000, rules), 3500);
  assert.equal(isValidVolume(4500, rules), false);
});

test("invalid broker constraints fail closed", () => {
  assert.equal(normalizeVolume(2000, { minVolume: 0, stepVolume: 1000, maxVolume: 5000 }), 0);
  assert.equal(isValidVolume(2000, { minVolume: 1000, stepVolume: 0, maxVolume: 5000 }), false);
});
