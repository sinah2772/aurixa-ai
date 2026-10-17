(() => {
  "use strict";

  // Frontend boot marker: makes browser-side startup visible even when API calls fail.
  try {
    const boot = document.getElementById("frontendBoot");
    if (boot) boot.textContent = "AURIXA DIAGNOSTIC: JS EXECUTING";
    window.__AURIXA_JS_STARTED = Date.now();
  } catch (e) {
    console.error("AURIXA frontend boot marker failed:", e);
  }

  const $ = (id) => document.getElementById(id);

  const API = {
    market: "/api/market",
    marketState: "/api/market/state",
    system: "/api/system/state",
    ctrader: "/api/ctrader/status",
    autoStatus: "/api/auto-trader/status",
    autoPositions: "/api/auto-trader/positions",
    autoTrades: "/api/auto-trader/trades?limit=500",
    performance: "/api/auto-trader/performance?limit=500",
    account: "/api/auto-trader/account",
    aiDecision: "/api/ai/decision",
    aiHistory: "/api/ai/decision/history",
    aiSignals: "/api/ai/signals",
    marketHistory: "/api/market/history?limit=300"
  };

  let chart = null;
  let fullRefreshBusy = false;
  let latestPositions = null;
  let lastPositionRefresh = 0;

  async function getJSON(url) {
    try {
      const r = await fetch(url, {
        cache: "no-store",
        headers: { Accept: "application/json" }
      });

      if (!r.ok) {
        console.error("AURIXA API ERROR:", url, r.status);
        return null;
      }

      return await r.json();
    } catch {
      return null;
    }
  }

  function first(...values) {
    for (const v of values) {
      if (
        v !== undefined &&
        v !== null &&
        v !== "" &&
        !(typeof v === "number" && Number.isNaN(v))
      ) {
        return v;
      }
    }

    return null;
  }

  function priceDigits(symbol) {
    const key = String(symbol || "XAUUSD").toUpperCase().replace(/[\/\s_-]/g, "");
    return ({XAUUSD:2, EURUSD:5, NZDUSD:5, USDCHF:5, USDCAD:5, AUDUSD:5, USDJPY:3, GBPUSD:5, XAGUSD:3, BTCUSD:2})[key] ?? 2;
  }

  function number(v, digits = 2) {
    if (v === null || v === undefined || v === "") return "—";
    const n = Number(v);

    if (!Number.isFinite(n)) return "—";

    return n.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
  }

  function percent(v) {
    if (v === null || v === undefined || v === "") return "—";
    const n = Number(v);

    if (!Number.isFinite(n)) return "—";

    return `${number(n, 1)}%`;
  }

  function priceNumber(v, digits = 2) {
    if (v === null || v === undefined || v === "") return "—";
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? number(n, digits) : "—";
  }

  function text(id, value) {
    const el = $(id);

    if (el) el.textContent = value ?? "—";
  }

  function updateConnection(status) {
    if (!status) {
      text("ctraderConnection", "STATUS UNAVAILABLE");
      text("dataStatus", "STALE");
      const badge = $(".live-badge");
      if (badge) {
        badge.innerHTML = '<span class="dot"></span> STATUS UNKNOWN';
        badge.classList.add("offline");
      }
      return;
    }

    const liveSymbol = String(first(status.symbol, status.symbolName, "XAUUSD")).toUpperCase();
    text("instrument", liveSymbol);
    text("chartTitle", liveSymbol + " / 5 MINUTE");

    const connected =
      status.connected === true &&
      status.authorized === true;

    text(
      "ctraderConnection",
      connected
        ? "CONNECTED · Live market feed"
        : "DISCONNECTED"
    );

    text(
      "dataStatus",
      connected ? "LIVE" : "DISCONNECTED"
    );

    text(
      "accountId",
      first(status.accountId, status.account?.ctidTraderAccountId)
    );

    text(
      "symbolId",
      first(status.symbolId, status.symbol?.id)
    );

    if (status.lastUpdate) {
      const d = new Date(status.lastUpdate);

      if (!Number.isNaN(d.getTime())) {
        text(
          "lastUpdate",
          d.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
          })
        );
      }
    }

    const badge = $(".live-badge");

    if (badge) {
      badge.innerHTML = connected
        ? '<span class="dot"></span> LIVE'
        : '<span class="dot"></span> OFFLINE';
      badge.classList.toggle("offline", !connected);
    }
  }


  function calculateEMA(values, period) {
    if (!Array.isArray(values) || values.length < period) return null;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + Number(b), 0) / period;
    for (let i = period; i < values.length; i++) {
      ema = Number(values[i]) * k + ema * (1 - k);
    }
    return ema;
  }

  function calculateRSI(candles, period = 14) {
    if (!Array.isArray(candles) || candles.length <= period) return null;

    const closes = candles.map(c => Number(c.close)).filter(Number.isFinite);
    if (closes.length <= period) return null;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
      const change = closes[i] - closes[i - 1];
      if (change >= 0) gains += change;
      else losses -= change;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      const gain = Math.max(change, 0);
      const loss = Math.max(-change, 0);

      avgGain = ((avgGain * (period - 1)) + gain) / period;
      avgLoss = ((avgLoss * (period - 1)) + loss) / period;
    }

    if (avgLoss === 0) return 100;

    return 100 - (100 / (1 + (avgGain / avgLoss)));
  }

  function calculateATR(candles, period = 14) {
    if (!Array.isArray(candles) || candles.length <= period) return null;

    const tr = [];

    for (let i = 0; i < candles.length; i++) {
      const high = Number(candles[i].high);
      const low = Number(candles[i].low);
      const prevClose = i > 0 ? Number(candles[i - 1].close) : null;

      if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

      tr.push(
        i === 0 || !Number.isFinite(prevClose)
          ? high - low
          : Math.max(
              high - low,
              Math.abs(high - prevClose),
              Math.abs(low - prevClose)
            )
      );
    }

    if (tr.length <= period) return null;

    let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < tr.length; i++) {
      atr = ((atr * (period - 1)) + tr[i]) / period;
    }

    return atr;
  }

  function updateMarket(data, ctrader) {
    if (!data) return;

    const market =
      data.market ||
      data.data ||
      data.state ||
      data;

    const price = first(
      market.mid,
      market.price,
      market.currentPrice,
      market.last,
      market.close
    );

    const bid = first(market.bid, market.bidPrice, data.bid, data.bidPrice, ctrader?.bid, ctrader?.bidPrice);
    const ask = first(market.ask, market.askPrice, data.ask, data.askPrice, ctrader?.ask, ctrader?.askPrice);

    const activeSymbol = String(first(ctrader?.symbolName, ctrader?.symbol, market.symbol, market.symbolName, "XAUUSD")).toUpperCase();
    const digits = priceDigits(activeSymbol);
    text("price", priceNumber(price, digits));
    text("bid", priceNumber(bid, digits));
    text("ask", priceNumber(ask, digits));

    if (bid !== null && bid !== undefined && bid !== "" && ask !== null && ask !== undefined && ask !== "" &&
        Number.isFinite(Number(bid)) && Number.isFinite(Number(ask)) && Number(bid) > 0 && Number(ask) > 0) {
      text("spread", number(Number(ask) - Number(bid), digits));
    } else {
      text("spread", "—");
    }

    const marketSymbol = activeSymbol;

    text("instrument", marketSymbol);
    text("chartTitle", marketSymbol + " / 5 MINUTE");

    const candles = first(
      market.candles,
      market.bars,
      market.candleCount,
      data.candleCount
    );

    let calculated = {};

    if (Array.isArray(candles)) {
      text("candleCount", candles.length);
      drawChart(candles);

      const closes = candles
        .map(c => Number(c.close))
        .filter(Number.isFinite);

      const ema9 = calculateEMA(closes, 9);
      const ema21 = calculateEMA(closes, 21);
      const ema50 = calculateEMA(closes, 50);
      const rsi14 = calculateRSI(candles, 14);
      const atr14 = calculateATR(candles, 14);
      const latest = candles[candles.length - 1];

      calculated = {
        ema9,
        ema21,
        ema50,
        rsi14,
        atr14
      };

      const latestRawTime = latest
        ? first(latest.time, latest.timestamp, latest.openTime, latest.open_time)
        : null;
      const latestDate = latestRawTime
        ? new Date(Number.isFinite(Number(latestRawTime))
            ? Number(latestRawTime)
            : latestRawTime)
        : null;

      const latestTime = latestDate && !Number.isNaN(latestDate.getTime())
        ? latestDate.toLocaleString()
        : formatTime(latestRawTime);

      text("latestCandle", latestTime);
    } else {
      text("candleCount", first(candles, "—"));
    }

    const indicators =
      market.indicators ||
      data.indicators ||
      {};

    text(
      "ema9",
      number(first(indicators.ema9, market.ema9, calculated.ema9), 2)
    );

    text(
      "ema21",
      number(first(indicators.ema21, market.ema21, calculated.ema21), 2)
    );

    text(
      "ema50",
      number(first(indicators.ema50, market.ema50, calculated.ema50), 2)
    );

    text(
      "rsi",
      number(first(indicators.rsi14, indicators.rsi, market.rsi14, market.rsi, calculated.rsi14), 2)
    );

    text(
      "atr",
      number(first(indicators.atr14, indicators.atr, market.atr14, market.atr, calculated.atr14), 2)
    );

    text(
      "score",
      first(indicators.score, market.score, data.score, "—")
    );
  }

  function setSignal(signal) {
    const value = String(signal || "WAIT").toUpperCase();
    const el = $("signal");
    if (el) {
      el.classList.remove("buy", "sell", "wait");
      el.classList.add(value === "BUY" ? "buy" : value === "SELL" ? "sell" : "wait");
      el.textContent = value === "BUY" || value === "SELL" ? value : "WAIT";
    }
  }

  function updateSignal(ai) {
    const data = ai?.decision || ai || {};
    const signal = String(first(data.signal, data.direction, "WAIT")).toUpperCase();
    const confidence = data.confidence == null || data.confidence === "" ? NaN : Number(data.confidence);
    const gates = data.gates || {};
    const blocked = Array.isArray(data.blockedBy)
      ? data.blockedBy
      : Object.entries(gates).filter(([,v]) => v === false).map(([k]) => k);
    const labels = {
      quoteFresh:"QUOTE FRESHNESS", spreadAllowed:"SPREAD", volatilityAllowed:"VOLATILITY",
      candleQualityAllowed:"CANDLE QUALITY", trendConfirmed:"TREND", confidenceAllowed:"CONFIDENCE",
      rewardRiskAllowed:"R:R", cTraderReady:"cTRADER", demoAccount:"DEMO ACCOUNT", quoteReady:"QUOTE"
    };

    setSignal(signal);
    text("confidence", Number.isFinite(confidence) ? number(confidence,0) + "%" : "—");
    text("aiDecisionSymbol", String(first(data.symbol, data.symbolName, $("instrument")?.textContent, "XAUUSD")).toUpperCase());
    text("aiRegime", String(first(data.regime,"—")).replaceAll("_"," "));
    text("aiTrend", first(data.trend,"—"));
    const rsi = data.rsi == null || data.rsi === "" ? NaN : Number(data.rsi);
    const momentum = data.momentum == null || data.momentum === "" ? NaN : Number(data.momentum);
    text("aiRsi", Number.isFinite(rsi) ? number(rsi,1) : "—");
    text("aiMomentum", Number.isFinite(momentum) ? number(momentum,2) + " ATR" : "—");

    const buy = data?.score?.buy == null || data.score.buy === "" ? NaN : Number(data.score.buy);
    const sell = data?.score?.sell == null || data.score.sell === "" ? NaN : Number(data.score.sell);
    text("aiScore", Number.isFinite(buy) && Number.isFinite(sell) ? "BUY " + buy + " / SELL " + sell : "—");

    const logic = data.logic || {};
    text("aiLogicChecks", logic.passed != null && logic.passed !== "" && Number.isFinite(Number(logic.passed))
      ? String(logic.passed) + "/" + String(first(logic.total,6)) + " PASSED"
      : "—");

    const failed = blocked.map(k => labels[k] || String(k).replaceAll("_", " ").toUpperCase());
    const logicFailed = Array.isArray(logic.failed) ? logic.failed.join(" · ").toUpperCase() : "";
    let reason;
    if (signal === "WAIT") {
      reason = failed.length
        ? "WAIT — BLOCKED: " + failed.join(" · ")
        : (logicFailed ? "WAIT — LOGIC: " + logicFailed : "WAIT — confirmation not complete");
    } else {
      reason = "AI " + signal + " — " +
        (logicFailed ? "logic weak: " + logicFailed : "logic aligned") +
        (failed.length ? " · blocked: " + failed.join(" · ") : data.executionEligible === true ? " · all execution gates passed" : " · execution eligibility not confirmed");
    }
    text("reason", reason);
    text("aiGate", failed.length ? "BLOCKED · " + failed.join(" · ") : data.executionEligible === true ? "ALL GATES PASSED" : "WAITING FOR GATES");
  }

  function updateAutoTradeCandidate(ai, ctrader, autoStatus, positions) {
    const data = ai?.decision || ai?.result || ai || {};
    const signal = String(first(data.signal, data.direction, "WAIT")).toUpperCase();
    const symbol = String(first(data.symbol, data.symbolName, "UNKNOWN")).toUpperCase().replace(/[\\/\\s_-]/g, "");
    const gates = data.gates || {};
    const blocked = Array.isArray(data.blockedBy)
      ? data.blockedBy
      : Object.entries(gates).filter(([, value]) => value === false).map(([key]) => key);
    const reasons = blocked.map(key => String(key).replaceAll("_", " ").toUpperCase());
    const connected = ctrader?.connected === true && ctrader?.authorized === true;
    const demo = autoStatus?.demoAccount === true && autoStatus?.demoOnly === true;
    const enabled = autoStatus?.enabled === true;
    const autoReady = enabled && demo && connected && autoStatus?.blocked !== true;
    const eligible = data.executionEligible === true && (signal === "BUY" || signal === "SELL");

    text("candidateSymbol", symbol);
    text("candidateDirection", signal === "BUY" || signal === "SELL" ? signal : "WAIT");

    let approval;
    if (!data || !Object.keys(data).length) {
      approval = "DECISION UNAVAILABLE";
    } else if (reasons.length) {
      approval = "BLOCKED";
    } else if (!eligible) {
      approval = signal === "BUY" || signal === "SELL" ? "GATES UNCONFIRMED" : "WAITING FOR SIGNAL";
    } else if (!enabled) {
      approval = "SIGNAL READY · AUTO OFF";
    } else if (!autoReady) {
      approval = "WAITING · ACCOUNT / FEED";
    } else {
      approval = "ENTRY GATES PASSED";
    }
    text("candidateApproval", approval);

    const autoLabel = !autoStatus
      ? "STATUS UNAVAILABLE"
      : !enabled
        ? "OFF"
        : autoStatus.blocked === true
          ? "BLOCKED"
          : autoReady
            ? "ARMED · DEMO"
            : "WAITING · VERIFY DEMO / FEED";
    text("candidateAutoStatus", autoLabel);

    const openPositions = Array.isArray(positions?.positions) ? positions.positions : [];
    const matchingPosition = openPositions.find(position => {
      const positionSymbol = String(first(position.symbol, position.symbolName, position.tradeData?.symbolName, "")).toUpperCase().replace(/[\\/\\s_-]/g, "");
      const side = Number(first(position.tradeData?.tradeSide, position.tradeSide));
      const positionDirection = side === 1 ? "BUY" : side === 2 ? "SELL" : String(first(position.direction, "")).toUpperCase();
      return positionSymbol === symbol && positionDirection === signal;
    });
    text("candidateBrokerStatus", matchingPosition ? "OPEN POSITION VERIFIED" : "NO MATCHING OPEN POSITION");

    let reason;
    if (!data || !Object.keys(data).length) {
      reason = "The AI decision API has not supplied a decision yet.";
    } else if (reasons.length) {
      reason = "BLOCKED BY: " + reasons.join(" · ");
    } else if (signal !== "BUY" && signal !== "SELL") {
      reason = "No BUY/SELL candidate is confirmed for " + symbol + ". Waiting for the strategy.";
    } else if (!eligible) {
      reason = "The direction is " + signal + ", but the backend has not confirmed execution eligibility.";
    } else if (!enabled) {
      reason = signal + " signal for " + symbol + " passes the reported AI gates, but auto-trading is OFF.";
    } else if (!autoReady) {
      reason = "Candidate " + symbol + " " + signal + " is waiting for verified demo account, cTrader connection, or unblocked auto-trader status.";
    } else if (matchingPosition) {
      reason = symbol + " " + signal + " has a matching open position in the cTrader position feed.";
    } else {
      reason = symbol + " " + signal + " passes the reported entry gates. No matching open position is visible yet; this is not proof that an order was accepted.";
    }
    text("candidateReason", reason);

    const panel = $("autoTradeCandidatePanel");
    if (panel) {
      panel.classList.toggle("is-blocked", approval === "BLOCKED" || autoLabel === "BLOCKED");
      panel.classList.toggle("is-approved", approval === "ENTRY GATES PASSED");
    }
  }

  function updateMarketSession(market, ctrader) {
    const state = market || {};
    const status = String(
      state.marketStatus ||
      (ctrader?.connected && ctrader?.authorized ? "MARKET_OPEN" : "CTRADER_DISCONNECTED")
    );

    const open = status === "MARKET_OPEN";
    const label =
      status === "MARKET_OPEN" ? "MARKET OPEN" :
      status === "FEED_STALE" ? "FEED STALE" :
      "CTRADER DISCONNECTED";

    text("marketSession", label);
    text("dataStatus", open ? "LIVE" : "NOT LIVE");
    text("dashMarketStatus", label);
    text(
      "dashMarketDetail",
      open
        ? "Fresh cTrader feed"
        : (state.marketStatusDetail || "Trading signals blocked")
    );

    const session = $("marketSession");
    if (session) {
      session.classList.remove("market-open", "market-closed", "market-stale", "market-disconnected");
      session.classList.add(
        open ? "market-open" :
        status === "FEED_STALE" ? "market-stale" :
        "market-disconnected"
      );
    }

    const badge = $("dataStatus");
    if (badge) {
      badge.classList.remove("live", "offline");
      badge.classList.add(open ? "live" : "offline");
    }

    if (!open) {
      text("engineStatus", label);
      setSignal("WAIT");
      text("confidence", "0%");
      text(
        "reason",
        state.marketStatusDetail ||
        "Live market data is unavailable. Waiting for a fresh cTrader feed."
      );
    }
  }

  function updateFinalTradeGate(marketState, prediction, ai, positions) {
    const data = ai?.decision || ai || {};
    const gates = data.gates || {};
    const direction = String(first(data.direction, data.signal, "WAIT")).toUpperCase();
    const digits = priceDigits(first(data.symbol, marketState?.symbol, "XAUUSD"));
    const eligible = data.executionEligible === true;
    const hasPosition = Number(first(positions?.count, 0)) > 0;
    const ready = eligible && !hasPosition;

    text("gateMarket", gates.dataReady === false ? "NO DATA" : (gates.spreadAllowed === false ? "SPREAD BLOCKED" : "DATA READY"));
    text("gateSignal", direction);
    const failedGates = Object.entries(gates).filter(([,v]) => v === false).map(([k]) => k);
    text("gateQuality", failedGates.length ? "BLOCKED · " + failedGates.map(k => String(k).replaceAll("_", " ").toUpperCase()).join(" / ") : eligible ? "PASSED" : "WAITING FOR GATES");
    text("gatePosition", hasPosition ? "OPEN" : "FLAT");
    text("gateEntry", priceNumber(first(data.entry, data.entryPrice), digits));
    text("gateSL", priceNumber(first(data.stopLoss, data.stop), digits));
    text("gateTP", priceNumber(first(data.takeProfit, data.target), digits));
    text("gateRR", Number.isFinite(Number(first(data.rewardRisk, data.riskReward))) ? number(first(data.rewardRisk, data.riskReward), 1) + "R" : "—");

    const decision = $("gateDecision");
    if (decision) {
      decision.classList.remove("buy", "sell", "wait");
      decision.classList.add(ready && (direction === "BUY" || direction === "SELL") ? direction.toLowerCase() : "wait");
      decision.textContent = ready ? "TRADE " + direction : "WAIT";
    }

    let reason = first(data.reason, "Waiting for AI Trader decision.");
    const failed = Object.entries(gates).filter(([,v]) => v === false).map(([k]) => String(k).replaceAll("_", " ").toUpperCase());
    if (hasPosition) {
      reason = "OPEN POSITION GATE: " + Number(first(positions?.count, 0)) + " position(s) currently open.";
      if (failed.length) reason += " OTHER BLOCKERS: " + failed.join(" · ");
    } else if (!eligible) {
      reason = failed.length ? "BLOCKED: " + failed.join(" · ") : reason;
    } else if (ready) reason = direction + " approved by AURIXA AI Trader V1.";
    text("gateReason", reason);
  }

  function updateAutoTrader(status, positions) {
    if (!status) {
      text("autoTradeStatus", "STATUS UNAVAILABLE");
      text("autoTradeNotice", "Auto-trader status unavailable. The frontend will not assume trading is enabled.");
      return;
    }
    const enabled = status.enabled === true;
    const demo = status.demoAccount === true && status.demoOnly === true;
    const connected = status.connected === true && status.authorized === true;
    const blocked = status.blocked === true;
    const state = blocked ? "BLOCKED" : (enabled && demo && connected ? "READY" : (enabled ? "WAITING" : "OFF"));

    text("autoTradeStatus", state);
    const openCount = Number(first(positions?.count, Array.isArray(positions?.positions) ? positions.positions.length : 0));
    const maxOpenRaw = first(status.maxOpenPositions, status.positionLimit);
    const unlimited = maxOpenRaw === "unlimited" || maxOpenRaw === "UNLIMITED" || maxOpenRaw == null;
    const maxOpen = unlimited ? null : Number(maxOpenRaw);
    text("autoTradeMode", demo ? "DEMO ONLY · AI V1" : "GUARDED · AI V1");
    if (maxOpenRaw != null) text("gateMaxPositions", unlimited ? "OPEN POSITIONS: UNLIMITED" : "MAX " + maxOpen + " POSITIONS");
    if (status.riskPercent != null) text("gateRiskLimit", "RISK " + number(status.riskPercent, 2) + "%");
    if (status.dailyTradeLimit != null) text("gateDailyLimit", status.dailyTradeLimit === "unlimited" || status.dailyTradeLimit === "UNLIMITED" ? "DAILY LIMIT: UNLIMITED" : "DAILY LIMIT " + status.dailyTradeLimit);
    if (status.cooldownMinutes != null) text("gateCooldown", "COOLDOWN " + status.cooldownMinutes + " MIN");
    text("autoTradePosition", openCount > 0 ? (unlimited ? `OPEN ${openCount}` : `OPEN ${openCount}/${maxOpen}`) : (unlimited ? "FLAT 0" : `FLAT 0/${maxOpen}`));

    const list = Array.isArray(positions?.positions) ? positions.positions : [];
    const p = list[0];
    const activeTitle = $("activePositionTitle");
    if (activeTitle) activeTitle.textContent = list.length
      ? "BROKER POSITION SNAPSHOT · " + list.length + " OPEN ACROSS MARKETS"
      : "BROKER POSITION SNAPSHOT · MULTI-MARKET";

    if (!p) {
      text("autoPositionDirection", "FLAT");
      text("autoPositionEntry", "—");
      text("autoPositionCurrent", "—");
      text("autoPositionVolume", "—");
      text("autoPositionSL", "—");
      text("autoPositionPnl", "—");
      const activeTitle = $("activePositionTitle");
      if (activeTitle) activeTitle.textContent = "BROKER POSITION SNAPSHOT · MULTI-MARKET";
      text("autoTradeNotice", state === "READY" ? "Demo auto-trader is armed. No open positions across supported markets." : state);
    } else {
      const positionSymbol = String(first(p.symbol, p.symbolName, status.symbol, "XAUUSD")).toUpperCase().replace(/[\/\s_-]/g, "");
      const positionDigits = priceDigits(positionSymbol);
      const side = Number(p?.tradeData?.tradeSide) === 1 ? "BUY" : Number(p?.tradeData?.tradeSide) === 2 ? "SELL" : first(p.direction, "—");
      const entry = first(p?.tradeData?.openPrice, p?.tradeData?.price, p?.price, p?.entryPrice);
      const current = first(p?.currentPrice, p?.tradeData?.currentPrice);
      const volume = first(p?.tradeData?.volume, p?.volume);
      const sl = first(p?.tradeData?.stopLoss, p?.stopLoss);
      const pnl = first(p?.unrealizedNetProfit, p?.tradeData?.unrealizedNetProfit, p?.netProfit, p?.profit);
      text("autoPositionDirection", side);
      text("autoPositionEntry", priceNumber(entry, positionDigits));
      text("autoPositionCurrent", priceNumber(current, positionDigits));
      text("autoPositionVolume", volume ?? "—");
      text("autoPositionSL", priceNumber(sl, positionDigits));
      text("autoPositionPnl", pnl === null || pnl === undefined || pnl === "" || !Number.isFinite(Number(pnl)) ? "—" : number(pnl, 2));
      text("autoTradeNotice", "Showing " + positionSymbol + " as the first of " + list.length + " open broker position(s). Full list is below.");
    }



  }


  function renderOpenTrades(data) {
    const body = $("openTradesList");
    const summary = $("openTradesSummary");
    const updated = $("openTradesUpdated");
    if (!body) return;

    const positions = Array.isArray(data?.positions)
      ? data.positions
      : Array.isArray(data)
        ? data
        : [];

    const activeSymbol = String(first(data?.selectedSymbol, data?.symbol, $("instrument")?.textContent, "XAUUSD")).toUpperCase().replace(/[\/\s_-]/g, "");
    const activePositions = positions;

    if (summary) summary.textContent = activePositions.length + " OPEN POSITIONS · MULTI-MARKET";

    if (!activePositions.length) {
      body.innerHTML = '<div class="empty">No open positions across supported markets.</div>';
      if (updated) updated.textContent = "Live cTrader position feed · " + new Date().toLocaleTimeString();
      return;
    }

    body.innerHTML = activePositions.map(p => {
      const td = p?.tradeData || {};
      const positionSymbol = String(first(p.symbol, p.symbolName, activeSymbol)).toUpperCase().replace(/[\/\s_-]/g, "");
      const digits = priceDigits(positionSymbol);
      const sideNum = Number(first(td.tradeSide, p.tradeSide));
      const direction = sideNum === 1
        ? "BUY"
        : sideNum === 2
          ? "SELL"
          : String(first(p.direction, "—")).toUpperCase();

      const positionId = first(p.positionId, td.positionId, p.id);
      const orderId = first(p.orderId, td.orderId);
      const entry = first(p.openPrice, td.openPrice, td.price, p.entryPrice, p.price);
      const current = first(p.currentPrice, td.currentPrice);
      const volume = first(p.volume, td.volume);
      const brokerProtection = p.brokerProtection || {};
      const sl = first(brokerProtection.stopLoss, p.stopLoss, td.stopLoss);
      const tp = first(brokerProtection.takeProfit, p.takeProfit, td.takeProfit);
      const protectionStatus = String(first(brokerProtection.status, "UNKNOWN")).toUpperCase();
      const intelligence = p.positionIntelligence || {};
      const intelligenceAction = String(first(intelligence.action, "HOLD")).toUpperCase();
      const intelligenceStatus = String(first(intelligence.brokerActionStatus, "NOT_EVALUATED")).toUpperCase();
      const intelligenceReason = String(first(intelligence.reason, "Waiting for position analysis."));
      const pnl = first(
        p.unrealizedNetProfit,
        td.unrealizedNetProfit,
        p.netProfit,
        p.profit
      );
      const opened = first(p.openTime, p.openedAt, td.openTime, td.openedAt);
      const toNumeric = value => value === null || value === undefined || value === "" ? NaN : Number(value);
      const entryN = toNumeric(entry);
      const currentN = toNumeric(current);
      const slN = toNumeric(sl);
      const tpN = toNumeric(tp);
      const pnlN = pnl === null || pnl === undefined || pnl === "" ? NaN : Number(pnl);
      const pnlClass = Number.isFinite(pnlN) ? (pnlN > 0 ? "profit" : pnlN < 0 ? "loss" : "flat") : "";
      const sideClass = direction === "BUY" ? "buy" : direction === "SELL" ? "sell" : "flat";

      return '<article class="open-trade-card">' +
        '<div class="open-trade-top">' +
          '<div><strong class="open-trade-direction ' + sideClass + '">' + escapeHTML(direction) + '</strong><span class="open-trade-symbol">' + escapeHTML(positionSymbol) + '</span></div>' +
          '<strong class="open-trade-pnl ' + pnlClass + '">' + escapeHTML(Number.isFinite(pnlN) ? (pnlN > 0 ? "+" : "") + number(pnlN, 2) : "—") + '</strong>' +
        '</div>' +
        '<div class="open-trade-id">POSITION ' + escapeHTML(positionId ?? "—") + (orderId ? ' · ORDER ' + escapeHTML(orderId) : '') + '</div>' +
        '<div class="open-trade-grid">' +
          '<div><span>ENTRY</span><strong>' + escapeHTML(Number.isFinite(entryN) ? number(entryN, digits) : "—") + '</strong></div>' +
          '<div><span>CURRENT</span><strong>' + escapeHTML(Number.isFinite(currentN) ? number(currentN, digits) : "—") + '</strong></div>' +
          '<div><span>VOLUME</span><strong>' + escapeHTML(volume ?? "—") + '</strong></div>' +
          '<div><span>STOP LOSS</span><strong>' + escapeHTML(Number.isFinite(slN) ? number(slN, digits) : "NOT SET") + '</strong></div>' +
          '<div><span>TAKE PROFIT</span><strong>' + escapeHTML(Number.isFinite(tpN) ? number(tpN, digits) : "NOT SET") + '</strong></div>' +
          '<div><span>OPENED</span><strong>' + escapeHTML(opened ? formatTime(opened) : "—") + '</strong></div>' +
        '</div>' +
        '<div class="open-trade-footer"><span>AI POSITION DECISION ' + escapeHTML(intelligenceAction) + ' · ' + escapeHTML(intelligenceStatus) + '</span><span>' + escapeHTML(intelligenceReason) + '</span></div>' +
        '<div class="open-trade-footer"><span>BROKER PROTECTION ' + escapeHTML(protectionStatus) + ' · ' + (Number.isFinite(slN) ? "SL " + number(slN, digits) : "SL MISSING") + ' · ' + (Number.isFinite(tpN) ? "TP " + number(tpN, digits) : "TP MISSING") + (first(brokerProtection.checkedAt, p.snapshotCheckedAt) ? ' · CHECKED ' + escapeHTML(formatTime(first(brokerProtection.checkedAt, p.snapshotCheckedAt))) : '') + '</span><span>LIVE cTRADER SNAPSHOT</span></div>' +
      '</article>';
    }).join("");

    if (updated) updated.textContent = "Live cTrader position feed · " + new Date().toLocaleTimeString();
  }

