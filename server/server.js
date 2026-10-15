const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

// Manual operator authorization is required after every server restart/deploy.
// Ignore a stale AUTO_TRADING=true environment value so startup is always OFF.
process.env.AUTO_TRADING = "false";

const app = express();
const {
  registerCTrader,
  getCTraderStatus,
  setMarketEngine,
  getDatabaseHealth,
  queryDatabase
} = require("./ctrader");

const autoTrader = require("./auto-trader");
const marketEngine = require("./market-engine");
const aiTraderEngine = require("./ai-trader-engine");
const strategyComparison = require("./strategy-comparison");
const aiQualityCheckV2 = require("./ai-quality-check-v2");
const aiQualityCheckV2Monitor = require("./ai-quality-check-v2-monitor");
const aiQualityCheckV2Persistence = require("./ai-quality-check-v2-persistence");
aiQualityCheckV2Persistence.configure(queryDatabase);
const { normalizeSymbolName, isSupportedSymbol } = require("./symbol-support");

// Latest per-symbol scanner decision and execution outcome for the dashboard.
const latestAutoTradeCandidates = new Map();
function storeAutoTradeCandidate(symbol, candidate) {
  latestAutoTradeCandidates.set(symbol, candidate);
  aiQualityCheckV2Monitor.record(candidate);
  aiQualityCheckV2Persistence.persist(candidate).catch(err => {
    console.warn("Quality Check V2 history persistence unavailable:", err.message);
  });
}
async function auditAiDecision(decision){
 try{
  await queryDatabase("CREATE SCHEMA IF NOT EXISTS aurixa");
  await queryDatabase("CREATE TABLE IF NOT EXISTS aurixa.ai_trade_decisions(id BIGSERIAL PRIMARY KEY,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),engine TEXT NOT NULL,version TEXT NOT NULL,signal TEXT NOT NULL,confidence NUMERIC(6,2),decision JSONB NOT NULL)");
  await queryDatabase("CREATE TABLE IF NOT EXISTS aurixa.ai_signals(id BIGSERIAL PRIMARY KEY,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),candle_time TIMESTAMPTZ,engine TEXT NOT NULL,version TEXT NOT NULL,symbol TEXT NOT NULL,timeframe TEXT NOT NULL,signal TEXT NOT NULL,confidence NUMERIC(6,2),entry_price NUMERIC,stop_loss NUMERIC,take_profit NUMERIC,reward_risk NUMERIC,execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,blocked_by JSONB NOT NULL DEFAULT '[]'::jsonb,decision JSONB NOT NULL)");
  await queryDatabase("ALTER TABLE aurixa.ai_signals ADD COLUMN IF NOT EXISTS decision_id BIGINT");
  const q=await queryDatabase("INSERT INTO aurixa.ai_trade_decisions(engine,version,signal,confidence,decision) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id",[decision.engine,decision.version,decision.signal,decision.confidence,JSON.stringify(decision)]);

  // Execution is evaluated every 15s, but signal history is intentionally
  // deduplicated: keep one record per new M5 candle and record any signal
  // transition immediately. This prevents WAIT/BUY/SELL spam in the UI.
  const parsedCandleTime=Date.parse(decision.candleTime);
  const fallbackCandleTime=Math.floor(Date.now()/300000)*300000;
  const candleTime=new Date(Number.isFinite(parsedCandleTime)?parsedCandleTime:fallbackCandleTime);
  const latest=await queryDatabase("SELECT signal,candle_time AS \"candleTime\" FROM aurixa.ai_signals WHERE symbol=$1 ORDER BY created_at DESC LIMIT 1",[decision.symbol||"XAUUSD"]);
  const previous=latest.rows[0];
  const previousCandle=previous?.candleTime?Date.parse(previous.candleTime):NaN;
  const candleChanged=!previous || !Number.isFinite(previousCandle) || candleTime.getTime()!==previousCandle;
  const signalChanged=!previous || String(previous.signal)!==String(decision.signal);
  const shouldRecord=!previous || candleChanged || signalChanged;

  if(shouldRecord){
    await queryDatabase("INSERT INTO aurixa.ai_signals(decision_id,candle_time,engine,version,symbol,timeframe,signal,confidence,entry_price,stop_loss,take_profit,reward_risk,execution_eligible,blocked_by,decision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb)",[
      q.rows[0]?.id || null,candleTime,
      decision.engine,decision.version,decision.symbol||"XAUUSD",decision.timeframe||"M5",decision.signal,decision.confidence,
      decision.entry,decision.stopLoss,decision.takeProfit,decision.rewardRisk,Boolean(decision.executionEligible),
      JSON.stringify(decision.blockedBy||[]),JSON.stringify(decision)
    ]);
    console.log("AURIXA SIGNAL RECORDED:",JSON.stringify({signal:decision.signal,candleTime:candleTime.toISOString(),executionEligible:Boolean(decision.executionEligible)}));
  }
  return q.rows[0]?.id||null;
 }catch(e){console.warn("AI signal audit:",e.message);return null;}
}
setMarketEngine(marketEngine);

autoTrader.configure({
  ctrader: {
    ...require("./ctrader"),
    getMarketCandles: () => marketEngine.getState()?.candles || []
  },
  query: queryDatabase,
  ai: aiTraderEngine
});

const PORT = Number(process.env.PORT || 8787);

app.use(cors());
app.use(express.json());

// Keep a dependency-free liveness endpoint for Render and external probes.
// It must never wait on PostgreSQL or cTrader.
app.get("/health", (req, res) => {
  res.status(200).type("application/json").send(JSON.stringify({
    ok: true,
    service: "aurixa-ai",
    timestamp: new Date().toISOString()
  }));
});

registerCTrader(app);
app.get("/api/ai/decision", async (req,res)=>{
 try{
  const state=marketEngine.getState()||{},ct=getCTraderStatus()||{};
  const decision=aiTraderEngine.decide(state.candles||[],ct);
  decision.qualityCheckV2=aiQualityCheckV2.observe(state.candles||[],ct,decision);
  const decisionId=await auditAiDecision(decision);
  res.json({ok:true,decision,...decision,decisionId});
 }catch(e){res.status(500).json({ok:false,signal:"WAIT",executionEligible:false,error:e.message});}
});

