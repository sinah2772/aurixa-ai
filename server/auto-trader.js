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
    strategy: "AURIXA_OF1",
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

async function executeOrderflowSignal(of1) {
  const cfg = config();
  const signal = {
    direction: of1?.signal,
    candleTime: of1?.candleTime,
    entryPrice: of1?.entry ?? of1?.price ?? null
  };
  const strategyKey = `AURIXA_OF1:${String(of1?.candleTime || "")}:${String(of1?.signal || "")}`;

  const reject = async (reason, extra = {}) => {
    if (typeof dbQuery === "function") {
      await dbQuery(`
        INSERT INTO aurixa.auto_trades
        (signal_id,strategy,strategy_signal_key,symbol,timeframe,direction,signal_entry_price,volume,status,gate_reason,error)
        VALUES (NULL,'AURIXA_OF1',$1,'XAUUSD','5m',$2,$3,0,'REJECTED',$4,$5)
        ON CONFLICT (strategy_signal_key) DO UPDATE
          SET status='REJECTED', gate_reason=EXCLUDED.gate_reason, error=EXCLUDED.error
      `, [strategyKey, signal.direction || "BUY", signal.entryPrice, reason, extra.error || null]);
    }
    return {
      executed: false,
      strategy: "AURIXA_OF1",
      signalId: null,
      strategySignalKey: strategyKey,
      direction: signal.direction || null,
      reason,
      ...extra
    };
  };

  if (!cfg.enabled) return reject("AUTO_TRADING_DISABLED");
  if (!of1 || !["BUY","SELL"].includes(of1.signal)) return reject("OF1_NON_DIRECTIONAL_SIGNAL");

  const signalTime = Number(of1.candleTime);
  const normalizedSignalTime = signalTime < 100000000000 ? signalTime * 1000 : signalTime;
  const age = Date.now() - normalizedSignalTime;
  if (!Number.isFinite(normalizedSignalTime) || age < 0 || age > cfg.maxSignalAgeMinutes * 60000)
    return reject("OF1_STALE_SIGNAL", { ageMs: age });

  const status = cTrader?.getCTraderStatus?.();
  if (!status?.connected || !status?.authorized) return reject("CTRADER_NOT_READY");
  if (cfg.demoOnly && status.account?.isLive !== false)
    return reject(status.account?.isLive === true ? "LIVE_ACCOUNT_BLOCKED" : "ACCOUNT_ENVIRONMENT_UNKNOWN");
  if (!status.tradingPermission) return reject("TRADE_PERMISSION_REQUIRED");
  if (String(status.symbolName || status.symbol || "").toUpperCase() !== "XAUUSD")
    return reject("XAUUSD_NOT_READY");

  const bid = Number(status.bid), ask = Number(status.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask <= bid)
    return reject("LIVE_PRICE_UNAVAILABLE");
  const spread = ask - bid;
  if (spread > cfg.maxSpread)
    return reject("SPREAD_TOO_HIGH", { spread, maxSpread: cfg.maxSpread });

  const of1Score = Number(of1.score);
  const of1Confidence = Number(of1.confidence);
  if (!Number.isFinite(of1Score) || of1Score < 8)
    return reject("OF1_SCORE_TOO_LOW", { of1Score });
  if (!Number.isFinite(of1Confidence) || of1Confidence < 75)
    return reject("OF1_CONFIDENCE_TOO_LOW", { of1Confidence });

  const entry = signal.direction === "BUY" ? ask : bid;
  const stop = Number(of1.stop);
  const target = Number(of1.target);

  if (!Number.isFinite(stop) || stop <= 0) return reject("OF1_STOP_MISSING");
  if (!Number.isFinite(target) || target <= 0) return reject("OF1_TARGET_MISSING");
  if (signal.direction === "BUY" && stop >= entry) return reject("BUY_STOP_INVALID", { entry, stop });
  if (signal.direction === "SELL" && stop <= entry) return reject("SELL_STOP_INVALID", { entry, stop });
  if (signal.direction === "BUY" && target <= entry) return reject("BUY_TARGET_INVALID", { entry, target });
  if (signal.direction === "SELL" && target >= entry) return reject("SELL_TARGET_INVALID", { entry, target });

  const riskDistance = Math.abs(entry - stop);
  const targetDistance = Math.abs(target - entry);
  if (!Number.isFinite(riskDistance) || riskDistance <= 0)
    return reject("INVALID_RISK_DISTANCE", { entry, stop });
  if (!Number.isFinite(targetDistance) || targetDistance <= 0)
    return reject("INVALID_TARGET_DISTANCE", { entry, target });

  const positions = await cTrader.getOpenXAUUSDPositions();
  if (positions.length >= 1)
    return reject("XAUUSD_POSITION_ALREADY_OPEN", { openPositions: positions.length });

  if (typeof dbQuery === "function") {
    const dup = await dbQuery(
      "SELECT id,status FROM aurixa.auto_trades WHERE strategy_signal_key=$1 LIMIT 1",
      [strategyKey]
    );
    if (dup.rows.length)
      return {
        executed: false,
        strategy: "AURIXA_OF1",
        strategySignalKey: strategyKey,
        direction: signal.direction,
        reason: "OF1_SIGNAL_ALREADY_GATED"
      };

    const limits = await dbQuery(`
      SELECT COUNT(*) FILTER(
               WHERE created_at>=CURRENT_DATE
                 AND status IN ('OPEN','PARTIAL','CLOSED','SUBMITTED')
             )::int AS today,
             MAX(created_at) FILTER(
               WHERE status IN ('OPEN','PARTIAL','CLOSED','SUBMITTED')
             ) AS last_trade
      FROM aurixa.auto_trades
    `);
    const today = Number(limits.rows[0]?.today || 0);
    if (today >= cfg.maxTradesPerDay)
      return reject("MAX_DAILY_TRADES_REACHED", { tradesToday: today });

    const last = limits.rows[0]?.last_trade;
    if (last && Date.now() - new Date(last).getTime() < cfg.cooldownMinutes * 60000)
      return reject("TRADE_COOLDOWN_ACTIVE");
  }

  if (typeof cTrader.getAccountBalance !== "function")
    return reject("ACCOUNT_BALANCE_NOT_AVAILABLE");
  const account = await cTrader.getAccountBalance();
  const balance = Number(account.balance);
  if (!Number.isFinite(balance) || balance <= 0)
    return reject("INVALID_ACCOUNT_BALANCE");

  const riskAmount = balance * cfg.riskPercent / 100;
  const volume = Math.min(
    cfg.maxVolume,
    Math.floor((riskAmount / riskDistance) / 100) * 100
  );
  if (volume < 100)
    return reject("RISK_BUDGET_TOO_SMALL_FOR_VOLUME_STEP", {
      balance, riskAmount, riskDistance
    });

  let result;
  try {
    result = await cTrader.placeDemoMarketOrder({
      direction: signal.direction,
      volume,
      stopLossDistance: riskDistance,
      takeProfitDistance: targetDistance
    });
  } catch (err) {
    return reject("CTRADER_ORDER_REJECTED", { error: err.message });
  }

  if (typeof dbQuery === "function") {
    await dbQuery(`
      INSERT INTO aurixa.auto_trades
      (signal_id,strategy,strategy_signal_key,symbol,timeframe,direction,signal_entry_price,
       order_id,position_id,client_msg_id,volume,stop_loss_distance,take_profit_distance,
       status,opened_at,execution_entry_price,gate_reason,risk_percent,risk_amount,
       planned_entry_price,planned_stop_price,planned_take_profit_price)
      VALUES
      (NULL,'AURIXA_OF1',$1,'XAUUSD','5m',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
       CASE WHEN $11 IN ('OPEN','PARTIAL') THEN NOW() ELSE NULL END,
       $12,'PASSED',$13,$14,$15,$16,$17)
      ON CONFLICT(strategy_signal_key) DO UPDATE SET
        order_id=EXCLUDED.order_id,
        position_id=EXCLUDED.position_id,
        client_msg_id=EXCLUDED.client_msg_id,
        volume=EXCLUDED.volume,
        stop_loss_distance=EXCLUDED.stop_loss_distance,
        take_profit_distance=EXCLUDED.take_profit_distance,
        status=EXCLUDED.status,
        opened_at=EXCLUDED.opened_at,
        execution_entry_price=EXCLUDED.execution_entry_price,
        gate_reason='PASSED',
        risk_percent=EXCLUDED.risk_percent,
        risk_amount=EXCLUDED.risk_amount,
        planned_entry_price=EXCLUDED.planned_entry_price,
        planned_stop_price=EXCLUDED.planned_stop_price,
        planned_take_profit_price=EXCLUDED.planned_take_profit_price
    `, [
      strategyKey, signal.direction, signal.entryPrice,
      result.orderId || null, result.positionId || null, result.clientMsgId || null,
      volume, riskDistance, targetDistance, result.status || "SUBMITTED",
      result.executionPrice || entry, cfg.riskPercent, riskAmount,
      entry, stop, target
    ]);
  }

  return {
    executed: ["OPEN","PARTIAL"].includes(result.status),
    strategy: "AURIXA_OF1",
    signalId: null,
    strategySignalKey: strategyKey,
    direction: signal.direction,
    gate: "PASSED",
    of1Score,
    of1Confidence,
    riskPercent: cfg.riskPercent,
    riskAmount,
    volume,
    plannedEntryPrice: entry,
    plannedStopPrice: stop,
    plannedTakeProfitPrice: target,
    stopLossDistance: riskDistance,
    takeProfitDistance: targetDistance,
    ...result
  };
}

