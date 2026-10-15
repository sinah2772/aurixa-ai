"use strict";
/* AURIXA AI TRADER — Quality Check V2 (observe-only).
 * Diagnostic-only: never mutates V1 decisions, gates, trading settings, or orders.
 */
const MIN_BARS=50, MAX_QUOTE_AGE_MS=30000, MAX_SPREAD_ATR_RATIO=0.20,
  MAX_ENTRY_EXTENSION_ATR=1.50, EXTREME_DISTANCE_ATR=0.20, MIN_ENTRY_BODY_ATR=0.20;
function num(v){if(v===null||v===undefined||v==="")return null;const n=Number(v);return Number.isFinite(n)?n:null;}
function timestampMs(v){
  if(v===null||v===undefined||v==="")return null;
  if(typeof v==="number"||/^\d+(?:\.\d+)?$/.test(String(v))){const n=Number(v);if(!Number.isFinite(n)||n<=0)return null;return n<1e11?n*1000:n;}
  const n=Date.parse(String(v));return Number.isFinite(n)?n:null;
}
function check(ok,detail){return {status:ok===null?"unknown":ok?"pass":"warning",detail};}
function observe(candles,quote={},decision={}){
  const now=Date.now(),rows=Array.isArray(candles)?candles:[];
  const valid=rows.filter(c=>{
    const o=num(c?.open),h=num(c?.high),l=num(c?.low),cl=num(c?.close);
    return [o,h,l,cl].every(v=>v!==null&&v>0)&&h>=Math.max(o,l,cl)&&l<=Math.min(o,h,cl);
  });
  const bid=num(quote.bid),ask=num(quote.ask),quoteReady=bid!==null&&ask!==null&&bid>0&&ask>bid;
  const updateMs=timestampMs(quote.lastUpdate),quoteAgeMs=updateMs===null?null:now-updateMs;
  const quoteFresh=quoteAgeMs!==null&&quoteAgeMs>=0&&quoteAgeMs<=MAX_QUOTE_AGE_MS;
  const atr=num(decision.atr),spread=quoteReady?ask-bid:null;
  const spreadAtrRatio=atr!==null&&atr>0&&spread!==null?spread/atr:null;
  const side=["BUY","SELL"].includes(decision.signal)?decision.signal:null;
  const momentum=num(decision.momentum),rsi=num(decision.rsi),entry=num(decision.entry),ema9=num(decision.ema9);
  const trendAligned=side==="BUY"?decision.trend==="BULLISH":side==="SELL"?decision.trend==="BEARISH":null;
  const momentumAligned=side==="BUY"?momentum!==null&&momentum>0:side==="SELL"?momentum!==null&&momentum<0:null;
  const rsiAligned=side==="BUY"?rsi!==null&&rsi>=52&&rsi<=72:side==="SELL"?rsi!==null&&rsi>=28&&rsi<=48:null;
  // M5 history often includes the still-forming candle. Do not use that candle
  // to diagnose entry-candle body strength when its open timestamp is known.
  const completedValid=valid.filter(c=>{
    const candleMs=timestampMs(c?.time??c?.timestamp??c?.openTime??c?.open_time??c?.date);
    return candleMs===null||candleMs+300000<=now;
  });
  const completedRecent=completedValid.slice(-20);
  const last=completedRecent.at(-1),close=num(last?.close),open=num(last?.open);
  const lastCandleTimestamp=last?timestampMs(last?.time??last?.timestamp??last?.openTime??last?.open_time??last?.date):null;
  const bodyCandleIsTimestamped=lastCandleTimestamp!==null;
  const bodyAtr=atr!==null&&atr>0&&close!==null&&open!==null?Math.abs(close-open)/atr:null;
  const entryExtensionAtr=atr!==null&&atr>0&&entry!==null&&ema9!==null?Math.abs(entry-ema9)/atr:null;
  const swingHigh=recent.length?Math.max(...recent.map(c=>num(c.high))):null;
  const swingLow=recent.length?Math.min(...recent.map(c=>num(c.low))):null;
  const extremeDistanceAtr=atr!==null&&atr>0&&entry!==null
    ?side==="BUY"&&swingHigh!==null?(swingHigh-entry)/atr
      :side==="SELL"&&swingLow!==null?(entry-swingLow)/atr:null:null;
  const checks={
    candleHistory:check(valid.length>=MIN_BARS,valid.length+" valid candles; need at least "+MIN_BARS),
    quoteShape:check(quoteReady,quoteReady?"Bid/ask valid":"Bid/ask missing or invalid"),
    quoteFreshness:check(quoteFresh,quoteAgeMs===null?"Quote timestamp unavailable":"Quote age "+Math.round(quoteAgeMs)+" ms"),
    spreadToAtr:check(spreadAtrRatio===null?null:spreadAtrRatio<=MAX_SPREAD_ATR_RATIO,spreadAtrRatio===null?"Spread/ATR unavailable":"Spread/ATR "+spreadAtrRatio.toFixed(3)+"; diagnostic threshold "+MAX_SPREAD_ATR_RATIO),
    trendRegime:check(side===null?null:trendAligned,side===null?"No directional signal":"Signal "+side+"; trend "+(decision.trend||"unknown")+"; regime "+(decision.regime||"unknown")),
    momentumAlignment:check(side===null?null:momentumAligned,side===null?"No directional signal":"Momentum "+(momentum===null?"unknown":momentum.toFixed(3))+" ATR"),
    rsiAlignment:check(side===null?null:rsiAligned,side===null?"No directional signal":"RSI "+(rsi===null?"unknown":rsi.toFixed(1))),
    entryCandleBody:check(bodyAtr===null?null:bodyAtr>=MIN_ENTRY_BODY_ATR,bodyAtr===null?"Completed entry candle body/ATR unavailable":"Completed candle body/ATR "+bodyAtr.toFixed(3)+"; diagnostic minimum "+MIN_ENTRY_BODY_ATR+(bodyCandleIsTimestamped?"":"; candle timestamp unavailable")),
    entryExtension:check(entryExtensionAtr===null?null:entryExtensionAtr<=MAX_ENTRY_EXTENSION_ATR,entryExtensionAtr===null?"Entry extension from EMA9 unavailable":"Entry is "+entryExtensionAtr.toFixed(3)+" ATR from EMA9"),
    nearSwingExtreme:check(extremeDistanceAtr===null?null:extremeDistanceAtr>EXTREME_DISTANCE_ATR,extremeDistanceAtr===null?"Swing-extreme distance unavailable":"Distance from relevant 20-candle extreme "+extremeDistanceAtr.toFixed(3)+" ATR"),
    brokerProtection:check(null,"Not checked by this pre-execution observer; broker-confirmed SL/TP remains authoritative")
  };
  const wouldFlag=Object.entries(checks).filter(([,v])=>v.status==="warning"||v.status==="fail").map(([k])=>k);
  return {
    mode:"observe_only",version:"2.2.0",evaluatedAt:new Date(now).toISOString(),
    symbol:decision.symbol||quote.symbolName||quote.symbol||null,signalObserved:decision.signal||"WAIT",
    v1ExecutionEligible:decision.executionEligible===true,wouldFlag,checks,
    metrics:{validCandleCount:valid.length,completedCandleCount:completedValid.length,entryCandleTimestamp:lastCandleTimestamp===null?null:new Date(lastCandleTimestamp).toISOString(),quoteAgeMs,spread,atr,
      spreadAtrRatio:spreadAtrRatio===null?null:Number(spreadAtrRatio.toFixed(4)),
      entryBodyAtr:bodyAtr===null?null:Number(bodyAtr.toFixed(4)),
      entryExtensionAtr:entryExtensionAtr===null?null:Number(entryExtensionAtr.toFixed(4)),
      swingExtremeDistanceAtr:extremeDistanceAtr===null?null:Number(extremeDistanceAtr.toFixed(4))},
    executionDecisionUnaffected:true,
    note:"Diagnostics only. V2 observations do not modify V1 signal, gates, execution eligibility, or trading settings."
  };
}
function observeExecution(result={}){
  const raw=result.protectionStatus;let brokerProtection="NOT_CONFIRMED";
  if(raw&&typeof raw==="object"){
    if(raw.verified===true||String(raw.status||"").toUpperCase()==="VERIFIED")brokerProtection="VERIFIED";
    else if(raw.verified===false||["FAILED","MISSING","UNPROTECTED"].includes(String(raw.status||"").toUpperCase()))brokerProtection="FAILED";
  }else if(typeof raw==="string"){
    const s=raw.toUpperCase();
    if(s.includes("VERIFIED")||s.includes("PROTECTED"))brokerProtection="VERIFIED";
    else if(s.includes("FAILED")||s.includes("MISSING")||s.includes("UNPROTECTED"))brokerProtection="FAILED";
  }
  return {mode:"observe_only",executed:result.executed===true,executionReason:result.reason||null,
    brokerProtection,rawProtectionStatus:raw??null,
    note:"Recorded for observation only; this report does not retry, repair, block, or authorize orders."};
}
module.exports={observe,observeExecution};
