"use strict";

/*
 * AURIXA Opening Range + FVG Retest Strategy V1
 *
 * Strategy mapped for AURIXA:
 * 1. 09:30 New York first M5 candle = opening range
 * 2. M1 breakout
 * 3. 3-candle Fair Value Gap
 * 4. FVG retest
 * 5. Engulfing confirmation
 * 6. Entry at confirmation close
 * 7. SL beyond retest candle
 * 8. TP = 3R
 *
 * SIGNAL ONLY.
 * This module does NOT place trades.
 */

const MAX_M1 = 2000;
const MAX_M5 = 400;

const SESSION_START_MINUTE = 9 * 60 + 30;
// OR/FVG remains active for the full trading day after the 09:30 New York opening range.\n// The opening range is still anchored to the 09:30 M5 candle; the old 90-minute\n// setup cutoff has been removed.

const TICK_SIZE = 0.01;
const TARGET_RR = 3;

const state = {
  m1: [],
  m5: [],
  lastPrediction: null
};

function nyParts(timestamp) {
  const d = new Date(Number(timestamp));

  if (!Number.isFinite(d.getTime())) {
    return null;
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(d);

  const out = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      out[part.type] = Number(part.value);
    }
  }

  if (!out.year || !out.month || !out.day) {
    return null;
  }

  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    minuteOfDay: out.hour * 60 + out.minute,
    dateKey:
      String(out.year) +
      "-" +
      String(out.month).padStart(2, "0") +
      "-" +
      String(out.day).padStart(2, "0")
  };
}

function cleanCandle(candle) {
  if (!candle) return null;

  let time = Number(candle.time);
  const open = Number(candle.open);

  // cTrader trendbars provide UTC time in minutes.
  // Convert minute timestamps to milliseconds before New York
  // timezone/session calculations. Without this, dates resolve to 1970.
  if (Number.isFinite(time) && time < 100000000000) {
    time *= 60000;
  }
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);

  if (
    !Number.isFinite(time) ||
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close) ||
    high < low
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

function upsert(list, candle, max) {
  const c = cleanCandle(candle);

  if (!c) return;

  const index = list.findIndex(
    x => Number(x.time) === Number(c.time)
  );

  if (index >= 0) {
    list[index] = c;
  } else {
    list.push(c);
  }

  list.sort(
    (a, b) =>
      Number(a.time) - Number(b.time)
  );

  if (list.length > max) {
    list.splice(
      0,
      list.length - max
    );
  }
}

function isBullish(c) {
  return Number(c.close) > Number(c.open);
}

function isBearish(c) {
  return Number(c.close) < Number(c.open);
}

function bodyEngulfsBullish(previous, current) {
  return (
    isBullish(current) &&
    Number(current.open) <= Number(previous.close) &&
    Number(current.close) >= Number(previous.open)
  );
}

function bodyEngulfsBearish(previous, current) {
  return (
    isBearish(current) &&
    Number(current.open) >= Number(previous.close) &&
    Number(current.close) <= Number(previous.open)
  );
}

function findOpeningRange(m5, dateKey) {
  const candle = m5.find(c => {
    const p = nyParts(c.time);

    return (
      p &&
      p.dateKey === dateKey &&
      p.minuteOfDay === SESSION_START_MINUTE
    );
  });

  if (!candle) {
    return null;
  }

  return {
    dateKey,
    time: candle.time,
    high: Number(candle.high),
    low: Number(candle.low),
    range:
      Number(candle.high) -
      Number(candle.low)
  };
}

function withinSession(candle, dateKey) {
  const p = nyParts(candle.time);

  return (
    p &&
    p.dateKey === dateKey &&
    p.minuteOfDay >= SESSION_START_MINUTE &&
    p.minuteOfDay < SESSION_END_MINUTE
  );
}

