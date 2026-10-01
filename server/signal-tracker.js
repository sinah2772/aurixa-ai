"use strict";

const HORIZONS = [5, 15, 30];

const {
  calculatePrediction
} = require("./market-engine");

let dbQuery = null;
let getMarketState = null;

let initialized = false;
let lastTrackedCandle = null;

function configure({ query, getState }) {
  dbQuery = query;
  getMarketState = getState;
}

function requireConfigured() {
  if (typeof dbQuery !== "function") {
    throw new Error("Signal tracker database query is not configured");
  }

  if (typeof getMarketState !== "function") {
    throw new Error("Signal tracker market state is not configured");
  }
}

async function init() {
  if (typeof dbQuery !== "function") {
    initialized = false;
    console.log(
      "AURIXA Signal Tracking: PostgreSQL not configured; tracking disabled locally"
    );
    return false;
  }

  await dbQuery(`
    CREATE SCHEMA IF NOT EXISTS aurixa
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS aurixa.signals (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      candle_time TIMESTAMPTZ NOT NULL,
      symbol TEXT NOT NULL DEFAULT 'XAUUSD',
      timeframe TEXT NOT NULL DEFAULT '5m',

      direction TEXT NOT NULL
        CHECK (direction IN ('BUY','SELL','WAIT')),

      entry_price NUMERIC(18,5) NOT NULL,
      confidence NUMERIC(6,3),

      score NUMERIC(8,3),
      ema9 NUMERIC(18,8),
      ema21 NUMERIC(18,8),
      ema50 NUMERIC(18,8),
      rsi NUMERIC(18,8),
      atr NUMERIC(18,8),

      momentum3 NUMERIC(18,8),
      momentum5 NUMERIC(18,8),
      momentum8 NUMERIC(18,8),
      slope NUMERIC(18,8),
      body_strength NUMERIC(18,8),

      volatility TEXT,
      breakout NUMERIC(18,8),

      bullish_factors INTEGER,
      bearish_factors INTEGER,

      reason TEXT,
      features JSONB,

      UNIQUE(symbol, timeframe, candle_time)
    )
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS aurixa.signal_evaluations (
      id BIGSERIAL PRIMARY KEY,

      signal_id BIGINT NOT NULL
        REFERENCES aurixa.signals(id)
        ON DELETE CASCADE,

      horizon_minutes INTEGER NOT NULL
        CHECK (horizon_minutes IN (5,15,30)),

      due_at TIMESTAMPTZ NOT NULL,

      evaluated_at TIMESTAMPTZ,

      entry_price NUMERIC(18,5) NOT NULL,
      evaluation_price NUMERIC(18,5),

      price_change NUMERIC(18,8),
      price_change_pct NUMERIC(12,6),

      result TEXT
        CHECK (result IN ('PENDING','WIN','LOSS','FLAT')),

      UNIQUE(signal_id, horizon_minutes)
    )
  `);

  await dbQuery(`
    CREATE INDEX IF NOT EXISTS idx_aurixa_signals_candle_time
    ON aurixa.signals(candle_time DESC)
  `);

  await dbQuery(`
    CREATE INDEX IF NOT EXISTS idx_aurixa_signal_evaluations_due
    ON aurixa.signal_evaluations(result, due_at)
  `);

  for (const horizon of HORIZONS) {
    await dbQuery(`
      INSERT INTO aurixa.signal_evaluations
        (
          signal_id,
          horizon_minutes,
          due_at,
          entry_price,
          result
        )
      SELECT
        s.id,
        $1,
        s.candle_time + ($1::INTEGER * INTERVAL '1 minute'),
        s.entry_price,
        'PENDING'
      FROM aurixa.signals s
      WHERE s.direction IN ('BUY','SELL')
        AND NOT EXISTS (
          SELECT 1
          FROM aurixa.signal_evaluations e
          WHERE e.signal_id = s.id
            AND e.horizon_minutes::INTEGER = $1::INTEGER
        )
    `, [horizon]);
  }

  initialized = true;

  console.log("AURIXA Signal Tracking V1: database ready");
  return true;
}

function cleanNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function trackClosedSignal() {
  if (!initialized) return null;

  const state = getMarketState();
  const candles = Array.isArray(state?.candles)
    ? state.candles
    : [];

  if (candles.length < 60) return null;

  /*
   * Prefer the market engine's explicit lastClosedTime.
   * This avoids depending on whether a live/current candle
   * is present in state.candles.
   */
  let candleTime = Number(state?.lastClosedTime);

  if (!Number.isFinite(candleTime)) {
    /*
     * Fallback:
     * If the engine has a current candle, the previous candle
     * is closed. Otherwise the newest candle is treated as the
     * latest available closed candle.
     */
    const hasCurrent =
      state?.currentCandle &&
      Number.isFinite(Number(state.currentCandle.time));

    const candidate = hasCurrent
      ? candles[candles.length - 2]
      : candles[candles.length - 1];

    candleTime = Number(candidate?.time);
  }

  if (!Number.isFinite(candleTime)) return null;

  /*
   * Find the exact candle by timestamp.
   */
  const closedCandle = candles.find(
    c => Number(c?.time) === candleTime
  );

  if (!closedCandle) return null;

  const candleDate = new Date(candleTime);

  if (!Number.isFinite(candleDate.getTime())) {
    return null;
  }

  /*
   * Build prediction using candles up to and including
   * the closed candle only.
   *
   * If a current live candle exists, exclude it.
   * Otherwise all available candles are already closed.
   */
  let completedCandles = candles;

  if (
    state?.currentCandle &&
    Number.isFinite(Number(state.currentCandle.time))
  ) {
    const currentTime = Number(state.currentCandle.time);

    completedCandles = candles.filter(
      c => Number(c?.time) <= candleTime && Number(c?.time) < currentTime
    );
  } else {
    completedCandles = candles.filter(
      c => Number(c?.time) <= candleTime
    );
  }

  if (completedCandles.length < 60) return null;

  /*
   * IMPORTANT:
   * Calculate the signal directly from the completed candles.
   *
   * Do not use state.prediction here because that prediction
   * may have been calculated from the newest/live market state.
   * Using calculatePrediction(completedCandles) prevents the
   * current candle from leaking into historical signal tracking.
   */
  const finalPrediction =
    typeof calculatePrediction === "function"
      ? calculatePrediction(completedCandles)
      : null;

  return {
    candleTime,
    candleDate,
    candle: closedCandle,
    prediction: finalPrediction
  };
}

