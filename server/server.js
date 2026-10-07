const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

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
async function auditAiDecision(decision){
 try{
  await queryDatabase("CREATE SCHEMA IF NOT EXISTS aurixa");
  await queryDatabase("CREATE TABLE IF NOT EXISTS aurixa.ai_trade_decisions(id BIGSERIAL PRIMARY KEY,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),engine TEXT NOT NULL,version TEXT NOT NULL,signal TEXT NOT NULL,confidence NUMERIC(6,2),decision JSONB NOT NULL)");
  await queryDatabase("CREATE TABLE IF NOT EXISTS aurixa.ai_signals(id BIGSERIAL PRIMARY KEY,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),candle_time TIMESTAMPTZ,engine TEXT NOT NULL,version TEXT NOT NULL,symbol TEXT NOT NULL,timeframe TEXT NOT NULL,signal TEXT NOT NULL,confidence NUMERIC(6,2),entry_price NUMERIC,stop_loss NUMERIC,take_profit NUMERIC,reward_risk NUMERIC,execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,blocked_by JSONB NOT NULL DEFAULT '[]'::jsonb,decision JSONB NOT NULL)");
  const q=await queryDatabase("INSERT INTO aurixa.ai_trade_decisions(engine,version,signal,confidence,decision) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id",[decision.engine,decision.version,decision.signal,decision.confidence,JSON.stringify(decision)]);

  // Execution is evaluated every 15s, but signal history is intentionally
  // deduplicated: keep one record per new M5 candle and record any signal
  // transition immediately. This prevents WAIT/BUY/SELL spam in the UI.
  const parsedCandleTime=Date.parse(decision.candleTime);
  const fallbackCandleTime=Math.floor(Date.now()/300000)*300000;
  const candleTime=new Date(Number.isFinite(parsedCandleTime)?parsedCandleTime:fallbackCandleTime);
  const latest=await queryDatabase("SELECT signal,candle_time AS \"candleTime\" FROM aurixa.ai_signals ORDER BY created_at DESC LIMIT 1");
  const previous=latest.rows[0];
  const previousCandle=previous?.candleTime?Date.parse(previous.candleTime):NaN;
  const candleChanged=!previous || !Number.isFinite(previousCandle) || candleTime.getTime()!==previousCandle;
  const signalChanged=!previous || String(previous.signal)!==String(decision.signal);
  const shouldRecord=!previous || candleChanged || signalChanged;

  if(shouldRecord){
    await queryDatabase("INSERT INTO aurixa.ai_signals(candle_time,engine,version,symbol,timeframe,signal,confidence,entry_price,stop_loss,take_profit,reward_risk,execution_eligible,blocked_by,decision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb)",[
      candleTime,
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
  const decision=aiTraderEngine.decide(state.candles||[],ct),decisionId=await auditAiDecision(decision);
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
    const positions = await require("./ctrader").inspectOpenXAUUSDPositions();

    res.json({
      ok: true,
      readOnly: true,
      count: positions.length,
      positions
    });
  } catch (err) {
    console.error("Auto-Trader position inspection error:", err);

    res.status(500).json({
      ok: false,
      readOnly: true,
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

    const result = await queryDatabase(`
      SELECT
        id,
        decision_id AS "decisionId",
        strategy_signal_key AS "strategySignalKey",
        signal_id AS "signalId",
        created_at AS "createdAt",
        symbol,
        timeframe,
        direction,
        signal_entry_price AS "signalEntryPrice",
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
      FROM aurixa.auto_trades
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);

    res.json({
      ok: true,
      autoTradingEnabled:
        String(process.env.AUTO_TRADING || "false").toLowerCase() === "true",
      count: result.rows.length,
      trades: result.rows
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
    symbol: ct.symbol || "XAUUSD",
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
      try {
        const state=marketEngine.getState()||{},ct=getCTraderStatus()||{};
        const decision=aiTraderEngine.decide(Array.isArray(state.candles)?state.candles:[],ct);
        const decisionId=await auditAiDecision(decision);
        if(decision.executionEligible===true){
          const result=await autoTrader.executeAiDecision({...decision,decisionId},decisionId);
          console.log("AURIXA AI EXECUTION:",JSON.stringify({
            decisionId,
            signal:decision.signal,
            executed:result.executed,
            reason:result.reason||null,
            orderId:result.orderId||null,
            positionId:result.positionId||null,
            openPositions:result.openPositions??null,
            riskAmount:result.riskAmount??null,
            volume:result.volume??null,
            volumeMin:result.volumeMin??null,
            volumeStep:result.volumeStep??null
          }));
        }
        try{
          const sync=await autoTrader.syncOpenPositions();
          console.log("AURIXA POSITION SYNC:",JSON.stringify(sync));
        }catch(e){console.error("AURIXA position sync error:",e.message);}
      }catch(err){console.error("AURIXA AI Trader V1 loop error:",err.message);}
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
