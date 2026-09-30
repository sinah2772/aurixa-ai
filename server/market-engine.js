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
   BASIC INDICATORS
   ============================================================ */

function ema(values, period) {
  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return null;
  }

  const k = 2 / (period + 1);

  let value =
    values
      .slice(0, period)
      .reduce(
        (sum, x) => sum + Number(x),
        0
      ) / period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    value =
      Number(values[i]) * k +
      value * (1 - k);
  }

  return value;
}


function rsi(values, period = 14) {
  if (
    !Array.isArray(values) ||
    values.length <= period
  ) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    const change =
      Number(values[i]) -
      Number(values[i - 1]);

    if (change >= 0) {
      gains += change;
    } else {
      losses -= change;
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const change =
      Number(values[i]) -
      Number(values[i - 1]);

    const gain =
      Math.max(change, 0);

    const loss =
      Math.max(-change, 0);

    avgGain =
      ((avgGain * (period - 1)) + gain) /
      period;

    avgLoss =
      ((avgLoss * (period - 1)) + loss) /
      period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}


function atr(candles, period = 14) {
  if (
    !Array.isArray(candles) ||
    candles.length <= period
  ) {
    return null;
  }

  const tr = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const current = candles[i];
    const previous = candles[i - 1];

    const high = Number(current.high);
    const low = Number(current.low);
    const previousClose =
      Number(previous.close);

    tr.push(
      Math.max(
        high - low,
        Math.abs(
          high - previousClose
        ),
        Math.abs(
          low - previousClose
        )
      )
    );
  }

  if (tr.length < period) {
    return null;
  }

  return (
    tr
      .slice(-period)
      .reduce(
        (a, b) => a + b,
        0
      ) / period
  );
}


/* ============================================================
   ADVANCED HELPERS
   ============================================================ */

function averageRange(candles, period = 20) {
  if (
    !Array.isArray(candles) ||
    candles.length < period
  ) {
    return null;
  }

  const ranges = candles
    .slice(-period)
    .map(c =>
      Number(c.high) -
      Number(c.low)
    )
    .filter(Number.isFinite);

  if (!ranges.length) {
    return null;
  }

  return (
    ranges.reduce(
      (sum, value) => sum + value,
      0
    ) / ranges.length
  );
}


function momentumPercent(values, bars) {
  if (
    !Array.isArray(values) ||
    values.length <= bars
  ) {
    return null;
  }

  const current =
    Number(values[values.length - 1]);

  const previous =
    Number(
      values[values.length - 1 - bars]
    );

  if (
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous === 0
  ) {
    return null;
  }

  return (
    ((current - previous) / previous) *
    100
  );
}


function linearSlope(values, period = 10) {
  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return null;
  }

  const sample = values
    .slice(-period)
    .map(Number);

  const n = sample.length;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += sample[i];
    sumXY += i * sample[i];
    sumXX += i * i;
  }

  const denominator =
    n * sumXX - sumX * sumX;

  if (denominator === 0) {
    return null;
  }

  return (
    (n * sumXY - sumX * sumY) /
    denominator
  );
}


function candleStrength(candle) {
  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);

  const range = high - low;

  if (
    !Number.isFinite(range) ||
    range <= 0
  ) {
    return 0;
  }

  return (
    Math.abs(close - open) /
    range
  );
}


function candleDirection(candle) {
  const open = Number(candle.open);
  const close = Number(candle.close);

  if (close > open) {
    return 1;
  }

  if (close < open) {
    return -1;
  }

  return 0;
}


function recentCandleBias(candles, count = 5) {
  if (
    !Array.isArray(candles) ||
    candles.length < count
  ) {
    return 0;
  }

  const sample =
    candles.slice(-count);

  let bullish = 0;
  let bearish = 0;

  for (const candle of sample) {
    const direction =
      candleDirection(candle);

    if (direction > 0) {
      bullish++;
    }

    if (direction < 0) {
      bearish++;
    }
  }

  if (bullish > bearish) {
    return 1;
  }

  if (bearish > bullish) {
    return -1;
  }

  return 0;
}


function breakoutState(candles, lookback = 20) {
  if (
    !Array.isArray(candles) ||
    candles.length <= lookback
  ) {
    return 0;
  }

  const current =
    candles[candles.length - 1];

  const previous =
    candles.slice(
      -(lookback + 1),
      -1
    );

  const previousHigh =
    Math.max(
      ...previous.map(
        c => Number(c.high)
      )
    );

  const previousLow =
    Math.min(
      ...previous.map(
        c => Number(c.low)
      )
    );

  const close =
    Number(current.close);

  if (close > previousHigh) {
    return 1;
  }

  if (close < previousLow) {
    return -1;
  }

  return 0;
}


