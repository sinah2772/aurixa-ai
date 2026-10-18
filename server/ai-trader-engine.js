"use strict";

/* AURIXA AI TRADER V1 — standalone strategy core.
 * Does not depend on retired OrderFlow or OR/FVG modules.
 * Produces an auditable decision; execution remains in the trade executor.
 */

const { normalizeSymbolName, isSupportedSymbol, getSymbolProfile } = require("./symbol-support");
const orderFlowOF1 = require("./chris-creamer-orderflow");
const rewardRisk = require("./reward-risk");

const MIN_BARS = 50;
const MIN_CONFIDENCE = Math.max(55, Math.min(90, Number(process.env.AI_MIN_CONFIDENCE || 65)));
const MIN_RR = Math.max(1.5, Number(process.env.AI_MIN_RR || 2));

function n(v){const x=Number(v);return Number.isFinite(x)?x:null;}
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function ema(values,p){
  if(values.length<p)return null;
  const k=2/(p+1); let e=values.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for(let i=p;i<values.length;i++)e=values[i]*k+e*(1-k);
  return e;
}
function atr(c,p=14){
  if(c.length<p+1)return null; const tr=[];
  for(let i=1;i<c.length;i++){const x=c[i],q=c[i-1];tr.push(Math.max(x.high-x.low,Math.abs(x.high-q.close),Math.abs(x.low-q.close)));}
  return tr.slice(-p).reduce((a,b)=>a+b,0)/p;
}
function rsi(v,p=14){
  if(v.length<=p)return null;let g=0,l=0;
  for(let i=v.length-p;i<v.length;i++){const d=v[i]-v[i-1];if(d>=0)g+=d;else l-=d;}
  if(l===0)return 100;return 100-(100/(1+(g/p)/(l/p)));
}
function wait(reason,extra={},symbol="XAUUSD"){return {engine:"AURIXA_AI_TRADER_V1",version:"1.4.0",symbol,timeframe:"M5",signal:"WAIT",confidence:0,executionEligible:false,blockedBy:[reason],reasons:[reason],...extra,generatedAt:new Date().toISOString()};}

// OF1's standalone entry signal requires every rare setup condition to pass.
// For confirmation of an already-qualified V1 signal, use OF1's directional
// context plus multiple independent structural checks. Never override V1.
function confirmOrderFlowDirection(mainSignal, confirmation) {
  if (mainSignal !== "BUY" && mainSignal !== "SELL") {
    return { status: "MAIN_STRATEGY_WAIT", confirmed: false, direction: null, evidenceCount: 0,
      reason: "Main strategy did not produce a directional signal" };
  }
  if (!confirmation || confirmation.dataReady !== true) {
    return { status: "OF1_DATA_UNAVAILABLE", confirmed: false, direction: null, evidenceCount: 0,
      reason: confirmation?.reason || "OF1 data is not ready" };
  }
  const direction = confirmation.direction ||
    confirmation.environment?.direction ||
    (confirmation.signal === "BUY" || confirmation.signal === "SELL" ? confirmation.signal : null);
  const checks = confirmation.confirmation || {};
  const evidence = [
    ["retracementZone", confirmation.fib?.inZone === true],
    ["outsideValueArea", checks.outsideValue === true],
    ["liquiditySweep", checks.liquiditySweep === true],
    ["displacement", checks.displacement === true],
    ["participation", checks.participation === true]
  ];
  const passed = evidence.filter(([, ok]) => ok).map(([name]) => name);
  const invalidated = confirmation.fib?.invalidated === true;
  const hasTrigger = checks.liquiditySweep === true || checks.displacement === true;
  if (invalidated) {
    return { status: "OF1_INVALIDATED", confirmed: false, direction, evidenceCount: passed.length,
      evidence: passed, reason: "OF1 retracement invalidation level was breached" };
  }
  // A raw OF1 directional label is not enough to veto the primary V1 strategy.
  // Require a real trigger plus at least two independent structural checks before
  // treating opposing OF1 context as a confirmed conflict. Weak/incomplete OF1
  // evidence remains visible to the operator but is diagnostic only.
  if (direction !== mainSignal) {
    const conflictConfirmed = Boolean(direction) && hasTrigger && passed.length >= 2;
    return {
      status: conflictConfirmed ? "DIRECTION_MISMATCH" : direction ? "OF1_CONFLICT_UNCONFIRMED" : "OF1_WAIT",
      confirmed: false,
      direction,
      evidenceCount: passed.length,
      evidence: passed,
      reason: conflictConfirmed
        ? `OF1 direction opposes ${mainSignal}; ${passed.length}/5 structural checks passed (${passed.join(", ")}), including a trigger`
        : direction
          ? `OF1 direction opposes ${mainSignal}, but evidence is incomplete (${passed.length}/5 checks; trigger ${hasTrigger ? "present" : "missing"}); conflict is diagnostic only`
          : "OF1 has no directional bias"
    };
  }
  const confirmed = hasTrigger && passed.length >= 2;
  return {
    status: confirmed ? "CONFIRMED" : "OF1_WAIT",
    confirmed,
    direction,
    evidenceCount: passed.length,
    evidence: passed,
    reason: confirmed
      ? `OF1 direction agrees; ${passed.length}/5 structural checks passed (${passed.join(", ")}); full OF1 entry signal: ${confirmation.signal || "WAIT"}`
      : !hasTrigger
          ? "OF1 needs a liquidity sweep or directional displacement"
          : `OF1 structural confirmation is incomplete: ${passed.length}/5 checks passed; need at least 2`
  };
}