app.get("/api/ai/signals",async(req,res)=>{
  try{
    const limit=Math.min(200,Math.max(1,Number(req.query.limit)||50));
    const q=await queryDatabase(`SELECT id,created_at AS "createdAt",candle_time AS "candleTime",engine,version,symbol,timeframe,signal,confidence,entry_price AS "entry",stop_loss AS "stopLoss",take_profit AS "takeProfit",reward_risk AS "rewardRisk",execution_eligible AS "executionEligible",blocked_by AS "blockedBy",decision FROM aurixa.ai_signals ORDER BY created_at DESC LIMIT $1`,[limit]);
    res.json({ok:true,count:q.rows.length,signals:q.rows});
  }catch(e){console.error("AI signals history error:",e);res.status(500).json({ok:false,error:"AI signal history unavailable"});}
});

app.get("/api/ai/signals/:id", async (req,res)=>{
  try {
    const id=Number(req.params.id);
    if(!Number.isSafeInteger(id)||id<=0) return res.status(400).json({ok:false,error:"Invalid signal ID"});
    const q=await queryDatabase(`
      SELECT s.id,s.created_at AS "createdAt",s.candle_time AS "candleTime",
        s.engine,s.version,s.symbol,s.timeframe,s.signal,s.confidence,
        s.entry_price AS "entryPrice",s.stop_loss AS "stopLoss",
        s.take_profit AS "takeProfit",s.reward_risk AS "rewardRisk",
        s.execution_eligible AS "executionEligible",s.blocked_by AS "blockedBy",
        s.decision_id AS "decisionId",s.decision,d.decision AS "decisionRecord",
        t.id AS "tradeId",t.status AS "tradeStatus",t.gate_reason AS "gateReason",
        t.error AS "executionError",t.order_id AS "orderId",t.position_id AS "positionId",
        t.volume,t.signal_entry_price AS "signalEntryPrice",
        t.execution_entry_price AS "executionEntryPrice",
        t.planned_stop_price AS "plannedStopLoss",t.planned_take_profit_price AS "plannedTakeProfit",
        t.opened_at AS "openedAt",t.closed_at AS "closedAt",
        t.close_price AS "closePrice",t.profit,t.exit_reason AS "exitReason"
      FROM aurixa.ai_signals s
      LEFT JOIN aurixa.ai_trade_decisions d ON d.id=s.decision_id
      LEFT JOIN aurixa.auto_trades t ON t.decision_id=s.decision_id
      WHERE s.id=$1 ORDER BY t.created_at DESC NULLS LAST LIMIT 1
    `,[id]);
    if(!q.rows.length) return res.status(404).json({ok:false,error:"Signal not found"});
    const r=q.rows[0];
    res.json({ok:true,signal:{
      id:r.id,createdAt:r.createdAt,candleTime:r.candleTime,engine:r.engine,version:r.version,
      symbol:r.symbol,timeframe:r.timeframe,direction:r.signal,confidence:r.confidence,
      entryPrice:r.entryPrice,stopLoss:r.stopLoss,takeProfit:r.takeProfit,rewardRisk:r.rewardRisk,
      executionEligible:r.executionEligible,blockedBy:Array.isArray(r.blockedBy)?r.blockedBy:[],
      gates:r.decision?.gates||r.decisionRecord?.gates||{},decision:r.decision||r.decisionRecord||{},
      execution:{
        status:r.tradeId!=null?String(r.tradeStatus||"UNKNOWN").toUpperCase():(r.executionEligible===true?"NO LINKED TRADE RECORD":"NOT APPROVED"),
        tradeId:r.tradeId??null,gateReason:r.gateReason||null,error:r.executionError||null,
        orderId:r.orderId||null,positionId:r.positionId||null,volume:r.volume??null,
        signalEntryPrice:r.signalEntryPrice??null,fillPrice:r.executionEntryPrice??null,
        openedAt:r.openedAt??null,closedAt:r.closedAt??null,closePrice:r.closePrice??null,
        profit:r.profit??null,exitReason:r.exitReason||null,
        plannedStopLoss:r.plannedStopLoss??null,plannedTakeProfit:r.plannedTakeProfit??null
      }
    }});
  } catch(err) {
    console.error("AI signal investigation error:",err);
    res.status(500).json({ok:false,error:"Signal investigation unavailable"});
  }
});

app.get("/api/ai/decision/history",async(req,res)=>{
  try {
    const limit=Math.min(100,Math.max(1,Number(req.query.limit)||20));
    const q=await queryDatabase('SELECT id,created_at AS "createdAt",engine,version,signal,confidence,decision FROM aurixa.ai_trade_decisions ORDER BY created_at DESC LIMIT $1',[limit]);
    res.json({ok:true,count:q.rows.length,decisions:q.rows});
  } catch(e) { res.status(500).json({ok:false,error:"AI decision history unavailable"}); }
});

const WEB_DIR = path.join(__dirname, "..", "web");

// Serve the frontend explicitly before the API fallback. This avoids a blank page
// when a browser/CDN requests an asset with a stale or ambiguous route.
app.use("/style.css", express.static(path.join(WEB_DIR, "style.css"), {
  etag: true,
  maxAge: 0,
  setHeaders: (res) => res.setHeader("Cache-Control", "no-store")
}));
app.use("/app.js", express.static(path.join(WEB_DIR, "app.js"), {
  etag: true,
  maxAge: 0,
  setHeaders: (res) => res.setHeader("Cache-Control", "no-store")
}));
app.get(["/", "/index.html"], (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(WEB_DIR, "index.html"));
});
app.use(express.static(WEB_DIR, {
  etag: true,
  maxAge: 0,
  setHeaders: (res) => res.setHeader("Cache-Control", "no-store")
}));

app.get("/api/system/health", async (req, res) => {
  const started = Date.now();

  try {
    const database = await getDatabaseHealth();
    const ct = getCTraderStatus();

    res.status(database.connected ? 200 : 503).json({
      ok: database.connected,
      service: "AURIXA AI",
      environment: process.env.NODE_ENV || "production",
      database,
      ctrader: {
        connected: ct.connected,
        authorized: ct.authorized
      },
      latencyMs: Date.now() - started,
      checkedAt: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      service: "AURIXA AI",
      database: {
        status: "ERROR",
        connected: false,
        detail: String(err.message || err)
      },
      checkedAt: new Date().toISOString()
    });
  }
});

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


