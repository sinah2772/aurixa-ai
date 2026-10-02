'use strict';

/*
 * AURIXA_OF1 — OrderFlow V1
 *
 * Separate strategy. Does NOT modify AURIXA Classic/Open Range.
 *
 * IMPORTANT:
 * The current cTrader feed does not provide a true institutional
 * footprint/bid-ask delta/GEX feed. This implementation therefore
 * uses price, candle volume, value-area and liquidity-sweep proxies.
 */

const STRATEGY = 'AURIXA_OF1';

const CONFIG = {
  atrPeriod: 14,

  higherTfMinutes: 60,
  higherEmaFast: 5,
  higherEmaSlow: 10,

  profileLookbackBars: 48,
  profileBins: 24,
  valueAreaPercent: 0.70,

  swingLookback: 12,

  fib705: 0.705,
  fib788: 0.788,
  fib886: 0.886,
  fibToleranceAtr: 0.20,

  minDisplacementAtr: 0.35,
  minParticipationRatio: 0.65,

  maxSweepAtr: 0.75,
  stopBufferAtr: 0.12,

  targetR: 1.50,

  nyOpenHour: 9,
  nyOpenMinute: 30,
  nyWindowMinutes: 90,

  minimumBars: 80
};

function finite(v) {
  return Number.isFinite(Number(v));
}

function n(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function round(v, digits = 2) {
  if (!Number.isFinite(v)) return null;
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

function validCandle(c) {
  return c &&
    finite(c.open) &&
    finite(c.high) &&
    finite(c.low) &&
    finite(c.close);
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;

  const k = 2 / (period + 1);
  let value = values
    .slice(0, period)
    .reduce((a, b) => a + Number(b), 0) / period;

  for (let i = period; i < values.length; i++) {
    value = Number(values[i]) * k + value * (1 - k);
  }

  return value;
}

function calculateATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) {
    return null;
  }

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];

    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );

    if (Number.isFinite(tr)) trs.push(tr);
  }

  if (trs.length < period) return null;

  let value = trs
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < trs.length; i++) {
    value = ((value * (period - 1)) + trs[i]) / period;
  }

  return value;
}

function candleTime(c) {
  return Number(
    c.time ??
    c.timestamp ??
    c.openTime ??
    c.utcTimestamp ??
    Date.now()
  );
}

function aggregate(candles, minutes = 60) {
  const groups = new Map();
  const bucketMs = minutes * 60 * 1000;

  for (const c of candles) {
    if (!validCandle(c)) continue;

    let t = candleTime(c);

    // Handle seconds timestamps.
    if (t > 0 && t < 100000000000) t *= 1000;

    const bucket = Math.floor(t / bucketMs) * bucketMs;

    if (!groups.has(bucket)) {
      groups.set(bucket, {
        time: bucket,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: n(c.volume, n(c.tickVolume, 0))
      });
    } else {
      const g = groups.get(bucket);

      g.high = Math.max(g.high, c.high);
      g.low = Math.min(g.low, c.low);
      g.close = c.close;
      g.volume += n(c.volume, n(c.tickVolume, 0));
    }
  }

  return [...groups.values()].sort((a, b) => a.time - b.time);
}

function nyDateParts(timestamp) {
  let t = Number(timestamp);

  if (!Number.isFinite(t)) return null;
  if (t < 100000000000) t *= 1000;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(t));

  const result = {};

  for (const p of parts) {
    if (p.type !== 'literal') result[p.type] = Number(p.value);
  }

  if (result.hour === 24) result.hour = 0;

  return result;
}

function inNYOpenWindow(timestamp) {
  const p = nyDateParts(timestamp);

  if (!p) return false;

  const current = p.hour * 60 + p.minute;
  const start = CONFIG.nyOpenHour * 60 + CONFIG.nyOpenMinute;
  const end = start + CONFIG.nyWindowMinutes;

  return current >= start && current < end;
}

