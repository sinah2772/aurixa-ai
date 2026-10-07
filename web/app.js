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
    autoTrades: "/api/auto-trader/trades",
    aiDecision: "/api/ai/decision",
    aiHistory: "/api/ai/decision/history",
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

  // =========================================================
  // SIGNAL ALERTS
  // Browser notification + sound + vibration.
  // Alerts are for NEW signals only; they do not mean a trade was opened.
  // =========================================================
  let alertInitialized = false;
  let lastAlertKey = null;

  function signalAlertKey(signal) {
    const s = signal || {};
    const direction = String(first(s.direction, s.signal, "WAIT")).toUpperCase();
    if (direction !== "BUY" && direction !== "SELL") return null;

    const candleTime = first(
      s.candleTime,
      s.candle_time,
      s.timestamp,
      s.createdAt,
      s.created_at,
      s.time
    );

    const entry = first(s.entryPrice, s.entry, s.price);
    return direction + "|" + String(candleTime || entry || "");
  }

  function playSignalAlert(direction) {
    try {
      if (navigator.vibrate) navigator.vibrate([180, 90, 180]);
    } catch (_) {}

    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;

      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "sine";
      osc.frequency.value = direction === "BUY" ? 880 : 520;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
      osc.addEventListener("ended", () => ctx.close());
    } catch (_) {}
  }

  function showSignalAlert(signal) {
    const s = signal || {};
    const direction = String(first(s.direction, s.signal, "WAIT")).toUpperCase();
    if (direction !== "BUY" && direction !== "SELL") return;

    const confidence = Number(first(s.confidence));
    const entry = first(s.entryPrice, s.entry, s.price);
    const score = first(s.score);

    const title = "AURIXA AI SIGNAL · " + direction;
    const body = [
      "XAUUSD · OF1",
      Number.isFinite(confidence) ? "Confidence " + number(confidence, 0) + "%" : null,
      entry !== null ? "Entry " + number(entry, 2) : null,
      score !== null ? "Score " + number(score, 1) : null,
      "Signal only — trade not guaranteed"
    ].filter(Boolean).join(" · ");

    playSignalAlert(direction);

    if ("Notification" in window && Notification.permission === "granted") {
      try {
        const n = new Notification(title, {
          body,
          tag: "aurixa-" + signalAlertKey(s),
          renotify: true
        });
        setTimeout(() => n.close(), 10000);
      } catch (_) {}
    }

    const banner = $("signalAlert");
    if (banner) {
      banner.textContent = title + " — " + body;
      banner.classList.remove("buy", "sell", "show");
      banner.classList.add(direction.toLowerCase(), "show");
      window.clearTimeout(window.__aurixaAlertTimer);
      window.__aurixaAlertTimer = window.setTimeout(() => {
        banner.classList.remove("show");
      }, 12000);
    }
  }

  async function enableSignalAlerts() {
    if (!("Notification" in window)) {
      text("alertStatus", "Notifications not supported");
      return;
    }

    try {
      const permission = await Notification.requestPermission();
      text(
        "alertStatus",
        permission === "granted"
          ? "Alerts enabled"
          : "Alerts blocked"
      );
    } catch (_) {
      text("alertStatus", "Alert permission unavailable");
    }
  }

  function checkForNewSignal(signal) {
    const key = signalAlertKey(signal);
    if (!key) return;

    if (!alertInitialized) {
      lastAlertKey = key;
      alertInitialized = true;
      return;
    }

    if (key !== lastAlertKey) {
      lastAlertKey = key;
      showSignalAlert(signal);
    }
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

  function updateOrderflow(ai) {
    const data = ai?.decision || ai || {};
    const signal = String(first(data.direction, data.signal, "WAIT")).toUpperCase();
    const confidence = Number(data.confidence);
    const candles = first(data.candleCount, data.candles);
    text("aiSignal", signal);
    text("aiConfidence", Number.isFinite(confidence) ? number(confidence, 0) + "%" : "—");
    text("aiScore", Number.isFinite(Number(data.score)) ? number(data.score, 0) : "—");
    text("aiPhase", first(data.trend, data.regime, "—"));
    text("aiEntry", number(first(data.entry, data.entryPrice), 2));
    text("aiStop", number(first(data.stopLoss, data.stop), 2));
    text("aiTarget", number(first(data.takeProfit, data.target), 2));
    text("aiCandles", first(candles, "—"));

    const decision = $("aiDecision");
    if (decision) {
      decision.classList.remove("buy", "sell", "wait");
      decision.classList.add(signal === "BUY" || signal === "SELL" ? signal.toLowerCase() : "wait");
      decision.textContent = signal;
    }
    text("aiReason", first(data.reason, "Waiting for AURIXA AI Trader V1."));
  }

  function updateFinalTradeGate(marketState, prediction, ai, positions) {
    const data = ai?.decision || ai || {};
    const gates = data.gates || {};
    const direction = String(first(data.direction, data.signal, "WAIT")).toUpperCase();
    const eligible = data.executionEligible === true;
    const hasPosition = Number(first(positions?.count, 0)) > 0;
    const ready = eligible && !hasPosition;

    text("gateMarket", gates.dataReady === false ? "NO DATA" : (gates.spreadAllowed === false ? "SPREAD BLOCKED" : "READY"));
    text("gateSignal", direction);
    text("gateFvg", Number.isFinite(Number(data.confidence)) ? number(data.confidence, 0) + "% CONF" : "WAIT");
    text("gatePosition", hasPosition ? "OPEN" : "FLAT");
    text("gateEntry", number(first(data.entry, data.entryPrice), 2));
    text("gateSL", number(first(data.stopLoss, data.stop), 2));
    text("gateTP", number(first(data.takeProfit, data.target), 2));
    text("gateRR", Number.isFinite(Number(data.riskReward)) ? number(data.riskReward, 1) + "R" : "—");

    const decision = $("gateDecision");
    if (decision) {
      decision.classList.remove("buy", "sell", "wait");
      decision.classList.add(ready && (direction === "BUY" || direction === "SELL") ? direction.toLowerCase() : "wait");
      decision.textContent = ready ? "TRADE " + direction : "WAIT";
    }

    let reason = first(data.reason, "Waiting for AI Trader decision.");
    if (hasPosition) reason = "One XAUUSD position is already open.";
    else if (!eligible) {
      const failed = Object.entries(gates).filter(([,v]) => v === false).map(([k]) => k);
      reason = failed.length ? "Blocked: " + failed.join(", ") : reason;
    } else if (ready) reason = direction + " approved by AURIXA AI Trader V1.";
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
    text("autoTradeMode", demo ? "DEMO ONLY · AI V1" : "GUARDED · AI V1");
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

    history.innerHTML =
      '<div class="auto-trade-table-wrap"><table class="auto-trade-table">' +
      '<thead><tr>' +
      '<th>TIME</th><th>SIDE</th><th>ENTRY</th><th>SL</th><th>TP</th>' +
      '<th>EXIT</th><th>STATUS</th><th>RESULT</th><th>EXIT REASON</th><th>P/L</th><th></th>' +
      '</tr></thead><tbody>' +
      rows.slice(0, 20).map((t) => {
        const direction = String(first(t.direction, "—")).toUpperCase();
        const status = String(first(t.status, "—")).toUpperCase();
        const resultClass = status.includes("WIN") ? "win" : status.includes("LOSS") ? "loss" : "neutral";
        const resultText = status === "CLOSED_WIN" ? "WIN" :
          status === "CLOSED_LOSS" ? "LOSS" :
          status === "CLOSED_FLAT" ? "FLAT" :
          status === "OPEN" || status === "PARTIAL" ? "OPEN" : "—";
        const profit = first(t.profit);
        const pnlText = profit === null || profit === undefined ? "—" : number(profit, 2);
        const exitReason = String(first(t.exitReason, status.includes("CLOSED") ? "MANUAL/OTHER" : "—"));
        const trace = t.id
          ? '<a class="trade-trace-link" href="/api/auto-trader/trade-trace/' + encodeURIComponent(t.id) + '" target="_blank" rel="noopener">TRACE</a>'
          : "";

        return '<tr>' +
          '<td><small>' + escapeHTML(formatTime(first(t.createdAt, t.openedAt))) + '</small>' +
            (t.closedAt ? '<small class="trade-lifecycle">CLOSED ' + escapeHTML(formatTime(t.closedAt)) + '</small>' : '') + '</td>' +
          '<td><strong class="' + direction.toLowerCase() + '">' + escapeHTML(direction) + '</strong></td>' +
          '<td>' + escapeHTML(number(first(t.executionEntryPrice, t.plannedEntryPrice, t.signalEntryPrice), 2)) + '</td>' +
          '<td>' + escapeHTML(number(first(t.plannedStopPrice), 2)) + '</td>' +
          '<td>' + escapeHTML(number(first(t.plannedTakeProfitPrice), 2)) + '</td>' +
          '<td>' + escapeHTML(number(first(t.closePrice), 2)) + '</td>' +
          '<td><span class="trade-status">' + escapeHTML(status) + '</span></td>' +
          '<td><span class="trade-result ' + resultClass + '">' + escapeHTML(resultText) + '</span></td>' +
          '<td>' + escapeHTML(exitReason.replace(/_/g, " ")) + '</td>' +
          '<td class="trade-pnl ' + resultClass + '">' + escapeHTML(pnlText) + '</td>' +
          '<td>' + trace + '</td>' +
        '</tr>';
      }).join("") +
      '</tbody></table></div>';
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
    if (!canvas) { container.innerHTML=""; canvas=document.createElement("canvas"); canvas.setAttribute("aria-label","cTrader live XAUUSD M5 candlestick chart"); canvas.style.width="100%"; canvas.style.height="100%"; canvas.style.display="block"; container.appendChild(canvas); }
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
async function refresh() {
    const [
      market,
      marketState,
      ctrader,
      autoStatus,
      autoPositions,
      autoTrades,
      aiDecision
    ] = await Promise.all([
      getJSON(API.market),
      getJSON(API.marketState),
      getJSON(API.ctrader),
      getJSON(API.autoStatus),
      getJSON(API.autoPositions),
      getJSON(API.autoTrades),
      getJSON(API.aiDecision)
    ]);

    const mergedMarket = {
      ...(marketState || {}),
      ...(market || {})
    };

    updateMarket(mergedMarket, ctrader);
    updateMarketSession(mergedMarket, ctrader);

    const liveAi = aiDecision?.decision || aiDecision?.result || aiDecision || {};
    updateSignal(liveAi);
    updateAutoTrader(autoStatus, autoPositions, autoTrades);
    updateOrderflow(liveAi);
    updateFinalTradeGate(mergedMarket, null, liveAi, autoPositions);

    text(
      "engineStatus",
      liveAi.dataReady === false
        ? "WAITING FOR DATA"
        : liveAi.executionEligible
          ? "TRADE READY"
          : "WAITING"
    );

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