function detectSetup(m1, range) {
  const bars = m1
    .filter(c =>
      withinSession(c, range.dateKey)
    )
    .sort(
      (a, b) =>
        Number(a.time) -
        Number(b.time)
    );

  if (bars.length < 5) {
    return {
      signal: "WAIT",
      phase: "WAIT_BREAKOUT",
      reason:
        "Waiting for M1 breakout data"
    };
  }

  let breakout = null;

  for (let i = 2; i < bars.length; i++) {
    const a = bars[i - 2];
    const b = bars[i - 1];
    const c = bars[i];

    const bullishFvg =
      Number(a.high) < Number(c.low);

    const bearishFvg =
      Number(a.low) > Number(c.high);

    if (
      bullishFvg &&
      [a, b, c].some(
        x =>
          Number(x.close) >
          range.high
      )
    ) {
      breakout = {
        direction: "BUY",
        index: i,
        from: Number(a.high),
        to: Number(c.low),
        candleTime: c.time
      };

      break;
    }

    if (
      bearishFvg &&
      [a, b, c].some(
        x =>
          Number(x.close) <
          range.low
      )
    ) {
      breakout = {
        direction: "SELL",
        index: i,
        from: Number(c.high),
        to: Number(a.low),
        candleTime: c.time
      };

      break;
    }
  }

  if (!breakout) {
    return {
      signal: "WAIT",
      phase: "WAIT_BREAKOUT",
      reason:
        "Opening range established; waiting for breakout + FVG",
      openingRange: range
    };
  }

  for (
    let i = breakout.index + 1;
    i < bars.length - 1;
    i++
  ) {
    const retest = bars[i];
    const confirm = bars[i + 1];

    const gapLow = Math.min(
      breakout.from,
      breakout.to
    );

    const gapHigh = Math.max(
      breakout.from,
      breakout.to
    );

    const touchesFvg =
      Number(retest.low) <= gapHigh &&
      Number(retest.high) >= gapLow;

    if (!touchesFvg) {
      continue;
    }

    if (
      breakout.direction === "BUY" &&
      bodyEngulfsBullish(
        retest,
        confirm
      )
    ) {
      const entry =
        Number(confirm.close);

      const stop =
        Number(retest.low) -
        TICK_SIZE;

      const risk =
        entry - stop;

      if (risk > 0) {
        return {
          signal: "BUY",
          phase: "TRIGGERED",
          reason:
            "Bullish opening-range breakout + FVG retest + engulfing confirmation",
          entryPrice: entry,
          stopLoss: stop,
          takeProfit:
            entry +
            risk * TARGET_RR,
          riskDistance: risk,
          rewardRisk: TARGET_RR,
          openingRange: range,
          fvg: {
            low: gapLow,
            high: gapHigh,
            breakoutTime:
              breakout.candleTime
          },
          retestCandleTime:
            retest.time,
          triggerCandleTime:
            confirm.time
        };
      }
    }

    if (
      breakout.direction === "SELL" &&
      bodyEngulfsBearish(
        retest,
        confirm
      )
    ) {
      const entry =
        Number(confirm.close);

      const stop =
        Number(retest.high) +
        TICK_SIZE;

      const risk =
        stop - entry;

      if (risk > 0) {
        return {
          signal: "SELL",
          phase: "TRIGGERED",
          reason:
            "Bearish opening-range breakout + FVG retest + engulfing confirmation",
          entryPrice: entry,
          stopLoss: stop,
          takeProfit:
            entry -
            risk * TARGET_RR,
          riskDistance: risk,
          rewardRisk: TARGET_RR,
          openingRange: range,
          fvg: {
            low: gapLow,
            high: gapHigh,
            breakoutTime:
              breakout.candleTime
          },
          retestCandleTime:
            retest.time,
          triggerCandleTime:
            confirm.time
        };
      }
    }
  }

  return {
    signal: "WAIT",
    phase: "WAIT_RETEST",
    reason:
      breakout.direction +
      " breakout + FVG confirmed; waiting for FVG retest + engulfing",
    openingRange: range,
    fvg: {
      low: Math.min(
        breakout.from,
        breakout.to
      ),
      high: Math.max(
        breakout.from,
        breakout.to
      ),
      breakoutTime:
        breakout.candleTime
    }
  };
}

