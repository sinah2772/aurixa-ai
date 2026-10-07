"use strict";

/*
 * AURIXA AI Trade Decision Engine V1
 *
 * Purpose:
 * - Combine the existing M5 prediction, OrderFlow OF1 and OR/FVG strategy
 *   into one auditable trade decision.
 * - Keep the decision layer separate from cTrader execution.
 * - Never place an order from this module.
 *
 * Decision flow:
 *   market data -> strategy votes -> agreement/confidence -> risk/feed gate
 *   -> BUY / SELL / WAIT decision
 *
 * This is an AI-ready deterministic ensemble. A future model provider can
 * replace/augment the scoring layer without changing the execution contract.
 */

const MIN_CONFIDENCE = Math.max(
  50,
  Math.min(95, Number(process.env.AI_TRADE_MIN_CONFIDENCE || 65))
);

const MAX_SPREAD = Math.max(
  0.05,
  Number(process.env.AI_TRADE_MAX_SPREAD || 0.60)
);

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function direction(value) {
  return value === "BUY" || value === "SELL" ? value : "WAIT";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function strategyVote(name, result, baseWeight) {
  const signal = direction(result?.signal);
  const confidence = clamp(num(result?.confidence) ?? 0, 0, 100);

  if (signal === "WAIT") {
    return {
      strategy: name,
      signal: "WAIT",
      confidence,
      weight: baseWeight,
      points: 0,
      reason: result?.reason || "No directional signal"
    };
  }

  const confidenceFactor = Math.max(0.25, confidence / 100);
  const points = Math.round(baseWeight * confidenceFactor);

  return {
    strategy: name,
    signal,
    confidence,
    weight: baseWeight,
    points,
    reason: result?.reason || ""
  };
}

function pickTradePlan(votes, results, price) {
  const directional = votes.filter(v => v.signal !== "WAIT");

  if (!directional.length) {
    return {
      entryPrice: price,
      stopLoss: null,
      takeProfit: null,
      rewardRisk: null
    };
  }

  const buyVotes = directional.filter(v => v.signal === "BUY");
  const sellVotes = directional.filter(v => v.signal === "SELL");
  const winning = buyVotes.reduce((s, v) => s + v.points, 0) >=
    sellVotes.reduce((s, v) => s + v.points, 0)
    ? "BUY"
    : "SELL";

  const candidates = [
    results.of1,
    results.orFvg
  ].filter(r => direction(r?.signal) === winning);

  const planned = candidates.find(r =>
    num(r?.entryPrice ?? r?.entry) !== null &&
    num(r?.stopLoss ?? r?.stop) !== null &&
    num(r?.takeProfit ?? r?.target) !== null
  );

  if (!planned) {
    return {
      entryPrice: price,
      stopLoss: null,
      takeProfit: null,
      rewardRisk: null
    };
  }

  const entry = num(planned.entryPrice ?? planned.entry) ?? price;
  const stop = num(planned.stopLoss ?? planned.stop);
  const target = num(planned.takeProfit ?? planned.target);

  if (stop === null || target === null) {
    return {
      entryPrice: entry,
      stopLoss: null,
      takeProfit: null,
      rewardRisk: null
    };
  }

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);

  return {
    entryPrice: entry,
    stopLoss: stop,
    takeProfit: target,
    rewardRisk: risk > 0 ? reward / risk : null
  };
}

