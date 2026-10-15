"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const quality=require("../server/ai-quality-check-v2");
function candles(count=60){return Array.from({length:count},(_,i)=>({time:Date.now()-(count-i)*300000,open:100+i*.1,high:100.2+i*.1,low:99.9+i*.1,close:100.15+i*.1,volume:1}));}
test("observe-only diagnostics never mutate the V1 decision",()=>{
  const input=candles(),decision={engine:"AURIXA_AI_TRADER_V1",symbol:"XAUUSD",signal:"BUY",executionEligible:true,trend:"BULLISH",regime:"TREND_UP",momentum:.4,rsi:60,atr:1,ema9:105,entry:106};
  const before=JSON.stringify(decision),report=quality.observe(input,{bid:105.9,ask:106,lastUpdate:new Date().toISOString()},decision);
  assert.equal(JSON.stringify(decision),before);assert.equal(report.mode,"observe_only");assert.equal(report.signalObserved,"BUY");
  assert.equal(report.v1ExecutionEligible,true);assert.equal(report.executionDecisionUnaffected,true);
});
test("stale or invalid quotes are diagnostics only",()=>{
  const decision={symbol:"XAUUSD",signal:"SELL",executionEligible:true,atr:1};
  const report=quality.observe(candles(),{bid:100,ask:99,lastUpdate:"2000-01-01T00:00:00.000Z"},decision);
  assert.equal(report.checks.quoteShape.status,"warning");assert.equal(report.checks.quoteFreshness.status,"warning");
  assert.equal(report.v1ExecutionEligible,true);assert.equal(report.executionDecisionUnaffected,true);
});
test("insufficient history is flagged and protection is not assumed",()=>{
  const report=quality.observe(candles(10),{},{symbol:"EURUSD",signal:"WAIT",executionEligible:false});
  assert.ok(report.wouldFlag.includes("candleHistory"));assert.equal(report.checks.brokerProtection.status,"unknown");
});
test("broker protection requires explicit evidence",()=>{
  assert.equal(quality.observeExecution({executed:true}).brokerProtection,"NOT_CONFIRMED");
  assert.equal(quality.observeExecution({executed:true,protectionStatus:{verified:true}}).brokerProtection,"VERIFIED");
  assert.equal(quality.observeExecution({executed:true,protectionStatus:{verified:false}}).brokerProtection,"FAILED");
});