function volumeProfile(candles) {
  if (!candles.length) return null;

  const lows = candles.map(c => c.low);
  const highs = candles.map(c => c.high);

  const low = Math.min(...lows);
  const high = Math.max(...highs);

  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;

  if (high <= low) {
    return {
      poc: low,
      vah: high,
      val: low,
      totalVolume: 0
    };
  }

  const bins = CONFIG.profileBins;
  const width = (high - low) / bins;
  const profile = Array.from({ length: bins }, () => 0);

  let totalVolume = 0;

  for (const c of candles) {
    const volume = n(c.volume, n(c.tickVolume, 0));

    if (volume <= 0) continue;

    const typical = (c.high + c.low + c.close) / 3;

    let index = Math.floor((typical - low) / width);
    index = Math.max(0, Math.min(bins - 1, index));

    profile[index] += volume;
    totalVolume += volume;
  }

  if (totalVolume <= 0) {
    return {
      poc: (high + low) / 2,
      vah: high,
      val: low,
      totalVolume: 0
    };
  }

  let pocIndex = 0;

  for (let i = 1; i < bins; i++) {
    if (profile[i] > profile[pocIndex]) {
      pocIndex = i;
    }
  }

  const target = totalVolume * CONFIG.valueAreaPercent;

  let accumulated = profile[pocIndex];
  let left = pocIndex;
  let right = pocIndex;

  while (accumulated < target && (left > 0 || right < bins - 1)) {
    const nextLeft = left > 0 ? profile[left - 1] : -1;
    const nextRight = right < bins - 1 ? profile[right + 1] : -1;

    if (nextRight >= nextLeft && right < bins - 1) {
      right++;
      accumulated += profile[right];
    } else if (left > 0) {
      left--;
      accumulated += profile[left];
    } else {
      break;
    }
  }

  return {
    poc: low + (pocIndex + 0.5) * width,
    vah: low + (right + 1) * width,
    val: low + left * width,
    totalVolume
  };
}

function swingRange(candles) {
  if (!candles.length) return null;

  const high = Math.max(...candles.map(c => c.high));
  const low = Math.min(...candles.map(c => c.low));

  return {
    high,
    low,
    range: high - low,
    midpoint: (high + low) / 2
  };
}

function fibZone(swing, direction) {
  if (!swing || swing.range <= 0) return null;

  const r = swing.range;

  let levels;

  if (direction === 'BUY') {
    levels = {
      fib705: swing.high - r * CONFIG.fib705,
      fib788: swing.high - r * CONFIG.fib788,
      fib886: swing.high - r * CONFIG.fib886
    };
  } else {
    levels = {
      fib705: swing.low + r * CONFIG.fib705,
      fib788: swing.low + r * CONFIG.fib788,
      fib886: swing.low + r * CONFIG.fib886
    };
  }

  return {
    ...levels,
    zoneLow: Math.min(levels.fib705, levels.fib886),
    zoneHigh: Math.max(levels.fib705, levels.fib886)
  };
}

function detectSweep(candles, direction, atrValue) {
  if (candles.length < 4 || !atrValue) {
    return {
      ok: false,
      reason: 'Not enough candles for liquidity sweep'
    };
  }

  const last = candles[candles.length - 1];
  const previous = candles.slice(0, -1);

  if (direction === 'BUY') {
    const priorLow = Math.min(...previous.map(c => c.low));
    const swept = last.low < priorLow;
    const reclaimed = last.close > priorLow;
    const distance = priorLow - last.low;

    return {
      ok: swept && reclaimed && distance <= atrValue * CONFIG.maxSweepAtr,
      type: 'SELL_SIDE_LIQUIDITY_SWEEP',
      level: priorLow,
      extreme: last.low,
      reclaimed,
      distanceAtr: round(distance / atrValue, 3)
    };
  }

  const priorHigh = Math.max(...previous.map(c => c.high));
  const swept = last.high > priorHigh;
  const reclaimed = last.close < priorHigh;
  const distance = last.high - priorHigh;

  return {
    ok: swept && reclaimed && distance <= atrValue * CONFIG.maxSweepAtr,
    type: 'BUY_SIDE_LIQUIDITY_SWEEP',
    level: priorHigh,
    extreme: last.high,
    reclaimed,
    distanceAtr: round(distance / atrValue, 3)
  };
}

function displacement(candle, atrValue, direction) {
  if (!candle || !atrValue) {
    return {
      ok: false,
      ratio: 0
    };
  }

  const body = Math.abs(candle.close - candle.open);
  const ratio = body / atrValue;

  const bullish = candle.close > candle.open;
  const bearish = candle.close < candle.open;

  const directional =
    direction === 'BUY' ? bullish : bearish;

  return {
    ok: directional && ratio >= CONFIG.minDisplacementAtr,
    body,
    ratio: round(ratio, 3)
  };
}