function shouldBlockOnOF1(status) {
  return status === "DIRECTION_MISMATCH" || status === "OF1_INVALIDATED";
}

function detectFalseBreakout(candles, side, atrValue, lookback=24) {
  if ((side !== "BUY" && side !== "SELL") || !Array.isArray(candles) || candles.length < lookback + 2) {
    return { detected: false, reason: "INSUFFICIENT_BREAKOUT_CONTEXT", lookback, sweptLevel: null };
  }
  // Compare the newest candle against completed candles before it, never against
  // a range that already includes the candidate breakout candle.
  const latest = candles[candles.length - 1];
  const prior = candles.slice(-(lookback + 1), -1);
  if (!latest || ![latest.open, latest.high, latest.low, latest.close].every(v => n(v) !== null)) {
    return { detected: false, reason: "INVALID_BREAKOUT_CANDLE", lookback, sweptLevel: null };
  }
  const swingHigh = Math.max(...prior.map(c => Number(c.high)));
  const swingLow = Math.min(...prior.map(c => Number(c.low)));
  const buffer = Math.max(Number(atrValue) > 0 ? Number(atrValue) * 0.05 : 0, 0);
  const sweptHigh = Number(latest.high) > swingHigh + buffer;
  const sweptLow = Number(latest.low) < swingLow - buffer;
  const rejectedHigh = sweptHigh && Number(latest.close) < swingHigh;
  const rejectedLow = sweptLow && Number(latest.close) > swingLow;
  const detected = side === "BUY" ? rejectedHigh : rejectedLow;
  return {
    detected,
    reason: detected ? (side === "BUY" ? "RESISTANCE_SWEEP_CLOSED_BACK_INSIDE" : "SUPPORT_SWEEP_CLOSED_BACK_INSIDE") : "NO_DIRECTIONAL_FALSE_BREAKOUT",
    lookback,
    sweptLevel: detected ? (side === "BUY" ? swingHigh : swingLow) : null,
    swingHigh,
    swingLow,
    buffer,
    candleClose: Number(latest.close)
  };
}

