"use strict";

/*
 * AURIXA Demo Auto-Trading V1
 *
 * Safety:
 * - Disabled unless AUTO_TRADING=true
 * - Demo accounts only
 * - Never trades WAIT
 * - Maximum configured open positions
 * - Mandatory SL
 * - Uses closed-candle AURIXA signals
 */

let cTrader = null;
let dbQuery = null;

function configure({ ctrader, query }) {
  cTrader = ctrader;
  dbQuery = query;
}

function config() {
  return {
    enabled: String(process.env.AUTO_TRADING || "false").toLowerCase() === "true",
    demoOnly: String(process.env.AUTO_TRADING_DEMO_ONLY || "true").toLowerCase() !== "false",
    volume: Math.max(1, Number(process.env.AUTO_TRADING_VOLUME || 100)),
    sl: Number(process.env.AUTO_TRADING_SL || 0),
    tp: Number(process.env.AUTO_TRADING_TP || 0),
    maxPositions: Math.max(1, Number(process.env.AUTO_TRADING_MAX_POSITIONS || 1)),
    maxSignalAgeMinutes: Math.max(
      1,
      Number(process.env.AUTO_TRADING_MAX_SIGNAL_AGE_MINUTES || 7)
    )
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
    volume: cfg.volume,
    sl: cfg.sl,
    tp: cfg.tp,
    maxPositions: cfg.maxPositions,
    symbol: symbolName,
    connected: Boolean(ct?.connected),
    authorized: Boolean(ct?.authorized)
  };
}

async function executeSignal(signal) {
  const cfg = config();

  if (!cfg.enabled) {
    return { executed: false, reason: "AUTO_TRADING_DISABLED" };
  }

  if (!signal || !["BUY", "SELL"].includes(signal.direction)) {
    return { executed: false, reason: "NON_DIRECTIONAL_SIGNAL" };
  }

  const signalTime = new Date(signal.candleTime).getTime();
  const signalAgeMs = Date.now() - signalTime;

  if (
    !Number.isFinite(signalTime) ||
    signalAgeMs < 0 ||
    signalAgeMs > cfg.maxSignalAgeMinutes * 60 * 1000
  ) {
    return {
      executed: false,
      reason: "STALE_SIGNAL",
      signalAgeMinutes: Number.isFinite(signalAgeMs)
        ? Number((signalAgeMs / 60000).toFixed(2))
        : null,
      maxSignalAgeMinutes: cfg.maxSignalAgeMinutes
    };
  }

  if (!cfg.sl || cfg.sl <= 0) {
    return { executed: false, reason: "INVALID_STOP_LOSS" };
  }

  if (!cTrader || typeof cTrader.placeDemoMarketOrder !== "function") {
    return { executed: false, reason: "CTRADER_EXECUTOR_NOT_CONFIGURED" };
  }

  const status = cTrader.getCTraderStatus();

  if (!status.connected || !status.authorized) {
    return { executed: false, reason: "CTRADER_NOT_READY" };
  }

  if (cfg.demoOnly && status.account?.isLive === true) {
    console.error("AURIXA AUTO TRADE BLOCKED: live account detected");
    return { executed: false, reason: "LIVE_ACCOUNT_BLOCKED" };
  }

  if (cfg.demoOnly && status.account?.isLive !== false) {
    return { executed: false, reason: "ACCOUNT_ENVIRONMENT_UNKNOWN" };
  }

  const symbolName = String(
    status.symbolName || status.symbol || ""
  ).toUpperCase();

  if (!status.symbolId || symbolName !== "XAUUSD") {
    return { executed: false, reason: "XAUUSD_NOT_READY" };
  }

  // Hard maximum-position protection.
  if (typeof cTrader.getOpenXAUUSDPositions === "function") {
    const openPositions = await cTrader.getOpenXAUUSDPositions();

    if (openPositions.length >= cfg.maxPositions) {
      return {
        executed: false,
        reason: "MAX_OPEN_POSITIONS",
        openPositions: openPositions.length
      };
    }
  } else {
    return {
      executed: false,
      reason: "POSITION_CHECK_NOT_CONFIGURED"
    };
  }

  if (typeof dbQuery === "function" && signal.id) {
    const duplicate = await dbQuery(`
      SELECT id
      FROM aurixa.auto_trades
      WHERE signal_id = $1
      LIMIT 1
    `, [signal.id]);

    if (duplicate.rows.length) {
      return { executed: false, reason: "SIGNAL_ALREADY_TRADED" };
    }
  }

  const result = await cTrader.placeDemoMarketOrder({
    direction: signal.direction,
    volume: cfg.volume,
    stopLossDistance: cfg.sl,
    takeProfitDistance: cfg.tp
  });

  if (typeof dbQuery === "function" && signal.id) {
    await dbQuery(`
      INSERT INTO aurixa.auto_trades
      (
        signal_id,
        symbol,
        timeframe,
        direction,
        signal_entry_price,
        order_id,
        position_id,
        volume,
        stop_loss_distance,
        take_profit_distance,
        status
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (signal_id) DO NOTHING
    `, [
      signal.id,
      "XAUUSD",
      "5m",
      signal.direction,
      signal.entryPrice,
      result.orderId || null,
      result.positionId || null,
      cfg.volume,
      cfg.sl,
      cfg.tp || null,
      result.status || "SUBMITTED"
    ]);
  }

  return {
    executed: true,
    signalId: signal.id,
    direction: signal.direction,
    ...result
  };
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
    maxPositions: cfg.maxPositions,
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
  result.checks.positionLimitAvailable =
    openPositions.length < cfg.maxPositions;

  if (openPositions.length >= cfg.maxPositions) {
    result.reason = "MAX_OPEN_POSITIONS";
    return result;
  }

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
    CREATE TABLE IF NOT EXISTS aurixa.auto_trades (
      id BIGSERIAL PRIMARY KEY,
      signal_id BIGINT NOT NULL UNIQUE
        REFERENCES aurixa.signals(id)
        ON DELETE CASCADE,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      symbol TEXT NOT NULL DEFAULT 'XAUUSD',
      timeframe TEXT NOT NULL DEFAULT '5m',
      direction TEXT NOT NULL
        CHECK (direction IN ('BUY','SELL')),

      signal_entry_price NUMERIC(18,5),

      order_id TEXT,
      position_id TEXT,

      volume BIGINT NOT NULL,
      stop_loss_distance NUMERIC(18,5) NOT NULL,
      take_profit_distance NUMERIC(18,5),

      status TEXT NOT NULL DEFAULT 'SUBMITTED',

      opened_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      close_price NUMERIC(18,5),
      profit NUMERIC(18,5),
      error TEXT
    )
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
  getStatus
};