function participation(candles) {
  const withVolume = candles.filter(
    c => n(c.volume, n(c.tickVolume, 0)) > 0
  );

  if (withVolume.length < 8) {
    return {
      available: false,
      ok: false,
      ratio: null
    };
  }

  const recent = withVolume.slice(-3);
  const prior = withVolume.slice(-8, -3);

  const recentAvg =
    recent.reduce(
      (sum, c) => sum + n(c.volume, n(c.tickVolume, 0)),
      0
    ) / recent.length;

  const priorAvg =
    prior.reduce(
      (sum, c) => sum + n(c.volume, n(c.tickVolume, 0)),
      0
    ) / prior.length;

  if (priorAvg <= 0) {
    return {
      available: false,
      ok: false,
      ratio: null
    };
  }

  const ratio = recentAvg / priorAvg;

  return {
    available: true,
    ok: ratio >= CONFIG.minParticipationRatio,
    ratio: round(ratio, 3),
    recentAverage: round(recentAvg, 2),
    priorAverage: round(priorAvg, 2)
  };
}

function determineEnvironment(higher) {
  if (higher.length < CONFIG.higherEmaSlow) {
    return {
      state: 'UNKNOWN',
      direction: null,
      emaFast: null,
      emaSlow: null
    };
  }

  const closes = higher.map(c => c.close);

  const fast = ema(closes, CONFIG.higherEmaFast);
  const slow = ema(closes, CONFIG.higherEmaSlow);

  if (!Number.isFinite(fast) || !Number.isFinite(slow)) {
    return {
      state: 'UNKNOWN',
      direction: null,
      emaFast: null,
      emaSlow: null
    };
  }

  if (fast > slow) {
    return {
      state: 'VALUE_UP',
      direction: 'BUY',
      emaFast: fast,
      emaSlow: slow
    };
  }

  if (fast < slow) {
    return {
      state: 'VALUE_DOWN',
      direction: 'SELL',
      emaFast: fast,
      emaSlow: slow
    };
  }

  return {
    state: 'SIDEWAYS',
    direction: null,
    emaFast: fast,
    emaSlow: slow
  };
}

function waitResult(reason, extra = {}) {
  return {
    strategy: STRATEGY,
    strategyVersion: '1.0.0',
    signal: 'WAIT',
    direction: null,
    confidence: 0,
    score: 0,
    dataReady: false,
    reason,
    trueFootprint: false,
    gex: false,
    ...extra
  };
}

