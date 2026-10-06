"use strict";

/*
 * AURIXA Demo Auto-Trading V1
 *
 * Safety:
 * - Disabled unless AUTO_TRADING=true
 * - Demo accounts only
 * - Never trades WAIT
 * - No application-level maximum open-position limit
 * - Mandatory SL
 * - Uses closed-candle AURIXA signals
 */

let cTrader = null;
let dbQuery = null;
let analyzeOrderflow = null;

function configure({ ctrader, query, orderflow }) {
  cTrader = ctrader;
  dbQuery = query;
  analyzeOrderflow = orderflow || null;
}

function config() {
  return {
    enabled: String(process.env.AUTO_TRADING || "false").toLowerCase() === "true",
    demoOnly: String(process.env.AUTO_TRADING_DEMO_ONLY || "true").toLowerCase() !== "false",
    riskPercent: Math.max(0.1, Math.min(1, Number(process.env.AUTO_TRADING_RISK_PERCENT || 0.5))),
    rr: Math.max(1.5, Math.min(3, Number(process.env.AUTO_TRADING_RR || 2))),
    minConfidence: Math.max(50, Math.min(79, Number(process.env.AUTO_TRADING_MIN_CONFIDENCE || 60))),
    minScore: Math.max(6, Number(process.env.AUTO_TRADING_MIN_SCORE || 6)),
    maxSpread: Math.max(0.05, Number(process.env.AUTO_TRADING_MAX_SPREAD || 0.60)),
    cooldownMinutes: Math.max(5, Number(process.env.AUTO_TRADING_COOLDOWN_MINUTES || 30)),
    maxTradesPerDay: Math.max(1, Math.floor(Number(process.env.AUTO_TRADING_MAX_TRADES_PER_DAY || 2))),
    maxSignalAgeMinutes: Math.max(1, Number(process.env.AUTO_TRADING_MAX_SIGNAL_AGE_MINUTES || 7)),
    maxVolume: Math.max(100, Math.floor(Number(process.env.AUTO_TRADING_MAX_VOLUME || 1000))),
    breakevenR: Math.max(0.75, Number(process.env.AUTO_TRADING_BREAKEVEN_R || 1)),
    partialR: Math.max(0.75, Number(process.env.AUTO_TRADING_PARTIAL_R || 1)),
    partialPercent: Math.max(0, Math.min(75, Number(process.env.AUTO_TRADING_PARTIAL_PERCENT || 50)))
  };
}
function getStatus() {
  const cfg = config();
  const ct = typeof cTrader?.getCTraderStatus === "function"
    ? cTrader.getCTraderStatus()
    : null;

  const isDemo = ct?.account?.isLive === false;
  const symbolName = String(ct?.symbolName || ct?.symbol || "").toUpperCase();

  return {
    enabled: cfg.enabled,
    demoOnly: cfg.demoOnly,
    demoAccount: isDemo,
    blocked: cfg.demoOnly && !isDemo,
    riskPercent: cfg.riskPercent,
    rewardRisk: cfg.rr,
    minConfidence: cfg.minConfidence,
    minScore: cfg.minScore,
    maxSpread: cfg.maxSpread,
    maxTradesPerDay: cfg.maxTradesPerDay,
    cooldownMinutes: cfg.cooldownMinutes,
    maxVolume: cfg.maxVolume,
    breakevenR: cfg.breakevenR,
    partialR: cfg.partialR,
    partialPercent: cfg.partialPercent,
    symbol: symbolName,
    connected: Boolean(ct?.connected),
    authorized: Boolean(ct?.authorized)
  };
}