async function recordSignal(signalData) {
  if (!signalData?.prediction) return null;

  const p = signalData.prediction;
  const candle = signalData.candle;

  const direction =
    p.signal === "BUY" || p.signal === "SELL"
      ? p.signal
      : "WAIT";

  const entryPrice = cleanNumber(candle.close);

  if (entryPrice === null || entryPrice <= 0) {
    return null;
  }

  const candleDate = signalData.candleDate;

  const result = await dbQuery(`
    INSERT INTO aurixa.signals
    (
      candle_time,
      symbol,
      timeframe,
      direction,
      entry_price,
      confidence,
      score,
      ema9,
      ema21,
      ema50,
      rsi,
      atr,
      momentum3,
      momentum5,
      momentum8,
      slope,
      body_strength,
      volatility,
      breakout,
      bullish_factors,
      bearish_factors,
      reason,
      features
    )
    VALUES
    (
      $1,
      'XAUUSD',
      '5m',
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $10,
      $11,
      $12,
      $13,
      $14,
      $15,
      $16,
      $17,
      $18,
      $19,
      $20,
      $21
    )
    ON CONFLICT (symbol, timeframe, candle_time)
    DO NOTHING
    RETURNING id
  `, [
    candleDate.toISOString(),
    direction,
    entryPrice,
    cleanNumber(p.confidence),
    cleanNumber(p.score),
    cleanNumber(p.ema9),
    cleanNumber(p.ema21),
    cleanNumber(p.ema50),
    cleanNumber(p.rsi),
    cleanNumber(p.atr),
    cleanNumber(p.momentum3),
    cleanNumber(p.momentum5),
    cleanNumber(p.momentum8),
    cleanNumber(p.slope),
    cleanNumber(p.bodyStrength),
    p.volatility || null,
    cleanNumber(p.breakout),
    Number.isFinite(Number(p.bullishFactors))
      ? Number(p.bullishFactors)
      : null,
    Number.isFinite(Number(p.bearishFactors))
      ? Number(p.bearishFactors)
      : null,
    p.reason || null,
    JSON.stringify({
      signal: direction,
      confidence: cleanNumber(p.confidence),
      score: cleanNumber(p.score),
      ema9: cleanNumber(p.ema9),
      ema21: cleanNumber(p.ema21),
      ema50: cleanNumber(p.ema50),
      rsi: cleanNumber(p.rsi),
      atr: cleanNumber(p.atr),
      momentum3: cleanNumber(p.momentum3),
      momentum5: cleanNumber(p.momentum5),
      momentum8: cleanNumber(p.momentum8),
      slope: cleanNumber(p.slope),
      bodyStrength: cleanNumber(p.bodyStrength),
      volatility: p.volatility || null,
      breakout: cleanNumber(p.breakout),
      bullishFactors: p.bullishFactors ?? null,
      bearishFactors: p.bearishFactors ?? null
    })
  ]);

  const signalId = result.rows[0]?.id || null;

  /*
   * Duplicate candle:
   * PostgreSQL already contains this signal.
   */
  if (!signalId) {
    return {
      id: null,
      direction,
      entryPrice,
      candleTime: signalData.candleTime,
      duplicate: true
    };
  }

  /*
   * Only directional signals receive outcome evaluations.
   * WAIT is still stored in aurixa.signals.
   */
  if (direction === "BUY" || direction === "SELL") {
    for (const horizon of HORIZONS) {
      await dbQuery(`
        INSERT INTO aurixa.signal_evaluations
        (
          signal_id,
          horizon_minutes,
          due_at,
          entry_price,
          result
        )
        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          'PENDING'
        )
        ON CONFLICT (signal_id, horizon_minutes)
        DO NOTHING
      `, [
        signalId,
        horizon,
        new Date(
          candleDate.getTime() + horizon * 60 * 1000
        ).toISOString(),
        entryPrice
      ]);
    }
  }

  return {
    id: signalId,
    direction,
    entryPrice,
    candleTime: signalData.candleTime,
    duplicate: false
  };
}

