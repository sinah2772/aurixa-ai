"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");

test("frontend JavaScript parses", () => {
  assert.doesNotThrow(() => new Function(read("web/app.js")));
  assert.doesNotThrow(() => new Function(read("web/manual-control.js")));
  assert.doesNotThrow(() => new Function(read("web/auto-trade-candidate.js")));
  assert.doesNotThrow(() => new Function(read("server/server.js")));
});

test("HTML element IDs are unique", () => {
  const html = read("web/index.html");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual(duplicates, []);
});

test("position polling never fabricates trading authorization", () => {
  const app = read("web/app.js");
  const start = app.indexOf("async function refreshOpenTrades()");
  const end = app.indexOf("async function refreshLiveChart()", start);
  assert.ok(start >= 0 && end > start);
  const fastPoll = app.slice(start, end);
  assert.equal(fastPoll.includes("updateAutoTrader("), false);
  assert.equal(fastPoll.includes("authorized: true"), false);
  assert.equal(fastPoll.includes("connected: true"), false);
  assert.equal(fastPoll.includes("enabled: true"), false);
});

test("positions endpoint has one dedicated fast-poll owner", () => {
  const app = read("web/app.js");
  const refreshStart = app.indexOf("async function refresh()");
  const refreshEnd = app.indexOf("let openTradesRefreshBusy", refreshStart);
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);
  assert.doesNotMatch(app.slice(refreshStart, refreshEnd), /getJSON\(API\.autoPositions\)/);
  assert.match(app.slice(refreshEnd), /getJSON\(API\.autoPositions\)/);
});

test("scanner labels market-data readiness separately from entry approval", () => {
  const manual = read("web/manual-control.js");
  assert.match(manual, /MARKETS WITH DATA READY/);
  assert.match(manual, /DATA READY DOES NOT MEAN ENTRY APPROVED/);
  assert.match(manual, /"DATA READY" : "DATA WAIT"/);
});

test("frontend has a visible stale-data indicator", () => {
  const html = read("web/index.html");
  const app = read("web/app.js");
  assert.match(html, /id="frontendDataFreshness"/);
  assert.match(app, /DATA PARTIAL \/ STALE/);
  assert.match(app, /STATUS UNAVAILABLE/);
});

test("signal and closed-trade history identify their symbol", () => {
  const app = read("web/app.js");
  assert.match(app, /rowSymbol/);
  assert.match(app, /tradeSymbol/);
  assert.match(app, /aiDecisionSymbol/);
});


test("auto-trade candidate panel distinguishes AI eligibility from broker position confirmation", () => {
  const html = read("web/index.html");
  const app = read("web/app.js");
  const candidate = read("web/auto-trade-candidate.js");
  const css = read("web/multi-market-ui.css");
  for (const id of ["candidateSymbol", "candidateDirection", "candidateApproval", "candidateAutoStatus", "candidateBrokerStatus", "candidateReason"]) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(candidate, /candidateSymbol/);
  assert.match(candidate, /candidateBrokerStatus/);
  assert.match(app, /function updateAutoTradeCandidate/);
  assert.doesNotMatch(app, /updateAutoTradeCandidate\(liveAi, ctrader, autoStatus, autoPositions\)/);
  assert.match(candidate, /executionStatus/);
  assert.match(candidate, /NOT SUBMITTED · ENTRY NOT APPROVED/);
  assert.match(css, /\.auto-candidate-grid/);
  assert.match(html, /scans supported markets independently/i);
});


test("auto-trade candidate panel reflects per-symbol scanner decisions and broker execution", () => {
  const html = read("web/index.html");
  const frontend = read("web/auto-trade-candidate.js");
  const server = read("server/server.js");
  const app = read("web/app.js");
  assert.match(html, /id="candidateSymbol"/);
  assert.match(html, /id="candidateApproval"/);
  assert.match(html, /id="candidateBrokerStatus"/);
  assert.match(html, /id="autoCandidateList"/);
  assert.match(html, /auto-trade-candidate\.js/);
  assert.match(frontend, /\/api\/auto-trader\/candidate/);
  assert.match(server, /app\.get\("\/api\/auto-trader\/candidate"/);
  assert.match(server, /latestAutoTradeCandidates\.set\(symbol, candidate\)/);
  assert.match(server, /ORDER ACCEPTED BY BROKER/);
  assert.match(frontend, /STALE · WAITING FOR REFRESH/);
  assert.doesNotMatch(app, /updateAutoTradeCandidate\(liveAi, ctrader, autoStatus, autoPositions\)/);
});

test("candidate status distinguishes strategy approval from an accepted broker order", () => {
  const html = read("web/index.html");
  const frontend = read("web/auto-trade-candidate.js");
  const server = read("server/server.js");
  assert.match(html, /Chart selection is separate from auto-trade candidate selection/i);
  assert.match(html, /This panel does not enable auto-trading/i);
  assert.match(frontend, /NOT SUBMITTED · ENTRY NOT APPROVED/);
  assert.match(frontend, /executionStatus/);
  assert.match(server, /selectedForAutoTrade/);
  assert.match(server, /AUTO_TRADING_OFF/);
});
