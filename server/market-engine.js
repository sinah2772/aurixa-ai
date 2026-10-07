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
  if (
    value == null ||
    !Number.isFinite(Number(value))
  ) {
    return null;
  }

  const p = 10 ** digits;
  return Math.round(Number(value) * p) / p;
}

function normalizeTime(value) {
  const n = Number(value || 0);

  if (!n) {
    return Date.now();
  }

  // cTrader trendbar timestamps may be UTC minutes.
  if (n < 100000000000) {
    return n * 60000;
  }

  return n;
}


/* ============================================================
   CANDLE MANAGEMENT
   ============================================================ */

function cleanCandle(candle) {
  if (!candle) {
    return null;
  }

  const time =
    normalizeTime(candle.time);

  const open =
    Number(candle.open);

  const high =
    Number(candle.high);

  const low =
    Number(candle.low);

  const close =
    Number(candle.close);

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
  state.initialized = state.candles.length >= 60;
  state.lastUpdate = new Date().toISOString();
}


function upsertCandle(
  candle,
  closed = false
) {
  const c =
    cleanCandle(candle);

  if (!c) {
    return;
  }

  const existingIndex =
    state.candles.findIndex(
      x =>
        Number(x.time) ===
        Number(c.time)
    );

  if (existingIndex >= 0) {
    state.candles[
      existingIndex
    ] = c;
  } else {
    state.candles.push(c);
  }

  state.candles.sort(
    (a, b) =>
      Number(a.time) -
      Number(b.time)
  );

  if (
    state.candles.length >
    MAX_CANDLES
  ) {
    state.candles =
      state.candles.slice(
        -MAX_CANDLES
      );
  }

  if (closed) {
    state.lastClosedTime =
      c.time;

    state.currentCandle =
      null;
  } else {
    state.currentCandle =
      c;
  }

  recompute();
}


function setHistoricalCandles(
  candles
) {
  if (!Array.isArray(candles)) {
    throw new Error(
      "Historical candle data must be an array"
    );
  }

  state.candles = [];

  for (const candle of candles) {
    const c =
      cleanCandle(candle);

    if (c) {
      state.candles.push(c);
    }
  }

  state.candles.sort(
    (a, b) =>
      Number(a.time) -
      Number(b.time)
  );

  state.candles =
    state.candles.slice(
      -MAX_CANDLES
    );

  if (state.candles.length) {
    state.lastClosedTime =
      state.candles[
        state.candles.length - 1
      ].time;
  }

  state.error = null;

  recompute();
}


function updateLiveCandle(candle) {
  upsertCandle(
    candle,
    false
  );
}


function closeLiveCandle(candle) {
  upsertCandle(
    candle,
    true
  );
}


function setSpotPrice(price) {
  const p =
    Number(price);

  if (
    !Number.isFinite(p) ||
    p <= 0
  ) {
    return;
  }

  const now =
    Date.now();

  const bucket =
    Math.floor(now / M5) *
    M5;

  let current =
    state.currentCandle;

  if (
    !current ||
    Number(current.time) !==
      bucket
  ) {
    if (current) {
      closeLiveCandle(
        current
      );
    }

    /*
     * When Render starts, historical candles already exist but
     * currentCandle is null. Previously we left lastClosedTime
     * pointing at the newest historical bar while starting a
     * brand-new live candle. The signal tracker then kept
     * replaying that historical bar; Auto-Trader correctly
     * rejected the resulting BUY/SELL as STALE_SIGNAL.
     *
     * Hand the stream over explicitly: the newest historical
     * bar becomes the latest closed bar, and the new time bucket
     * becomes the live candle.
     */
    const latestHistorical =
      state.candles[state.candles.length - 1];

    if (
      latestHistorical &&
      Number(latestHistorical.time) < bucket
    ) {
      state.lastClosedTime =
        Number(latestHistorical.time);
    }

    current = {
      time: bucket,
      open: p,
      high: p,
      low: p,
      close: p,
      volume: null
    };

    state.currentCandle =
      current;

    upsertCandle(
      current,
      false
    );

    return;
  }

  current.high =
    Math.max(
      Number(current.high),
      p
    );

  current.low =
    Math.min(
      Number(current.low),
      p
    );

  current.close = p;

  upsertCandle(
    current,
    false
  );
}


function setError(error) {
  state.error =
    error
      ? String(error)
      : null;

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

}


function getState() {
  return {
    source:
      state.source,

    timeframe:
      state.timeframe,

    candles:
      state.candles,

    currentCandle:
      state.currentCandle,

    lastClosedTime:
      state.lastClosedTime,

    initialized:
      state.initialized,

    candleCount:
      state.candles.length,

    lastUpdate:
      state.lastUpdate,

    error:
      state.error,

    price:
      state.currentCandle?.close ??
      state.candles[
        state.candles.length - 1
      ]?.close ??
      null,

    prediction:
      state.prediction
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
