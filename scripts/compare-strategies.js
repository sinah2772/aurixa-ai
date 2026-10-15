"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { compareStrategies } = require("../server/strategy-comparison");

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/compare-strategies.js <dataset.json>");
  console.error("JSON shape: { symbol, costs: { spreadPrice, slippagePricePerSide, commissionRPerTrade }, candles: [{ time, open, high, low, close }] }");
  process.exit(2);
}
try {
  const input = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  const report = compareStrategies(input);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  console.error("Strategy comparison failed:", error.message);
  process.exit(1);
}
