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
