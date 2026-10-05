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
    signal: "/api/signal",
    signals: "/api/signals",
    history: "/api/signals/history",
    stats: "/api/signals/stats",
    tracking: "/api/signal-tracking",
    trackingStats: "/api/signals/stats",
    trackingHistory: "/api/signals/history",
    market: "/api/market",
    marketState: "/api/market/state",
    system: "/api/system/state",
    ctrader: "/api/ctrader/status",
    autoStatus: "/api/auto-trader/status",
    autoPositions: "/api/auto-trader/positions",
    autoTrades: "/api/auto-trader/trades",
    openingRange: "/api/strategies/or-fvg",
    marketHistory: "/api/market/history?limit=300"
  };

  let chart = null;
  let selectedSymbol = "XAUUSD";

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

      const json = await r.json();
      console.log("AURIXA API RESPONSE:", url, json);
      return json;
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

  function number(v, digits = 2) {
    const n = Number(v);

    if (!Number.isFinite(n)) return "—";

    return n.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
  }

  function percent(v) {
    const n = Number(v);

    if (!Number.isFinite(n)) return "—";

    return `${number(n, 1)}%`;
  }

  function text(id, value) {
    const el = $(id);

    if (el) el.textContent = value ?? "—";
  }

  function setSignal(signal) {
    const value = String(signal || "WAIT").toUpperCase();

    const el = $("signal");
    if (el) {
      el.textContent = value;
      el.classList.remove("buy", "sell", "wait");

      if (value === "BUY") el.classList.add("buy");
      else if (value === "SELL") el.classList.add("sell");
      else el.classList.add("wait");
    }

    // Keep the three direction indicators synchronized with the
    // single active signal. They are status indicators, not
    // simultaneous signals.
    ["buyIndicator", "waitIndicator", "sellIndicator"].forEach((id) => {
      const option = $(id);
      if (option) option.classList.remove("active");
    });

    const activeId =
      value === "BUY" ? "buyIndicator" :
      value === "SELL" ? "sellIndicator" :
      "waitIndicator";

    const active = $(activeId);
    if (active) active.classList.add("active");
  }

  function updateConnection(status) {
    if (!status) return;

    const liveSymbol = first(status.symbol, status.symbolName, selectedSymbol, "XAUUSD");
    selectedSymbol = String(liveSymbol).toUpperCase();
    text("instrument", selectedSymbol);
    text("chartTitle", selectedSymbol + " / 5 MINUTE");

    const selector = $("pairSelector");
    if (selector && selector.value !== selectedSymbol) selector.value = selectedSymbol;

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

    text("price", number(price, 2));
    text("bid", number(bid, 2));
    text("ask", number(ask, 2));

    if (Number.isFinite(Number(bid)) && Number.isFinite(Number(ask))) {
      text("spread", number(Number(ask) - Number(bid), 2));
    }

    const marketSymbol = String(
      first(
        ctrader?.symbol,
        market.symbol,
        market.symbolName,
        selectedSymbol,
        "XAUUSD"
      )
    ).toUpperCase();

    selectedSymbol = marketSymbol;
    text("instrument", marketSymbol);
    text("chartTitle", marketSymbol + " / 5 MINUTE");

    const selector = $("pairSelector");
    if (selector && selector.value !== marketSymbol) {
      selector.value = marketSymbol;
    }

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

  function updateSignal(data) {
    if (!data) return;

    const s =
      data.signal ||
      data.currentSignal ||
      data.prediction ||
      data;

    const direction = first(
      s.direction,
      s.signal,
      s.action,
      data.direction,
      "WAIT"
    );

    setSignal(direction);

    text(
      "confidence",
      Number.isFinite(Number(first(
        s.confidence,
        data.confidence
      )))
        ? `${number(first(s.confidence, data.confidence), 0)}%`
        : "—"
    );

    text(
      "reason",
      first(
        s.reason,
        s.marketReason,
        s.explanation,
        data.reason,
        "Waiting for stronger confirmation"
      )
    );

    text(
      "signalEntry",
      number(first(
        s.entryPrice,
        s.price,
        data.entryPrice
      ), 2)
    );

    text(
      "signalTime",
      formatTime(first(
        s.timestamp,
        s.createdAt,
        data.timestamp
      ))
    );
  }

  function updateCommandCenter(signal, autoStatus, ctrader) {
    const s = signal || {};
    const direction = String(first(s.direction, s.signal, "WAIT")).toUpperCase();
    const confidence = first(s.confidence);
    text("dashSignal", direction);
    text("dashConfidence", confidence === undefined || confidence === null ? "—" : String(number(confidence, 0)) + "%");

    if (autoStatus) {
      const enabled = autoStatus.enabled === true;
      const demo = autoStatus.demoOnly === true && autoStatus.demoAccount === true;
      const connected = autoStatus.connected === true && autoStatus.authorized === true;
      const state = autoStatus.blocked === true ? "BLOCKED" : (enabled && demo && connected ? "READY" : (enabled ? "WAITING" : "OFF"));
      text("dashAutoStatus", state);
      text("dashAutoMode", demo ? "DEMO ONLY" : "GUARDED");
      text("dashRisk", autoStatus.blocked === true ? "BLOCKED" : "ACTIVE");
      text("dashRiskDetail", "MAX " + String(first(autoStatus.maxPositions, 1)) + " POSITION");
    }

    if (ctrader) {
      const connected = ctrader.connected === true && ctrader.authorized === true;
      text("dashConnection", connected ? "CONNECTED" : "OFFLINE");
      text("dashAccount", first(ctrader.accountId, "—"));
    }

    text("dashRefresh", new Date().toLocaleTimeString());
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

  function updateFinalTradeGate(marketState, prediction, orFvg, positions) {
    const marketOpen = String(first(marketState?.marketStatus, "")).toUpperCase() === "MARKET_OPEN";
    const direction = String(first(prediction?.direction, prediction?.signal, "WAIT")).toUpperCase();
    const fvgDirection = String(first(orFvg?.signal, "WAIT")).toUpperCase();
    const triggered = String(first(orFvg?.phase, "")).toUpperCase() === "TRIGGERED";
    const hasPosition = Number(first(positions?.count, 0)) > 0;
    const ready = marketOpen && direction !== "WAIT" && direction === fvgDirection && triggered && !hasPosition;

    text("gateMarket", marketOpen ? "OPEN" : "BLOCKED");
    text("gateSignal", direction);
    text("gateFvg", triggered ? fvgDirection : String(first(orFvg?.phase, "WAIT")).replaceAll("_", " "));
    text("gatePosition", hasPosition ? "OPEN" : "FLAT");
    text("gateEntry", number(orFvg?.entryPrice, 2));
    text("gateSL", number(orFvg?.stopLoss, 2));
    text("gateTP", number(orFvg?.takeProfit, 2));
    text("gateRR", orFvg?.rewardRisk ? number(orFvg.rewardRisk, 1) + "R" : "2R PLAN");

    const decision = $("gateDecision");
    if (decision) {
      decision.classList.remove("buy", "sell", "wait");
      decision.classList.add(ready ? direction.toLowerCase() : "wait");
      decision.textContent = ready ? "TRADE " + direction : "WAIT";
    }

    let reason = "Waiting for confirmation.";
    if (!marketOpen) reason = "Market/feed is not open. No trade.";
    else if (hasPosition) reason = "One XAUUSD position is already open.";
    else if (direction === "WAIT") reason = "AURIXA M5 has no confirmed direction.";
    else if (!triggered) reason = "Waiting for opening-range breakout + FVG retest + engulfing.";
    else if (direction !== fvgDirection) reason = "M5 direction and OR/FVG direction disagree.";
    else if (ready) reason = direction + " confirmed by both strategy layers.";
    text("gateReason", reason);
  }

  function updateAutoTrader(status, positions, trades) {
    if (!status) return;
    const enabled = status.enabled === true;
    const demo = status.demoAccount === true && status.demoOnly === true;
    const connected = status.connected === true && status.authorized === true;
    const blocked = status.blocked === true;
    const state = blocked ? "BLOCKED" : (enabled && demo && connected ? "READY" : (enabled ? "WAITING" : "OFF"));

    text("autoTradeStatus", state);
    text("autoTradeMode", demo ? "DEMO ONLY" : "GUARDED");
    text("autoTradePosition", positions?.count ? "OPEN" : "FLAT");

    const rows = Array.isArray(trades?.trades) ? trades.trades : [];
    const latest = rows[0];
    text("autoTradeLastAction", latest ? String(first(latest.status, latest.direction, "—")).toUpperCase() : "—");

    const list = Array.isArray(positions?.positions) ? positions.positions : [];
    const p = list[0];

    if (!p) {
      text("autoPositionDirection", "FLAT");
      text("autoPositionEntry", "—");
      text("autoPositionCurrent", "—");
      text("autoPositionVolume", "—");
      text("autoPositionSL", "—");
      text("autoPositionPnl", "—");
      text("autoTradeNotice", state === "READY" ? "Demo auto-trader is armed. No XAUUSD position is open." : state);
    } else {
      const side = Number(p?.tradeData?.tradeSide) === 1 ? "BUY" : Number(p?.tradeData?.tradeSide) === 2 ? "SELL" : first(p.direction, "—");
      const entry = first(p?.tradeData?.openPrice, p?.tradeData?.price, p?.price, p?.entryPrice);
      const current = first(p?.currentPrice, p?.tradeData?.currentPrice, p?.price);
      const volume = first(p?.tradeData?.volume, p?.volume);
      const sl = first(p?.tradeData?.stopLoss, p?.stopLoss);
      const pnl = first(p?.unrealizedNetProfit, p?.tradeData?.unrealizedNetProfit, p?.netProfit, p?.profit);
      text("autoPositionDirection", side);
      text("autoPositionEntry", number(entry, 2));
      text("autoPositionCurrent", number(current, 2));
      text("autoPositionVolume", volume ?? "—");
      text("autoPositionSL", number(sl, 2));
      text("autoPositionPnl", number(pnl, 2));
      text("autoTradeNotice", "Demo XAUUSD position is open.");
    }

    const history = $("autoTradeHistory");
    if (!history) return;
    if (!rows.length) {
      history.innerHTML = '<div class="empty-state">No demo trades recorded yet.</div>';
      return;
    }
    history.innerHTML = rows.slice(0, 10).map((t) => {
      const direction = String(first(t.direction, "—")).toUpperCase();
      const statusText = String(first(t.status, "—")).toUpperCase();
      const profit = first(t.profit);
      return '<div class="auto-trade-row">' +
        '<div><strong class="' + direction.toLowerCase() + '">' + escapeHTML(direction) + '</strong><span>' + escapeHTML(number(first(t.signalEntryPrice), 2)) + '</span></div>' +
        '<div><small>' + escapeHTML(formatTime(first(t.createdAt, t.openedAt))) + '</small></div>' +
        '<div><span class="trade-status">' + escapeHTML(statusText) + '</span><span>' + (profit === null || profit === undefined ? "P&L —" : "P&L " + escapeHTML(number(profit, 2))) + '</span></div>' +
      '</div>';
    }).join("");
  }

  function updateTrackingStats(data) {
    if (!data) return;

    const s =
      data.stats ||
      data.tracking ||
      data.data ||
      data;

    text(
      "totalSignals",
      first(
        s.totalSignals,
        s.total,
        s.count,
        "—"
      )
    );

    text(
      "success5m",
      percent(first(
        s.success5m,
        s.success_5m,
        s["5m"],
        s["5mSuccess"],
        s.winRate5m
      ))
    );

    text(
      "success15m",
      percent(first(
        s.success15m,
        s.success_15m,
        s["15m"],
        s["15mSuccess"],
        s.winRate15m
      ))
    );

    text(
      "success30m",
      percent(first(
        s.success30m,
        s.success_30m,
        s["30m"],
        s["30mSuccess"],
        s.winRate30m
      ))
    );

    text(
      "wins",
      first(s.wins, s.totalWins, "—")
    );

    text(
      "losses",
      first(s.losses, s.totalLosses, "—")
    );

    text(
      "neutral",
      first(s.neutral, s.draws, s.unchanged, "—")
    );
  }

  function updateHistory(data) {
    const container = $("signalHistory");

    if (!container) return;

    let rows = [];

    if (Array.isArray(data)) {
      rows = data;
    } else if (Array.isArray(data?.signals)) {
      rows = data.signals;
    } else if (Array.isArray(data?.history)) {
      rows = data.history;
    } else if (Array.isArray(data?.data)) {
      rows = data.data;
    }

    if (!rows.length) {
      container.innerHTML =
        '<div class="empty-state">No tracked signals yet.</div>';
      return;
    }

    container.innerHTML = rows
      .slice(0, 30)
      .map((s) => {
        const direction = String(
          first(
            s.direction,
            s.signal,
            s.action,
            "WAIT"
          )
        ).toUpperCase();

        const result5 = first(
          s.result5m,
          s.evaluation5m,
          s["5m"],
          s.success5m
        );

        const result15 = first(
          s.result15m,
          s.evaluation15m,
          s["15m"],
          s.success15m
        );

        const result30 = first(
          s.result30m,
          s.evaluation30m,
          s["30m"],
          s.success30m
        );

        return `
          <div class="signal-row">
            <div>
              <strong class="${direction.toLowerCase()}">
                ${escapeHTML(direction)}
              </strong>
              <span>
                ${number(first(s.entryPrice, s.price), 2)}
              </span>
            </div>

            <div>
              <small>${escapeHTML(formatTime(
                first(s.timestamp, s.createdAt, s.time)
              ))}</small>
            </div>

            <div class="evaluation">
              <span>5M: ${escapeHTML(displayResult(result5))}</span>
              <span>15M: ${escapeHTML(displayResult(result15))}</span>
              <span>30M: ${escapeHTML(displayResult(result30))}</span>
            </div>
          </div>
        `;
      })
      .join("");
  }

  function displayResult(v) {
    if (v === undefined || v === null || v === "") {
      return "—";
    }

    if (typeof v === "boolean") {
      return v ? "WIN" : "LOSS";
    }

    if (typeof v === "number") {
      return v > 0 ? "WIN" : v < 0 ? "LOSS" : "NEUTRAL";
    }

    const value = String(v).toUpperCase();

    if (
      value.includes("WIN") ||
      value.includes("SUCCESS") ||
      value === "TRUE"
    ) {
      return "WIN";
    }

    if (
      value.includes("LOSS") ||
      value.includes("FAIL") ||
      value === "FALSE"
    ) {
      return "LOSS";
    }

    return value;
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
    const canvas = $("marketChart");
    if (!canvas || !Array.isArray(candles)) return;

    const latest = candles.slice(-100);
    const values = latest.map((c) => Number(first(c.close, c.price, c.mid)));
    const valid = values.filter(Number.isFinite);
    if (valid.length < 2) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(320, Math.floor(rect.width || canvas.clientWidth || 640));
    const height = Math.max(260, Math.floor(rect.height || canvas.clientHeight || 320));
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const min = Math.min(...valid);
    const max = Math.max(...valid);
    const range = Math.max(max - min, 0.01);
    const pad = { left: 12, right: 12, top: 18, bottom: 28 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#e5e7eb";

    let plotted = 0;
    values.forEach((value, i) => {
      if (!Number.isFinite(value)) return;
      const x = pad.left + (i / Math.max(values.length - 1, 1)) * plotW;
      const y = pad.top + (1 - (value - min) / range) * plotH;
      if (plotted === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      plotted++;
    });
    ctx.stroke();

    ctx.fillStyle = "#9ca3af";
    ctx.font = "12px Arial, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(number(max, 2), pad.left, 13);
    ctx.textAlign = "right";
    ctx.fillText(number(min, 2), width - pad.right, height - 6);

    const last = valid[valid.length - 1];
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 13px Arial, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(number(last, 2), width - pad.right, 13);

    text("candleCount", String(latest.length));
    const latestCandle = latest[latest.length - 1];
    text("latestCandle", formatTime(first(
      latestCandle?.time,
      latestCandle?.timestamp,
      latestCandle?.openTime
    )));
  }


async function loadPairSelector() {
  const selector =
    document.getElementById(
      "pairSelector"
    );

  if (!selector) return;

  try {
    const response =
      await fetch(
        "/api/ctrader/symbols",
        {
          cache: "no-store"
        }
      );

    if (!response.ok) return;

    const data =
      await response.json();

    const apiSymbols =
      Array.isArray(data.symbols)
        ? data.symbols.filter(s => s && s.symbolName)
        : [];

    const knownSymbols = [
      { symbolName: "XAUUSD" },
      { symbolName: "BITCOIN" },
      { symbolName: "BITCOINCASH" },
      { symbolName: "XAUUSDgr" }
    ];

    const seen = new Set();
    const symbols = [...apiSymbols, ...knownSymbols].filter((s) => {
      const name = String(s.symbolName || "").toUpperCase();
      if (!name || seen.has(name)) return false;
      seen.add(name);
      return true;
    });

    selector.innerHTML = "";

    for (const symbol of symbols) {
      const option =
        document.createElement(
          "option"
        );

      option.value =
        symbol.symbolName;

      option.textContent =
        symbol.symbolName;

      if (
        String(
          symbol.symbolName
        ).toUpperCase() ===
        String(
          data.selected || ""
        ).toUpperCase()
      ) {
        option.selected = true;
      }

      selector.appendChild(
        option
      );
    }

  } catch (err) {
    console.error(
      "AURIXA pair list:",
      err
    );
  }
}

async function selectPair(symbol) {
  try {
    const response =
      await fetch(
        "/api/ctrader/select-symbol",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json"
          },
          body:
            JSON.stringify({
              symbol
            })
        }
      );

    const data =
      await response.json();

    if (
      !response.ok ||
      !data.ok
    ) {
      throw new Error(
        data.error ||
        "Pair selection failed"
      );
    }

    selectedSymbol = String(
      data.selected || symbol || "XAUUSD"
    ).toUpperCase();

    if (chart) {
      chart.destroy();
      chart = null;
    }

    text("instrument", selectedSymbol);
    text("chartTitle", selectedSymbol + " / 5 MINUTE");
    text("price", "—");
    text("bid", "—");
    text("ask", "—");
    text("spread", "—");
    text("candleCount", "—");
    text("latestCandle", "—");
    text("engineStatus", "LOADING " + selectedSymbol);

    const selector = $("pairSelector");
    if (selector) selector.value = selectedSymbol;

    console.log(
      "AURIXA selected:",
      selectedSymbol,
      "symbolId:",
      data.symbolId
    );

    await refresh();

  } catch (err) {
    console.error(
      "AURIXA pair selection:",
      err
    );

    alert(
      err.message ||
      "Unable to select pair"
    );
  }
}

async function refresh() {
    const [
      market,
      marketState,
      signal,
      stats,
      trackingStats,
      history,
      trackingHistory,
      ctrader,
      autoStatus,
      autoPositions,
      autoTrades,
      openingRange
    ] = await Promise.all([
      getJSON(API.market),
      getJSON(API.marketState),
      getJSON(API.signal),
      getJSON(API.stats),
      getJSON(API.trackingStats),
      getJSON(API.history),
      getJSON(API.trackingHistory),
      getJSON(API.ctrader),
      getJSON(API.autoStatus),
      getJSON(API.autoPositions),
      getJSON(API.autoTrades),
      getJSON(API.openingRange)
    ]);

    const mergedMarket = {
      ...(marketState || {}),
      ...(market || {})
    };

    updateMarket(mergedMarket, ctrader);
    updateMarketSession(mergedMarket, ctrader);

    // =========================================================
    // LIVE PREDICTION V2
    // /api/market/state is the ONLY authoritative source.
    // Never fall back to /api/signal or old cached prediction data.
    // =========================================================
    const livePrediction = marketState?.prediction || null;

    console.log("AURIXA MARKET STATE:", marketState);
    console.log("AURIXA LIVE PREDICTION V2:", livePrediction);

    if (livePrediction) {
      updateSignal(livePrediction);

      text(
        "engineStatus",
        livePrediction.dataReady === false ? "WAITING FOR DATA" : "LIVE"
      );
    } else {
      setSignal("WAIT");

      text("confidence", "0%");
      text(
        "reason",
        "Live prediction unavailable from /api/market/state"
      );
      text("signalEntry", "—");
      text("signalTime", new Date().toLocaleTimeString());
      text("engineStatus", "NO LIVE DATA");
    }

    updateTrackingStats(
      stats
    );

    updateHistory(
      history
    );

    if (ctrader) {
      updateConnection(ctrader);
    }

    updateCommandCenter(livePrediction, autoStatus, ctrader);
    updateAutoTrader(autoStatus, autoPositions, autoTrades);
    updateFinalTradeGate(mergedMarket, livePrediction, openingRange?.result || openingRange, autoPositions);

    const system = await getJSON(API.system);

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
    loadPairSelector();

    const selector = $("pairSelector");

    if (selector) {
      selector.addEventListener("change", () => {
        selectPair(selector.value);
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

    // Fast chart-only polling keeps the visible market line current
    // without running the full dashboard refresh every second.
    setInterval(refreshLiveChart, 2000);
    setInterval(refresh, 5000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();

/* ============================================================
   AURIXA SIGNAL TRACKING V1 DASHBOARD
   Frontend only.
   Uses the existing real API:
     /api/signals/stats
     /api/signals/history
   Does NOT modify trading logic.
   ============================================================ */

(function initAurixaSignalTrackingV1() {
  "use strict";

  const STATS_URL = "/api/signals/stats";
  const HISTORY_URL = "/api/signals/history";

  function esc(value) {
    return String(value ?? "—")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function numberValue(value) {
    if (value === null || value === undefined || value === "") return "—";
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString() : esc(value);
  }

  function percentValue(value) {
    if (value === null || value === undefined || value === "") return "—";
    const n = Number(value);
    return Number.isFinite(n) ? `${n.toFixed(2)}%` : esc(value);
  }

  function horizon(data, key) {
    return (
      data?.horizons?.[key] ||
      data?.horizons?.[String(key)] ||
      {}
    );
  }

  function ensureTrackingPanel() {
    let panel = document.getElementById("aurixaTrackingV1");

    if (panel) return panel;

    panel = document.createElement("section");
    panel.id = "aurixaTrackingV1";
    panel.className = "tracking-v1";

    panel.innerHTML = `
      <div class="card tracking-card">
        <div class="section-title">
          AURIXA SIGNAL TRACKING V1
        </div>

        <div class="tracking-v1-grid">

          <div class="tracking-horizon">
            <div class="tracking-horizon-title">5 MINUTES</div>
            <div id="tracking5Rate" class="tracking-rate">—</div>
            <div class="tracking-rate-label">WIN RATE</div>

            <div class="tracking-mini-grid">
              <div class="tracking-mini">
                <div id="tracking5Eval" class="tracking-mini-value">—</div>
                <div class="tracking-mini-label">EVALUATED</div>
              </div>
              <div class="tracking-mini">
                <div id="tracking5Wins" class="tracking-mini-value">—</div>
                <div class="tracking-mini-label">WINS</div>
              </div>
              <div class="tracking-mini">
                <div id="tracking5Losses" class="tracking-mini-value">—</div>
                <div class="tracking-mini-label">LOSSES</div>
              </div>
            </div>
          </div>

          <div class="tracking-horizon">
            <div class="tracking-horizon-title">15 MINUTES</div>
            <div id="tracking15Rate" class="tracking-rate">—</div>
            <div class="tracking-rate-label">WIN RATE</div>

            <div class="tracking-mini-grid">
              <div class="tracking-mini">
                <div id="tracking15Eval" class="tracking-mini-value">—</div>
                <div class="tracking-mini-label">EVALUATED</div>
              </div>
              <div class="tracking-mini">
                <div id="tracking15Wins" class="tracking-mini-value">—</div>
                <div class="tracking-mini-label">WINS</div>
              </div>
              <div class="tracking-mini">
                <div id="tracking15Losses" class="tracking-mini-value">—</div>
                <div class="tracking-mini-label">LOSSES</div>
              </div>
            </div>
          </div>

          <div class="tracking-horizon">
            <div class="tracking-horizon-title">30 MINUTES</div>
            <div id="tracking30Rate" class="tracking-rate">—</div>
            <div class="tracking-rate-label">WIN RATE</div>

            <div class="tracking-mini-grid">
              <div class="tracking-mini">
                <div id="tracking30Eval" class="tracking-mini-value">—</div>
                <div class="tracking-mini-label">EVALUATED</div>
              </div>
              <div class="tracking-mini">
                <div id="tracking30Wins" class="tracking-mini-value">—</div>
                <div class="tracking-mini-label">WINS</div>
              </div>
              <div class="tracking-mini">
                <div id="tracking30Losses" class="tracking-mini-value">—</div>
                <div class="tracking-mini-label">LOSSES</div>
              </div>
            </div>
          </div>

        </div>

        <div class="tracking-totals">
          <div class="tracking-total">
            <div id="trackingTotal" class="tracking-total-value">—</div>
            <div class="tracking-total-label">DIRECTIONAL</div>
          </div>

          <div class="tracking-total">
            <div id="trackingBuy" class="tracking-total-value">—</div>
            <div class="tracking-total-label">BUY</div>
          </div>

          <div class="tracking-total">
            <div id="trackingSell" class="tracking-total-value">—</div>
            <div class="tracking-total-label">SELL</div>
          </div>

          <div class="tracking-total">
            <div id="trackingWait" class="tracking-total-value">—</div>
            <div class="tracking-total-label">WAIT</div>
          </div>
        </div>

        <div class="tracking-history">
          <div class="history-filter">
            <div class="history-filter-field">
              <label for="historyFrom">FROM</label>
              <input id="historyFrom" type="date">
            </div>
            <div class="history-filter-field">
              <label for="historyTo">TO</label>
              <input id="historyTo" type="date">
            </div>
            <div class="history-filter-actions">
              <button id="historyApply" type="button">APPLY</button>
              <button id="history7d" type="button">7 DAYS</button>
              <button id="historyClear" type="button">CLEAR</button>
            </div>
          </div>

          <div class="tracking-horizon-title history-board-title">
            HISTORY BOARD <span id="historyFilterSummary">ALL DATES</span>
          </div>

          <table class="tracking-history-table">
            <thead>
              <tr>
                <th>TIME</th>
                <th>SIGNAL</th>
                <th>PRICE</th>
                <th>5M</th>
                <th>15M</th>
                <th>30M</th>
              </tr>
            </thead>
            <tbody id="aurixaTrackingHistoryBody">
              <tr>
                <td colspan="6">Loading signal history...</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div id="aurixaTrackingUpdated" class="tracking-updated">
          Tracking data loading...
        </div>
      </div>
    `;

    const host = document.getElementById("trackingHost");

    if (host) {
      host.appendChild(panel);
      return panel;
    }

    const main = document.querySelector("main");
    if (main) {
      main.appendChild(panel);
    } else {
      document.body.appendChild(panel);
    }

    return panel;
  }

  function set(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function updateStats(data) {
    if (!data || data.ok === false) return;

    const h5 = horizon(data, "5");
    const h15 = horizon(data, "15");
    const h30 = horizon(data, "30");
    const totals = data.totals || {};

    set("tracking5Rate", percentValue(h5.winRate));
    set("tracking5Eval", numberValue(h5.evaluated));
    set("tracking5Wins", numberValue(h5.wins));
    set("tracking5Losses", numberValue(h5.losses));

    set("tracking15Rate", percentValue(h15.winRate));
    set("tracking15Eval", numberValue(h15.evaluated));
    set("tracking15Wins", numberValue(h15.wins));
    set("tracking15Losses", numberValue(h15.losses));

    set("tracking30Rate", percentValue(h30.winRate));
    set("tracking30Eval", numberValue(h30.evaluated));
    set("tracking30Wins", numberValue(h30.wins));
    set("tracking30Losses", numberValue(h30.losses));

    set("trackingTotal", numberValue(totals.directional));
    set("trackingBuy", numberValue(totals.buy));
    set("trackingSell", numberValue(totals.sell));
    set("trackingWait", numberValue(totals.wait));

    if (data.updatedAt) {
      set(
        "aurixaTrackingUpdated",
        `Updated ${new Date(data.updatedAt).toLocaleString()}`
      );
    }
  }

  function extractHistory(data) {
    if (Array.isArray(data)) return data;

    if (!data || typeof data !== "object") return [];

    const candidates = [
      data.history,
      data.signals,
      data.rows,
      data.data,
      data.results
    ];

    for (const value of candidates) {
      if (Array.isArray(value)) return value;
    }

    return [];
  }

  function pick(obj, keys) {
    for (const key of keys) {
      if (
        obj &&
        obj[key] !== undefined &&
        obj[key] !== null &&
        obj[key] !== ""
      ) {
        return obj[key];
      }
    }
    return null;
  }

  function statusClass(value) {
    const v = String(value || "").toLowerCase();

    if (v.includes("win") || v === "won") return "win";
    if (v.includes("loss") || v === "lost") return "loss";
    if (v.includes("flat")) return "flat";
    if (v.includes("wait") || v.includes("neutral")) return "wait";

    return "";
  }

  function formatTime(value) {
    if (!value) return "—";

    const d = new Date(value);

    if (Number.isNaN(d.getTime())) {
      return esc(value);
    }

    return d.toLocaleString();
  }

  function renderHistory(data) {
    const body = document.getElementById("aurixaTrackingHistoryBody");
    if (!body) return;

    const rows = extractHistory(data);

    if (!rows.length) {
      body.innerHTML = `
        <tr>
          <td colspan="6">No signal history returned yet.</td>
        </tr>
      `;
      return;
    }

    body.innerHTML = rows.slice(0, 30).map(row => {
      const time = pick(row, [
        "candle_time",
        "candleTime",
        "createdAt",
        "created_at",
        "timestamp",
        "time",
        "signalTime",
        "entryTime"
      ]);

      const signal = pick(row, [
        "direction",
        "signal",
        "prediction",
        "action",
        "side"
      ]);

      const price = pick(row, [
        "entryPrice",
        "entry_price",
        "price",
        "close",
        "entry"
      ]);

      const r5 = pick(row, [
        "result5m",
        "result_5m",
        "status5m",
        "status_5m",
        "outcome5m",
        "outcome_5m",
        "evaluation5m"
      ]);

      const r15 = pick(row, [
        "result15m",
        "result_15m",
        "status15m",
        "status_15m",
        "outcome15m",
        "outcome_15m",
        "evaluation15m"
      ]);

      const r30 = pick(row, [
        "result30m",
        "result_30m",
        "status30m",
        "status_30m",
        "outcome30m",
        "outcome_30m",
        "evaluation30m"
      ]);

      return `
        <tr>
          <td>${formatTime(time)}</td>
          <td><strong>${esc(signal)}</strong></td>
          <td>${numberValue(price)}</td>
          <td class="tracking-history-status ${statusClass(r5)}">${esc(r5 ?? "—")}</td>
          <td class="tracking-history-status ${statusClass(r15)}">${esc(r15 ?? "—")}</td>
          <td class="tracking-history-status ${statusClass(r30)}">${esc(r30 ?? "—")}</td>
        </tr>
      `;
    }).join("");
  }

  function validDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
  }

  function buildHistoryUrl() {
    const from = document.getElementById("historyFrom")?.value || "";
    const to = document.getElementById("historyTo")?.value || "";
    const params = new URLSearchParams({
      symbol: "XAUUSD",
      timeframe: "5m",
      limit: "100"
    });

    if (validDate(from)) params.set("from", from);
    if (validDate(to)) params.set("to", to);

    return HISTORY_URL + "?" + params.toString();
  }

  function setHistorySummary(rows) {
    const from = document.getElementById("historyFrom")?.value || "";
    const to = document.getElementById("historyTo")?.value || "";
    const el = document.getElementById("historyFilterSummary");
    if (!el) return;

    const range = from || to
      ? (from || "…") + " → " + (to || "…")
      : "ALL DATES";

    el.textContent = range + " · " + rows.length + " SIGNALS";
  }

  function setHistoryDefault7d() {
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - 6);

    const iso = d => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return y + "-" + m + "-" + day;
    };

    const fromEl = document.getElementById("historyFrom");
    const toEl = document.getElementById("historyTo");
    if (fromEl) fromEl.value = iso(from);
    if (toEl) toEl.value = iso(to);
  }

  function setupHistoryFilters() {
    const apply = document.getElementById("historyApply");
    const quick = document.getElementById("history7d");
    const clear = document.getElementById("historyClear");

    if (apply && !apply.dataset.bound) {
      apply.dataset.bound = "1";
      apply.addEventListener("click", fetchTracking);
    }

    if (quick && !quick.dataset.bound) {
      quick.dataset.bound = "1";
      quick.addEventListener("click", () => {
        setHistoryDefault7d();
        fetchTracking();
      });
    }

    if (clear && !clear.dataset.bound) {
      clear.dataset.bound = "1";
      clear.addEventListener("click", () => {
        const from = document.getElementById("historyFrom");
        const to = document.getElementById("historyTo");
        if (from) from.value = "";
        if (to) to.value = "";
        fetchTracking();
      });
    }
  }

  async function fetchTracking() {
    try {
      ensureTrackingPanel();
      setupHistoryFilters();

      const [statsResponse, historyResponse] = await Promise.all([
        fetch(STATS_URL, {
          cache: "no-store",
          headers: { "Accept": "application/json" }
        }),
        fetch(buildHistoryUrl(), {
          cache: "no-store",
          headers: { "Accept": "application/json" }
        })
      ]);

      if (!statsResponse.ok) {
        throw new Error(`Stats HTTP ${statsResponse.status}`);
      }

      const stats = await statsResponse.json();
      updateStats(stats);

      if (historyResponse.ok) {
        const history = await historyResponse.json();
        const rows = extractHistory(history);
        renderHistory(history);
        setHistorySummary(rows);
      } else {
        renderHistory([]);
      }

    } catch (error) {
      console.error("AURIXA Signal Tracking V1:", error);

      const body = document.getElementById("aurixaTrackingHistoryBody");

      if (body) {
        body.innerHTML = `
          <tr>
            <td colspan="6">
              Signal tracking temporarily unavailable.
            </td>
          </tr>
        `;
      }

      set(
        "aurixaTrackingUpdated",
        `Tracking error: ${error.message}`
      );
    }
  }

  function start() {
    ensureTrackingPanel();
    setupHistoryFilters();
    fetchTracking();

    // Refresh statistics/history without touching trading logic.
    setInterval(fetchTracking, 30000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

})();

/* ============================================================
   AURIXA SIGNAL TRACKING V2.1 DASHBOARD
   Analytics only. Does NOT modify trading logic.
   ============================================================ */

(function initAurixaSignalTrackingV21() {
  "use strict";

  const V2_URL = "/api/signals/v2-stats";

  function esc(value) {
    return String(value ?? "—")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function stat(obj) {
    obj = obj || {};

    const rate =
      obj.winRate === null || obj.winRate === undefined
        ? "—"
        : `${Number(obj.winRate).toFixed(2)}%`;

    return `
      <div class="tracking-v2-cell">
        <strong>${esc(rate)}</strong>
        <span>
          ${Number(obj.evaluated || 0)} eval /
          ${Number(obj.wins || 0)}W /
          ${Number(obj.losses || 0)}L
        </span>
      </div>
    `;
  }

  function horizon(direction, h) {
    return stat(
      direction &&
      (direction[String(h)] || direction[h])
    );
  }

  function ensurePanel() {
    let panel = document.getElementById("aurixaTrackingV2");

    if (panel) return panel;

    panel = document.createElement("section");
    panel.id = "aurixaTrackingV2";
    panel.className = "tracking-v2";

    panel.innerHTML = `
      <div class="card tracking-card">

        <div class="section-title">
          AURIXA SIGNAL TRACKING V2.1
        </div>

        <div class="tracking-v2-subtitle">
          Historical signal performance from stored AURIXA signals
        </div>

        <div class="tracking-v21-summary">
          <div class="tracking-v21-stat">
            <span>Directional</span>
            <strong id="v21Directional">—</strong>
          </div>

          <div class="tracking-v21-stat">
            <span>BUY</span>
            <strong id="v21BuyCount">—</strong>
          </div>

          <div class="tracking-v21-stat">
            <span>SELL</span>
            <strong id="v21SellCount">—</strong>
          </div>

          <div class="tracking-v21-stat">
            <span>WAIT</span>
            <strong id="v21WaitCount">—</strong>
          </div>
        </div>

        <h3>BUY vs SELL</h3>

        <div class="tracking-v2-table">
          <div class="tracking-v2-row tracking-v2-header">
            <div>Direction</div>
            <div>5 MIN</div>
            <div>15 MIN</div>
            <div>30 MIN</div>
          </div>

          <div class="tracking-v2-row">
            <div class="tracking-v2-label">BUY</div>
            <div id="v2Buy5">—</div>
            <div id="v2Buy15">—</div>
            <div id="v2Buy30">—</div>
          </div>

          <div class="tracking-v2-row">
            <div class="tracking-v2-label">SELL</div>
            <div id="v2Sell5">—</div>
            <div id="v2Sell15">—</div>
            <div id="v2Sell30">—</div>
          </div>
        </div>

        <h3>CONFIDENCE BANDS</h3>

        <div class="tracking-v2-table">
          <div class="tracking-v2-row tracking-v2-header">
            <div>CONFIDENCE</div>
            <div>5 MIN</div>
            <div>15 MIN</div>
            <div>30 MIN</div>
          </div>

          <div class="tracking-v2-row">
            <div>40–49</div>
            <div id="v2C40_5">—</div>
            <div id="v2C40_15">—</div>
            <div id="v2C40_30">—</div>
          </div>

          <div class="tracking-v2-row">
            <div>50–59</div>
            <div id="v2C50_5">—</div>
            <div id="v2C50_15">—</div>
            <div id="v2C50_30">—</div>
          </div>

          <div class="tracking-v2-row">
            <div>60–69</div>
            <div id="v2C60_5">—</div>
            <div id="v2C60_15">—</div>
            <div id="v2C60_30">—</div>
          </div>

          <div class="tracking-v2-row">
            <div>70–79</div>
            <div id="v2C70_5">—</div>
            <div id="v2C70_15">—</div>
            <div id="v2C70_30">—</div>
          </div>

          <div class="tracking-v2-row">
            <div>80+</div>
            <div id="v2C80_5">—</div>
            <div id="v2C80_15">—</div>
            <div id="v2C80_30">—</div>
          </div>
        </div>

        <h3>HORIZON SUMMARY</h3>

        <div class="tracking-v21-horizon">
          <div>
            <span>5 MIN</span>
            <strong id="v21H5">—</strong>
          </div>

          <div>
            <span>15 MIN</span>
            <strong id="v21H15">—</strong>
          </div>

          <div>
            <span>30 MIN</span>
            <strong id="v21H30">—</strong>
          </div>
        </div>

        <div id="trackingV2Updated" class="tracking-v2-updated">
          Waiting for analytics…
        </div>

      </div>
    `;

    const host = document.getElementById("trackingHost");
    if (host) {
      host.appendChild(panel);
      return panel;
    }

    const target =
      document.querySelector(".database-card") ||
      document.querySelector("#database") ||
      document.querySelector(".dashboard") ||
      document.querySelector("main");

    if (target && target.parentNode) {
      target.parentNode.insertBefore(panel, target);
    } else {
      document.body.appendChild(panel);
    }

    return panel;
  }

  function set(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  function combinedSummary(a, b) {
    a = a || {};
    b = b || {};

    const evaluated =
      Number(a.evaluated || 0) +
      Number(b.evaluated || 0);

    const wins =
      Number(a.wins || 0) +
      Number(b.wins || 0);

    const losses =
      Number(a.losses || 0) +
      Number(b.losses || 0);

    const flats =
      Number(a.flats || 0) +
      Number(b.flats || 0);

    const rate =
      wins + losses > 0
        ? `${((wins / (wins + losses)) * 100).toFixed(2)}%`
        : "—";

    return `
      <div class="tracking-v21-horizon-value">
        <strong>${esc(rate)}</strong>
        <span>${evaluated} eval · ${wins}W · ${losses}L · ${flats}F</span>
      </div>
    `;
  }

  async function refresh() {
    ensurePanel();

    try {
      const response = await fetch(
        `${V2_URL}?_=${Date.now()}`,
        {
          cache: "no-store"
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (!data || data.ok !== true) {
        throw new Error("Invalid V2 response");
      }

      const buy = data.directions?.BUY || {};
      const sell = data.directions?.SELL || {};
      const confidence = data.confidenceBands || {};

      // V2.2: use accurate totals from all stored signals.
      const totals = data.totals || {};

      set("v21Directional", totals.directional ?? "—");
      set("v21BuyCount", totals.buy ?? "—");
      set("v21SellCount", totals.sell ?? "—");
      set("v21WaitCount", totals.wait ?? "—");

      set("v2Buy5", horizon(buy, 5));
      set("v2Buy15", horizon(buy, 15));
      set("v2Buy30", horizon(buy, 30));

      set("v2Sell5", horizon(sell, 5));
      set("v2Sell15", horizon(sell, 15));
      set("v2Sell30", horizon(sell, 30));

      const bands = [
        ["40-49", "40"],
        ["50-59", "50"],
        ["60-69", "60"],
        ["70-79", "70"],
        ["80+", "80"]
      ];

      for (const [band, id] of bands) {
        const row = confidence[band] || {};

        set(`v2C${id}_5`, stat(row["5"]));
        set(`v2C${id}_15`, stat(row["15"]));
        set(`v2C${id}_30`, stat(row["30"]));
      }

      set("v21H5", combinedSummary(buy["5"], sell["5"]));
      set("v21H15", combinedSummary(buy["15"], sell["15"]));
      set("v21H30", combinedSummary(buy["30"], sell["30"]));

      const updated = data.updatedAt
        ? new Date(data.updatedAt).toLocaleTimeString()
        : new Date().toLocaleTimeString();

      set(
        "trackingV2Updated",
        `Analytics updated ${esc(updated)} · refresh 30s`
      );

    } catch (err) {
      console.error("AURIXA Signal Tracking V2.1:", err);

      set(
        "trackingV2Updated",
        "V2.1 analytics temporarily unavailable"
      );
    }
  }

  function start() {
    ensurePanel();
    refresh();
    setInterval(refresh, 30000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

})();

try {
  const boot = document.getElementById("frontendBoot");
  if (boot) boot.textContent = "AURIXA DIAGNOSTIC: JS RUNNING · UI INITIALIZING";
  window.__AURIXA_JS_READY = Date.now();
} catch (e) {
  console.error("AURIXA frontend ready marker failed:", e);
}