function getMarketSessionStatus(ct = getCTraderStatus()) {
  const connected = Boolean(ct?.connected && ct?.authorized);
  const last = ct?.lastUpdate ? Date.parse(ct.lastUpdate) : NaN;
  const ageMs = Number.isFinite(last) ? Math.max(0, Date.now() - last) : null;
  const stale = ageMs === null || ageMs > 30000;

  if (!connected) {
    return {
      status: "CTRADER_DISCONNECTED",
      open: false,
      stale: true,
      ageMs,
      reason: "cTrader is disconnected or unauthorized"
    };
  }

  if (stale) {
    return {
      status: "FEED_STALE",
      open: false,
      stale: true,
      ageMs,
      reason: "No fresh cTrader price update for more than 30 seconds"
    };
  }

  return {
    status: "MARKET_OPEN",
    open: true,
    stale: false,
    ageMs,
    reason: "Fresh cTrader market data is available"
  };
}


// Offline-only strategy comparison. Reads the current in-memory broker candle
// cache and never changes execution, risk, symbol arming, or auto-trading state.
app.get("/api/research/market-candles", (req, res) => {
  try {
    const ctrader = require("./ctrader");
    const symbol = normalizeSymbolName(req.query.symbol || "XAUUSD");
    if (!isSupportedSymbol(symbol)) {
      return res.status(400).json({ ok: false, error: "UNSUPPORTED_SYMBOL", supportedSymbols: require("./symbol-support").SUPPORTED_SYMBOLS });
    }
    const market = ctrader.getMultiSymbolMarket(symbol);
    const candles = Array.isArray(market?.candles) ? market.candles : [];
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true, mode: "research_data_only", symbol, timeframe: "M5",
      count: candles.length, required: 100,
      ready: candles.length >= 100,
      candles: candles.map(c => ({
        time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? null
      })),
      note: "Broker-cached M5 OHLC only. Historical spread, commission and slippage are not inferred."
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: "RESEARCH_CANDLES_UNAVAILABLE" });
  }
});

app.get("/api/research/compare-strategies", (req, res) => {
  try {
    const ctrader = require("./ctrader");
    const symbol = normalizeSymbolName(req.query.symbol || "XAUUSD");
    if (!isSupportedSymbol(symbol)) {
      return res.status(400).json({ ok: false, error: "UNSUPPORTED_SYMBOL" });
    }
    const market = ctrader.getMultiSymbolMarket(symbol);
    const candles = Array.isArray(market?.candles) ? market.candles : [];
    if (candles.length < 100) {
      return res.status(409).json({
        ok: false, error: "INSUFFICIENT_M5_HISTORY", symbol,
        availableCandles: candles.length, requiredCandles: 100,
        message: "Wait for broker M5 history to load before comparing strategies."
      });
    }
    const costs = {
      spreadPrice: Number(req.query.spreadPrice),
      slippagePricePerSide: Number(req.query.slippagePricePerSide),
      commissionRPerTrade: Number(req.query.commissionRPerTrade)
    };
    if (Object.values(costs).some(v => !Number.isFinite(v) || v < 0) ||
        ["spreadPrice", "slippagePricePerSide", "commissionRPerTrade"].some(k => req.query[k] === undefined || req.query[k] === "")) {
      return res.status(400).json({
        ok: false, error: "EXPLICIT_COSTS_REQUIRED",
        requiredQueryParameters: {
          symbol: "Supported symbol, e.g. XAUUSD",
          spreadPrice: "Spread in symbol price units",
          slippagePricePerSide: "Slippage estimate per side in symbol price units",
          commissionRPerTrade: "Round-trip commission divided by monetary risk per trade, in R units"
        },
        note: "Do not use guessed costs. Replace these with measured costs for the same broker/account."
      });
    }
    const report = strategyComparison.compareStrategies({ symbol, candles, costs });
    res.set("Cache-Control", "no-store");
    res.json({
      ...report,
      dataQuality: {
        candleCount: candles.length,
        lastCandleTime: candles.at(-1)?.time ?? null,
        currentQuoteSpread: Number.isFinite(Number(market?.ask)) && Number.isFinite(Number(market?.bid))
          ? Number((Number(market.ask) - Number(market.bid)).toFixed(8)) : null,
        historicalSpreadUsed: false
      }
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: "STRATEGY_COMPARISON_FAILED", message: err.message });
  }
});

app.get("/api/auto-trader/status", (req, res) => {
  try {
    res.json({
      ok: true,
      ...autoTrader.getStatus()
    });
  } catch (err) {
    console.error("Auto-Trader status error:", err);
    res.status(500).json({
      ok: false,
      error: "Auto-Trader status unavailable"
    });
  }
});

