const M5 = 5 * 60 * 1000;
const MAX_CANDLES = 300;

const state = {
  candles: [],
  currentCandle: null,
  lastClosedTime: null,
  initialized: false,
  lastUpdate: null,
  source: "CTRADER",
  timeframe: "5m",
  error: null,
  prediction: {
    signal: "WAIT",
    confidence: 0,
    dataReady: false,
    reason: "Waiting for cTrader M5 data"
  }
};

function round(value, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const p = 10 ** digits;
  return Math.round(Number(value) * p) / p;
}

function normalizeTime(value) {
  const n = Number(value || 0);
  if (!n) return Date.now();

  // cTrader trendbar timestamps are normally UTC minutes.
  if (n < 100000000000) return n * 60000;

  return n;
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) {
    return null;
  }

  const k = 2 / (period + 1);

  let value =
    values
      .slice(0, period)
      .reduce((sum, x) => sum + Number(x), 0) / period;

  for (let i = period; i < values.length; i++) {
    value = Number(values[i]) * k + value * (1 - k);
  }

  return value;
}

function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change =
      Number(values[i]) - Number(values[i - 1]);

    if (change >= 0) {
      gains += change;
    } else {
      losses -= change;
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change =
      Number(values[i]) - Number(values[i - 1]);

    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    avgGain =
      ((avgGain * (period - 1)) + gain) / period;

    avgLoss =
      ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}

function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) {
    return null;
  }

  const tr = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const high = Number(current.high);
    const low = Number(current.low);
    const previousClose = Number(previous.close);

    tr.push(
      Math.max(
        high - low,
        Math.abs(high - previousClose),
        Math.abs(low - previousClose)
      )
    );
  }

  if (tr.length < period) return null;

  return (
    tr
      .slice(-period)
      .reduce((a, b) => a + b, 0) / period
  );
}

function calculatePrediction(candles) {
  if (!candles || candles.length < 50) {
    return {
      signal: "WAIT",
      confidence: 0,
      dataReady: false,
      reason:
        `Building M5 history (${candles?.length || 0}/50 candles)`
    };
  }

  const closes = candles.map(c => Number(c.close));

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const r = rsi(closes, 14);
  const a = atr(candles, 14);

  if (
    ema9 == null ||
    ema21 == null ||
    ema50 == null ||
    r == null ||
    a == null
  ) {
    return {
      signal: "WAIT",
      confidence: 0,
      dataReady: false,
      reason: "Indicators are still calculating"
    };
  }

  let score = 0;
  const reasons = [];

  if (ema9 > ema21) {
    score++;
    reasons.push("EMA9 above EMA21");
  } else {
    score--;
    reasons.push("EMA9 below EMA21");
  }

  if (ema21 > ema50) {
    score++;
    reasons.push("EMA21 above EMA50");
  } else {
    score--;
    reasons.push("EMA21 below EMA50");
  }

  if (r >= 55 && r < 75) {
    score++;
    reasons.push("RSI bullish zone");
  } else if (r <= 45 && r > 25) {
    score--;
    reasons.push("RSI bearish zone");
  }

  const last = closes[closes.length - 1];
  const previous = closes[closes.length - 2];

  if (last > previous) {
    score++;
    reasons.push("price rising");
  } else if (last < previous) {
    score--;
    reasons.push("price falling");
  }

  let signal = "WAIT";

  if (score >= 3) {
    signal = "BUY";
  } else if (score <= -3) {
    signal = "SELL";
  }

  const confidence =
    signal === "WAIT"
      ? Math.min(65, 40 + Math.abs(score) * 5)
      : Math.min(95, 50 + Math.abs(score) * 10);

  return {
    signal,
    confidence,
    score,
    dataReady: true,
    reason: reasons.join(" • "),
    price: round(last, 2),
    ema9: round(ema9, 2),
    ema21: round(ema21, 2),
    ema50: round(ema50, 2),
    rsi: round(r, 2),
    atr: round(a, 2),
    timestamp: new Date().toISOString()
  };
}

