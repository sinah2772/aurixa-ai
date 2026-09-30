const { calculatePrediction } = require("./market-engine");

const HORIZONS = {
  "5m": 1,
  "15m": 3,
  "30m": 6
};

function pct(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) {
    return null;
  }
  return ((a - b) / b) * 100;
}

function round(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return null;
  const p = 10 ** digits;
  return Math.round(Number(value) * p) / p;
}

function emptyStats() {
  return {
    evaluated: 0,
    correct: 0,
    incorrect: 0,
    accuracy: null,
    avgMove: null,
    avgFavorableMove: null,
    avgAdverseMove: null
  };
}

function createStats() {
  return {
    BUY: emptyStats(),
    SELL: emptyStats(),
    WAIT: emptyStats(),
    ALL_DIRECTIONAL: emptyStats()
  };
}

function addResult(stats, signal, correct, move, favorable, adverse) {
  const bucket = stats[signal];

  if (!bucket) return;

  bucket.evaluated++;

  if (correct) {
    bucket.correct++;
  } else {
    bucket.incorrect++;
  }

  bucket._moveSum =
    (bucket._moveSum || 0) + move;

  bucket._favorableSum =
    (bucket._favorableSum || 0) + favorable;

  bucket._adverseSum =
    (bucket._adverseSum || 0) + adverse;

  if (signal === "BUY" || signal === "SELL") {
    const all = stats.ALL_DIRECTIONAL;

    all.evaluated++;

    if (correct) {
      all.correct++;
    } else {
      all.incorrect++;
    }

    all._moveSum =
      (all._moveSum || 0) + move;

    all._favorableSum =
      (all._favorableSum || 0) + favorable;

    all._adverseSum =
      (all._adverseSum || 0) + adverse;
  }
}

function finalizeStats(stats) {
  for (const bucket of Object.values(stats)) {
    bucket.accuracy =
      bucket.evaluated
        ? round(
            (bucket.correct / bucket.evaluated) * 100,
            2
          )
        : null;

    bucket.avgMove =
      bucket.evaluated
        ? round(
            bucket._moveSum / bucket.evaluated,
            4
          )
        : null;

    bucket.avgFavorableMove =
      bucket.evaluated
        ? round(
            bucket._favorableSum / bucket.evaluated,
            4
          )
        : null;

    bucket.avgAdverseMove =
      bucket.evaluated
        ? round(
            bucket._adverseSum / bucket.evaluated,
            4
          )
        : null;

    delete bucket._moveSum;
    delete bucket._favorableSum;
    delete bucket._adverseSum;
  }

  return stats;
}

function evaluateSignal(signal, entry, future) {
  const futureMove =
    pct(future, entry);

  if (futureMove == null) {
    return null;
  }

  if (signal === "BUY") {
    return {
      correct: future > entry,
      move: futureMove,
      favorable: Math.max(futureMove, 0),
      adverse: Math.min(futureMove, 0)
    };
  }

  if (signal === "SELL") {
    const sellMove = -futureMove;

    return {
      correct: future < entry,
      move: sellMove,
      favorable: Math.max(sellMove, 0),
      adverse: Math.min(sellMove, 0)
    };
  }

  return {
    correct: false,
    move: futureMove,
    favorable: 0,
    adverse: 0
  };
}

function backtest(candles) {
  if (!Array.isArray(candles)) {
    throw new Error("Candles must be an array");
  }

  const clean = candles
    .filter(c =>
      Number.isFinite(Number(c.open)) &&
      Number.isFinite(Number(c.high)) &&
      Number.isFinite(Number(c.low)) &&
      Number.isFinite(Number(c.close))
    )
    .sort(
      (a, b) =>
        Number(a.time) - Number(b.time)
    );

  const result = {
    engine: "AURIXA V3 VALIDATION",
    timeframe: "5m",
    candles: clean.length,
    generatedAt: new Date().toISOString(),
    horizons: {}
  };

  for (const [horizonName, barsForward] of Object.entries(HORIZONS)) {
    const stats = createStats();
    const confidenceBuckets = {
      "50-59": emptyStats(),
      "60-69": emptyStats(),
      "70-79": emptyStats(),
      "80-89": emptyStats(),
      "90-94": emptyStats()
    };

    const samples = [];

    const start = 60;
    const end =
      clean.length - barsForward;

    for (let i = start; i < end; i++) {
      const history =
        clean.slice(0, i + 1);

      const prediction =
        calculatePrediction(history);

      if (!prediction?.dataReady) {
        continue;
      }

      const signal =
        prediction.signal || "WAIT";

      const entry =
        Number(clean[i].close);

      const future =
        Number(
          clean[i + barsForward].close
        );

      const evaluation =
        evaluateSignal(
          signal,
          entry,
          future
        );

      if (!evaluation) continue;

      addResult(
        stats,
        signal,
        evaluation.correct,
        evaluation.move,
        evaluation.favorable,
        evaluation.adverse
      );

      if (
        signal === "BUY" ||
        signal === "SELL"
      ) {
        let bucket;

        if (prediction.confidence < 60) {
          bucket = "50-59";
        } else if (prediction.confidence < 70) {
          bucket = "60-69";
        } else if (prediction.confidence < 80) {
          bucket = "70-79";
        } else if (prediction.confidence < 90) {
          bucket = "80-89";
        } else {
          bucket = "90-94";
        }

        const cb =
          confidenceBuckets[bucket];

        cb.evaluated++;

        if (evaluation.correct) {
          cb.correct++;
        } else {
          cb.incorrect++;
        }

        cb._moveSum =
          (cb._moveSum || 0) +
          evaluation.move;

        cb._favorableSum =
          (cb._favorableSum || 0) +
          evaluation.favorable;

        cb._adverseSum =
          (cb._adverseSum || 0) +
          evaluation.adverse;
      }

      if (
        samples.length < 20 &&
        signal !== "WAIT"
      ) {
        samples.push({
          candleTime: clean[i].time,
          signal,
          confidence: prediction.confidence,
          score: prediction.score,
          entry: round(entry, 2),
          future: round(future, 2),
          movePercent:
            round(evaluation.move, 4),
          correct:
            evaluation.correct
        });
      }
    }

    result.horizons[horizonName] = {
      stats:
        finalizeStats(stats),

      confidence:
        finalizeStats(confidenceBuckets),

      samples
    };
  }

  return result;
}

module.exports = {
  backtest
};