async function executeSignal(signal) {
  const cfg = config();
  const reject = async (reason, extra = {}) => {
    if (typeof dbQuery === "function" && signal?.id) {
      await dbQuery(`
        INSERT INTO aurixa.auto_trades
        (signal_id,symbol,timeframe,direction,signal_entry_price,volume,status,gate_reason,error)
        VALUES ($1,'XAUUSD','5m',$2,$3,0,'REJECTED',$4,$5)
        ON CONFLICT (signal_id) DO UPDATE SET status='REJECTED',gate_reason=EXCLUDED.gate_reason,error=EXCLUDED.error
      `, [signal.id, signal.direction || "BUY", signal.entryPrice ?? null, reason, extra.error || null]);
    }
    return { executed:false, signalId:signal?.id || null, direction:signal?.direction || null, reason, ...extra };
  };

  if (!cfg.enabled) return reject("AUTO_TRADING_DISABLED");
  if (!signal || !["BUY","SELL"].includes(signal.direction)) return reject("NON_DIRECTIONAL_SIGNAL");

  const signalTime = new Date(signal.candleTime).getTime();
  const age = Date.now() - signalTime;
  if (!Number.isFinite(signalTime) || age < 0 || age > cfg.maxSignalAgeMinutes * 60000)
    return reject("STALE_SIGNAL");

  const status = cTrader?.getCTraderStatus?.();
  if (!status?.connected || !status?.authorized) return reject("CTRADER_NOT_READY");
  if (cfg.demoOnly && status.account?.isLive !== false)
    return reject(status.account?.isLive === true ? "LIVE_ACCOUNT_BLOCKED" : "ACCOUNT_ENVIRONMENT_UNKNOWN");
  if (!status.tradingPermission) return reject("TRADE_PERMISSION_REQUIRED");
  if (String(status.symbolName || status.symbol || "").toUpperCase() !== "XAUUSD") return reject("XAUUSD_NOT_READY");

  const bid = Number(status.bid), ask = Number(status.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask <= bid) return reject("LIVE_PRICE_UNAVAILABLE");
  const spread = ask - bid;
  if (spread > cfg.maxSpread) return reject("SPREAD_TOO_HIGH",{spread,maxSpread:cfg.maxSpread});

  let orFvg;
  try { orFvg = require("./opening-range-strategy").getPrediction(); }
  catch (err) { return reject("OR_FVG_STRATEGY_UNAVAILABLE",{error:err.message}); }

  if (orFvg?.signal !== signal.direction || orFvg?.phase !== "TRIGGERED")
    return reject("OR_FVG_GATE_FAILED",{orFvgSignal:orFvg?.signal || "WAIT",orFvgPhase:orFvg?.phase || null});


  if (typeof analyzeOrderflow === "function") {
    let of1 = null;
    try { of1 = analyzeOrderflow(cTrader.getMarketCandles ? cTrader.getMarketCandles() : []); }
    catch (err) { return reject("OF1_UNAVAILABLE",{error:err.message}); }
    if (!of1 || of1.signal !== signal.direction) return reject("OF1_CONFIRMATION_FAILED",{of1Signal:of1?.signal || "WAIT",of1Score:of1?.score ?? null});
    if (Number(of1.score) < 8 || Number(of1.confidence) < 75) return reject("OF1_CONFIRMATION_TOO_WEAK",{of1Score:of1?.score ?? null,of1Confidence:of1?.confidence ?? null});
  }

  const confidence=Number(signal.confidence), score=Number(signal.score);
  if (!Number.isFinite(confidence) || confidence < cfg.minConfidence) return reject("M5_CONFIDENCE_TOO_LOW",{confidence});
  if (!Number.isFinite(score) || Math.abs(score) < cfg.minScore) return reject("M5_SCORE_TOO_LOW",{score});

  const ema9=Number(signal.ema9), ema21=Number(signal.ema21), ema50=Number(signal.ema50);
  const trendOk=signal.direction==="BUY" ? ema9>ema21 && ema21>ema50 : ema9<ema21 && ema21<ema50;
  if (!trendOk) return reject("M5_TREND_CONFLICT",{ema9,ema21,ema50});
  if (String(signal.volatility||"").toLowerCase()==="high") return reject("HIGH_VOLATILITY_BLOCK");
  const rsi=Number(signal.rsi);
  if ((signal.direction==="BUY"&&rsi>76)||(signal.direction==="SELL"&&rsi<24)) return reject("EXTREME_RSI_BLOCK",{rsi});

  const positions=await cTrader.getOpenXAUUSDPositions();
  if (positions.length >= 1) return reject("XAUUSD_POSITION_ALREADY_OPEN",{openPositions:positions.length});

  if (typeof dbQuery === "function" && signal.id) {
    const dup=await dbQuery("SELECT id,status FROM aurixa.auto_trades WHERE signal_id=$1 LIMIT 1",[signal.id]);
    if (dup.rows.length) return {executed:false,signalId:signal.id,direction:signal.direction,reason:"SIGNAL_ALREADY_GATED"};
    const limits=await dbQuery(`
      SELECT COUNT(*) FILTER(WHERE created_at>=CURRENT_DATE AND status IN ('OPEN','PARTIAL','CLOSED','SUBMITTED'))::int AS today,
             MAX(created_at) FILTER(WHERE status IN ('OPEN','PARTIAL','CLOSED','SUBMITTED')) AS last_trade
      FROM aurixa.auto_trades`);
    const today=Number(limits.rows[0]?.today||0);
    if (today>=cfg.maxTradesPerDay) return reject("MAX_DAILY_TRADES_REACHED",{tradesToday:today});
    const last=limits.rows[0]?.last_trade;
    if (last && Date.now()-new Date(last).getTime()<cfg.cooldownMinutes*60000)
      return reject("TRADE_COOLDOWN_ACTIVE");
  }

  const entry=signal.direction==="BUY"?ask:bid;
  const stop=Number(orFvg.stopLoss);
  if (!Number.isFinite(stop)||stop<=0) return reject("OR_FVG_STOP_MISSING");
  if (signal.direction==="BUY" && stop>=entry) return reject("BUY_STOP_INVALID",{entry,stop});
  if (signal.direction==="SELL" && stop<=entry) return reject("SELL_STOP_INVALID",{entry,stop});

  const riskDistance=Math.abs(entry-stop);
  if (!Number.isFinite(riskDistance) || riskDistance <= 0) return reject("INVALID_RISK_DISTANCE",{entry,stop});
  if (typeof cTrader.getAccountBalance !== "function") return reject("ACCOUNT_BALANCE_NOT_AVAILABLE");
  const account=await cTrader.getAccountBalance();
  const balance=Number(account.balance);
  if (!Number.isFinite(balance)||balance<=0) return reject("INVALID_ACCOUNT_BALANCE");

  const riskAmount=balance*cfg.riskPercent/100;
  const volume=Math.min(cfg.maxVolume,Math.floor((riskAmount/riskDistance)/100)*100);
  if (volume<100) return reject("RISK_BUDGET_TOO_SMALL_FOR_VOLUME_STEP",{balance,riskAmount,riskDistance});

  const tp=signal.direction==="BUY"?entry+riskDistance*cfg.rr:entry-riskDistance*cfg.rr;
  let result;
  try {
    result=await cTrader.placeDemoMarketOrder({
      direction:signal.direction,
      volume,
      stopLossDistance:riskDistance,
      takeProfitDistance:riskDistance*cfg.rr
    });
  } catch(err) {
    return reject("CTRADER_ORDER_REJECTED",{error:err.message});
  }

  if (typeof dbQuery === "function" && signal.id) {
    await dbQuery(`
      INSERT INTO aurixa.auto_trades
      (signal_id,symbol,timeframe,direction,signal_entry_price,order_id,position_id,client_msg_id,volume,stop_loss_distance,take_profit_distance,status,opened_at,execution_entry_price,gate_reason,risk_percent,risk_amount,planned_entry_price,planned_stop_price,planned_take_profit_price)
      VALUES ($1,'XAUUSD','5m',$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $10 IN ('OPEN','PARTIAL') THEN NOW() ELSE NULL END,$11,'PASSED',$12,$13,$14,$15,$16)
      ON CONFLICT(signal_id) DO UPDATE SET order_id=EXCLUDED.order_id,position_id=EXCLUDED.position_id,client_msg_id=EXCLUDED.client_msg_id,volume=EXCLUDED.volume,stop_loss_distance=EXCLUDED.stop_loss_distance,take_profit_distance=EXCLUDED.take_profit_distance,status=EXCLUDED.status,opened_at=EXCLUDED.opened_at,execution_entry_price=EXCLUDED.execution_entry_price,gate_reason='PASSED',risk_percent=EXCLUDED.risk_percent,risk_amount=EXCLUDED.risk_amount,planned_entry_price=EXCLUDED.planned_entry_price,planned_stop_price=EXCLUDED.planned_stop_price,planned_take_profit_price=EXCLUDED.planned_take_profit_price
    `,[signal.id,signal.direction,signal.entryPrice??null,result.orderId||null,result.positionId||null,result.clientMsgId||null,volume,riskDistance,riskDistance*cfg.rr,result.status||"SUBMITTED",result.executionPrice||entry,cfg.riskPercent,riskAmount,entry,stop,tp]);
  }

  return {executed:["OPEN","PARTIAL"].includes(result.status),signalId:signal.id,direction:signal.direction,gate:"PASSED",riskPercent:cfg.riskPercent,riskAmount,volume,plannedEntryPrice:entry,plannedStopPrice:stop,plannedTakeProfitPrice:tp,stopLossDistance:riskDistance,takeProfitDistance:riskDistance*cfg.rr,...result};
}