app.get("/api/auto-trader/multi-symbol-status", (req, res) => {
  try {
    const ctrader = require("./ctrader");
    const markets = ctrader.getMultiSymbolMarkets().map(market => {
      const quoteTime = market.lastUpdate ? Date.parse(market.lastUpdate) : NaN;
      const quoteFresh = Number.isFinite(quoteTime) && Date.now() - quoteTime <= 30000;
      const ready = Boolean(
        ctrader.getCTraderStatusForSymbol(market.symbol)?.connected &&
        ctrader.getCTraderStatusForSymbol(market.symbol)?.authorized &&
        market.candleCount >= 50 && quoteFresh &&
        Number.isFinite(Number(market.bid)) && Number.isFinite(Number(market.ask)) &&
        Number(market.ask) > Number(market.bid)
      );
      const candidate = latestAutoTradeCandidates.get(normalizeSymbolName(market.symbol)) || {};
      const candidateTime = Date.parse(candidate.checkedAt || "");
      const candidateFresh = Number.isFinite(candidateTime) && Date.now() - candidateTime <= 45000;
      return { ...market, quoteFresh, ready,
        reason: ready ? "READY" : market.candleCount < 50 ? "WAITING_FOR_M5_HISTORY" :
          !quoteFresh ? "WAITING_FOR_FRESH_QUOTE" : "MARKET_DATA_UNAVAILABLE",
        study: {
          fresh: candidateFresh,
          signal: candidateFresh ? (candidate.signal || "WAIT") : "WAIT",
          confidence: candidateFresh ? (candidate.confidence ?? null) : null,
          trend: candidateFresh ? (candidate.trend || null) : null,
          regime: candidateFresh ? (candidate.regime || null) : null,
          ema9: candidateFresh ? (candidate.ema9 ?? null) : null,
          ema21: candidateFresh ? (candidate.ema21 ?? null) : null,
          ema50: candidateFresh ? (candidate.ema50 ?? null) : null,
          rsi: candidateFresh ? (candidate.rsi ?? null) : null,
          atr: candidateFresh ? (candidate.atr ?? null) : null,
          momentum: candidateFresh ? (candidate.momentum ?? null) : null,
          score: candidateFresh ? (candidate.score || null) : null,
          logic: candidateFresh ? (candidate.logic || null) : null,
          entry: candidateFresh ? (candidate.entry ?? null) : null,
          stopLoss: candidateFresh ? (candidate.stopLoss ?? null) : null,
          takeProfit: candidateFresh ? (candidate.takeProfit ?? null) : null,
          rewardRisk: candidateFresh ? (candidate.rewardRisk ?? null) : null,
          executionEligible: candidateFresh && candidate.executionEligible === true,
          executionStatus: candidateFresh ? (candidate.executionStatus || "ANALYZED · NO ENTRY") : "WAITING FOR ANALYSIS",
          reason: candidateFresh ? (candidate.executionReason || candidate.reason || "WAITING FOR ENTRY CONFIRMATION") : "WAITING FOR FRESH STRATEGY EVALUATION",
          checkedAt: candidate.checkedAt || null
        } };
    });
    res.set("Cache-Control", "no-store");
    const autoStatus = autoTrader.getStatus();
    const enabledSymbols = Array.isArray(autoStatus.enabledSymbols) ? autoStatus.enabledSymbols : [];
    const symbolScoped = autoStatus.symbolScoped === true;
    res.set("Cache-Control", "no-store");
    res.json({ ok:true, enabled:autoStatus.enabled, demoOnly:true, symbolScoped,
      enabledSymbols, discovered:markets.length, readyCount:markets.filter(m=>m.ready).length,
      markets:markets.map(m=>({...m, autoTradeEnabled:autoStatus.enabled &&
        (!symbolScoped || enabledSymbols.includes(normalizeSymbolName(m.symbol)))})) });
  } catch (err) {
    res.status(500).json({ok:false,error:"MULTI_SYMBOL_STATUS_UNAVAILABLE"});
  }
});

// Live scanner decisions: distinguish chart selection, data readiness, strategy approval and broker execution.
app.get("/api/auto-trader/candidate", (req, res) => {
  try {
    const enabled = autoTrader.getStatus().enabled === true;
    const now = Date.now();
    const candidates = Array.from(latestAutoTradeCandidates.values()).map(item => {
      const checkedAt = Date.parse(item.checkedAt || "");
      const fresh = Number.isFinite(checkedAt) && now - checkedAt <= 45000;
      const selectedForAutoTrade = enabled && fresh && item.executionEligible === true &&
        item.executionResult !== "BLOCKED" && item.executionResult !== "AUTO_TRADING_OFF";
      return { ...item, fresh, selectedForAutoTrade };
    }).sort((a, b) =>
      Number(b.selectedForAutoTrade) - Number(a.selectedForAutoTrade) ||
      Number(b.executionEligible) - Number(a.executionEligible) ||
      Number(b.confidence || 0) - Number(a.confidence || 0) ||
      String(b.checkedAt || "").localeCompare(String(a.checkedAt || ""))
    );
    const selected = candidates.find(item => item.selectedForAutoTrade) ||
      candidates.find(item => item.fresh && ["BUY", "SELL"].includes(item.bias)) || null;
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      enabled,
      scannerCount: candidates.length,
      selectedSymbol: selected?.symbol || null,
      selectedForAutoTrade: Boolean(selected?.selectedForAutoTrade),
      selectionStatus: !selected ? "WAITING FOR SCANNER EVALUATION" :
        selected.selectedForAutoTrade ? "CANDIDATE APPROVED · EXECUTION GATES PASSED" :
        selected.executionEligible ? "STRATEGY APPROVED · AUTO-TRADING OFF OR EXECUTION BLOCKED" :
        "NO ENTRY APPROVED · " + (selected.blockedBy?.join(", ") || selected.reason || "WAITING FOR GATES"),
      candidate: selected,
      candidates
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: "AUTO_TRADE_CANDIDATE_UNAVAILABLE" });
  }
});

// Read-only Quality Check V2 monitoring. This endpoint reports observations only:
 // it never changes V1 decisions, execution gates, broker orders, or trading settings.
app.get("/api/ai/quality-check-v2", async (req, res) => {
  try {
    // Prefer durable PostgreSQL telemetry so trends survive Render restarts/deploys.
    // If the database is unavailable, keep serving the in-memory observe-only view.
    try {
      const persisted = await aiQualityCheckV2Persistence.loadRecent(2000);
      if (persisted.length) aiQualityCheckV2Monitor.replaceHistory(persisted);
    } catch (historyError) {
      console.warn("Quality Check V2 durable history unavailable; using memory:", historyError.message);
    }
    const report = aiQualityCheckV2Monitor.summarize(Array.from(latestAutoTradeCandidates.values()));
    const history = aiQualityCheckV2Monitor.summarizeHistory();
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      ...report,
      history,
      note: "Observe-only diagnostics. WARNING/STALE statuses are monitoring labels, not order blocks."
    });
  } catch (err) {
    console.error("Quality Check V2 monitoring error:", err);
    res.status(500).json({ ok: false, mode: "observe_only", error: "QUALITY_CHECK_V2_MONITOR_UNAVAILABLE" });
  }
});