function formatTime(value) {
    if (!value) return "—";

    const d = new Date(value);

    if (Number.isNaN(d.getTime())) {
      return String(value);
    }

    return d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }

  function escapeHTML(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function drawChart(candles) {
    const container = $("marketChart");
    if (!container || !Array.isArray(candles)) return;
    const source = candles.filter(c => c && [c.open,c.high,c.low,c.close].every(v => Number.isFinite(Number(v)))).slice(-120);
    if (source.length < 2) return;
    let canvas = container.querySelector("canvas");
    if (!canvas) { container.innerHTML=""; canvas=document.createElement("canvas"); canvas.setAttribute("aria-label","cTrader live selected-symbol M5 candlestick chart"); canvas.style.width="100%"; canvas.style.height="100%"; canvas.style.display="block"; container.appendChild(canvas); }
    const rect=container.getBoundingClientRect(), dpr=Math.max(1,Math.min(2,window.devicePixelRatio||1)), width=Math.max(320,Math.floor(rect.width||640)), height=Math.max(260,Math.floor(rect.height||420));
    canvas.width=Math.floor(width*dpr); canvas.height=Math.floor(height*dpr);
    const ctx=canvas.getContext("2d"); if(!ctx)return; ctx.setTransform(dpr,0,0,dpr,0,0); ctx.fillStyle="#080a0d"; ctx.fillRect(0,0,width,height);
    const left=12,right=64,top=14,bottom=30,plotW=width-left-right,plotH=height-top-bottom,prices=source.flatMap(c=>[Number(c.high),Number(c.low)]),hi=Math.max(...prices),lo=Math.min(...prices),pad=Math.max((hi-lo)*.08,.5),maxP=hi+pad,minP=lo-pad,y=p=>top+((maxP-p)/(maxP-minP))*plotH,step=plotW/source.length,bodyW=Math.max(2,Math.min(10,step*.62));
    ctx.font="11px sans-serif"; ctx.fillStyle="#89919d"; ctx.strokeStyle="rgba(255,255,255,.08)";
    for(let i=0;i<=5;i++){const gy=top+plotH*i/5,price=maxP-(maxP-minP)*i/5;ctx.beginPath();ctx.moveTo(left,gy);ctx.lineTo(left+plotW,gy);ctx.stroke();ctx.fillText(price.toFixed(2),left+plotW+7,gy+4);}
    source.forEach((c,i)=>{const o=+c.open,h=+c.high,l=+c.low,cl=+c.close,x=left+i*step+step/2,up=cl>=o,bt=y(Math.max(o,cl)),bb=y(Math.min(o,cl));ctx.strokeStyle=up?"#30d68a":"#ff5b65";ctx.fillStyle=ctx.strokeStyle;ctx.beginPath();ctx.moveTo(x,y(h));ctx.lineTo(x,y(l));ctx.stroke();ctx.fillRect(x-bodyW/2,bt,bodyW,Math.max(1,bb-bt));});
    const latest=source[source.length-1],price=+latest.close,py=y(price);ctx.strokeStyle="#f5c451";ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(left,py);ctx.lineTo(left+plotW,py);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle="#f5c451";ctx.fillText(price.toFixed(2),left+plotW+7,py+4);
    ctx.fillStyle="#89919d";ctx.fillText(formatTime(first(source[0].time,source[0].timestamp,source[0].openTime)),left,height-8);ctx.fillText(formatTime(first(latest.time,latest.timestamp,latest.openTime)),Math.max(left,left+plotW-90),height-8);
    text("candleCount",String(source.length));text("latestCandle",formatTime(first(latest.time,latest.timestamp,latest.openTime)));
  }
function updateActivity(ai, ctrader, autoStatus, positions) {
    const data = ai?.decision || ai || {};
    const signal = String(first(data.signal, data.direction, "WAIT")).toUpperCase();
    const connected = ctrader?.connected === true && ctrader?.authorized === true;
    const logic = data.logic || {};
    const failed = Array.isArray(data.blockedBy) ? data.blockedBy : [];
    const rr = first(data.rewardRisk, data.riskReward);
    const evaluationTime = first(data.evaluatedAt, data.evaluated_at, data.evaluationTime, data.timestamp, data.createdAt, data.created_at);
    text("activityLast", evaluationTime ? formatTime(evaluationTime) : "UI UPDATE · " + new Date().toLocaleTimeString());
    text("activityDecision", signal + " · " + number(data.confidence, 0) + "%");
    text("activityLogic", Number.isFinite(Number(logic.passed)) ? String(logic.passed) + "/" + String(first(logic.total, 6)) + " checks passed" : "Logic unavailable");
    text("activityGates", failed.length ? "BLOCKED · " + failed.map(x => x.replaceAll("_"," ")).join(" · ").toUpperCase() : (data.executionEligible === true ? "ALL GATES PASSED" : "WAITING FOR GATES"));
    const feed = $("aiActivityFeed");
    if (feed) {
      const status = autoStatus?.enabled === true
        ? (autoStatus?.blocked === true ? "AUTO BLOCKED" : (connected && autoStatus?.demoAccount === true ? "AUTO ARMED · DEMO" : "AUTO WAITING"))
        : "AUTO OFF";
      const position = Number(first(positions?.count, 0)) > 0 ? "POSITION OPEN" : "FLAT";
      feed.innerHTML =
        '<div class="activity-item"><strong>LIVE FEED</strong><span>' + (connected ? "CONNECTED" : "OFFLINE") + '</span></div>' +
        '<div class="activity-item"><strong>AI DECISION</strong><span>' + escapeHTML(signal + " · " + number(data.confidence, 0) + "%") + '</span></div>' +
        '<div class="activity-item"><strong>LOGIC</strong><span>' + escapeHTML(String(first(logic.passed, "—")) + "/" + String(first(logic.total, 6)) + " PASSED") + '</span></div>' +
        '<div class="activity-item"><strong>R:R</strong><span>' + escapeHTML(Number.isFinite(Number(rr)) ? number(rr, 2) + "R" : "—") + '</span></div>' +
        '<div class="activity-item"><strong>AUTO-TRADER</strong><span>' + escapeHTML(status) + '</span></div>' +
        '<div class="activity-item"><strong>POSITION</strong><span>' + escapeHTML(position) + '</span></div>';
    }
  }

  function renderConfirmedSignalHistory(history, autoTrades = []) {
    const body = $("confirmedSignalHistory");
    const summary = $("confirmedSignalHistorySummary");
    if (!body) return;
    const source = Array.isArray(history?.signals) ? history.signals
      : Array.isArray(history?.history) ? history.history
      : Array.isArray(history?.decisions) ? history.decisions
      : Array.isArray(history) ? history : [];
    const confirmed = source.filter(row => {
      const signal = String(first(row?.signal, row?.direction, row?.decision, "")).toUpperCase();
      return (signal === "BUY" || signal === "SELL") &&
        (row?.executionEligible === true || row?.confirmed === true ||
         row?.finalGate === true || row?.status === "CONFIRMED");
    }).sort((a, b) => {
      const stamp = row => {
        const value = first(row?.createdAt, row?.created_at, row?.timestamp, row?.time, row?.candleTime, row?.decision?.timestamp);
        const parsed = value == null ? NaN : Date.parse(value);
        return Number.isFinite(parsed) ? parsed : (Number.isFinite(Number(value)) ? Number(value) : 0);
      };
      return stamp(b) - stamp(a);
    }).slice(0, 50);
    if (summary) summary.textContent = confirmed.length + " CONFIRMED SIGNALS · NEWEST FIRST";
    if (!confirmed.length) {
      body.innerHTML = '<div class="empty">No confirmed BUY or SELL signals yet.</div>';
      return;
    }
    body.innerHTML = confirmed.map(row => {
      const signal=String(first(row?.signal,row?.direction,row?.decision,"")).toUpperCase();
      const confidence=row?.confidence == null || row?.confidence === "" ? NaN : Number(row.confidence);
      const detail=row?.decision && typeof row.decision==="object"?row.decision:{};
      const price=first(row?.entry,row?.entryPrice,row?.entry_price,row?.price,row?.mid,row?.close,detail?.entry,detail?.price,detail?.mid,detail?.close);
      const time=first(row?.createdAt,row?.created_at,row?.timestamp,row?.time,row?.candleTime,detail?.timestamp);
      const rowSymbol=String(first(row?.symbol,detail?.symbol,"UNKNOWN")).toUpperCase().replace(/[^A-Z0-9._/-]/g,"");
      const id=Number(row?.id);
      return '<button type="button" class="confirmed-signal-row confirmed-signal-click" data-signal-id="'+(Number.isSafeInteger(id)&&id>0?id:"")+'" aria-label="Investigate '+escapeHTML(signal+" "+rowSymbol)+'">'+
        '<strong class="'+(signal==="BUY"?"history-buy":"history-sell")+'">'+escapeHTML(signal+" · "+rowSymbol)+'</strong>'+
        '<span>'+escapeHTML(Number.isFinite(confidence)?number(confidence,0)+"%":"—")+'</span>'+
        '<span>'+escapeHTML(Number.isFinite(Number(price))?number(price,2):"—")+'</span>'+
        '<span>'+escapeHTML(formatTime(time))+'</span>'+
        '<span>VIEW WHY &amp; HOW ↗</span></button>';
    }).join("");
  }

  function investigationValue(value, digits=2) {
    if(value===null||value===undefined||value==="") return "Not recorded";
    const n=Number(value);
    return Number.isFinite(n)?number(n,digits):String(value);
  }
  function investigationField(label,value) {
    return '<div class="signal-investigation-field"><span>'+escapeHTML(label)+'</span><strong>'+escapeHTML(value==null||value===""?"Not recorded":String(value))+'</strong></div>';
  }
  function renderSignalInvestigation(signal) {
    const content=$("signalInvestigationContent");
    if(!content) return;
    const d=signal.decision||{}, ex=signal.execution||{};
    const blocked=Array.isArray(signal.blockedBy)?signal.blockedBy:[];
    const gates=signal.gates&&typeof signal.gates==="object"?signal.gates:{};
    const gateRows=Object.entries(gates).map(([key,value])=>{
      const status=value===true?"PASS":value===false?"FAIL":"UNKNOWN";
      const cls=value===true?"gate-pass":value===false?"gate-fail":"gate-unknown";
      return '<div class="signal-audit-gate"><span>'+escapeHTML(key.replaceAll("_"," ").toUpperCase())+'</span><strong class="'+cls+'">'+status+'</strong></div>';
    }).join("");
    const why=blocked.length?blocked.map(x=>String(x).replaceAll("_"," ")).join(" · "):
      signal.executionEligible===true?"All recorded execution gates passed; a passed signal does not by itself prove an order was filled.":"No explicit block reason was stored. Review the recorded decision below.";
    const status=String(ex.status||"UNKNOWN").toUpperCase();
    const tradeOutcome=ex.tradeId
      ? (status==="CLOSED"?"The linked trade is recorded as closed.":status==="OPEN"||status==="PARTIAL"?"The linked trade is recorded as open.":"A linked trade record exists; check its status and broker identifiers.")
      : signal.executionEligible===true
        ? "No trade record is linked to this signal. This is not proof of broker rejection; historical linkage or execution evidence may be missing."
        : "The signal was not approved for execution according to the stored decision.";
    const pnl=ex.profit===null||ex.profit===undefined||ex.profit===""?"Not available from the stored trade record":investigationValue(ex.profit);
    $("signalInvestigationTitle").textContent=String(signal.direction||"SIGNAL").toUpperCase()+" · "+String(signal.symbol||"UNKNOWN").toUpperCase();
    $("signalInvestigationSubtitle").textContent="Signal #"+signal.id+" · "+formatTime(signal.createdAt||signal.candleTime)+" · "+String(signal.timeframe||"M5");
    content.innerHTML=
      '<section class="signal-investigation-section"><h3>WHY was this signal generated?</h3>'+
      '<div class="signal-investigation-grid">'+
      investigationField("Direction",signal.direction)+investigationField("Confidence",investigationValue(signal.confidence,1)+"%")+
      investigationField("Signal price",investigationValue(signal.entryPrice))+investigationField("Strategy",String(signal.engine||"Unknown")+" / "+String(signal.version||"Unknown"))+
      investigationField("Trend",d.trend||"Not recorded")+investigationField("Market regime",d.regime||"Not recorded")+
      investigationField("RSI",investigationValue(d.rsi,2))+investigationField("Momentum",investigationValue(d.momentum,2))+
      investigationField("EMA 9 / 21 / 50",[d.ema9,d.ema21,d.ema50].map(v=>v==null?"—":investigationValue(v)).join(" / "))+
      investigationField("Planned stop loss",investigationValue(signal.stopLoss))+investigationField("Planned take profit",investigationValue(signal.takeProfit))+
      investigationField("Reward / risk",signal.rewardRisk==null?"Not recorded":investigationValue(signal.rewardRisk,2)+"R")+
      '</div><p class="signal-investigation-explanation"><b>Recorded decision:</b> '+escapeHTML(why)+'</p></section>'+
      '<section class="signal-investigation-section"><h3>HOW did execution checks behave?</h3>'+
      (gateRows?'<div class="signal-audit-gates">'+gateRows+'</div>':'<p class="signal-investigation-muted">Gate-by-gate values were not stored for this signal.</p>')+
      '<p class="signal-investigation-explanation"><b>Execution interpretation:</b> '+escapeHTML(tradeOutcome)+'</p>'+
      '<div class="signal-investigation-grid">'+
      investigationField("Execution status",status)+investigationField("Block / gate reason",ex.gateReason||blocked.join(", ")||"No explicit reason recorded")+
      investigationField("Execution error",ex.error||"Not recorded")+investigationField("Order ID",ex.orderId)+
      investigationField("Position ID",ex.positionId)+investigationField("Volume",investigationValue(ex.volume,0))+
      investigationField("Signal entry price",investigationValue(ex.signalEntryPrice))+investigationField("Actual fill price",investigationValue(ex.fillPrice))+
      investigationField("Opened",ex.openedAt?formatTime(ex.openedAt):"Not recorded")+investigationField("Closed",ex.closedAt?formatTime(ex.closedAt):"Not recorded")+
      investigationField("Exit price",investigationValue(ex.closePrice))+investigationField("Realized P/L",pnl)+
      investigationField("Exit reason",ex.exitReason||"Not recorded")+
      investigationField("Stored planned SL / TP",investigationValue(ex.plannedStopLoss)+" / "+investigationValue(ex.plannedTakeProfit))+
      '</div></section>';
  }
  async function openSignalInvestigation(id) {
    const modal=$("signalInvestigation"),content=$("signalInvestigationContent");
    if(!modal||!content||!id) return;
    modal.hidden=false;modal.setAttribute("aria-hidden","false");
    document.body.classList.add("signal-investigation-open");
    content.innerHTML='<div class="empty">Loading stored signal and execution records…</div>';
    try {
      const response=await fetch("/api/ai/signals/"+encodeURIComponent(id),{cache:"no-store",headers:{Accept:"application/json"}});
      const data=await response.json();
      if(!response.ok||data?.ok!==true||!data.signal) throw new Error(data?.error||"Signal evidence unavailable");
      renderSignalInvestigation(data.signal);
    } catch(error) {
      content.innerHTML='<div class="empty">Could not load investigation evidence: '+escapeHTML(error.message||"Request failed")+'. Please check the server and try again.</div>';
    }
  }
  function closeSignalInvestigation() {
    const modal=$("signalInvestigation");
    if(!modal)return;
    modal.hidden=true;modal.setAttribute("aria-hidden","true");
    document.body.classList.remove("signal-investigation-open");
  }
  function wireSignalInvestigation() {
    const body=$("confirmedSignalHistory");
    if(body&&!body.dataset.investigationWired){
      body.dataset.investigationWired="true";
      body.addEventListener("click",event=>{
        const button=event.target.closest("[data-signal-id]");
        if(button&&button.dataset.signalId) openSignalInvestigation(button.dataset.signalId);
      });
    }
    const modal=$("signalInvestigation");
    if(modal&&!modal.dataset.closeWired){
      modal.dataset.closeWired="true";
      modal.addEventListener("click",event=>{if(event.target.closest("[data-signal-close]"))closeSignalInvestigation();});
      document.addEventListener("keydown",event=>{if(event.key==="Escape"&&!modal.hidden)closeSignalInvestigation();});
    }
  }


  function updateAccountPanel(account, autoStatus, ctrader) {
    const a = account?.account || account || {};
    // Missing broker values stay unavailable; null must never display as 0.00.
    const accountNumber = value => {
      if (value === null || value === undefined || value === "") return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    const balance = accountNumber(a.balance);
    const equity = accountNumber(a.equity);
    const freeMargin = accountNumber(a.freeMargin);
    const usedMargin = accountNumber(a.usedMargin);
    text("accountBalance", balance === null ? "—" : number(balance, 2));
    text("accountEquity", equity === null ? "—" : number(equity, 2));
    text("accountFreeMargin", freeMargin === null ? "—" : number(freeMargin, 2));
    text("accountUsedMargin", usedMargin === null ? "—" : number(usedMargin, 2));
    const currencyLabel = first(
      a.currency,
      a.depositAsset?.name,
      a.depositAsset?.assetName,
      a.depositAssetId != null ? "ASSET ID " + a.depositAssetId + " · CODE UNAVAILABLE" : null,
      "UNAVAILABLE"
    );
    text("accountCurrency", currencyLabel);
    const floatingPnl = accountNumber(a.unrealizedNetProfit);
    text("accountUnrealizedPnl", floatingPnl === null ? "—" : (floatingPnl > 0 ? "+" : "") + number(floatingPnl, 2));
    const marginStatus = String(first(a.marginStatus, "UNAVAILABLE")).toUpperCase();
    const equitySource = String(first(a.equitySource, "UNAVAILABLE")).toUpperCase();
    const marginLabel = marginStatus === "BROKER_CONFIRMED"
      ? "Margin values confirmed by cTrader"
      : marginStatus === "CALCULATED_FROM_BROKER_SNAPSHOT"
        ? "Used margin from cTrader positions · free margin calculated from equity minus used margin"
        : marginStatus === "PARTIAL"
          ? "Partial margin data · some broker fields unavailable"
          : "Margin data unavailable from cTrader";
    const equityLabel = equitySource === "BROKER_ACCOUNT_FIELD"
      ? "Equity supplied by cTrader"
      : equitySource === "BALANCE_PLUS_BROKER_NET_PNL"
        ? "Equity calculated as balance plus cTrader net floating P&L"
        : "Equity unavailable";
    text("accountMarginStatus", equityLabel + " · " + marginLabel);
    text("accountBroker", first(a.brokerTitleShort, ctrader?.account?.brokerTitleShort, "—"));
    text("accountLogin", first(a.traderLogin, ctrader?.account?.traderLogin, "—"));
    text("accountEnvironment", a.isLive === false || ctrader?.account?.isLive === false ? "DEMO" : a.isLive === true || ctrader?.account?.isLive === true ? "LIVE BLOCKED" : "UNKNOWN");
    text("accountPermission", ctrader?.tradingPermission === true ? "TRADING" : "READ ONLY / BLOCKED");
    const ready = ctrader?.connected === true && ctrader?.authorized === true && a.isLive === false;
    text("accountReadStatus", account?.ok === true ? (ready ? "ACCOUNT DATA LIVE" : "ACCOUNT DATA READ") : "ACCOUNT DATA UNAVAILABLE");
  }

  function updatePerformance(trades, liveSummary) {
    const rows = Array.isArray(trades?.trades) ? trades.trades : [];
    const dedicatedClosed = Array.isArray(trades?.closedTrades) ? trades.closedTrades : [];
    const closed = dedicatedClosed.length ? dedicatedClosed : rows.filter(t => String(t?.status || "").trim().toUpperCase().startsWith("CLOSED") || Boolean(t?.closedAt));
    if (liveSummary?.ok === true && liveSummary?.source === "aurixa.auto_trades") {
      const wins = Number(liveSummary.wins || 0), losses = Number(liveSummary.losses || 0), flat = Number(liveSummary.breakeven || 0);
      const evaluated = wins + losses + flat;
      const totalClosed = Number(liveSummary.totalClosed || 0), sampled = Number(liveSummary.sampledClosed || 0);
      const pending = Number(liveSummary.pnlPending || 0), withPnl = Number(liveSummary.withRecordedPnl || 0), pnl = Number(liveSummary.realizedPnl || 0);
      const winRate = liveSummary.winRate == null ? null : Number(liveSummary.winRate);
      text("performanceWins", wins); text("performanceLosses", losses); text("performanceFlat", flat);
      text("performanceWinRate", winRate === null || !Number.isFinite(winRate) ? "—" : number(winRate, 1) + "%");
      text("performancePnl", withPnl ? ((pnl > 0 ? "+" : "") + number(pnl, 2)) : "—");
      const scope = totalClosed > sampled ? "LATEST " + sampled + " OF " + totalClosed + " CLOSED TRADES" : "LATEST " + sampled + " CLOSED TRADES";
      const updated = liveSummary.updatedAt ? new Date(liveSummary.updatedAt).toLocaleTimeString() : new Date().toLocaleTimeString();
      text("performanceSample", scope + " · " + withPnl + " WITH RECORDED P/L · " + pending + " P/L PENDING · UPDATED " + updated);
      return;
    }
    const verified = closed.map(t => t.profit === null || t.profit === undefined || t.profit === "" ? null : Number(t.profit)).filter(v => Number.isFinite(v));
    let wins = 0, losses = 0, flat = 0;
    const pnl = verified.reduce((sum, p) => sum + p, 0);
    for (const p of verified) { if (p > 0) wins++; else if (p < 0) losses++; else flat++; }
    const evaluated = wins + losses + flat, pending = closed.length - evaluated;
    const winRate = evaluated ? wins / evaluated * 100 : null;
    text("performanceWins", wins); text("performanceLosses", losses); text("performanceFlat", flat);
    text("performanceWinRate", winRate === null ? "—" : number(winRate, 1) + "%");
    text("performancePnl", evaluated ? ((pnl > 0 ? "+" : "") + number(pnl, 2)) : "—");
    text("performanceSample", "FALLBACK SAMPLE ONLY · " + closed.length + " CLOSED LOADED · " + evaluated + " WITH RECORDED P/L · " + pending + " P/L PENDING · LIVE SUMMARY UNAVAILABLE");
  }

  async function openFinishedTradeInvestigation(tradeId) {
    let modal = document.getElementById("finishedTradeInvestigation");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "finishedTradeInvestigation";
      modal.className = "signal-investigation-modal";
      modal.hidden = true;
      modal.setAttribute("aria-hidden", "true");
      modal.innerHTML = '<div class="signal-investigation-backdrop" data-finished-close></div><section class="signal-investigation-dialog" role="dialog" aria-modal="true" aria-labelledby="finishedTradeTitle"><header class="signal-investigation-header"><div><p class="eyebrow">TRADE LIFECYCLE AUDIT</p><h2 id="finishedTradeTitle">Why did this trade finish?</h2></div><button type="button" class="signal-investigation-close" data-finished-close aria-label="Close">×</button></header><div id="finishedTradeContent" class="signal-investigation-content"></div></section>';
      document.body.appendChild(modal);
      modal.addEventListener("click", event => {
        if (event.target.closest("[data-finished-close]")) {
          modal.hidden = true;
          modal.setAttribute("aria-hidden", "true");
          document.body.classList.remove("signal-investigation-open");
        }
      });
    }
    const content = document.getElementById("finishedTradeContent");
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("signal-investigation-open");
    content.innerHTML = '<div class="empty">Loading broker and trade records…</div>';
    try {
      const response = await fetch("/api/auto-trader/trade-trace/" + encodeURIComponent(tradeId), {cache:"no-store",headers:{Accept:"application/json"}});
      const payload = await response.json();
      if (!response.ok || payload?.ok !== true || !payload.trace) throw new Error(payload?.error || "Trade record unavailable");
      const t = payload.trace, d = t.decision || {}, ex = t.execution || {}, p = t.protection || {}, life = t.lifecycle || {}, gates = t.gates || {};
      const val = v => v === null || v === undefined || v === "" ? "Not recorded" : String(v);
      const money = v => v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? "P/L unavailable" : (Number(v) > 0 ? "+" : "") + Number(v).toFixed(2);
      const reason = String(life.exitReason || "");
      const explanation = reason === "AI_DIRECTION_REVERSAL" ? "AURIXA confirmed an opposite-direction signal and the broker confirmed the close." :
        reason === "BROKER_CLOSED" ? "The broker position disappeared and a close was reconciled. The stored record does not identify whether SL, TP, manual close, or another broker action triggered it." :
        reason ? "Recorded exit reason: " + reason.replace(/_/g, " ").toLowerCase() + "." :
        "No specific exit trigger was stored for this trade.";
      const field = (label, value) => '<div class="signal-investigation-field"><span>' + escapeHTML(label) + '</span><strong>' + escapeHTML(val(value)) + '</strong></div>';
      content.innerHTML =
        '<section class="signal-investigation-section"><h3>WHY did the trade open?</h3><div class="signal-investigation-grid">' +
        field("Direction / symbol", val(ex.direction) + " / " + val(t.symbol)) +
        field("Strategy", val(d.engine) + " / " + val(d.version)) +
        field("Signal confidence", d.confidence == null ? "Not recorded" : Number(d.confidence).toFixed(1) + "%") +
        field("Decision ID", d.id) + field("Gate / block reason", gates.reason) +
        field("Original decision", d.data?.reason || d.data?.explanation || "See raw decision evidence below") +
        '</div></section><section class="signal-investigation-section"><h3>HOW did it execute and finish?</h3><div class="signal-investigation-grid">' +
        field("Status", ex.status) + field("Order ID", ex.orderId) + field("Position ID", ex.positionId) +
        field("Volume", ex.volume) + field("Signal entry", ex.signalEntryPrice) + field("Actual entry", ex.entryPrice) +
        field("Planned entry", p.plannedEntryPrice) + field("Planned stop-loss", p.plannedStopPrice) +
        field("Planned take-profit", p.plannedTakeProfitPrice) + field("Stop distance", p.stopLossDistance) +
        field("Take-profit distance", p.takeProfitDistance) + field("Opened at", ex.openedAt) +
        field("Closed at", life.closedAt) + field("Exit price", life.closePrice) +
        field("Realized P/L", money(life.profit)) + field("Recorded exit reason", reason || "Not recorded") +
        '</div><p class="signal-investigation-explanation"><b>Closure explanation:</b> ' + escapeHTML(explanation) + '</p>' +
        (t.error ? '<p class="signal-investigation-explanation"><b>Execution error:</b> ' + escapeHTML(t.error) + '</p>' : '') +
        '</section>';
    } catch (error) {
      content.innerHTML = '<div class="empty">Could not load trade investigation: ' + escapeHTML(error.message || "Request failed") + '</div>';
    }
  }

  function renderClosedTradeHistory(data) {
    const body = $("closedTradeHistory");
    const summary = $("closedTradeHistorySummary");
    if (!body) return;
    // Prefer the dedicated close-time-ordered feed. Older servers fall back
    // to filtering the general trade/audit feed for compatibility.
    const trades = Array.isArray(data?.trades) ? data.trades : [];
    const dedicatedClosed = Array.isArray(data?.closedTrades) ? data.closedTrades : [];
    // An empty dedicated feed must not mask closed records in the general feed.
    const closed = (dedicatedClosed.length
      ? [...dedicatedClosed]
      : trades.filter(t => String(t?.status || "").trim().toUpperCase().startsWith("CLOSED") || Boolean(t?.closedAt)))
      .sort((a, b) => {
        const stamp = t => {
          const value = first(t?.closedAt, t?.closed_at, t?.openedAt, t?.createdAt, t?.created_at);
          const parsed = value == null ? NaN : Date.parse(value);
          return Number.isFinite(parsed) ? parsed : (Number.isFinite(Number(value)) ? Number(value) : 0);
        };
        return stamp(b) - stamp(a);
      });
    if (!closed.length) {
      if (summary) summary.textContent = Number(data?.closedTradeCount || 0) + " CLOSED TRADES · HISTORY LOADED";
      body.innerHTML = '<div class="empty">No closed trades yet.</div>';
      return;
    }

    const toNumber = value => {
      if (value === null || value === undefined || value === "") return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    const realizedValues = closed.map(t => toNumber(t.profit)).filter(v => v !== null);
    const pendingPnl = closed.length - realizedValues.length;
    const netPnl = realizedValues.reduce((sum, value) => sum + value, 0);
    if (summary) {
      const netLabel = realizedValues.length ? " · NET " + (netPnl > 0 ? "+" : "") + number(netPnl, 2) : "";
      const pendingLabel = pendingPnl ? " · " + pendingPnl + " P/L PENDING" : "";
      const total = Math.max(closed.length, Number(data?.closedTradeCount || 0));
      const countLabel = total > closed.length ? closed.length + " SHOWN / " + total + " TOTAL CLOSED TRADES" : total + " CLOSED TRADES";
      summary.textContent = countLabel + netLabel + pendingLabel;
    }

    const cell = value => '<td>' + escapeHTML(value == null || value === "" ? "—" : String(value)) + '</td>';
    const priceCell = (value, digits) => {
      const n = toNumber(value);
      return n !== null && n > 0 ? number(n, digits) : "—";
    };
    body.innerHTML =
      '<div class="closed-trade-table-wrap" role="region" aria-label="Closed trade history table" tabindex="0">' +
      '<table class="closed-trade-table"><thead><tr>' +
      '<th scope="col">TIME</th><th scope="col">SIDE / SYMBOL</th><th scope="col">ENTRY</th>' +
      '<th scope="col">SL (RECORDED)</th><th scope="col">TP (RECORDED)</th><th scope="col">EXIT</th>' +
      '<th scope="col">STATUS</th><th scope="col">RESULT</th><th scope="col">EXIT REASON</th><th scope="col">P/L</th>' +
      '</tr></thead><tbody>' +
      closed.map(t => {
        const direction = String(t.direction || "—").toUpperCase();
        const tradeSymbol = String(first(t.symbol, t.symbolName, "UNKNOWN")).toUpperCase();
        const digits = priceDigits(tradeSymbol);
        const entry = first(t.executionEntryPrice, t.plannedEntryPrice, t.signalEntryPrice);
        const sl = first(t.plannedStopPrice, t.stopLoss);
        const tp = first(t.plannedTakeProfitPrice, t.takeProfit);
        const exit = t.closePrice;
        const pnl = toNumber(t.profit);
        const result = pnl === null ? "P/L PENDING" : pnl > 0 ? "PROFIT" : pnl < 0 ? "LOSS" : "BREAKEVEN";
        const pnlClass = pnl === null ? "pnl-pending" : pnl > 0 ? "pnl-positive" : pnl < 0 ? "pnl-negative" : "pnl-flat";
        const time = formatTime(t.closedAt || t.openedAt || t.createdAt);
        const pnlLabel = pnl === null ? "PENDING" : (pnl > 0 ? "+" : "") + number(pnl, 2);
        return '<tr data-finished-trade-id="' + escapeHTML(String(t.id || "")) + '" tabindex="0" role="button" aria-label="Investigate finished trade ' + escapeHTML(String(t.id || "")) + '">' +
          cell(time) +
          '<td><strong class="' + (direction === "BUY" ? "history-buy" : direction === "SELL" ? "history-sell" : "") + '">' + escapeHTML(direction + " · " + tradeSymbol) + '</strong></td>' +
          cell(priceCell(entry, digits)) +
          cell(priceCell(sl, digits)) +
          cell(priceCell(tp, digits)) +
          cell(priceCell(exit, digits)) +
          cell("CLOSED") +
          '<td class="' + pnlClass + '">' + escapeHTML(result) + '</td>' +
          cell(first(t.exitReason, t.gateReason, "—")) +
          '<td class="' + pnlClass + '">' + escapeHTML(pnlLabel) + '</td>' +
        '</tr>';
      }).join("") +
      '</tbody></table></div>';
  }

  function updateFrontendFreshness(responses) {
    const el = $("frontendDataFreshness");
    if (!el) return;
    const positionFeedFresh = lastPositionRefresh > 0 && Date.now() - lastPositionRefresh < 10000;
    const healthy = positionFeedFresh && responses.every(value => value !== null && value !== undefined && value?.ok !== false);
    el.textContent = healthy
      ? "API DATA UPDATED · " + new Date().toLocaleTimeString()
      : "DATA PARTIAL / STALE · ONE OR MORE API REQUESTS FAILED";
    el.classList.toggle("is-stale", !healthy);
    el.classList.toggle("is-fresh", healthy);
  }

  function renderMarketQuality(report) {
    const summary = $("marketQualitySummary");
    const grid = $("marketQualityGrid");
    if (!summary || !grid) return;
    if (!report || report.ok !== true || !Array.isArray(report.markets)) {
      summary.textContent = "DATA QUALITY REPORT UNAVAILABLE · NO PASS STATUS ASSUMED";
      summary.classList.add("is-stale");
      grid.innerHTML = '<div class="empty-state">Market-data diagnostics unavailable. Check the API and cTrader feed.</div>';
      return;
    }
    const ready = report.markets.filter(m => m.ready).length;
    const blocked = report.markets.length - ready;
    summary.textContent = "OBSERVE ONLY · " + ready + " READY · " + blocked + " NEED ATTENTION · UPDATED " + new Date(report.generatedAt || Date.now()).toLocaleTimeString();
    summary.classList.toggle("is-stale", blocked > 0);
    summary.classList.toggle("is-fresh", blocked === 0 && report.markets.length > 0);
    grid.innerHTML = report.markets.map(m => {
      const reasons = Array.isArray(m.reasons) ? m.reasons : [];
      const symbol = String(m.symbol || "UNKNOWN");
      const quote = m.quote || {};
      const candles = m.candles || {};
      const state = m.ready ? "DATA CHECKS PASS" : "DATA NEEDS ATTENTION";
      const detail = reasons.length ? reasons.join(" · ") : "No data-integrity issues detected";
      return '<article class="multi-symbol-card ' + (m.ready ? "is-ready" : "is-blocked") + '">' +
        '<div class="multi-symbol-card-head"><strong>' + escapeHTML(symbol) + '</strong><span>' + escapeHTML(state) + '</span></div>' +
        '<div class="multi-symbol-card-meta">BID ' + escapeHTML(priceNumber(m.bid, priceDigits(symbol))) +
        ' · ASK ' + escapeHTML(priceNumber(m.ask, priceDigits(symbol))) +
        ' · SPREAD ' + escapeHTML(m.spread == null ? "—" : number(m.spread, priceDigits(symbol))) + '</div>' +
        '<div class="multi-symbol-card-meta">QUOTE ' + (quote.fresh ? "FRESH" : "STALE / UNKNOWN") +
        ' · M5 ' + escapeHTML(String(candles.valid ?? 0)) + '/' + escapeHTML(String(candles.required ?? 50)) +
        ' · GAPS ' + escapeHTML(String(candles.detectedGaps ?? 0)) + '</div>' +
        '<div class="multi-symbol-card-reason">' + escapeHTML(detail) + '</div>' +
        '</article>';
    }).join("") || '<div class="empty-state">No broker-discovered supported markets are available yet.</div>';
  }

  async function refreshMarketQuality() {
    const report = await getJSON(API.marketQuality);
    renderMarketQuality(report);
  }

  async function refresh() {
    if (fullRefreshBusy) return;
    fullRefreshBusy = true;
    try {
    const [
      market,
      marketState,
      ctrader,
      autoStatus,
      aiDecision,
      aiHistory,
      aiSignals,
      autoTrades,
      performance,
      account,
    ] = await Promise.all([
      getJSON(API.market),
      getJSON(API.marketState),
      getJSON(API.ctrader),
      getJSON(API.autoStatus),
      getJSON(API.aiDecision),
      getJSON(API.aiHistory + "?limit=20"),
      getJSON(API.aiSignals + "?limit=100"),
      getJSON(API.autoTrades),
      getJSON(API.performance),
      getJSON(API.account)
    ]);

    const autoPositions = latestPositions;
    const mergedMarket = {
      ...(marketState || {}),
      ...(market || {})
    };

    updateConnection(ctrader);
    updateMarket(mergedMarket, ctrader);
    updateMarketSession(mergedMarket, ctrader);

    const liveAi = aiDecision?.decision || aiDecision?.result || aiDecision || {};
    updateSignal(liveAi);
    updateAutoTrader(autoStatus, autoPositions);
    updateAccountPanel(account, autoStatus, ctrader);
    updateFinalTradeGate(mergedMarket, null, liveAi, autoPositions);
    updateActivity(liveAi, ctrader, autoStatus, autoPositions);
    // The live multi-symbol candidate widget owns the candidate panel; avoid overwriting it with the chart-selected symbol.
    if (aiSignals && aiSignals.ok !== false) {
      renderConfirmedSignalHistory(aiSignals, autoTrades?.trades || []);
    } else {
      text("confirmedSignalHistorySummary", "SIGNAL HISTORY UNAVAILABLE");
      const signalBody = $("confirmedSignalHistory");
      if (signalBody) signalBody.innerHTML = '<div class="empty">Signal history API unavailable. Existing signal records cannot be verified right now.</div>';
    }
    if (autoTrades && autoTrades.ok !== false) {
      renderClosedTradeHistory(autoTrades);
    } else {
      text("closedTradeHistorySummary", "HISTORY UNAVAILABLE");
      const tradeBody = $("closedTradeHistory");
      if (tradeBody) tradeBody.innerHTML = '<div class="empty">Closed-trade history API unavailable. No result is being assumed.</div>';
    }
    // Performance is a separate live endpoint. Do not erase a successful
    // performance response merely because the detailed history endpoint failed.
    updatePerformance(autoTrades || {}, performance);

    const aiSignal = String(first(liveAi.signal, liveAi.direction, "WAIT")).toUpperCase();
    const blocked = Array.isArray(liveAi.blockedBy) ? liveAi.blockedBy : [];
    text("engineStatus",
      liveAi.executionEligible === true
        ? "TRADE READY · " + aiSignal
        : liveAi.candleCount < 50
          ? "WAITING FOR 50+ CANDLES"
          : blocked.length
            ? "AI ACTIVE · " + aiSignal + " · BLOCKED"
            : "AI ACTIVE · " + aiSignal
    );

    const system = await getJSON(API.system);
    updateFrontendFreshness([market, marketState, ctrader, autoStatus, aiDecision, aiHistory, aiSignals, autoTrades, account, system]);

    if (system) {
      const online =
        system.online !== false &&
        system.status !== "offline";

      text(
        "systemStatus",
        online ? "SYSTEM ONLINE" : "SYSTEM OFFLINE"
      );
    }

    text(
      "lastRefresh",
      new Date().toLocaleTimeString()
    );
    } finally {
      fullRefreshBusy = false;
    }
  }

  let openTradesRefreshBusy = false;

  async function refreshOpenTrades() {
    if (openTradesRefreshBusy) return;
    openTradesRefreshBusy = true;

    try {
      const live = await getJSON(API.autoPositions);
      if (live?.ok === true) {
        latestPositions = live;
        lastPositionRefresh = Date.now();
        // This fast poll owns only the broker position list. Authorization,
        // connection and auto-trading state must come from real status APIs.
        renderOpenTrades(live);
        const freshness = $("frontendDataFreshness");
        if (freshness && !freshness.classList.contains("is-stale")) {
          freshness.textContent = "API + POSITION DATA UPDATED · " + new Date().toLocaleTimeString();
        }
      } else {
        const updated = $("openTradesUpdated");
        if (updated) updated.textContent = "POSITION FEED STALE / UNAVAILABLE · LAST SUCCESS " + (lastPositionRefresh ? new Date(lastPositionRefresh).toLocaleTimeString() : "NONE");
        const freshness = $("frontendDataFreshness");
        if (freshness) {
          freshness.textContent = "DATA PARTIAL / STALE · POSITION API FAILED";
          freshness.classList.add("is-stale");
          freshness.classList.remove("is-fresh");
        }
      }
    } finally {
      openTradesRefreshBusy = false;
    }
  }

  async function refreshLiveChart() {
    try {
      const market = await getJSON(API.market);
      if (!market) return;

      const liveCandles = Array.isArray(market.candles) ? market.candles : [];

      // Prefer the live market-engine candles. If the live engine has not
      // populated its in-memory history yet, fall back to the persisted
      // cTrader M5 history endpoint so the chart never remains blank.
      if (liveCandles.length >= 2) {
        updateMarket(market, null);
        return;
      }

      const history = await getJSON(API.marketHistory);
      const historyCandles =
        Array.isArray(history?.candles) ? history.candles : [];

      updateMarket(
        historyCandles.length >= 2
          ? { ...market, candles: historyCandles }
          : market,
        null
      );
    } catch (error) {
      console.error("AURIXA live chart refresh:", error);
    }
  }

  function start() {
    wireSignalInvestigation();
    const closedHistory = $("closedTradeHistory");
    if (closedHistory && !closedHistory.dataset.finishedTradeInvestigationWired) {
      closedHistory.dataset.finishedTradeInvestigationWired = "true";
      const openFromRow = event => {
        const row = event.target.closest("[data-finished-trade-id]");
        if (row && row.dataset.finishedTradeId) openFinishedTradeInvestigation(row.dataset.finishedTradeId);
      };
      closedHistory.addEventListener("click", openFromRow);
      closedHistory.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          const row = event.target.closest("[data-finished-trade-id]");
          if (row && row.dataset.finishedTradeId) {
            event.preventDefault();
            openFinishedTradeInvestigation(row.dataset.finishedTradeId);
          }
        }
      });
    }
    const connectButton =
      $("loginBtn") ||
      $("connectCtrader");

    if (connectButton) {
      connectButton.addEventListener("click", () => {
        window.location.href = "/auth/login";
      });
    }

    refresh();
    refreshOpenTrades();
    refreshMarketQuality();

    // OPEN TRADES is a dedicated live broker-position feed.
    // Poll every 2 seconds so entry/current/P&L/SL/TP stay synchronized
    // without waiting for the slower full dashboard refresh.
    setInterval(refreshMarketQuality, 10000);
    setInterval(refreshOpenTrades, 2000);
    setInterval(refreshLiveChart, 2000);
    setInterval(refresh, 5000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();