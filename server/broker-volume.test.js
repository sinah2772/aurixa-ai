"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const brokerVolume = require("./broker-volume");

test("risk-sized volume can reach broker minimum when no smaller explicit cap is set", () => {
  const rules = { minVolume: 100000, stepVolume: 10000, maxVolume: 1000000 };
  const defaultCap = Number.MAX_SAFE_INTEGER;
  const configuredMax = Math.min(defaultCap, rules.maxVolume);
  assert.equal(brokerVolume.normalizeVolume(150000, rules, configuredMax), 150000);
});

test("volume remains rejected when risk sizing cannot afford broker minimum", () => {
  const rules = { minVolume: 100000, stepVolume: 10000, maxVolume: 1000000 };
  const defaultCap = Number.MAX_SAFE_INTEGER;
  const configuredMax = Math.min(defaultCap, rules.maxVolume);
  assert.equal(brokerVolume.normalizeVolume(90000, rules, configuredMax), 0);
});

test("an explicitly configured cap below broker minimum remains a hard safety gate", () => {
  const rules = { minVolume: 100000, stepVolume: 10000, maxVolume: 1000000 };
  assert.equal(brokerVolume.normalizeVolume(150000, rules, 50000), 0);
});