async function trackLatestClosedSignal() {
  if (!initialized) return null;

  const state = getMarketState();

  const candles = Array.isArray(state?.candles)
    ? state.candles
    : [];

  if (candles.length < 60) return null;

  /*
   * The market engine explicitly identifies the newest CLOSED candle.
   * Never process the current/live candle.
   */
  let lastClosedTime = Number(state?.lastClosedTime);

  if (!Number.isFinite(lastClosedTime)) {
    const hasCurrent =
      state?.currentCandle &&
      Number.isFinite(Number(state.currentCandle.time));

    const candidate = hasCurrent
      ? candles[candles.length - 2]
      : candles[candles.length - 1];

    lastClosedTime = Number(candidate?.time);
  }

  if (!Number.isFinite(lastClosedTime)) return null;

  /*
   * Find the newest candle already stored in PostgreSQL.
   *
   * This is more reliable than an in-memory lastTrackedCandle because:
   * - Render restarts do not lose tracking position.
   * - missed candles are automatically recovered.
   * - existing database records are never duplicated.
   */
  const existing = await dbQuery(`
    SELECT COALESCE(
      MAX(EXTRACT(EPOCH FROM candle_time) * 1000),
      0
    ) AS max_candle_time
    FROM aurixa.signals
    WHERE symbol = 'XAUUSD'
      AND timeframe = '5m'
  `);

  const lastStoredTime =
    Number(existing.rows[0]?.max_candle_time) || 0;

  /*
   * Process every closed candle after the newest stored candle.
   *
   * This intentionally catches up multiple candles if the service
   * was asleep, restarted, or missed a 5-minute interval.
   */
  const missingCandles = candles
    .filter(c => {
      const t = Number(c?.time);

      return (
        Number.isFinite(t) &&
        t > lastStoredTime &&
        t <= lastClosedTime
      );
    })
    .sort((a, b) => Number(a.time) - Number(b.time));

  if (missingCandles.length === 0) {
    lastTrackedCandle = lastClosedTime;
    return null;
  }

  let lastSaved = null;

  for (const targetCandle of missingCandles) {
    const candleTime = Number(targetCandle.time);

    /*
     * Only use candles through this exact closed candle.
     * This prevents future/live candle data from leaking into
     * the historical prediction.
     */
    const completedCandles = candles.filter(
      c => {
        const t = Number(c?.time);
        return Number.isFinite(t) && t <= candleTime;
      }
    );

    if (completedCandles.length < 60) {
      continue;
    }

    const prediction =
      typeof calculatePrediction === "function"
        ? calculatePrediction(completedCandles)
        : null;

    if (!prediction) {
      continue;
    }

    const signalData = {
      candleTime,
      candleDate: new Date(candleTime),
      candle: targetCandle,
      prediction
    };

    const saved = await recordSignal(signalData);

    /*
     * Move the in-memory marker forward after successful processing.
     * PostgreSQL remains the authoritative recovery point.
     */
    lastTrackedCandle = candleTime;

    if (saved) {
      lastSaved = saved;

      console.log(
        `AURIXA Signal: ${saved.direction} @ ${saved.entryPrice} ` +
        `(candle ${new Date(candleTime).toISOString()})` +
        (saved.duplicate ? " [already recorded]" : "")
      );
    }
  }

  return lastSaved;
}

async function evaluatePending() {
  if (!initialized) return;

  const state = getMarketState();

  const price =
    cleanNumber(state?.currentCandle?.close) ??
    cleanNumber(state?.price);

  if (price === null || price <= 0) return;

  const now = new Date().toISOString();

  const pending = await dbQuery(`
    SELECT
      e.id,
      e.signal_id,
      e.horizon_minutes,
      e.entry_price,
      s.direction
    FROM aurixa.signal_evaluations e
    JOIN aurixa.signals s
      ON s.id = e.signal_id
    WHERE e.result = 'PENDING'
      AND e.due_at <= $1
      AND s.direction IN ('BUY','SELL')
    ORDER BY e.due_at ASC
    LIMIT 100
  `, [now]);

  for (const row of pending.rows) {
    const entry = Number(row.entry_price);

    if (!Number.isFinite(entry) || entry <= 0) {
      continue;
    }

    const change = price - entry;
    const changePct = (change / entry) * 100;

    let result = "FLAT";

    if (row.direction === "BUY") {
      if (change > 0) result = "WIN";
      else if (change < 0) result = "LOSS";
    }

    if (row.direction === "SELL") {
      if (change < 0) result = "WIN";
      else if (change > 0) result = "LOSS";
    }

    await dbQuery(`
      UPDATE aurixa.signal_evaluations
      SET
        evaluated_at = NOW(),
        evaluation_price = $1,
        price_change = $2,
        price_change_pct = $3,
        result = $4
      WHERE id = $5
        AND result = 'PENDING'
    `, [
      price,
      change,
      changePct,
      result,
      row.id
    ]);
  }
}

