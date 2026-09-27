const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const app = express();
const { registerCTrader } = require("./ctrader");
registerCTrader(app);
const PORT = Number(process.env.PORT || 8787);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "web")));

let candles = [];
let lastPrice = null;
let liveConnected = false;
let lastUpdate = null;

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);
  let value = values.slice(0, period)
    .reduce((a,b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1-k);
  }

  return value;
}

function rsi(values, period=14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i=1; i<=period; i++) {
    const change = values[i] - values[i-1];
    if (change >= 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i=period+1; i<values.length; i++) {
    const change = values[i] - values[i-1];
    const gain = Math.max(change,0);
    const loss = Math.max(-change,0);

    avgGain = ((avgGain*(period-1))+gain)/period;
    avgLoss = ((avgLoss*(period-1))+loss)/period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - (100/(1+rs));
}

function atr(data, period=14) {
  if (data.length <= period) return null;

  const tr=[];

  for(let i=1;i<data.length;i++){
    const h=data[i].high;
    const l=data[i].low;
    const pc=data[i-1].close;

    tr.push(Math.max(
      h-l,
      Math.abs(h-pc),
      Math.abs(l-pc)
    ));
  }

  return tr.slice(-period)
    .reduce((a,b)=>a+b,0)/period;
}

function prediction() {
  if (candles.length < 50) {
    return {
      signal:"WAIT",
      confidence:0,
      reason:"Waiting for real XAUUSD data",
      dataReady:false
    };
  }

  const closes=candles.map(x=>x.close);

  const e9=ema(closes,9);
  const e21=ema(closes,21);
  const e50=ema(closes,50);
  const r=rsi(closes,14);
  const a=atr(candles,14);

  let score=0;

  if(e9 > e21) score += 1;
  else score -= 1;

  if(e21 > e50) score += 1;
  else score -= 1;

  if(r > 55 && r < 75) score += 1;
  if(r < 45 && r > 25) score -= 1;

  const last=closes[closes.length-1];
  const previous=closes[closes.length-2];

  if(last > previous) score += 1;
  else if(last < previous) score -= 1;

  let signal="WAIT";

  if(score >= 3) signal="BUY";
  if(score <= -3) signal="SELL";

  const confidence=Math.min(
    95,
    Math.round(50 + Math.abs(score)*10)
  );

  return {
    signal,
    confidence,
    price:last,
    ema9:e9,
    ema21:e21,
    ema50:e50,
    rsi:r,
    atr:a,
    dataReady:true,
    timestamp:new Date().toISOString()
  };
}

app.get("/api/health",(req,res)=>{
  res.json({
    ok:true,
    symbol:process.env.SYMBOL,
    timeframe:process.env.TIMEFRAME,
    liveConnected,
    paperTrading:process.env.PAPER_TRADING==="true",
    autoTrading:process.env.AUTO_TRADING==="true",
    lastUpdate
  });
});

app.get("/api/market",(req,res)=>{
  res.json({
    symbol:"XAUUSD",
    price:lastPrice,
    candles:candles.slice(-100),
    prediction:prediction(),
    liveConnected,
    lastUpdate
  });
});

/*
  REAL cTrader DATA CONNECTOR

  This function is intentionally not replaced with fake prices.
  Add the cTrader/Open API websocket implementation here after
  CTRADER_ACCESS_TOKEN and CTRADER_ACCOUNT_ID are configured.
*/
async function connectCtrader(){
  if(
    !process.env.CTRADER_ACCESS_TOKEN ||
    !process.env.CTRADER_ACCOUNT_ID
  ){
    liveConnected=false;
    console.log("cTrader: credentials not configured");
    return;
  }

  console.log("cTrader credentials detected.");
  console.log("Live XAUUSD connector awaiting Open API session setup.");
}

app.use((req,res)=>{
  res.sendFile(path.join(__dirname,"..","web","index.html"));
});

app.listen(PORT,"0.0.0.0",async()=>{
  console.log("");
  console.log("======================================");
  console.log("      XAUUSD AI 5M PREDICTOR");
  console.log("======================================");
  console.log(`Phone: http://127.0.0.1:${PORT}`);
  console.log(`Symbol: ${process.env.SYMBOL}`);
  console.log("Auto trading: DISABLED");
  console.log("Paper trading: ENABLED");
  console.log("======================================");
  await connectCtrader();
});