function decide(candles,quote={}){
  const symbol=normalizeSymbolName(quote.symbolName||quote.symbol||"XAUUSD");
  const profile=getSymbolProfile(symbol);
  if(!isSupportedSymbol(symbol)||!profile)return wait("Unsupported trading symbol",{symbol},symbol);
  const minAtr=Number(process.env["AI_MIN_ATR_"+symbol]||(symbol==="XAUUSD"?process.env.AI_MIN_ATR:"")||profile.minAtr);
  const maxAtr=Number(process.env["AI_MAX_ATR_"+symbol]||(symbol==="XAUUSD"?process.env.AI_MAX_ATR:"")||profile.maxAtr);
  const maxSpread=Number(process.env["AI_MAX_SPREAD_"+symbol]||(symbol==="XAUUSD"?process.env.AI_MAX_SPREAD:"")||profile.maxSpread);
  const rawDigits=quote.symbolDigits;
  const digits=rawDigits!==null&&rawDigits!==undefined&&Number.isInteger(Number(rawDigits))&&Number(rawDigits)>=0&&Number(rawDigits)<=10?Number(rawDigits):profile.digits;
  const roundPrice=value=>value===null||value===undefined||value===""?null:Number.isFinite(Number(value))?Number(Number(value).toFixed(digits)):null;
  const clean=Array.isArray(candles)?candles.filter(c=>c&&[c.open,c.high,c.low,c.close].every(v=>n(v)!==null)).slice(-300):[];
  if(clean.length<MIN_BARS)return wait("Waiting for "+MIN_BARS+" real "+symbol+" candles",{bars:clean.length,candleCount:clean.length},symbol);
  const closes=clean.map(c=>n(c.close)),e9=ema(closes,9),e21=ema(closes,21),e50=ema(closes,50),r=rsi(closes,14),a=atr(clean,14),last=closes.at(-1),prev=closes.at(-2);
  if([e9,e21,e50,r,a,last,prev].some(v=>v===null))return wait("Indicators unavailable",{candleCount:clean.length},symbol);
  const recent=clean.slice(-(symbol==="BTCUSD"||symbol==="XAUUSD"?24:20)),range=Math.max(...recent.map(c=>n(c.high)))-Math.min(...recent.map(c=>n(c.low)));
  const body=Math.abs(last-prev),avgBody=recent.slice(0,-1).reduce((s,c)=>s+Math.abs(n(c.close)-n(c.open)),0)/Math.max(1,recent.length-1);
  const bodyQuality=avgBody>0?body/avgBody:0,atrRatio=a>0?range/(a*20):0;
  const volatilityAllowed=a>=minAtr&&a<=maxAtr;
  const candleQualityAllowed=bodyQuality>=Number(process.env.AI_MIN_BODY_RATIO||0.25);
  const trendUp=e9>e21&&e21>e50,trendDown=e9<e21&&e21<e50,trendStrength=Math.abs(e9-e50)/(a||1);
  const regime=trendStrength>=1?(trendUp?"TREND_UP":trendDown?"TREND_DOWN":"TRANSITION"):(atrRatio>1.35?"VOLATILE":"RANGE");
  let buy=0,sell=0,reasons=[];
  if(e9>e21){buy+=2;reasons.push("EMA9 above EMA21");}else{sell+=2;reasons.push("EMA9 below EMA21");}
  if(e21>e50){buy+=2;reasons.push("EMA21 above EMA50");}else{sell+=2;reasons.push("EMA21 below EMA50");}
  if(r>=52&&r<=72){buy++;reasons.push("RSI bullish zone");} if(r<=48&&r>=28){sell++;reasons.push("RSI bearish zone");}
  if(last>prev)buy++;else if(last<prev)sell++;
  const momentum=(last-prev)/(a||1); if(momentum>0.25)buy++; if(momentum<-0.25)sell++;
  if(trendUp)buy++; if(trendDown)sell++;
  const side=buy>sell?"BUY":sell>buy?"SELL":"WAIT",total=buy+sell,agreement=total?Math.max(buy,sell)/total:0;
  const scoreGap=Math.abs(buy-sell);
  const logicChecks={trend:trendUp||trendDown,momentum:Math.abs(momentum)>=0.25,rsiAlignment:(side==="BUY"&&r>=52&&r<=72)||(side==="SELL"&&r>=28&&r<=48),emaAlignment:(side==="BUY"&&e9>e21&&e21>e50)||(side==="SELL"&&e9<e21&&e21<e50),candleQuality:candleQualityAllowed,volatility:volatilityAllowed};
  const passedLogic=Object.values(logicChecks).filter(Boolean).length;
  const failedLogic=Object.entries(logicChecks).filter(([,v])=>!v).map(([k])=>k);
  const confidence=clamp(Math.round(40+(passedLogic/6)*35+(scoreGap/6)*15+Math.min(10,trendStrength*3)),0,95);
  const bid=n(quote.bid),ask=n(quote.ask),spread=bid!==null&&ask!==null&&ask>=bid?ask-bid:null,entry=roundPrice(side==="BUY"?ask:side==="SELL"?bid:last);
  const swingHigh=Math.max(...recent.map(c=>n(c.high))),swingLow=Math.min(...recent.map(c=>n(c.low)));
  // Structure-based SL area: recent swing structure plus a small volatility buffer.
  // The final risk distance also has a 1.2 ATR floor for XAUUSD.
  const configuredStopAtr=Number(process.env["AI_STOP_ATR_MULTIPLIER_"+symbol]);
  const stopAtrMultiplier=Number.isFinite(configuredStopAtr)&&configuredStopAtr>=1.2&&configuredStopAtr<=4
    ? configuredStopAtr : Number(profile.minStopAtr||1.2);
  const slBuffer=Math.max(a*((symbol==="BTCUSD"||symbol==="XAUUSD")?0.30:0.15),profile.stopBuffer);
  const structureStop=side==="BUY"?swingLow-slBuffer:side==="SELL"?swingHigh+slBuffer:null;
  const minimumRisk=a*stopAtrMultiplier;
  const structureRisk=side==="BUY"?Math.max(0,entry-structureStop):side==="SELL"?Math.max(0,structureStop-entry):minimumRisk;
  const risk=Math.max(minimumRisk,structureRisk);
  const stop=roundPrice(side==="BUY"?entry-risk:side==="SELL"?entry+risk:null);
  // Round TP outward, never to nearest: nearest-tick rounding can turn a displayed 2.00R plan into a sub-2R executable plan.
  const target=side==="BUY"||side==="SELL"
    ? rewardRisk.normalizeTargetPrice({signal:side,entry,stop,digits,minRewardRisk:MIN_RR})
    : null;
  const rawRR=side==="WAIT"?null:Math.abs(target-entry)/Math.max(0.00001,Math.abs(entry-stop));
  const rr=rawRR===null?null:Number(rawRR.toFixed(2));
  const qualityTrade=side!=="WAIT"&&passedLogic>=5&&(trendUp||trendDown);
  const lastUpdate=quote.lastUpdate?Date.parse(quote.lastUpdate):NaN,quoteFresh=Number.isFinite(lastUpdate)&&Date.now()-lastUpdate<=30000;
  const falseBreakout=(symbol==="BTCUSD"||symbol==="XAUUSD")?detectFalseBreakout(clean,side,a,24):{detected:false,reason:"NOT_APPLICABLE",lookback:null,sweptLevel:null};
  const gates={dataReady:true,quoteReady:bid!==null&&ask!==null&&ask>bid,quoteFresh,spreadAllowed:spread!==null&&spread<=maxSpread,volatilityAllowed,candleQualityAllowed,trendConfirmed:trendUp||trendDown,logicQualityAllowed:qualityTrade,confidenceAllowed:confidence>=MIN_CONFIDENCE,rewardRiskAllowed:rr!==null&&rr>=MIN_RR,falseBreakoutAllowed:!falseBreakout.detected,cTraderReady:Boolean(quote.connected&&quote.authorized),demoAccount:quote.account?.isLive===false};
  const blockedBy=Object.entries(gates).filter(([,v])=>!v).map(([k])=>k);
  // Keep the existing AURIXA V1 calculation as the primary strategy.
  // OF1 is a confirmation layer: it never creates or reverses the V1 signal.
  // Evaluate it for every scan so WAITs and disagreements are auditable too.
  const mainSignal=side;
  const mainGatesPassed=blockedBy.length===0;
  const orderFlowConfirmation=orderFlowOF1.analyze(clean,{symbol,timeframe:"M5"});
  const of1Decision=confirmOrderFlowDirection(mainSignal,orderFlowConfirmation);
  const orderFlowConfirmed=of1Decision.confirmed;
  const confirmationStatus=of1Decision.status;
  // OF1 is a conflict/invalidation guard, not a second full entry strategy.
  // Missing or incomplete OF1 evidence must not veto an otherwise-qualified V1 signal.
  // Explicit opposing OF1 direction or invalidated structure still blocks the entry.
  const orderFlowBlocks = shouldBlockOnOF1(of1Decision.status);
  gates.orderFlowOF1Confirmed=mainSignal==="WAIT"?null:!orderFlowBlocks;
  let signal=mainSignal!=="WAIT"&&mainGatesPassed?mainSignal:"WAIT";
  if(signal!=="WAIT"&&orderFlowBlocks){
    blockedBy.push("orderFlowOF1Confirmed");
    signal="WAIT";
  }
  const signalConfirmation={
    mode:"main_strategy_with_of1_conflict_guard",
    primaryEngine:"AURIXA_AI_TRADER_V1",
    confirmationEngine:orderFlowConfirmation?.strategy||"AURIXA_OF1",
    mainSignal,
    confirmationSignal:of1Decision.direction||orderFlowConfirmation?.signal||"WAIT",
    status:confirmationStatus,
    confirmed:orderFlowConfirmed,
    evidenceCount:of1Decision.evidenceCount,
    evidence:of1Decision.evidence||[],
    applied:mainSignal!=="WAIT"&&mainGatesPassed,
    reason:of1Decision.reason,
    fullOF1Signal:orderFlowConfirmation?.signal||"WAIT",
    trueFootprint:orderFlowConfirmation?.trueFootprint===true,
    gex:orderFlowConfirmation?.gex===true
  };
  return {engine:"AURIXA_AI_TRADER_V1",version:"1.4.0",symbol,timeframe:"M5",priceDigits:digits,atrProfile:{min:minAtr,max:maxAtr,maxSpread},signal,confidence,price:roundPrice(last),entry,stopLoss:stop,takeProfit:target,
    slArea:side==="BUY"
      ? {type:"SUPPORT",low:Number(swingLow.toFixed(2)),high:Number((swingLow+slBuffer).toFixed(2)),buffer:Number(slBuffer.toFixed(2))}
      : side==="SELL"
        ? {type:"RESISTANCE",low:Number((swingHigh-slBuffer).toFixed(2)),high:Number(swingHigh.toFixed(2)),buffer:Number(slBuffer.toFixed(2))}
        : null,stopPlan:side==="WAIT"?null:{method:"ATR_PLUS_SWING_STRUCTURE",atr:a,atrMultiplier:stopAtrMultiplier,swingLookback:recent.length,structureStop,buffer:slBuffer,riskDistance:risk},rewardRisk:rr,spread,ema9:e9,ema21:e21,ema50:e50,rsi:r,atr:a,momentum,score:{buy,sell,gap:scoreGap},agreement:Number(agreement.toFixed(3)),logic:{checks:logicChecks,passed:passedLogic,total:6,failed:failedLogic},trend:trendUp?"BULLISH":trendDown?"BEARISH":"MIXED",regime,trendStrength:Number(trendStrength.toFixed(3)),bodyQuality:Number(bodyQuality.toFixed(3)),volatilityRatio:Number(atrRatio.toFixed(3)),candleCount:clean.length,orderFlowConfirmation,signalConfirmation,falseBreakout,gates,blockedBy,executionEligible:signal!=="WAIT",reasons:[...reasons,...(falseBreakout.detected?[`False breakout rejected: ${falseBreakout.reason}`]:[]),`Logic ${passedLogic}/6 checks passed`,`BUY score ${buy} · SELL score ${sell}`,`Momentum ${momentum.toFixed(2)} ATR`,`RSI ${r.toFixed(1)}`,`R:R ${rr===null?"N/A":rr.toFixed(2)} · minimum ${MIN_RR.toFixed(2)}`],candleTime:clean.at(-1).time||Date.now(),generatedAt:new Date().toISOString()};
}
module.exports={decide,detectFalseBreakout,confirmOrderFlowDirection,shouldBlockOnOF1,MIN_BARS,MIN_CONFIDENCE,MIN_RR};