// Manual auto-trading control. Defaults to OFF after each process start.
// A request with symbol arms/disarms only that broker-discovered demo market.
// A request without symbol controls the global master switch.
app.post("/api/auto-trader/control", (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ ok: false, error: "enabled must be true or false" });
  }

  const ct = getCTraderStatus() || {};
  if (!ct.connected || !ct.authorized) {
    return res.status(409).json({ ok: false, enabled: false, error: "CTRADER_NOT_READY" });
  }
  if (ct.account?.isLive !== false) {
    return res.status(409).json({ ok: false, enabled: false, error: "DEMO_ACCOUNT_REQUIRED" });
  }
  if (ct.tradingPermission !== true) {
    return res.status(409).json({ ok: false, enabled: false, error: "BROKER_TRADING_PERMISSION_REQUIRED" });
  }

  const supportedDiscovered = symbol => isSupportedSymbol(symbol) &&
    (ct.symbols || []).some(item =>
      normalizeSymbolName(item.canonicalName || item.symbolName) === symbol);
  const requestedSymbol = req.body?.symbol == null ? "" : normalizeSymbolName(req.body.symbol);

  if (requestedSymbol) {
    if (!supportedDiscovered(requestedSymbol)) {
      return res.status(409).json({ ok: false, error: "UNSUPPORTED_SYMBOL_OR_NOT_DISCOVERED", symbol: requestedSymbol });
    }
    let armed = [];
    try {
      const parsed = JSON.parse(process.env.AUTO_TRADING_SYMBOLS || "[]");
      if (Array.isArray(parsed)) armed = parsed.map(normalizeSymbolName).filter(supportedDiscovered);
    } catch (_) { armed = []; }

    // Enabling a single pair from OFF starts a one-pair scope. If the operator
    // disables one pair while global mode is active, preserve the other discovered pairs.
    const wasScoped = String(process.env.AUTO_TRADING_SYMBOL_SCOPE || "false").toLowerCase() === "true";
    if (!wasScoped) {
      armed = enabled ? [] : (ct.symbols || [])
        .map(item => normalizeSymbolName(item.canonicalName || item.symbolName))
        .filter(supportedDiscovered);
    }
    const next = new Set(armed);
    if (enabled) next.add(requestedSymbol);
    else next.delete(requestedSymbol);

    process.env.AUTO_TRADING_SYMBOL_SCOPE = "true";
    process.env.AUTO_TRADING_SYMBOLS = JSON.stringify([...next]);
    process.env.AUTO_TRADING = next.size ? "true" : "false";
    return res.json({
      ok: true, enabled: next.has(requestedSymbol), symbol: requestedSymbol,
      enabledSymbols: [...next], symbolScoped: true, demoOnly: true,
      message: next.has(requestedSymbol)
        ? requestedSymbol + " demo auto-trading enabled; other pairs remain independently controlled."
        : requestedSymbol + " demo auto-trading disabled."
    });
  }

  if (!enabled) {
    process.env.AUTO_TRADING = "false";
    process.env.AUTO_TRADING_SYMBOL_SCOPE = "false";
    process.env.AUTO_TRADING_SYMBOLS = "[]";
    return res.json({ ok: true, enabled: false, symbolScoped: false, enabledSymbols: [],
      message: "Auto-trading disabled. Existing broker positions are not automatically closed." });
  }

  const symbol = normalizeSymbolName(ct.symbolName || ct.symbol || "");
  if (!supportedDiscovered(symbol)) {
    return res.status(409).json({ ok: false, enabled: false, error: "UNSUPPORTED_SYMBOL_OR_NOT_DISCOVERED" });
  }
  process.env.AUTO_TRADING_SYMBOL_SCOPE = "false";
  process.env.AUTO_TRADING_SYMBOLS = "[]";
  process.env.AUTO_TRADING = "true";
  return res.json({ ok: true, enabled: true, symbol, symbolScoped: false, demoOnly: true,
    message: "Demo auto-trading enabled for all supported markets. Orders still require a confirmed eligible signal and all risk gates to pass." });
});

app.get("/api/auto-trader/dry-run", async (req, res) => {
  try {
    const dryRun = await autoTrader.dryRunAiTrader();

    res.json({
      ok: true,
      strategy: "AURIXA_AI_TRADER_V1",
      liveExecution: false,
      paperTrading: true,
      ...dryRun
    });
  } catch (err) {
    console.error("AI Trader dry-run error:", err);
    res.status(500).json({
      ok: false,
      strategy: "AURIXA_AI_TRADER_V1",
      dryRun: true,
      orderSubmitted: false,
      error: "AI Trader dry-run unavailable"
    });
  }
});

app.get("/api/auto-trader/positions", async (req, res) => {
  try {
    const ctrader = require("./ctrader");
    const status = getCTraderStatus() || {};

    // Read the broker position snapshot on every request, including
    // protection orders, so the dashboard never relies on stale DB state.
    const getPositions = ctrader.getOpenSymbolPositions || ctrader.getOpenXAUUSDPositions;
    const positions = await getPositions(true);

    // Route-level quote fields are also returned in the API response below.
    // Keep these in route scope; per-position symbol quotes are resolved inside the map.
    const bid = Number(status.bid);
    const ask = Number(status.ask);

    const livePositions = positions.map(position => {
      const td = position?.tradeData || {};
      const symbol = normalizeSymbolName(position?.symbol || position?.symbolName || status.symbolName || status.symbol || "XAUUSD");
      const symbolStatus = ctrader.getCTraderStatusForSymbol?.(symbol) || status;
      const bid = Number(symbolStatus.bid);
      const ask = Number(symbolStatus.ask);
      const side = Number(td.tradeSide);
      const direction = side === 1 ? "BUY" : side === 2 ? "SELL" : null;
      const entry = Number(position?.price ?? td.openPrice ?? td.price ?? position?.openPrice);
      const volume = Number(td.volume ?? position?.volume);

      // cTrader's live quote is the authoritative mark price:
      // BUY positions are marked to bid, SELL positions to ask.
      const currentPrice =
        direction === "BUY" && Number.isFinite(bid) ? bid :
        direction === "SELL" && Number.isFinite(ask) ? ask :
        Number(position?.currentPrice ?? td.currentPrice ?? NaN);

      const brokerPnl = Number(
        position?.unrealizedNetProfit ??
        td.unrealizedNetProfit ??
        position?.netProfit ??
        position?.profit ??
        td.profit
      );

      // Actual protection must come only from the current cTrader position
      // snapshot. Never fall back to planned/stored trade SL/TP: missing broker
      // fields must remain unconfirmed rather than being shown as protected.
      const rawSL = position?.stopLoss ?? td.stopLoss;
      const rawTP = position?.takeProfit ?? td.takeProfit;
      const actualSL = rawSL == null || rawSL === "" ? null : Number(rawSL);
      const actualTP = rawTP == null || rawTP === "" ? null : Number(rawTP);
      const hasSL = Number.isFinite(actualSL) && actualSL > 0;
      const hasTP = Number.isFinite(actualTP) && actualTP > 0;
      const protectionStatus = hasSL && hasTP ? "PROTECTED" : hasSL || hasTP ? "PARTIAL" : "UNPROTECTED";

      return {
        ...position,
        symbol,
        direction,
        entryPrice: Number.isFinite(entry) ? entry : null,
        currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
        volume: Number.isFinite(volume) ? volume : null,
        stopLoss: hasSL ? actualSL : null,
        takeProfit: hasTP ? actualTP : null,
        brokerProtection: {
          source: "CTRADER_LIVE_POSITION_SNAPSHOT",
          status: protectionStatus,
          stopLoss: hasSL ? actualSL : null,
          takeProfit: hasTP ? actualTP : null,
          stopLossSet: hasSL,
          takeProfitSet: hasTP,
          checkedAt: symbolStatus.lastUpdate || new Date().toISOString()
        },
        // Never invent floating P/L from price difference × broker volume;
        // volume units and account-currency conversion vary by symbol.
        unrealizedNetProfit: Number.isFinite(brokerPnl) ? brokerPnl : null,
        liveQuoteTimestamp: symbolStatus.lastUpdate || new Date().toISOString()
      };
    });

    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.json({
      ok: true,
      readOnly: true,
      live: true,
      quoteUpdatedAt: status.lastUpdate || null,
      scope: "MULTI_SYMBOL",
      symbol: normalizeSymbolName(status.symbolName || status.symbol || "XAUUSD"),
      selectedSymbol: normalizeSymbolName(status.symbolName || status.symbol || "XAUUSD"),
      symbolDigits: status.symbolDigits ?? null,
      bid: Number.isFinite(bid) ? bid : null,
      ask: Number.isFinite(ask) ? ask : null,
      count: livePositions.length,
      positions: livePositions
    });
  } catch (err) {
    console.error("Auto-Trader position inspection error:", err);

    res.status(500).json({
      ok: false,
      readOnly: true,
      live: false,
      error: "Position inspection unavailable"
    });
  }
});