/* ============================================================
   AURIXA PREDICTION ENGINE V2
   ============================================================ */

function calculatePrediction(candles) {
  if (
    !Array.isArray(candles) ||
    candles.length < 60
  ) {
    return {
      signal: "WAIT",
      confidence: 0,
      dataReady: false,
      score: 0,
      reason:
        `Building M5 history (${candles?.length || 0}/60 candles)`
    };
  }

  const closes =
    candles.map(
      c => Number(c.close)
    );

  const ema9 =
    ema(closes, 9);

  const ema21 =
    ema(closes, 21);

  const ema50 =
    ema(closes, 50);

  const r =
    rsi(closes, 14);

  const a =
    atr(candles, 14);

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
      score: 0,
      reason:
        "Indicators are still calculating"
    };
  }

  const last =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];

  const price =
    Number(last.close);

  const previousPrice =
    Number(previous.close);

  const avgRange =
    averageRange(candles, 20);

  const momentum3 =
    momentumPercent(closes, 3);

  const momentum5 =
    momentumPercent(closes, 5);

  const momentum8 =
    momentumPercent(closes, 8);

  const slope =
    linearSlope(closes, 10);

  const bodyStrength =
    candleStrength(last);

  const candleBias =
    recentCandleBias(candles, 5);

  const breakout =
    breakoutState(candles, 20);


  /* ------------------------------------------------------------
     SCORE
     ------------------------------------------------------------ */

  let score = 0;

  const reasons = [];

  let bullishFactors = 0;
  let bearishFactors = 0;


  /* EMA TREND */

  if (ema9 > ema21) {
    score += 2;
    bullishFactors++;
    reasons.push("EMA9 > EMA21");
  } else {
    score -= 2;
    bearishFactors++;
    reasons.push("EMA9 < EMA21");
  }


  if (ema21 > ema50) {
    score += 2;
    bullishFactors++;
    reasons.push("EMA21 > EMA50");
  } else {
    score -= 2;
    bearishFactors++;
    reasons.push("EMA21 < EMA50");
  }


  /* EMA STACK */

  const bullishStack =
    ema9 > ema21 &&
    ema21 > ema50;

  const bearishStack =
    ema9 < ema21 &&
    ema21 < ema50;

  if (bullishStack) {
    score += 1;
    bullishFactors++;
    reasons.push("bullish EMA stack");
  }

  if (bearishStack) {
    score -= 1;
    bearishFactors++;
    reasons.push("bearish EMA stack");
  }


  /* RSI */

  if (r >= 52 && r <= 68) {
    score += 2;
    bullishFactors++;
    reasons.push("RSI bullish momentum");
  } else if (r >= 68 && r < 76) {
    score += 1;
    bullishFactors++;
    reasons.push("RSI strong but elevated");
  } else if (r > 76) {
    score -= 2;
    bearishFactors++;
    reasons.push("RSI overbought");
  } else if (r >= 32 && r < 48) {
    score -= 2;
    bearishFactors++;
    reasons.push("RSI bearish momentum");
  } else if (r >= 24 && r < 32) {
    score -= 1;
    bearishFactors++;
    reasons.push("RSI weak but recovering zone");
  } else if (r < 24) {
    score += 1;
    bullishFactors++;
    reasons.push("RSI deeply oversold");
  } else {
    reasons.push("RSI neutral");
  }


  /* SHORT-TERM MOMENTUM */

  if (
    momentum3 != null &&
    momentum3 > 0.02
  ) {
    score += 1;
    bullishFactors++;
    reasons.push("3-bar momentum positive");
  } else if (
    momentum3 != null &&
    momentum3 < -0.02
  ) {
    score -= 1;
    bearishFactors++;
    reasons.push("3-bar momentum negative");
  }


  if (
    momentum5 != null &&
    momentum5 > 0.04
  ) {
    score += 1;
    bullishFactors++;
  } else if (
    momentum5 != null &&
    momentum5 < -0.04
  ) {
    score -= 1;
    bearishFactors++;
  }


  /* PRICE DIRECTION */

  if (price > previousPrice) {
    score += 1;
    bullishFactors++;
    reasons.push("latest candle rising");
  } else if (price < previousPrice) {
    score -= 1;
    bearishFactors++;
    reasons.push("latest candle falling");
  }


  /* CANDLE STRENGTH */

  if (bodyStrength >= 0.65) {
    const direction =
      candleDirection(last);

    if (direction > 0) {
      score += 1;
      bullishFactors++;
      reasons.push("strong bullish candle");
    } else if (direction < 0) {
      score -= 1;
      bearishFactors++;
      reasons.push("strong bearish candle");
    }
  }


  /* RECENT CANDLE BIAS */

  if (candleBias > 0) {
    score += 1;
    bullishFactors++;
    reasons.push("recent candles bullish");
  } else if (candleBias < 0) {
    score -= 1;
    bearishFactors++;
    reasons.push("recent candles bearish");
  }


  /* BREAKOUT */

  if (breakout > 0) {
    score += 2;
    bullishFactors++;
    reasons.push("20-bar upside breakout");
  } else if (breakout < 0) {
    score -= 2;
    bearishFactors++;
    reasons.push("20-bar downside breakout");
  }


  /* TREND SLOPE */

  if (
    slope != null &&
    slope > 0
  ) {
    score += 1;
    bullishFactors++;
    reasons.push("positive price slope");
  } else if (
    slope != null &&
    slope < 0
  ) {
    score -= 1;
    bearishFactors++;
    reasons.push("negative price slope");
  }


  /* VOLATILITY */

  let volatilityState =
    "normal";

  if (
    avgRange != null &&
    a > avgRange * 1.8
  ) {
    volatilityState = "high";
    reasons.push("high volatility");
  } else if (
    avgRange != null &&
    a < avgRange * 0.55
  ) {
    volatilityState = "low";
    reasons.push("low volatility");
  }


  /* ------------------------------------------------------------
     SIGNAL
     ------------------------------------------------------------ */

  let signal = "WAIT";

  const absScore =
    Math.abs(score);

  const directionalGap =
    Math.abs(
      bullishFactors -
      bearishFactors
    );


  if (
    score >= 6 &&
    bullishFactors >= 5 &&
    directionalGap >= 2
  ) {
    signal = "BUY";
  } else if (
    score <= -6 &&
    bearishFactors >= 5 &&
    directionalGap >= 2
  ) {
    signal = "SELL";
  }


  /* ------------------------------------------------------------
     CONFIDENCE
     ------------------------------------------------------------ */

  let confidence = 45;

  if (signal !== "WAIT") {
    confidence =
      52 +
      Math.min(
        38,
        absScore * 3 +
        directionalGap * 2
      );

    /*
     * Don't present extreme confidence during
     * abnormal volatility.
     */
    if (volatilityState === "high") {
      confidence -= 8;
    }

    /*
     * A very strong RSI is a warning against
     * chasing the move.
     */
    if (
      signal === "BUY" &&
      r > 76
    ) {
      confidence -= 12;
    }

    if (
      signal === "SELL" &&
      r < 24
    ) {
      confidence -= 12;
    }

    confidence =
      Math.max(
        50,
        Math.min(
          94,
          confidence
        )
      );
  } else {
    confidence =
      Math.min(
        68,
        42 +
        absScore * 3
      );
  }


  /* ------------------------------------------------------------
     FINAL REASON
     ------------------------------------------------------------ */

  let statusReason;

  if (signal === "BUY") {
    statusReason =
      `Bullish agreement ${bullishFactors}/${bullishFactors + bearishFactors}`;
  } else if (signal === "SELL") {
    statusReason =
      `Bearish agreement ${bearishFactors}/${bullishFactors + bearishFactors}`;
  } else {
    statusReason =
      "Conflicting signals — waiting for stronger confirmation";
  }

  const detailReasons =
    reasons.slice(-6);

  return {
    signal,
    confidence: round(confidence, 0),
    score,
    dataReady: true,

    reason:
      `${statusReason} • ${detailReasons.join(" • ")}`,

    price:
      round(price, 2),

    ema9:
      round(ema9, 2),

    ema21:
      round(ema21, 2),

    ema50:
      round(ema50, 2),

    rsi:
      round(r, 2),

    atr:
      round(a, 2),

    momentum3:
      round(momentum3, 4),

    momentum5:
      round(momentum5, 4),

    momentum8:
      round(momentum8, 4),

    slope:
      round(slope, 4),

    bodyStrength:
      round(bodyStrength, 2),

    volatility:
      volatilityState,

    breakout:
      breakout,

    bullishFactors,

    bearishFactors,

    timestamp:
      new Date().toISOString()
  };
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
  state.prediction =
    calculatePrediction(
      state.candles
    );

  state.initialized =
    state.candles.length >= 60;

  state.lastUpdate =
    new Date().toISOString();
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

  state.prediction = {
    signal: "WAIT",
    confidence: 0,
    dataReady: false,
    reason:
      "Waiting for cTrader M5 data"
  };
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