function evaluate(input = {}) {
  const market = input.market || {};
  const of1 = input.of1 || {};
  const orFvg = input.orFvg || {};
  const ctrader = input.ctrader || {};

  const price =
    num(ctrader.mid) ??
    num(ctrader.bid) ??
    num(ctrader.ask) ??
    num(market.price);

  const votes = [
    strategyVote("AURIXA_M5", market, 40),
    strategyVote("AURIXA_OF1", of1, 35),
    strategyVote("NY_OR_FVG", orFvg, 25)
  ];

  const buyScore = votes
    .filter(v => v.signal === "BUY")
    .reduce((sum, v) => sum + v.points, 0);

  const sellScore = votes
    .filter(v => v.signal === "SELL")
    .reduce((sum, v) => sum + v.points, 0);

  const directional = votes.filter(v => v.signal !== "WAIT");
  const agreement =
    directional.length > 0
      ? Math.max(buyScore, sellScore) / directional.reduce((s, v) => s + v.points, 0)
      : 0;

  const winningSignal =
    buyScore === sellScore
      ? "WAIT"
      : buyScore > sellScore
        ? "BUY"
        : "SELL";

  const winningVotes = votes.filter(v => v.signal === winningSignal);
  const opposingVotes = votes.filter(
    v => v.signal !== "WAIT" && v.signal !== winningSignal
  );

  const avgConfidence = winningVotes.length
    ? winningVotes.reduce((s, v) => s + v.confidence, 0) / winningVotes.length
    : 0;

  let confidence = Math.round(
    winningSignal === "WAIT"
      ? Math.min(60, 40 + directional.length * 5)
      : avgConfidence * 0.55 + agreement * 45
  );

  const connected = Boolean(ctrader.connected && ctrader.authorized);
  const bid = num(ctrader.bid);
  const ask = num(ctrader.ask);
  const spread =
    bid !== null && ask !== null && ask >= bid
      ? ask - bid
      : null;

  const gates = {
    dataReady: Boolean(market.dataReady !== false),
    cTraderReady: connected,
    priceAvailable: price !== null,
    spreadAvailable: spread !== null,
    spreadAllowed: spread === null ? false : spread <= MAX_SPREAD,
    noOpposition: opposingVotes.length === 0,
    confidenceAllowed: confidence >= MIN_CONFIDENCE
  };

  const hardFailure = Object.entries(gates)
    .filter(([key, value]) => !value)
    .map(([key]) => key);

  let signal = winningSignal;

  if (
    signal === "WAIT" ||
    hardFailure.length ||
    winningVotes.length < 2
  ) {
    signal = "WAIT";
  }

  if (opposingVotes.length > 0) {
    confidence = Math.min(confidence, 59);
  }

  const plan = pickTradePlan(
    votes,
    { of1, orFvg },
    price
  );

  const riskDistance =
    plan.stopLoss !== null && plan.entryPrice !== null
      ? Math.abs(plan.entryPrice - plan.stopLoss)
      : null;

  const targetDistance =
    plan.takeProfit !== null && plan.entryPrice !== null
      ? Math.abs(plan.takeProfit - plan.entryPrice)
      : null;

  const planValid =
    riskDistance !== null &&
    riskDistance > 0 &&
    targetDistance !== null &&
    targetDistance > 0 &&
    plan.rewardRisk !== null &&
    plan.rewardRisk >= 1.5;

  if (signal !== "WAIT" && !planValid) {
    signal = "WAIT";
    hardFailure.push("valid_trade_plan");
  }

  return {
    engine: "AURIXA_AI_DECISION_V1",
    version: "1.0.0",
    symbol: "XAUUSD",
    timeframe: "M5",
    signal,
    confidence: clamp(confidence, 0, 100),
    price,
    spread,
    buyScore,
    sellScore,
    agreement: Number(agreement.toFixed(3)),
    votes,
    gates: {
      ...gates,
      validTradePlan: planValid
    },
    blockedBy: [...new Set(hardFailure)],
    plan: {
      ...plan,
      riskDistance,
      targetDistance
    },
    executionEligible:
      signal !== "WAIT" &&
      hardFailure.length === 0 &&
      winningVotes.length >= 2 &&
      planValid,
    generatedAt: new Date().toISOString()
  };
}

async function persistDecision(query, decision) {
  if (typeof query !== "function") {
    return { persisted: false, id: null };
  }

  try {
    await query(`
      CREATE SCHEMA IF NOT EXISTS aurixa;
      CREATE TABLE IF NOT EXISTS aurixa.ai_trade_decisions (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        engine TEXT NOT NULL,
        version TEXT NOT NULL,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        signal TEXT NOT NULL,
        confidence NUMERIC(6,2),
        price NUMERIC(18,8),
        spread NUMERIC(18,8),
        buy_score NUMERIC(10,2),
        sell_score NUMERIC(10,2),
        agreement NUMERIC(8,4),
        execution_eligible BOOLEAN NOT NULL DEFAULT FALSE,
        blocked_by JSONB NOT NULL DEFAULT '[]'::jsonb,
        decision JSONB NOT NULL
      )
    `);

    const result = await query(`
      INSERT INTO aurixa.ai_trade_decisions
      (engine,version,symbol,timeframe,signal,confidence,price,spread,
       buy_score,sell_score,agreement,execution_eligible,blocked_by,decision)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb)
      RETURNING id, created_at
    `, [
      decision.engine,
      decision.version,
      decision.symbol,
      decision.timeframe,
      decision.signal,
      decision.confidence,
      decision.price,
      decision.spread,
      decision.buyScore,
      decision.sellScore,
      decision.agreement,
      decision.executionEligible,
      JSON.stringify(decision.blockedBy || []),
      JSON.stringify(decision)
    ]);

    return {
      persisted: true,
      id: result.rows[0]?.id || null,
      createdAt: result.rows[0]?.created_at || null
    };
  } catch (error) {
    console.error("AURIXA AI decision persistence failed:", error.message);
    return {
      persisted: false,
      id: null,
      error: error.message
    };
  }
}

module.exports = {
  evaluate,
  persistDecision,
  MIN_CONFIDENCE,
  MAX_SPREAD
};