function analyze(inputCandles) {
  const candles = Array.isArray(inputCandles)
    ? inputCandles.filter(validCandle).slice(-300)
    : [];

  if (candles.length < CONFIG.minimumBars) {
    return waitResult(
      `Waiting for ${CONFIG.minimumBars} candles`,
      {
        bars: candles.length
      }
    );
  }

  const last = candles[candles.length - 1];
  const price = last.close;

  const atrValue = calculateATR(candles, CONFIG.atrPeriod);

  if (!atrValue || atrValue <= 0) {
    return waitResult('ATR unavailable', {
      bars: candles.length,
      price
    });
  }

  const higher = aggregate(candles, CONFIG.higherTfMinutes);
  const env = determineEnvironment(higher);

  if (env.state === 'UNKNOWN') {
    return waitResult('Higher-timeframe environment unavailable', {
      bars: candles.length,
      price
    });
  }

  let direction = env.direction;

  if (!direction) {
    const ema20 = ema(
      candles.map(c => c.close),
      20
    );

    if (Number.isFinite(ema20)) {
      if (price > ema20) direction = 'BUY';
      else if (price < ema20) direction = 'SELL';
    }
  }

  if (!direction) {
    return waitResult('No directional environment', {
      dataReady: true,
      bars: candles.length,
      price,
      atr: round(atrValue, 3),
      environment: env
    });
  }

  const profileBars = candles.slice(-CONFIG.profileLookbackBars);
  const profile = volumeProfile(profileBars);

  const swing = swingRange(
    candles.slice(-CONFIG.swingLookback)
  );

  const fib = fibZone(swing, direction);

  if (!profile || !fib) {
    return waitResult('Value structure unavailable', {
      dataReady: true,
      bars: candles.length,
      price
    });
  }

  const fibTolerance = atrValue * CONFIG.fibToleranceAtr;

  const inFib =
    price >= fib.zoneLow - fibTolerance &&
    price <= fib.zoneHigh + fibTolerance;

  const outsideValue =
    direction === 'BUY'
      ? price <= profile.val + fibTolerance
      : price >= profile.vah - fibTolerance;

  const recent = candles.slice(-5);

  const sweep = detectSweep(
    recent,
    direction,
    atrValue
  );

  const displacementResult =
    displacement(last, atrValue, direction);

  const participationResult =
    participation(candles);

  const breached886 =
    direction === 'BUY'
      ? price < fib.fib886 - fibTolerance
      : price > fib.fib886 + fibTolerance;

  const sessionActive =
    inNYOpenWindow(candleTime(last));

  let score = 0;
  const reasons = [];

  if (
    env.direction === direction
  ) {
    score += 2;
    reasons.push('Higher-timeframe environment aligned');
  } else if (env.state === 'SIDEWAYS') {
    score += 1;
    reasons.push('Higher-timeframe environment sideways');
  }

  if (inFib) {
    score += 2;
    reasons.push('Price in 0.705-0.886 retracement zone');
  }

  if (outsideValue) {
    score += 2;
    reasons.push(
      direction === 'BUY'
        ? 'Price below value area / VAL'
        : 'Price above value area / VAH'
    );
  }

  if (sweep.ok) {
    score += 2;
    reasons.push(`Liquidity sweep confirmed: ${sweep.type}`);
  }

  if (displacementResult.ok) {
    score += 1;
    reasons.push('Directional displacement confirmed');
  }

  if (participationResult.available &&
      participationResult.ok) {
    score += 1;
    reasons.push('Participation confirmed');
  }

  const hardFailures = [];

  if (!sessionActive) {
    hardFailures.push('Outside New York first 90-minute window');
  }

  if (!inFib) {
    hardFailures.push('Price not inside retracement zone');
  }

  if (!outsideValue) {
    hardFailures.push('Price is not outside value area');
  }

  if (!sweep.ok) {
    hardFailures.push('Liquidity sweep/reclaim not confirmed');
  }

  if (!displacementResult.ok) {
    hardFailures.push('Displacement not confirmed');
  }

  if (breached886) {
    hardFailures.push('0.886 invalidation level breached');
  }

  if (
    participationResult.available &&
    !participationResult.ok
  ) {
    hardFailures.push('Participation below threshold');
  }

  const signal =
    hardFailures.length === 0 && score >= 8
      ? direction
      : 'WAIT';

  let entry = null;
  let stop = null;
  let target = null;
  let risk = null;

  if (signal !== 'WAIT' && finite(sweep.extreme)) {
    entry = price;

    if (direction === 'BUY') {
      stop = sweep.extreme -
        atrValue * CONFIG.stopBufferAtr;

      risk = entry - stop;

      target = entry +
        risk * CONFIG.targetR;
    } else {
      stop = sweep.extreme +
        atrValue * CONFIG.stopBufferAtr;

      risk = stop - entry;

      target = entry -
        risk * CONFIG.targetR;
    }

    if (!Number.isFinite(risk) || risk <= 0) {
      return waitResult('Invalid risk distance', {
        dataReady: true,
        bars: candles.length,
        price,
        score
      });
    }
  }

  const confidence =
    signal === 'WAIT'
      ? Math.min(79, Math.max(0, 35 + score * 4))
      : Math.min(95, 55 + score * 5);

  return {
    strategy: STRATEGY,
    strategyVersion: '1.0.0',

    signal,
    direction,
    confidence,
    score,

    dataReady: true,
    bars: candles.length,

    symbol: 'XAUUSD',
    timeframe: 'M5',

    price: round(price, 3),
    entry: round(entry, 3),
    stop: round(stop, 3),
    target: round(target, 3),
    risk: round(risk, 3),

    atr: round(atrValue, 3),

    environment: {
      state: env.state,
      direction: env.direction,
      emaFast: round(env.emaFast, 3),
      emaSlow: round(env.emaSlow, 3)
    },

    value: {
      poc: round(profile.poc, 3),
      vah: round(profile.vah, 3),
      val: round(profile.val, 3),
      totalVolume: round(profile.totalVolume, 2)
    },

    fib: {
      fib705: round(fib.fib705, 3),
      fib788: round(fib.fib788, 3),
      fib886: round(fib.fib886, 3),
      zoneLow: round(fib.zoneLow, 3),
      zoneHigh: round(fib.zoneHigh, 3),
      inZone: inFib,
      invalidated: breached886
    },

    liquidity: sweep,

    displacement: {
      confirmed: displacementResult.ok,
      body: round(displacementResult.body, 3),
      atrRatio: displacementResult.ratio
    },

    participation: participationResult,

    session: {
      name: 'NEW_YORK_OPEN',
      active: sessionActive,
      windowMinutes: CONFIG.nyWindowMinutes
    },

    confirmation: {
      outsideValue,
      liquiditySweep: sweep.ok,
      displacement: displacementResult.ok,
      participation:
        participationResult.available
          ? participationResult.ok
          : null
    },

    reasons,
    failures: hardFailures,

    // These remain false because current cTrader data
    // does not contain true footprint/GEX information.
    trueFootprint: false,
    gex: false,

    candleTime: candleTime(last),
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  STRATEGY,
  CONFIG,
  analyze
};