app.get("/api/auto-trader/account", async (req, res) => {
  try {
    const ct = getCTraderStatus() || {};
    if (!ct.connected || !ct.authorized) {
      return res.status(503).json({ ok:false, readOnly:true, error:"CTRADER_NOT_READY" });
    }
    if (ct.account?.isLive !== false) {
      return res.status(403).json({ ok:false, readOnly:true, demoOnly:true, error:"DEMO_ACCOUNT_REQUIRED" });
    }
    const account = await require("./ctrader").getAccountBalance();
    res.json({
      ok:true, readOnly:true, demoOnly:true,
      accountId:ct.accountId, symbol:ct.symbolName || ct.symbol || "XAUUSD",
      brokerTitleShort:ct.account?.brokerTitleShort || null,
      traderLogin:ct.account?.traderLogin || null,
      isLive:ct.account?.isLive === true,
      currency:account.currency || null,
      ...account,
      updatedAt:new Date().toISOString()
    });
  } catch (err) {
    console.error("Auto-Trader account inspection error:", err);
    res.status(500).json({ ok:false, readOnly:true, error:"ACCOUNT_DATA_UNAVAILABLE" });
  }
});

app.get("/api/auto-trader/trades", async (req, res) => {
  try {
    const limit = Math.min(
      100,
      Math.max(1, Number(req.query.limit) || 20)
    );

    const tradeColumns = `
      id,
      decision_id AS "decisionId",
      strategy_signal_key AS "strategySignalKey",
      signal_id AS "signalId",
      created_at AS "createdAt",
      symbol,
      timeframe,
      direction,
      signal_entry_price AS "signalEntryPrice",
      execution_entry_price AS "executionEntryPrice",
      order_id AS "orderId",
      position_id AS "positionId",
      volume,
      stop_loss_distance AS "stopLossDistance",
      take_profit_distance AS "takeProfitDistance",
      planned_entry_price AS "plannedEntryPrice",
      planned_stop_price AS "plannedStopPrice",
      planned_take_profit_price AS "plannedTakeProfitPrice",
      partial_taken AS "partialTaken",
      breakeven_applied AS "breakevenApplied",
      status,
      opened_at AS "openedAt",
      closed_at AS "closedAt",
      close_price AS "closePrice",
      profit,
      error,
      gate_reason AS "gateReason",
      exit_reason AS "exitReason",
      client_msg_id AS "clientMsgId",
      risk_percent AS "riskPercent",
      risk_amount AS "riskAmount"
    `;

    // Keep execution/audit events separate from closed-trade history.
    // Frequent rejected-signal audit rows can otherwise push recent closes
    // beyond the created_at-based page limit and hide them from the dashboard.
    const [result, closedResult] = await Promise.all([
      queryDatabase(`
        SELECT ${tradeColumns}
        FROM aurixa.auto_trades
        ORDER BY created_at DESC
        LIMIT $1
      `, [limit]),
      queryDatabase(`
        SELECT ${tradeColumns}
        FROM aurixa.auto_trades
        WHERE UPPER(BTRIM(COALESCE(status, ''))) LIKE 'CLOSED%'
           OR closed_at IS NOT NULL
        ORDER BY closed_at DESC NULLS LAST, created_at DESC
        LIMIT $1
      `, [limit])
    ]);

    // Closed-trade history is refreshed frequently and must never be served from a browser/proxy cache.
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.json({
      ok: true,
      autoTradingEnabled:
        String(process.env.AUTO_TRADING || "false").toLowerCase() === "true",
      count: result.rows.length,
      trades: result.rows,
      closedTradeCount: closedResult.rows.length,
      closedTrades: closedResult.rows
    });
  } catch (err) {
    console.error("Auto-Trader trades error:", err);

    res.status(500).json({
      ok: false,
      error: "Auto-Trader trade history unavailable"
    });
  }
});