async function getStats() {
  if (typeof dbQuery !== "function") {
    return {
      ok: true,
      tracking: false,
      horizons: {
        5: {
          evaluated: 0,
          wins: 0,
          losses: 0,
          flats: 0,
          winRate: null
        },
        15: {
          evaluated: 0,
          wins: 0,
          losses: 0,
          flats: 0,
          winRate: null
        },
        30: {
          evaluated: 0,
          wins: 0,
          losses: 0,
          flats: 0,
          winRate: null
        }
      },
      totals: {
        directional: 0,
        buy: 0,
        sell: 0,
        wait: 0
      },
      updatedAt: new Date().toISOString()
    };
  }

  requireConfigured();

  const result = await dbQuery(`
    SELECT
      e.horizon_minutes,

      COUNT(*) FILTER (
        WHERE e.result IN ('WIN','LOSS','FLAT')
      ) AS evaluated,

      COUNT(*) FILTER (
        WHERE e.result = 'WIN'
      ) AS wins,

      COUNT(*) FILTER (
        WHERE e.result = 'LOSS'
      ) AS losses,

      COUNT(*) FILTER (
        WHERE e.result = 'FLAT'
      ) AS flats,

      ROUND(
        100.0 *
        COUNT(*) FILTER (WHERE e.result = 'WIN')
        /
        NULLIF(
          COUNT(*) FILTER (
            WHERE e.result IN ('WIN','LOSS')
          ),
          0
        ),
        2
      ) AS win_rate

    FROM aurixa.signal_evaluations e
    JOIN aurixa.signals s
      ON s.id = e.signal_id

    WHERE s.direction IN ('BUY','SELL')

    GROUP BY e.horizon_minutes
    ORDER BY e.horizon_minutes
  `);

  const byHorizon = {};

  for (const row of result.rows) {
    const horizon = Number(row.horizon_minutes);

    byHorizon[horizon] = {
      evaluated: Number(row.evaluated || 0),
      wins: Number(row.wins || 0),
      losses: Number(row.losses || 0),
      flats: Number(row.flats || 0),
      winRate:
        row.win_rate === null
          ? null
          : Number(row.win_rate)
    };
  }

  for (const horizon of HORIZONS) {
    if (!byHorizon[horizon]) {
      byHorizon[horizon] = {
        evaluated: 0,
        wins: 0,
        losses: 0,
        flats: 0,
        winRate: null
      };
    }
  }

  const totals = await dbQuery(`
    SELECT
      COUNT(*) FILTER (
        WHERE direction IN ('BUY','SELL')
      ) AS directional,

      COUNT(*) FILTER (
        WHERE direction = 'BUY'
      ) AS buy,

      COUNT(*) FILTER (
        WHERE direction = 'SELL'
      ) AS sell,

      COUNT(*) FILTER (
        WHERE direction = 'WAIT'
      ) AS wait

    FROM aurixa.signals
  `);

  const t = totals.rows[0] || {};

  return {
    ok: true,
    horizons: byHorizon,
    totals: {
      directional: Number(t.directional || 0),
      buy: Number(t.buy || 0),
      sell: Number(t.sell || 0),
      wait: Number(t.wait || 0)
    },
    updatedAt: new Date().toISOString()
  };
}

async function getRecent(limit = 20) {
  if (typeof dbQuery !== "function") {
    return {
      ok: true,
      tracking: false,
      signals: []
    };
  }

  requireConfigured();

  const safeLimit = Math.min(
    Math.max(Number(limit) || 20, 1),
    100
  );

  const result = await dbQuery(`
    SELECT
      s.id,
      s.candle_time,
      s.direction,
      s.entry_price,
      s.confidence,

      jsonb_object_agg(
        e.horizon_minutes::text,
        jsonb_build_object(
          'result', e.result,
          'evaluationPrice', e.evaluation_price,
          'evaluatedAt', e.evaluated_at
        )
      ) FILTER (WHERE e.id IS NOT NULL) AS evaluations

    FROM aurixa.signals s

    LEFT JOIN aurixa.signal_evaluations e
      ON e.signal_id = s.id

    GROUP BY
      s.id,
      s.candle_time,
      s.direction,
      s.entry_price,
      s.confidence

    ORDER BY s.candle_time DESC
    LIMIT $1
  `, [safeLimit]);

  return {
    ok: true,
    signals: result.rows
  };
}

function getHorizonIntervalMs() {
  return 5000;
}

module.exports = {
  configure,
  init,
  trackLatestClosedSignal,
  evaluatePending,
  getStats,
  getRecent,
  getHorizonIntervalMs
};