function calculate() {
  const latestM1 =
    state.m1[state.m1.length - 1];

  if (!latestM1) {
    return {
      strategy:
        "NY_OPENING_RANGE_FVG",
      version: "V1",
      signal: "WAIT",
      confidence: 0,
      phase: "WAIT_M1",
      reason:
        "Waiting for cTrader M1 candles"
    };
  }

  const latestParts =
    nyParts(latestM1.time);

  if (!latestParts) {
    return {
      strategy:
        "NY_OPENING_RANGE_FVG",
      version: "V1",
      signal: "WAIT",
      confidence: 0,
      phase: "WAIT_TIME",
      reason:
        "Unable to determine New York session time"
    };
  }

  const range =
    findOpeningRange(
      state.m5,
      latestParts.dateKey
    );

  if (!range) {
    return {
      strategy:
        "NY_OPENING_RANGE_FVG",
      version: "V1",
      signal: "WAIT",
      confidence: 0,
      phase:
        "WAIT_OPENING_RANGE",
      reason:
        "Waiting for the 09:30 New York 5-minute opening-range candle",
      sessionDate:
        latestParts.dateKey
    };
  }

  if (
    latestParts.minuteOfDay <
    SESSION_START_MINUTE + 5
  ) {
    return {
      strategy:
        "NY_OPENING_RANGE_FVG",
      version: "V1",
      signal: "WAIT",
      confidence: 25,
      phase:
        "OPENING_RANGE",
      reason:
        "Opening range is established; waiting for M1 breakout",
      sessionDate:
        range.dateKey,
      openingRange: range
    };
  }

  if (
    latestParts.minuteOfDay >=
    SESSION_END_MINUTE
  ) {
    return {
      strategy:
        "NY_OPENING_RANGE_FVG",
      version: "V1",
      signal: "WAIT",
      confidence: 0,
      phase:
        "SESSION_ENDED",
      reason:
        "90-minute New York setup window has ended",
      sessionDate:
        range.dateKey,
      openingRange: range
    };
  }

  const setup =
    detectSetup(
      state.m1,
      range
    );

  let confidence = 0;

  if (setup.openingRange) {
    confidence += 25;
  }

  if (setup.fvg) {
    confidence += 35;
  }

  if (
    setup.signal !== "WAIT"
  ) {
    confidence += 40;
  }

  return {
    strategy:
      "NY_OPENING_RANGE_FVG",
    version: "V1",
    signal:
      setup.signal || "WAIT",
    confidence,
    phase:
      setup.phase,
    reason:
      setup.reason,
    sessionDate:
      range.dateKey,
    openingRange:
      setup.openingRange ||
      range,
    fvg:
      setup.fvg || null,
    entryPrice:
      setup.entryPrice ?? null,
    stopLoss:
      setup.stopLoss ?? null,
    takeProfit:
      setup.takeProfit ?? null,
    riskDistance:
      setup.riskDistance ?? null,
    rewardRisk:
      setup.rewardRisk ??
      TARGET_RR,
    retestCandleTime:
      setup.retestCandleTime ??
      null,
    triggerCandleTime:
      setup.triggerCandleTime ??
      null,
    latestM1Time:
      latestM1.time
  };
}

function setHistoricalM1Candles(
  candles
) {
  state.m1 = [];

  if (Array.isArray(candles)) {
    for (const candle of candles) {
      upsert(
        state.m1,
        candle,
        MAX_M1
      );
    }
  }

  state.lastPrediction =
    calculate();
}

function updateLiveM1Candle(
  candle
) {
  upsert(
    state.m1,
    candle,
    MAX_M1
  );

  state.lastPrediction =
    calculate();
}

function setM5Candles(candles) {
  state.m5 = [];

  if (Array.isArray(candles)) {
    for (const candle of candles) {
      upsert(
        state.m5,
        candle,
        MAX_M5
      );
    }
  }

  state.lastPrediction =
    calculate();
}

function updateM5Candle(candle) {
  upsert(
    state.m5,
    candle,
    MAX_M5
  );

  state.lastPrediction =
    calculate();
}

function getPrediction() {
  if (!state.lastPrediction) {
    state.lastPrediction =
      calculate();
  }

  return state.lastPrediction;
}

function getStats() {
  return {
    m1Candles:
      state.m1.length,
    m5Candles:
      state.m5.length,
    lastPrediction:
      getPrediction()
  };
}

function reset() {
  state.m1 = [];
  state.m5 = [];
  state.lastPrediction = null;
}

module.exports = {
  setHistoricalM1Candles,
  updateLiveM1Candle,
  setM5Candles,
  updateM5Candle,
  getPrediction,
  getStats,
  reset
};
