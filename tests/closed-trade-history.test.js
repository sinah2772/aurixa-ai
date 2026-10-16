"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizeRealizedClosingDeals } = require("../server/auto-trader");

test("closed trade summary aggregates only filled closing deals and preserves realized zero", () => {
  const summary = summarizeRealizedClosingDeals([
    {
      positionId: 42,
      dealStatus: 1,
      executionTimestamp: 1790000000000,
      executionPrice: 100.25,
      moneyDigits: 2,
      closePositionDetail: { grossProfit: 1250, swap: -25, commission: -25, pnlConversionFee: 0 }
    },
    {
      positionId: 42,
      dealStatus: 1,
      executionTimestamp: 1790000005000,
      executionPrice: 100.5,
      moneyDigits: 2,
      closePositionDetail: { grossProfit: 500, swap: 0, commission: 0, pnlConversionFee: 0 }
    },
    {
      positionId: 42,
      dealStatus: 3,
      executionTimestamp: 1790000006000,
      executionPrice: 999,
      moneyDigits: 2,
      closePositionDetail: { grossProfit: 99999 }
    },
    {
      positionId: 99,
      dealStatus: 1,
      executionTimestamp: 1790000007000,
      executionPrice: 999,
      moneyDigits: 2,
      closePositionDetail: { grossProfit: 99999 }
    }
  ], 42);

  assert.equal(summary.closingDeals, 2);
  assert.equal(summary.profit, 17);
  assert.equal(summary.closePrice, 100.5);
  assert.equal(summary.closedAt.toISOString(), "2026-09-21T00:00:05.000Z");
});

test("closed trade summary leaves missing broker P/L unavailable rather than estimating it", () => {
  const summary = summarizeRealizedClosingDeals([
    { positionId: 7, dealStatus: 1, executionTimestamp: 1790000000000, executionPrice: 2000, closePositionDetail: {} }
  ], 7);

  assert.equal(summary.closingDeals, 1);
  assert.equal(summary.closePrice, 2000);
  assert.equal(summary.profit, null);
});

test("no verified closing deals returns null realized values", () => {
  assert.deepEqual(
    summarizeRealizedClosingDeals([{ positionId: 7, dealStatus: 3, closePositionDetail: { grossProfit: 100 } }], 7),
    { profit: null, closePrice: null, closedAt: null, closingDeals: 0 }
  );
});