async function manageOpenPositions() {
  const cfg=config();
  if (!cfg.enabled || !cTrader?.getOpenXAUUSDPositions || !dbQuery) return {managed:0};

  // Never poll cTrader position APIs while the session is disconnected
  // or the account has not completed account authorization.
  const status = cTrader?.getCTraderStatus?.();
  if (!status?.connected || !status?.authorized || !status?.accountId) {
    return {managed:0, skipped:"CTRADER_NOT_READY"};
  }
  const positions=await cTrader.getOpenXAUUSDPositions(); if (!positions.length) return {managed:0};
  const ct=cTrader.getCTraderStatus?.()||{}; const bid=Number(ct.bid), ask=Number(ct.ask);
  if (!Number.isFinite(bid)||!Number.isFinite(ask)) return {managed:0};
  let managed=0;
  for(const p of positions){
    const positionId=String(p?.positionId||p?.tradeData?.positionId||""); if(!positionId) continue;
    const q=await dbQuery(`SELECT id,signal_id AS "signalId",direction,volume,execution_entry_price AS "entry",stop_loss_distance AS "risk",planned_take_profit_price AS "tp",COALESCE(partial_taken,false) AS "partialTaken" FROM aurixa.auto_trades WHERE position_id=$1 AND status IN ('OPEN','PARTIAL') LIMIT 1`,[positionId]);
    if(!q.rows.length) continue; const t=q.rows[0]; const entry=Number(t.entry), risk=Number(t.risk); if(!Number.isFinite(entry)||!Number.isFinite(risk)||risk<=0) continue;
    const current=t.direction==="BUY"?bid:ask; const rNow=t.direction==="BUY"?(current-entry)/risk:(entry-current)/risk;
    if(rNow>=cfg.partialR&&!t.partialTaken){const total=Math.floor(Number(t.volume));const closeVol=Math.floor((total*cfg.partialPercent/100)/100)*100;if(closeVol>=100&&closeVol<total){try{await cTrader.closeXAUUSDPosition(positionId,closeVol);await dbQuery("UPDATE aurixa.auto_trades SET partial_taken=true,status='PARTIAL' WHERE id=$1",[t.id]);}catch(err){console.error("AURIXA partial TP failed:",err.message);continue;}}else{await dbQuery("UPDATE aurixa.auto_trades SET partial_taken=true WHERE id=$1",[t.id]);}}
    if(rNow>=cfg.breakevenR){try{await cTrader.modifyPositionProtection(positionId,entry,Number.isFinite(Number(t.tp))?Number(t.tp):null);await dbQuery("UPDATE aurixa.auto_trades SET breakeven_applied=true WHERE id=$1",[t.id]);managed++;}catch(err){console.error("AURIXA breakeven update failed:",err.message);}}
  }
  return {managed};
}

