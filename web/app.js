(() => {
  "use strict";

  const API_MARKET = "/api/market";
  const POLL_MS = 3000;
  const MAX_CANDLES = 100;

  let lastData = null;
  let previousPrice = null;

  const $ = (id) => document.getElementById(id);

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }

  function number(value, decimals = 2) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";

    return n.toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  function normalizeSignal(signal) {
    const s = String(signal || "WAIT").toUpperCase();

    if (s === "BUY") return "BUY";
    if (s === "SELL") return "SELL";

    return "WAIT";
  }

  function updatePrice(data) {
    const price = Number(data.price);

    if (!Number.isFinite(price)) {
      setText("price", "—");
      return;
    }

    setText("price", number(price, 2));

    if (previousPrice !== null) {
      const change = price - previousPrice;

      if (Math.abs(change) >= 0.005) {
        const sign = change >= 0 ? "+" : "";
        setText("change", `${sign}${change.toFixed(2)}`);
      }
    }

    previousPrice = price;
  }

  function updateBidAsk(data) {
    setText("bid", number(data.bid, 2));
    setText("ask", number(data.ask, 2));

    const bid = Number(data.bid);
    const ask = Number(data.ask);

    if (Number.isFinite(bid) && Number.isFinite(ask)) {
      setText("spread", number(ask - bid, 2));
    }
  }

  function updatePrediction(data) {
    const p = data.prediction || {};

    const signal = normalizeSignal(p.signal);

    setText("prediction", signal);
    setText("confidence", `${Math.round(Number(p.confidence) || 0)}%`);

    setText("ema9", number(p.ema9, 2));
    setText("ema21", number(p.ema21, 2));
    setText("ema50", number(p.ema50, 2));
    setText("rsi", number(p.rsi, 2));
    setText("atr", number(p.atr, 2));
    setText("score", p.score ?? "—");

    setText(
      "predictionReason",
      p.reason || "Waiting for enough M5 data"
    );

    setText(
      "predictionStatus",
      p.dataReady ? "READY" : "BUILDING DATA"
    );

    const meter = $("meterFill");

    if (meter) {
      const confidence = Math.max(
        0,
        Math.min(100, Number(p.confidence) || 0)
      );

      meter.style.width = `${confidence}%`;
    }

    const prediction = $("prediction");

    if (prediction) {
      prediction.classList.remove(
        "signal-buy",
        "signal-sell",
        "signal-wait"
      );

      prediction.classList.add(
        signal === "BUY"
          ? "signal-buy"
          : signal === "SELL"
            ? "signal-sell"
            : "signal-wait"
      );
    }

    const buy = $("buySignal");
    const sell = $("sellSignal");
    const neutral = $("neutralSignal");

    if (buy) buy.classList.toggle("active", signal === "BUY");
    if (sell) sell.classList.toggle("active", signal === "SELL");
    if (neutral) neutral.classList.toggle("active", signal === "WAIT");
  }

  function updateStatus(data) {
    const connected =
      data.liveConnected === true &&
      data.authorized === true;

    setText(
      "systemStatus",
      connected ? "ONLINE" : "CONNECTING"
    );

    setText(
      "dataStatus",
      connected ? "LIVE" : "WAITING"
    );

    const badge = $("liveBadge");

    if (badge) {
      badge.textContent = connected
        ? "● LIVE"
        : "○ OFFLINE";

      badge.classList.toggle("online", connected);
      badge.classList.toggle("offline", !connected);
    }
  }

  function updateCTrader(data) {
    const connected =
      data.liveConnected === true &&
      data.authorized === true;

    setText(
      "ctraderStatus",
      connected
        ? "CONNECTED"
        : "AUTHORIZATION REQUIRED"
    );

    setText(
      "accountId",
      data.accountId
        ? String(data.accountId)
        : "NOT CONNECTED"
    );

    setText(
      "ctraderSymbol",
      data.symbol || "XAUUSD"
    );

    setText(
      "symbolId",
      data.symbolId ?? "—"
    );

    if (data.lastUpdate) {
      const date = new Date(data.lastUpdate);

      if (!Number.isNaN(date.getTime())) {
        setText(
          "lastUpdate",
          date.toLocaleTimeString()
        );
      }
    }

    const dot = $("ctraderDot");

    if (dot) {
      dot.classList.toggle("connected", connected);
      dot.classList.toggle("disconnected", !connected);
    }

    const button = $("connectCtrader");

    if (button) {
      button.textContent = connected
        ? "CTRADER CONNECTED"
        : "CONNECT CTRADER";

      button.classList.toggle("connected", connected);
    }
  }

  function updateTradingMode(data) {
    setText(
      "autoTrading",
      data.autoTrading === false
        ? "DISABLED"
        : "ENABLED"
    );

    setText(
      "paperTrading",
      data.paperTrading === true
        ? "ENABLED"
        : "DISABLED"
    );

    setText(
      "tradingSafety",
      "AURIXA AI will not place real trades."
    );
  }

  function formatTime(value) {
    let n = Number(value);

    if (!Number.isFinite(n)) return "";

    if (n < 100000000000) {
      n *= 1000;
    }

    const date = new Date(n);

    if (Number.isNaN(date.getTime())) return "";

    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function renderCandleChart(candles) {
    const container = $("candleChart");

    if (!container) return;

    if (!Array.isArray(candles) || candles.length === 0) {
      container.innerHTML =
        '<div class="chart-empty">Waiting for live M5 candles...</div>';
      return;
    }

    const clean = candles
      .map(c => ({
        time: Number(c.time),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close)
      }))
      .filter(c =>
        Number.isFinite(c.time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
      )
      .slice(-MAX_CANDLES);

    if (!clean.length) return;

    const width = Math.max(
      360,
      Math.floor(container.clientWidth || 900)
    );

    const height = 360;

    const left = 12;
    const right = 72;
    const top = 20;
    const bottom = 35;

    const chartWidth = width - left - right;
    const chartHeight = height - top - bottom;

    let max = Math.max(...clean.map(c => c.high));
    let min = Math.min(...clean.map(c => c.low));

    const range = Math.max(max - min, 0.01);
    const padding = range * 0.06;

    max += padding;
    min -= padding;

    const priceRange = max - min;
    const step = chartWidth / clean.length;
    const candleWidth = Math.max(
      2,
      Math.min(10, step * 0.65)
    );

    const x = i =>
      left + i * step + step / 2;

    const y = price =>
      top +
      ((max - price) / priceRange) *
        chartHeight;

    let svg = `
      <svg
        class="aurixa-candle-svg"
        viewBox="0 0 ${width} ${height}"
        width="100%"
        height="${height}"
        preserveAspectRatio="none"
      >
    `;

    for (let i = 0; i <= 4; i++) {
      const price =
        max - (priceRange * i) / 4;

      const yy = y(price);

      svg += `
        <line
          x1="${left}"
          y1="${yy}"
          x2="${width - right}"
          y2="${yy}"
          class="chart-grid"
        />

        <text
          x="${width - right + 8}"
          y="${yy + 4}"
          class="chart-price-label"
        >
          ${price.toFixed(2)}
        </text>
      `;
    }

    clean.forEach((c, i) => {
      const cx = x(i);

      const openY = y(c.open);
      const closeY = y(c.close);
      const highY = y(c.high);
      const lowY = y(c.low);

      const bullish = c.close >= c.open;

      const cls = bullish
        ? "candle-bull"
        : "candle-bear";

      const bodyTop = Math.min(openY, closeY);

      const bodyHeight = Math.max(
        1,
        Math.abs(closeY - openY)
      );

      svg += `
        <line
          x1="${cx}"
          y1="${highY}"
          x2="${cx}"
          y2="${lowY}"
          class="${cls} candle-wick"
        />

        <rect
          x="${cx - candleWidth / 2}"
          y="${bodyTop}"
          width="${candleWidth}"
          height="${bodyHeight}"
          rx="1"
          class="${cls} candle-body"
        />
      `;
    });

    const latest = clean[clean.length - 1];

    const currentY = y(latest.close);

    svg += `
      <line
        x1="${left}"
        y1="${currentY}"
        x2="${width - right}"
        y2="${currentY}"
        class="current-price-line"
      />

      <rect
        x="${width - right + 3}"
        y="${currentY - 10}"
        width="64"
        height="20"
        rx="4"
        class="current-price-box"
      />

      <text
        x="${width - right + 8}"
        y="${currentY + 4}"
        class="current-price-text"
      >
        ${latest.close.toFixed(2)}
      </text>
    `;

    const labels = [
      0,
      Math.floor(clean.length / 2),
      clean.length - 1
    ];

    [...new Set(labels)].forEach(i => {
      svg += `
        <text
          x="${x(i)}"
          y="${height - 10}"
          text-anchor="middle"
          class="chart-time-label"
        >
          ${formatTime(clean[i].time)}
        </text>
      `;
    });

    svg += "</svg>";

    container.innerHTML = svg;

    setText(
      "chartInfo",
      `${clean.length} M5 candles • Latest ${latest.close.toFixed(2)}`
    );
  }

  function renderMarket(data) {
    if (!data) return;

    lastData = data;

    updatePrice(data);
    updateBidAsk(data);
    updateStatus(data);
    updatePrediction(data);
    updateCTrader(data);
    updateTradingMode(data);

    const candles =
      Array.isArray(data.candles)
        ? data.candles
        : [];

    setText(
      "candleCount",
      candles.length.toLocaleString()
    );

    setText(
      "timeframe",
      data.timeframe || "5m"
    );

    if (data.error) {
      setText(
        "errorMessage",
        typeof data.error === "string"
          ? data.error
          : JSON.stringify(data.error)
      );
    }

    renderCandleChart(candles);
  }

  async function fetchMarket() {
    try {
      const response = await fetch(
        `${API_MARKET}?_=${Date.now()}`,
        {
          cache: "no-store",
          headers: {
            Accept: "application/json"
          }
        }
      );

      if (!response.ok) {
        throw new Error(
          `Market API HTTP ${response.status}`
        );
      }

      const data = await response.json();

      renderMarket(data);
    } catch (error) {
      console.error(
        "AURIXA market update failed:",
        error
      );

      setText("systemStatus", "CONNECTION ERROR");
      setText("dataStatus", "OFFLINE");
      setText("errorMessage", error.message);
    }
  }

  function connectCTrader() {
    window.location.href = "/auth/ctrader";
  }

  function bindEvents() {
    const button = $("connectCtrader");

    if (button) {
      button.addEventListener(
        "click",
        connectCTrader
      );
    }

    window.addEventListener(
      "resize",
      () => {
        if (lastData) {
          renderCandleChart(
            lastData.candles || []
          );
        }
      }
    );
  }

  function init() {
    console.log(
      "AURIXA AI live dashboard initialized"
    );

    bindEvents();

    fetchMarket();

    setInterval(
      fetchMarket,
      POLL_MS
    );
  }

  if (
    document.readyState === "loading"
  ) {
    document.addEventListener(
      "DOMContentLoaded",
      init
    );
  } else {
    init();
  }
})();