app.get("/api/market/history", async (req, res) => {
  try {
    const ct = getCTraderStatus() || {};
    const accountId = Number(req.query.accountId || ct.accountId);
    const symbolId = Number(req.query.symbolId || ct.symbolId);
    const timeframe = String(req.query.timeframe || "5m").trim() || "5m";
    const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 1000);

    // Always prefer persisted candles, but never let a DB problem make the
    // frontend chart blank when the live market engine already has candles.
    if (Number.isFinite(accountId) && Number.isFinite(symbolId)) {
      try {
        const result = await queryDatabase(`
          SELECT
            ctid_trader_account_id AS "accountId",
            symbol_id AS "symbolId",
            symbol,
            timeframe,
            EXTRACT(EPOCH FROM candle_time) * 1000 AS time,
            open, high, low, close, volume
          FROM aurixa.market_candles
          WHERE ctid_trader_account_id = $1
            AND symbol_id = $2
            AND timeframe = $3
          ORDER BY candle_time DESC
          LIMIT $4
        `, [accountId, symbolId, timeframe, limit]);

        const candles = result.rows.reverse();

        if (candles.length >= 2) {
          return res.json({
            ok: true,
            source: "database",
            accountId,
            symbolId,
            timeframe,
            count: candles.length,
            candles
          });
        }
      } catch (dbError) {
        console.warn("Market history DB fallback:", dbError.message);
      }
    }

    // Final fallback: live in-memory market-engine candles.
    const state = marketEngine.getState();
    const liveCandles = Array.isArray(state?.candles)
      ? state.candles.slice(-limit)
      : [];

    return res.json({
      ok: true,
      source: "market-engine",
      accountId: Number.isFinite(accountId) ? accountId : null,
      symbolId: Number.isFinite(symbolId) ? symbolId : null,
      timeframe,
      count: liveCandles.length,
      candles: liveCandles
    });
  } catch (err) {
    console.error("Market history error:", err);
    res.status(500).json({
      ok: false,
      error: "MARKET_HISTORY_UNAVAILABLE"
    });
  }
});