async function dryRunSignal(signal) {
  const cfg = config();

  const result = {
    dryRun: true,
    wouldExecute: false,
    orderSubmitted: false,
    direction: signal?.direction || null,
    signalId: signal?.id || null,
    signalEntryPrice: signal?.entryPrice || null,
    volume: cfg.volume,
    stopLossDistance: cfg.sl,
    takeProfitDistance: cfg.tp || 0,
    maxPositions: null,
    checks: {}
  };

  result.checks.autoTradingEnabled = cfg.enabled;
  result.checks.demoOnly = cfg.demoOnly;

  if (!signal || !["BUY", "SELL"].includes(signal.direction)) {
    result.reason = "NON_DIRECTIONAL_SIGNAL";
    return result;
  }

  if (!cfg.sl || cfg.sl <= 0) {
    result.reason = "INVALID_STOP_LOSS";
    return result;
  }

  if (!cTrader || typeof cTrader.getCTraderStatus !== "function") {
    result.reason = "CTRADER_STATUS_NOT_CONFIGURED";
    return result;
  }

  const status = cTrader.getCTraderStatus();

  result.checks.connected = Boolean(status.connected);
  result.checks.authorized = Boolean(status.authorized);
  result.checks.demoAccount = status.account?.isLive === false;
  result.checks.liveAccount = status.account?.isLive === true;
  result.checks.symbol = String(
    status.symbolName || status.symbol || ""
  ).toUpperCase();
  result.checks.symbolId = status.symbolId || null;
  result.checks.currentBid = status.bid ?? null;
  result.checks.currentAsk = status.ask ?? null;
  result.checks.currentMid = status.bid !== null && status.ask !== null
    ? (status.bid + status.ask) / 2
    : null;

  if (!status.connected || !status.authorized) {
    result.reason = "CTRADER_NOT_READY";
    return result;
  }

  if (cfg.demoOnly && status.account?.isLive === true) {
    result.reason = "LIVE_ACCOUNT_BLOCKED";
    return result;
  }

  if (cfg.demoOnly && status.account?.isLive !== false) {
    result.reason = "ACCOUNT_ENVIRONMENT_UNKNOWN";
    return result;
  }

  if (!status.symbolId || result.checks.symbol !== "XAUUSD") {
    result.reason = "XAUUSD_NOT_READY";
    return result;
  }

  if (typeof cTrader.getOpenXAUUSDPositions !== "function") {
    result.reason = "POSITION_CHECK_NOT_CONFIGURED";
    return result;
  }

  const openPositions = await cTrader.getOpenXAUUSDPositions();

  result.checks.openPositions = openPositions.length;
  result.checks.positionLimitAvailable = true;
  result.checks.maxPositions = null;

  if (typeof dbQuery === "function" && signal.id) {
    const duplicate = await dbQuery(`
      SELECT id
      FROM aurixa.auto_trades
      WHERE signal_id = $1
      LIMIT 1
    `, [signal.id]);

    result.checks.signalAlreadyTraded = duplicate.rows.length > 0;

    if (duplicate.rows.length) {
      result.reason = "SIGNAL_ALREADY_TRADED";
      return result;
    }
  } else {
    result.checks.signalAlreadyTraded = false;
  }

  result.wouldExecute = true;
  result.reason = "DRY_RUN_READY_NO_ORDER_SUBMITTED";

  return result;
}

