const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const app = express();
const { registerCTrader, getCTraderStatus, setMarketEngine } = require("./ctrader");
const marketEngine = require("./market-engine");
const { backtest } = require("./validation");
setMarketEngine(marketEngine);
registerCTrader(app);
const PORT = Number(process.env.PORT || 8787);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "web")));

let candles = [];
let lastPrice = null;
let liveConnected = false;
let lastUpdate = null;

// AURIXA live 5-minute candle engine.
// Candles are built from the authenticated cTrader mid-price stream.
// This does not place trades and does not modify cTrader authentication.
const AURIXA_TIMEFRAME_MS = 5 * 60 * 1000;
let liveCandle = null;
let lastCandleBucket = null;

function updateLiveCandle(price, timestamp = Date.now()) {
  if (!Number.isFinite(price) || price <= 0) return;

  const bucket = Math.floor(timestamp / AURIXA_TIMEFRAME_MS) * AURIXA_TIMEFRAME_MS;

  if (!liveCandle || lastCandleBucket !== bucket) {
    if (liveCandle) {
      candles.push(liveCandle);
      if (candles.length > 500) candles.shift();
    }

    liveCandle = {
      time: bucket,
      open: price,
      high: price,
      low: price,
      close: price
    };

    lastCandleBucket = bucket;
  } else {
    liveCandle.high = Math.max(liveCandle.high, price);
    liveCandle.low = Math.min(liveCandle.low, price);
    liveCandle.close = price;
  }

  lastPrice = price;
  lastUpdate = new Date(timestamp).toISOString();
}

function syncLiveMarket() {
  const ct = getCTraderStatus();

  if (
    ct.mid !== null &&
    ct.mid !== undefined &&
    Number.isFinite(Number(ct.mid))
  ) {
    const timestamp = ct.lastUpdate
      ? Date.parse(ct.lastUpdate)
      : Date.now();

    updateLiveCandle(Number(ct.mid), Number.isFinite(timestamp) ? timestamp : Date.now());
  }

  liveConnected = Boolean(ct.connected && ct.authorized);
}

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


let simState = {
  enabled: false,
  price: 2650,
  candles: [],
  signal: "WAIT",
  confidence: 0,
  reason: "Simulation not started",
  entry: null,
  pnl: 0
};

function simCandle() {
  const last = simState.price;
  const move = (Math.random() - 0.48) * 3.5;
  const close = Math.max(100, last + move);
  const high = Math.max(last, close) + Math.random() * 1.5;
  const low = Math.min(last, close) - Math.random() * 1.5;

  simState.price = close;
  simState.candles.push({
    time: Date.now(),
    open: last,
    high,
    low,
    close
  });

  if (simState.candles.length > 100)
    simState.candles.shift();

  const closes = simState.candles.map(x => x.close);

  if (closes.length < 21) {
    simState.signal = "WAIT";
    simState.confidence = 0;
    simState.reason = "Building simulated 5-minute history";
    return;
  }

  const ema = (period) => {
    const k = 2 / (period + 1);
    let value = closes[0];
    for (const price of closes.slice(1))
      value = price * k + value * (1 - k);
    return value;
  };

  const ema9 = ema(9);
  const ema21 = ema(21);

  let gains = 0;
  let losses = 0;
  for (let i = Math.max(1, closes.length - 14); i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }

  const avgGain = gains / 14;
  const avgLoss = losses / 14;
  const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  if (ema9 > ema21 && rsi < 70) {
    simState.signal = "BUY";
    simState.confidence = Math.min(95, Math.round(55 + Math.abs(ema9 - ema21) * 8));
    simState.reason = "Simulated bullish EMA alignment with RSI confirmation";
  } else if (ema9 < ema21 && rsi > 30) {
    simState.signal = "SELL";
    simState.confidence = Math.min(95, Math.round(55 + Math.abs(ema9 - ema21) * 8));
    simState.reason = "Simulated bearish EMA alignment with RSI confirmation";
  } else {
    simState.signal = "WAIT";
    simState.confidence = Math.round(40 + Math.random() * 15);
    simState.reason = "Simulated indicators disagree";
  }

  if (simState.entry !== null) {
    simState.pnl =
      simState.signal === "BUY"
        ? simState.price - simState.entry
        : simState.entry - simState.price;
  }
}

app.get("/api/simulation", (req, res) => {
  if (req.query.start === "1") simState.enabled = true;
  if (req.query.stop === "1") simState.enabled = false;

  if (simState.enabled) simCandle();

  res.json({
    mode: "SIMULATION",
    realMarketData: false,
    liveTrading: false,
    paperTrading: true,
    enabled: simState.enabled,
    symbol: "XAUUSD",
    timeframe: "5m",
    price: Number(simState.price.toFixed(2)),
    signal: simState.signal,
    confidence: simState.confidence,
    reason: simState.reason,
    candles: simState.candles.slice(-30),
    entry: simState.entry,
    pnl: Number(simState.pnl.toFixed(2))
  });
});


app.get("/api/validation",(req,res)=>{
  try {
    const state = marketEngine.getState();

    const result = backtest(
      state.candles || []
    );

    res.json({
      ok: true,
      autoTrading: false,
      paperTrading: true,
      ...result
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: String(err.message || err)
    });
  }
});

app.get("/api/market",(req,res)=>{
  const ct = getCTraderStatus();
  const state = marketEngine.getState();
  const prediction = state.prediction || {};

  res.json({
    symbol: ct.symbol || "XAUUSD",
    timeframe: "5m",

    price: ct.mid ?? state.spotPrice ?? null,
    bid: ct.bid ?? null,
    ask: ct.ask ?? null,

    candles: state.candles || [],

    prediction: {
      signal: prediction.signal || "WAIT",
      confidence: prediction.confidence ?? 0,
      reason: prediction.reason || "Waiting for enough M5 data",
      dataReady: prediction.dataReady ?? false,

      ema9: prediction.ema9 ?? null,
      ema21: prediction.ema21 ?? null,
      ema50: prediction.ema50 ?? null,
      rsi: prediction.rsi ?? null,
      atr: prediction.atr ?? null,
      score: prediction.score ?? 0,

      momentum3: prediction.momentum3 ?? null,
      momentum5: prediction.momentum5 ?? null,
      momentum8: prediction.momentum8 ?? null,
      slope: prediction.slope ?? null,
      bodyStrength: prediction.bodyStrength ?? null,
      volatility: prediction.volatility || "unknown",
      breakout: prediction.breakout ?? 0,
      bullishFactors: prediction.bullishFactors ?? 0,
      bearishFactors: prediction.bearishFactors ?? 0
    },

    liveConnected: !!(ct.connected && ct.authorized),
    authorized: !!ct.authorized,
    accountId: ct.accountId ?? null,
    symbolId: ct.symbolId ?? null,
    lastUpdate: ct.lastUpdate ?? null,
    error: ct.error ?? null,

    autoTrading: false,
    paperTrading: true,

    aurixa: {
      engine: "AURIXA",
      mode: "LIVE_MARKET_ANALYSIS",
      tradingEnabled: false,
      candleCount: state.candleCount || 0
    }
  });
});

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
});
