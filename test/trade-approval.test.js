"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const autoTrader = require("../server/auto-trader");

test("trade approval rejects invalid IDs without touching execution", async () => {
  let calls = 0;
  autoTrader.configure({ ctrader: { placeDemoMarketOrder: async () => { throw new Error("must not execute"); } },
    query: async () => { calls++; return { rows: [] }; }, ai: {} });
  const result = await autoTrader.resolveTradeApproval("not-an-id", "approve");
  assert.deepEqual(result, { ok: false, error: "INVALID_APPROVAL_ID" });
  assert.equal(calls, 0);
});

test("trade approval accepts only approve/reject actions", async () => {
  let calls = 0;
  autoTrader.configure({ ctrader: { placeDemoMarketOrder: async () => { throw new Error("must not execute"); } },
    query: async () => { calls++; return { rows: [] }; }, ai: {} });
  const result = await autoTrader.resolveTradeApproval("12", "execute");
  assert.deepEqual(result, { ok: false, error: "INVALID_APPROVAL_ACTION" });
  assert.equal(calls, 0);
});

test("rejecting an expired or already-resolved proposal never submits an order", async () => {
  const statements = [];
  let orders = 0;
  autoTrader.configure({
    ctrader: { placeDemoMarketOrder: async () => { orders++; throw new Error("must not execute"); } },
    query: async (sql, params) => {
      statements.push({ sql, params });
      if (sql.includes("SET status='REJECTED'")) return { rows: [] };
      return { rows: [] };
    },
    ai: {}
  });
  const result = await autoTrader.resolveTradeApproval("12", "reject");
  assert.deepEqual(result, { ok: false, error: "APPROVAL_EXPIRED_OR_ALREADY_RESOLVED" });
  assert.match(statements[0].sql, /status='PENDING'/);
  assert.match(statements[0].sql, /expires_at>NOW\(\)/);
  assert.equal(orders, 0);
});

test("approval queue expires stale proposals and returns only pending proposal fields", async () => {
  const statements = [];
  autoTrader.configure({
    query: async sql => {
      statements.push(sql);
      if (sql.startsWith("SELECT id,symbol,direction")) {
        return { rows: [{ id: "5", symbol: "XAUUSD", direction: "BUY", entry: "2000.1" }] };
      }
      return { rows: [] };
    },
    ctrader: {},
    ai: {}
  });
  const approvals = await autoTrader.getPendingTradeApprovals();
  assert.equal(approvals.length, 1);
  assert.match(statements[0], /status='EXPIRED'/);
  assert.match(statements[1], /status='PENDING'/);
  assert.doesNotMatch(statements[1], /decision_json/);
});