function cleanCandle(candle) {
  if (!candle) return null;

  const time = normalizeTime(candle.time);

  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);

  if (
    !Number.isFinite(time) ||
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close)
  ) {
    return null;
  }

  return {
    time,
    open,
    high,
    low,
    close,
    volume:
      candle.volume == null
        ? null
        : Number(candle.volume)
  };
}

function recompute() {
  state.prediction =
    calculatePrediction(state.candles);

  state.initialized =
    state.candles.length >= 50;

  state.lastUpdate =
    new Date().toISOString();
}

function upsertCandle(candle, closed = false) {
  const c = cleanCandle(candle);

  if (!c) return;

  const existingIndex =
    state.candles.findIndex(
      x => Number(x.time) === Number(c.time)
    );

  if (existingIndex >= 0) {
    state.candles[existingIndex] = c;
  } else {
    state.candles.push(c);
  }

  state.candles.sort(
    (a, b) => Number(a.time) - Number(b.time)
  );

  if (state.candles.length > MAX_CANDLES) {
    state.candles =
      state.candles.slice(-MAX_CANDLES);
  }

  if (closed) {
    state.lastClosedTime = c.time;
    state.currentCandle = null;
  } else {
    state.currentCandle = c;
  }

  recompute();
}

function setHistoricalCandles(candles) {
  if (!Array.isArray(candles)) {
    throw new Error("Historical candle data must be an array");
  }

  state.candles = [];

  for (const candle of candles) {
    const c = cleanCandle(candle);
    if (c) state.candles.push(c);
  }

  state.candles.sort(
    (a, b) => Number(a.time) - Number(b.time)
  );

  state.candles =
    state.candles.slice(-MAX_CANDLES);

  if (state.candles.length) {
    state.lastClosedTime =
      state.candles[state.candles.length - 1].time;
  }

  state.error = null;

  recompute();
}

function updateLiveCandle(candle) {
  upsertCandle(candle, false);
}

function closeLiveCandle(candle) {
  upsertCandle(candle, true);
}

function setSpotPrice(price) {
  const p = Number(price);

  if (!Number.isFinite(p) || p <= 0) {
    return;
  }

  const now = Date.now();
  const bucket =
    Math.floor(now / M5) * M5;

  let current = state.currentCandle;

  if (
    !current ||
    Number(current.time) !== bucket
  ) {
    if (current) {
      closeLiveCandle(current);
    }

    current = {
      time: bucket,
      open: p,
      high: p,
      low: p,
      close: p,
      volume: null
    };

    state.currentCandle = current;

    upsertCandle(current, false);
    return;
  }

  current.high =
    Math.max(Number(current.high), p);

  current.low =
    Math.min(Number(current.low), p);

  current.close = p;

  upsertCandle(current, false);
}

function setError(error) {
  state.error =
    error ? String(error) : null;

  state.lastUpdate =
    new Date().toISOString();
}

function reset() {
  state.candles = [];
  state.currentCandle = null;
  state.lastClosedTime = null;
  state.initialized = false;
  state.lastUpdate = null;
  state.error = null;

  state.prediction = {
    signal: "WAIT",
    confidence: 0,
    dataReady: false,
    reason: "Waiting for cTrader M5 data"
  };
}

function getState() {
  return {
    source: state.source,
    timeframe: state.timeframe,
    candles: state.candles,
    currentCandle: state.currentCandle,
    lastClosedTime: state.lastClosedTime,
    initialized: state.initialized,
    candleCount: state.candles.length,
    lastUpdate: state.lastUpdate,
    error: state.error,
    price:
      state.currentCandle?.close ??
      state.candles[state.candles.length - 1]?.close ??
      null,
    prediction: state.prediction
  };
}

module.exports = {
  M5,
  getState,
  setHistoricalCandles,
  updateLiveCandle,
  closeLiveCandle,
  setSpotPrice,
  setError,
  reset,
  calculatePrediction
};
