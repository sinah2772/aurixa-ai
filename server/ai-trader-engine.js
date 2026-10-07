"use strict";

/* AURIXA AI TRADER V1 — standalone strategy core.
 * Does not depend on retired OrderFlow or OR/FVG modules.
 * Produces an auditable decision; execution remains in the trade executor.
 */

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
function wait(reason,extra={}){return {engine:"AURIXA_AI_TRADER_V1",version:"1.0.0",symbol:"XAUUSD",timeframe:"M5",signal:"WAIT",confidence:0,executionEligible:false,blockedBy:[reason],reasons:[reason],...extra,generatedAt:new Date().toISOString()};}

function decide(candles,quote={}){
  const clean=Array.isArray(candles)?candles.filter(c=>c&&n(c.open)!==null&&n(c.high)!==null&&n(c.low)!==null&&n(c.close)!==null).slice(-300):[];
  if(clean.length<MIN_BARS)return wait("Waiting for "+MIN_BARS+" real XAUUSD candles",{bars:clean.length});
  const closes=clean.map(c=>n(c.close)), e9=ema(closes,9), e21=ema(closes,21), e50=ema(closes,50), r=rsi(closes,14), a=atr(clean,14), last=closes.at(-1), prev=closes.at(-2);
  if([e9,e21,e50,r,a,last,prev].some(v=>v===null))return wait("Indicators unavailable");
  let buy=0,sell=0,reasons=[];
  if(e9>e21){buy+=2;reasons.push("EMA9 above EMA21");}else{sell+=2;reasons.push("EMA9 below EMA21");}
  if(e21>e50)buy+=2;else sell+=2;
  if(r>=52&&r<=72){buy++;reasons.push("RSI bullish zone");}
  if(r<=48&&r>=28){sell++;reasons.push("RSI bearish zone");}
  if(last>prev)buy++;else if(last<prev)sell++;
  const momentum=(last-prev)/(a||1);
  if(momentum>0.25)buy++;
  if(momentum<-0.25)sell++;
  const side=buy>sell?"BUY":sell>buy?"SELL":"WAIT", total=buy+sell, agreement=total?Math.max(buy,sell)/total:0;
  const confidence=clamp(Math.round(50+agreement*35+Math.min(10,Math.abs(momentum)*5)),0,95);
  const bid=n(quote.bid),ask=n(quote.ask),spread=bid!==null&&ask!==null&&ask>=bid?ask-bid:null;
  const entry=side==="BUY"?ask:side==="SELL"?bid:last;
  const risk=Math.max(a*1.2,(Math.max(...clean.slice(-20).map(c=>c.high))-Math.min(...clean.slice(-20).map(c=>c.low)))*0.18);
  const stop=side==="BUY"?entry-risk:side==="SELL"?entry+risk:null;
  const target=side==="BUY"?entry+risk*MIN_RR:side==="SELL"?entry-risk*MIN_RR:null;
  const rr=side==="WAIT"?null:Math.abs(target-entry)/Math.abs(entry-stop);
  const gates={
    dataReady:true,quoteReady:bid!==null&&ask!==null,
    spreadAllowed:spread!==null&&spread<=Number(process.env.AI_MAX_SPREAD||0.60),
    confidenceAllowed:confidence>=MIN_CONFIDENCE,rewardRiskAllowed:rr!==null&&rr>=MIN_RR,
    cTraderReady:Boolean(quote.connected&&quote.authorized),demoAccount:quote.account?.isLive===false
  };
  const blockedBy=Object.entries(gates).filter(([,v])=>!v).map(([k])=>k);
  const signal=side!=="WAIT"&&blockedBy.length===0?side:"WAIT";
  return {engine:"AURIXA_AI_TRADER_V1",version:"1.0.0",symbol:"XAUUSD",timeframe:"M5",signal,confidence,price:last,entry,stopLoss:stop,takeProfit:target,rewardRisk:rr,spread,ema9:e9,ema21:e21,ema50:e50,rsi:r,atr:a,momentum,score:{buy,sell},agreement:Number(agreement.toFixed(3)),gates,blockedBy,executionEligible:signal!=="WAIT",reasons,candleTime:clean.at(-1).time||Date.now(),generatedAt:new Date().toISOString()};
}
module.exports={decide,MIN_BARS,MIN_CONFIDENCE,MIN_RR};