async function dryRunOrderflow() {
  const cfg = config();
  const result = {
    dryRun: true,
    wouldExecute: false,
    orderSubmitted: false,
    strategy: "AURIXA_OF1",
    checks: { autoTradingEnabled: cfg.enabled, demoOnly: cfg.demoOnly }
  };

  if (typeof analyzeOrderflow !== "function") {
    result.reason = "OF1_NOT_CONFIGURED";
    return result;
  }

  let of1;
  try {
    of1 = analyzeOrderflow(cTrader?.getMarketCandles ? cTrader.getMarketCandles() : []);
  } catch (err) {
    result.reason = "OF1_UNAVAILABLE";
    result.error = err.message;
    return result;
  }

  result.of1 = of1;
  result.checks.connected = Boolean(cTrader?.getCTraderStatus?.()?.connected);
  result.checks.authorized = Boolean(cTrader?.getCTraderStatus?.()?.authorized);
  result.reason = of1?.signal === "BUY" || of1?.signal === "SELL"
    ? "OF1_SIGNAL_READY_NO_ORDER_SUBMITTED"
    : "OF1_WAIT_NO_ORDER_SUBMITTED";
  result.wouldExecute = result.reason === "OF1_SIGNAL_READY_NO_ORDER_SUBMITTED";
  return result;
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
  const positions=await cTrader.getOpenXAUUSDPositions();
  const openPositionIds = new Set(
    positions.map(p => String(p?.positionId || p?.tradeData?.positionId || "")).filter(Boolean)
  );

  // Reconcile positions that disappeared from cTrader using the authoritative
  // closing deal, including realized gross profit, swap and commission.
  try {
    const pending = await dbQuery(`
      SELECT id, position_id AS "positionId", planned_stop_price AS "plannedStop",
             planned_take_profit_price AS "plannedTakeProfit"
      FROM aurixa.auto_trades
      WHERE status IN ('OPEN','PARTIAL') AND position_id IS NOT NULL
      ORDER BY opened_at ASC LIMIT 50
    `);

    for (const trade of pending.rows) {
      const pid = String(trade.positionId);
      if (openPositionIds.has(pid)) continue;

      try {
        const deals = typeof cTrader.getDealsByPositionId === "function"
          ? await cTrader.getDealsByPositionId(pid)
          : [];
        const closingDeals = deals.filter(d => d?.closePositionDetail);
        if (!closingDeals.length) continue;

        const last = closingDeals[closingDeals.length - 1];
        const detail = last.closePositionDetail || {};
        const moneyDigits = Number(last.moneyDigits ?? detail.moneyDigits ?? 2);
        const divisor = Math.pow(10, Number.isFinite(moneyDigits) ? moneyDigits : 2);
        const gross = Number(detail.grossProfit ?? 0) / divisor;
        const swap = Number(detail.swap ?? 0) / divisor;
        const commission = Number(detail.commission ?? last.commission ?? 0) / divisor;
        const profit = gross + swap + commission;
        const closePrice = Number(last.executionPrice);
        const plannedSL = Number(trade.plannedStop);
        const plannedTP = Number(trade.plannedTakeProfit);

        let exitReason = "MANUAL/OTHER";
        if (Number.isFinite(closePrice) && Number.isFinite(plannedTP) && Math.abs(closePrice - plannedTP) <= 0.15) {
          exitReason = "TAKE_PROFIT";
        } else if (Number.isFinite(closePrice) && Number.isFinite(plannedSL) && Math.abs(closePrice - plannedSL) <= 0.15) {
          exitReason = "STOP_LOSS";
        }

        const finalStatus = profit > 0 ? "CLOSED_WIN" : profit < 0 ? "CLOSED_LOSS" : "CLOSED_FLAT";

        await dbQuery(`
          UPDATE aurixa.auto_trades
          SET status=$2, closed_at=TO_TIMESTAMP($3 / 1000.0),
              close_price=$4, profit=$5, exit_reason=$6
          WHERE id=$1
        `, [trade.id, finalStatus, Number(last.executionTimestamp || Date.now()),
             Number.isFinite(closePrice) ? closePrice : null,
             Number.isFinite(profit) ? profit : null, exitReason]);

        console.log("AURIXA_TRADE_CLOSED:", JSON.stringify({
          id: trade.id, positionId: pid, status: finalStatus, closePrice, profit, exitReason
        }));
      } catch (err) {
        console.error("AURIXA trade close reconciliation failed:", err.message);
      }
    }
  } catch (err) {
    console.error("AURIXA trade history reconciliation failed:", err.message);
  }

  if (!positions.length) return {managed:0};
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
      signal_id BIGINT NULL UNIQUE
        REFERENCES aurixa.signals(id)
        ON DELETE CASCADE,
      strategy TEXT NOT NULL DEFAULT 'AURIXA_M5',
      strategy_signal_key TEXT UNIQUE,
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
    ["breakeven_applied", "BOOLEAN NOT NULL DEFAULT false"],
    ["exit_reason", "TEXT"],
    ["strategy", "TEXT NOT NULL DEFAULT 'AURIXA_M5'"],
    ["strategy_signal_key", "TEXT"]
  ];

  for (const [name, type] of columns) {
    await dbQuery(
      `ALTER TABLE aurixa.auto_trades ADD COLUMN IF NOT EXISTS ${name} ${type}`
    );
  }

  // OF1 trades are independent strategy events and do not require an
  // AURIXA M5 signal row. Existing M5 trade rows remain intact.
  await dbQuery(`ALTER TABLE aurixa.auto_trades ALTER COLUMN signal_id DROP NOT NULL`);

  // Repair legacy schemas created by earlier Auto-Trader versions.
  // Keep existing rows intact; only normalize nullable/default metadata needed by V1.
  await dbQuery(`ALTER TABLE aurixa.auto_trades ALTER COLUMN stop_loss_distance SET DEFAULT 0`);
  await dbQuery(`UPDATE aurixa.auto_trades SET stop_loss_distance = 0 WHERE stop_loss_distance IS NULL`);
  await dbQuery(`ALTER TABLE aurixa.auto_trades ALTER COLUMN stop_loss_distance SET NOT NULL`);
  await dbQuery(`ALTER TABLE aurixa.auto_trades ALTER COLUMN volume SET DEFAULT 0`);
  await dbQuery(`UPDATE aurixa.auto_trades SET volume = 0 WHERE volume IS NULL`);
  await dbQuery(`ALTER TABLE aurixa.auto_trades ALTER COLUMN volume SET NOT NULL`);

  await dbQuery(`
    UPDATE aurixa.auto_trades
    SET strategy='AURIXA_M5'
    WHERE strategy IS NULL
  `);

  await dbQuery(`
    CREATE INDEX IF NOT EXISTS idx_auto_trades_strategy
    ON aurixa.auto_trades(strategy, created_at DESC)
  `);

  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_trades_strategy_signal_key
    ON aurixa.auto_trades(strategy_signal_key)
    WHERE strategy_signal_key IS NOT NULL
  `);

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
  executeOrderflowSignal,
  dryRunOrderflow,
  // Compatibility wrapper: execution is now exclusively OF1-driven.
  async executeSignal() {
    return { executed: false, strategy: "AURIXA_OF1", reason: "M5_AUTO_TRADING_REMOVED" };
  },
  manageOpenPositions,
  getStatus
};