app.get("/api/market/state", (req, res) => {
  try {
    const state = marketEngine.getState();

    res.json({
      ok: true,
      source: "AURIXA market-engine",
      timestamp: new Date().toISOString(),
      ...state
    });
  } catch (error) {
    console.error("GET /api/market/state error:", error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/api/market",(req,res)=>{
  const ct = getCTraderStatus();
  const marketStatus = getMarketSessionStatus(ct);
  const state = marketEngine.getState();
  const decision = aiTraderEngine.decide(state.candles || [], ct);

  res.json({
    symbol: normalizeSymbolName(ct.symbolName || ct.symbol || "XAUUSD"),
    timeframe: "5m",

    price: ct.mid ?? state.price ?? null,
    bid: ct.bid ?? null,
    ask: ct.ask ?? null,

    candles: state.candles || [],

    prediction: decision,

    liveConnected: !!(ct.connected && ct.authorized),
    authorized: !!ct.authorized,
    accountId: ct.accountId ?? null,
    symbolId: ct.symbolId ?? null,
    lastUpdate: ct.lastUpdate ?? null,
    error: ct.error ?? null,
    marketStatus: marketStatus.status,
    marketOpen: marketStatus.open,
    marketStale: marketStatus.stale,
    marketStatusDetail: marketStatus.reason,
    marketDataAgeMs: marketStatus.ageMs,

    autoTrading: autoTrader.getStatus().enabled,
    autoTradingStrategy: "AURIXA_AI_TRADER_V1",
    paperTrading: true,

    aurixa: {
      engine: "AURIXA",
      mode: "LIVE_MARKET_ANALYSIS",
      tradingEnabled: autoTrader.getStatus().enabled,
      candleCount: state.candleCount || 0
    }
  });
});

app.use((req,res)=>{
  res.sendFile(path.join(__dirname,"..","web","index.html"));
});


const server = app.listen(PORT,"0.0.0.0",async()=>{
  console.log("");
  console.log("======================================");
  console.log("      AURIXA AI TRADER V1");
  console.log("======================================");
  console.log(`Phone: http://127.0.0.1:${PORT}`);
  console.log(`Symbol: ${process.env.SYMBOL}`);
  console.log("Auto trading strategy: AURIXA_AI_TRADER_V1");
  console.log("Paper trading: ENABLED");
  console.log("======================================");

  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;
  server.requestTimeout = 30000;

  try {
    await autoTrader.init();
    console.log("AURIXA Auto-Trader: initialized (execution remains controlled by AUTO_TRADING)");
  } catch (err) {
    console.error(
      "AURIXA Auto-Trader initialization failed:",
      err.message
    );
  }

    setInterval(async () => {
      const ctrader = require("./ctrader");
      const supported = ctrader.getSupportedSymbols();
      for (const item of supported) {
        const symbol = item.canonicalName;
        try {
          const market = ctrader.getMultiSymbolMarket(symbol);
          const ct = ctrader.getCTraderStatusForSymbol(symbol);
          const quoteTime = ct?.lastUpdate ? Date.parse(ct.lastUpdate) : NaN;
          const quoteFresh = Number.isFinite(quoteTime) && Date.now() - quoteTime <= 30000;
          if (!market || !Array.isArray(market.candles) || market.candles.length < 50 ||
              !Number.isFinite(Number(ct?.bid)) || !Number.isFinite(Number(ct?.ask)) ||
              Number(ct.ask) <= Number(ct.bid) || !quoteFresh) {
            const reason = !market ? "MARKET_NOT_REGISTERED" :
              (market.candles.length < 50 ? "INSUFFICIENT_M5_HISTORY" :
              (!quoteFresh ? "QUOTE_STALE" : "QUOTE_UNAVAILABLE"));
            const checkedAt = new Date().toISOString();
            const qualityCheckV2 = aiQualityCheckV2.observe(
              market?.candles || [], ct || {},
              { symbol, signal: "WAIT", executionEligible: false }
            );
            storeAutoTradeCandidate(symbol, {
              symbol, signal: "WAIT", bias: null, confidence: null,
              executionEligible: false, executionStatus: "WAITING FOR MARKET DATA",
              reason, blockedBy: [reason], candleCount: market?.candles?.length || 0,
              quoteFresh, qualityCheckV2, checkedAt
            });
            console.log("AURIXA_MULTI_SYMBOL_WAIT:", JSON.stringify({
              symbol, candleCount: market?.candles?.length || 0, quoteFresh, reason
            }));
            continue;
          }
          const decision = aiTraderEngine.decide(market.candles, ct);
          decision.qualityCheckV2 = aiQualityCheckV2.observe(market.candles, ct, decision);
          const decisionId = await auditAiDecision(decision);
          const bias = Number(decision.score?.buy) > Number(decision.score?.sell) ? "BUY" :
            Number(decision.score?.sell) > Number(decision.score?.buy) ? "SELL" : null;
          const candidate = {
            symbol, signal: decision.signal, bias, confidence: decision.confidence,
            executionEligible: decision.executionEligible === true,
            executionStatus: decision.executionEligible === true ? "ENTRY GATES PASSED · CHECKING EXECUTION" : "NOT APPROVED",
            reason: (decision.blockedBy || []).join(", ") || null,
            blockedBy: decision.blockedBy || [], gates: decision.gates || {},
            entry: decision.entry ?? null, stopLoss: decision.stopLoss ?? null,
            takeProfit: decision.takeProfit ?? null, rewardRisk: decision.rewardRisk ?? null,
            trend: decision.trend ?? null, regime: decision.regime ?? null,
            ema9: decision.ema9 ?? null, ema21: decision.ema21 ?? null, ema50: decision.ema50 ?? null,
            rsi: decision.rsi ?? null, atr: decision.atr ?? null, momentum: decision.momentum ?? null,
            score: decision.score ?? null, logic: decision.logic ?? null,
            qualityCheckV2: decision.qualityCheckV2,
            candleCount: market.candles.length, quoteFresh: true,
            decisionId, checkedAt: new Date().toISOString()
          };
          storeAutoTradeCandidate(symbol, candidate);
          // Emit one concise, auditable record per evaluated symbol, including
          // WAIT decisions. Without this, the absence of an order log is
          // ambiguous between "no approved signal" and an execution failure.
          console.log("AURIXA_MULTI_SYMBOL_DECISION:", JSON.stringify({
            symbol, signal: decision.signal, confidence: decision.confidence,
            executionEligible: decision.executionEligible === true,
            blockedBy: decision.blockedBy || [],
            candleTime: decision.candleTime ?? null,
            autoTradingEnabled: autoTrader.getStatus().enabled === true,
            quoteFresh: true, qualityCheckV2: decision.qualityCheckV2, decisionId
          }));
          if (decision.executionEligible === true) {
            const result = await autoTrader.executeAiDecision({...decision, decisionId}, decisionId);
            candidate.executionStatus = result.executed === true ? "ORDER ACCEPTED BY BROKER" :
              (result.reason ? "BLOCKED · " + result.reason : "NOT EXECUTED");
            candidate.executionReason = result.reason || null;
            candidate.executionResult = result.executed === true ? "ACCEPTED" :
              (result.reason === "AUTO_TRADING_DISABLED" ? "AUTO_TRADING_OFF" : "BLOCKED");
            candidate.orderId = result.orderId || null;
            candidate.positionId = result.positionId || null;
            candidate.volume = result.volume ?? null;
            candidate.protectionStatus = result.protectionStatus || null;
            candidate.qualityCheckV2.executionObservation = aiQualityCheckV2.observeExecution(result);
            candidate.checkedAt = new Date().toISOString();
            storeAutoTradeCandidate(symbol, candidate);
            console.log("AURIXA_MULTI_SYMBOL_EXECUTION:", JSON.stringify({
              symbol, decisionId, signal: decision.signal, executed: result.executed,
              reason: result.reason || null, orderId: result.orderId || null,
              positionId: result.positionId || null, riskAmount: result.riskAmount ?? null,
              volume: result.volume ?? null, protectionStatus: result.protectionStatus || null
            }));
          }
        } catch (err) {
          console.error("AURIXA_MULTI_SYMBOL_LOOP_ERROR:", JSON.stringify({symbol,error:err.message}));
        }
      }
      // Reconcile every symbol independently so each open position keeps its
      // own quote, SL/TP repair, break-even and trailing-stop context.
      for (const item of supported) {
        try {
          const sync = await autoTrader.syncOpenPositions(item.canonicalName);
          console.log("AURIXA_MULTI_SYMBOL_POSITION_SYNC:", JSON.stringify(sync));
        } catch (err) {
          console.error("AURIXA_MULTI_SYMBOL_POSITION_SYNC_ERROR:", JSON.stringify({
            symbol:item.canonicalName,error:err.message
          }));
        }
      }
    }, 15000);
});
app.get("/api/auto-trader/trade-trace/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid trade trace ID" });
    }

    const result = await queryDatabase(`
      SELECT
        t.id,
        t.decision_id AS "decisionId",
        t.created_at AS "createdAt",
        t.symbol,
        t.timeframe,
        t.direction,
        t.signal_entry_price AS "signalEntryPrice",
        t.execution_entry_price AS "executionEntryPrice",
        t.order_id AS "orderId",
        t.position_id AS "positionId",
        t.client_msg_id AS "clientMsgId",
        t.volume,
        t.stop_loss_distance AS "stopLossDistance",
        t.take_profit_distance AS "takeProfitDistance",
        t.planned_entry_price AS "plannedEntryPrice",
        t.planned_stop_price AS "plannedStopPrice",
        t.planned_take_profit_price AS "plannedTakeProfitPrice",
        t.partial_taken AS "partialTaken",
        t.breakeven_applied AS "breakevenApplied",
        t.status,
        t.opened_at AS "openedAt",
        t.closed_at AS "closedAt",
        t.close_price AS "closePrice",
        t.profit,
        t.error,
        t.gate_reason AS "gateReason",
        t.exit_reason AS "exitReason",
        d.engine,
        d.version,
        d.confidence,
        d.decision
      FROM aurixa.auto_trades t
      LEFT JOIN aurixa.ai_trade_decisions d ON d.id = t.decision_id
      WHERE t.id = $1
      LIMIT 1
    `, [id]);

    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: "Trade trace not found" });
    }

    const trade = result.rows[0];
    res.json({
      ok: true,
      trace: {
        decision: {
          id: trade.decisionId,
          engine: trade.engine,
          version: trade.version,
          confidence: trade.confidence,
          data: trade.decision
        },
        execution: {
          status: trade.status,
          direction: trade.direction,
          orderId: trade.orderId,
          positionId: trade.positionId,
          clientMsgId: trade.clientMsgId,
          entryPrice: trade.executionEntryPrice,
          openedAt: trade.openedAt
        },
        protection: {
          stopLossDistance: trade.stopLossDistance,
          takeProfitDistance: trade.takeProfitDistance,
          plannedEntryPrice: trade.plannedEntryPrice,
          plannedStopPrice: trade.plannedStopPrice,
          plannedTakeProfitPrice: trade.plannedTakeProfitPrice
        },
        lifecycle: {
          createdAt: trade.createdAt,
          closedAt: trade.closedAt,
          closePrice: trade.closePrice,
          profit: trade.profit,
          exitReason: trade.exitReason
        },
        gates: {
          reason: trade.gateReason
        },
        error: trade.error
      }
    });
  } catch (err) {
    console.error("Auto-Trader trade trace error:", err);
    res.status(500).json({ ok: false, error: "Trade trace unavailable" });
  }
});