async function init() {
  if (typeof dbQuery !== "function") return false;

  await dbQuery(`
    CREATE SCHEMA IF NOT EXISTS aurixa
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS aurixa.auto_trades (
      id BIGSERIAL PRIMARY KEY,
      signal_id BIGINT NOT NULL UNIQUE
        REFERENCES aurixa.signals(id)
        ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      symbol TEXT NOT NULL DEFAULT 'XAUUSD',
      timeframe TEXT NOT NULL DEFAULT '5m',
      direction TEXT NOT NULL CHECK (direction IN ('BUY','SELL')),
      signal_entry_price NUMERIC(18,5),
      execution_entry_price NUMERIC(18,5),
      order_id TEXT,
      position_id TEXT,
      client_msg_id TEXT,
      volume BIGINT NOT NULL DEFAULT 0,
      stop_loss_distance NUMERIC(18,5) NOT NULL DEFAULT 0,
      take_profit_distance NUMERIC(18,5),
      planned_entry_price NUMERIC(18,5),
      planned_stop_price NUMERIC(18,5),
      planned_take_profit_price NUMERIC(18,5),
      risk_percent NUMERIC(8,4),
      risk_amount NUMERIC(18,5),
      gate_reason TEXT,
      status TEXT NOT NULL DEFAULT 'SUBMITTED',
      opened_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      close_price NUMERIC(18,5),
      profit NUMERIC(18,5),
      error TEXT,
      partial_taken BOOLEAN NOT NULL DEFAULT false,
      breakeven_applied BOOLEAN NOT NULL DEFAULT false
    )
  `);

  // Backfill/repair older deployments without touching existing rows.
  const columns = [
    ["execution_entry_price", "NUMERIC(18,5)"],
    ["client_msg_id", "TEXT"],
    ["planned_entry_price", "NUMERIC(18,5)"],
    ["planned_stop_price", "NUMERIC(18,5)"],
    ["planned_take_profit_price", "NUMERIC(18,5)"],
    ["gate_reason", "TEXT"],
    ["risk_percent", "NUMERIC(8,4)"],
    ["risk_amount", "NUMERIC(18,5)"],
    ["partial_taken", "BOOLEAN NOT NULL DEFAULT false"],
    ["breakeven_applied", "BOOLEAN NOT NULL DEFAULT false"]
  ];

  for (const [name, type] of columns) {
    await dbQuery(
      `ALTER TABLE aurixa.auto_trades ADD COLUMN IF NOT EXISTS ${name} ${type}`
    );
  }

  // Repair legacy schemas created by earlier Auto-Trader versions.
  // Keep existing rows intact; only normalize nullable/default metadata needed by V1.
  await dbQuery(`ALTER TABLE aurixa.auto_trades ALTER COLUMN stop_loss_distance SET DEFAULT 0`);
  await dbQuery(`UPDATE aurixa.auto_trades SET stop_loss_distance = 0 WHERE stop_loss_distance IS NULL`);
  await dbQuery(`ALTER TABLE aurixa.auto_trades ALTER COLUMN stop_loss_distance SET NOT NULL`);
  await dbQuery(`ALTER TABLE aurixa.auto_trades ALTER COLUMN volume SET DEFAULT 0`);
  await dbQuery(`UPDATE aurixa.auto_trades SET volume = 0 WHERE volume IS NULL`);
  await dbQuery(`ALTER TABLE aurixa.auto_trades ALTER COLUMN volume SET NOT NULL`);

  await dbQuery(`
    CREATE INDEX IF NOT EXISTS idx_auto_trades_client_msg_id
    ON aurixa.auto_trades(client_msg_id)
  `);

  await dbQuery(`
    CREATE INDEX IF NOT EXISTS idx_auto_trades_status
    ON aurixa.auto_trades(status)
  `);

  return true;
}

module.exports = {
  configure,
  init,
  executeSignal,
  dryRunSignal,
  manageOpenPositions,
  getStatus
};
