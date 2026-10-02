(() => {
  "use strict";

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
    ctrader: "/api/ctrader/status"
  };

  let chart = null;

  async function getJSON(url) {
    try {
      const r = await fetch(url, {
        cache: "no-store",
        headers: { Accept: "application/json" }
      });

      if (!r.ok) return null;

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
    const el = $("prediction");

    if (!el) return;

    const value = String(signal || "WAIT").toUpperCase();

    el.textContent = value;

    el.classList.remove("buy", "sell", "wait");

    if (value === "BUY") el.classList.add("buy");
    else if (value === "SELL") el.classList.add("sell");
    else el.classList.add("wait");
  }

  function updateConnection(status) {
    if (!status) return;

    const connected =
      status.connected === true &&
      status.authorized === true;

    text(
      "connectionStatus",
      connected
        ? "CONNECTED · Live market feed"
        : "DISCONNECTED"
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

    const badge = $("liveBadge");

    if (badge) {
      badge.textContent = connected ? "● LIVE" : "● OFFLINE";
      badge.classList.toggle("offline", !connected);
    }
  }

  function updateMarket(data) {
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

    const bid = first(market.bid);
    const ask = first(market.ask);

    text("price", number(price, 2));
    text("bid", number(bid, 2));
    text("ask", number(ask, 2));

    if (Number.isFinite(Number(bid)) && Number.isFinite(Number(ask))) {
      text("spread", number(Number(ask) - Number(bid), 2));
    }

    text(
      "instrument",
      first(market.symbol, "XAUUSD")
    );

    const candles = first(
      market.candles,
      market.bars,
      market.candleCount,
      data.candleCount
    );

    if (Array.isArray(candles)) {
      text("candleCount", candles.length);
      drawChart(candles);
    } else {
      text("candleCount", first(candles, "—"));
    }

    const indicators =
      market.indicators ||
      data.indicators ||
      {};

    text(
      "ema9",
      number(first(indicators.ema9, market.ema9), 2)
    );

    text(
      "ema21",
      number(first(indicators.ema21, market.ema21), 2)
    );

    text(
      "ema50",
      number(first(indicators.ema50, market.ema50), 2)
    );

    text(
      "rsi",
      number(first(indicators.rsi14, indicators.rsi, market.rsi14, market.rsi), 2)
    );

    text(
      "atr",
      number(first(indicators.atr14, indicators.atr, market.atr14, market.atr), 2)
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
      "signalReason",
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

    if (!canvas || !window.Chart || !Array.isArray(candles)) {
      return;
    }

    const latest = candles.slice(-100);

    const labels = latest.map((c) =>
      formatTime(first(
        c.time,
        c.timestamp,
        c.openTime
      ))
    );

    const values = latest.map((c) =>
      Number(first(
        c.close,
        c.price,
        c.mid
      ))
    );

    if (!values.some(Number.isFinite)) return;

    if (chart) {
      chart.data.labels = labels;
      chart.data.datasets[0].data = values;
      chart.update("none");
      return;
    }

    chart = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "XAUUSD",
          data: values,
          tension: 0.25,
          pointRadius: 0,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: {
            display: false
          }
        },
        scales: {
          x: {
            display: false
          },
          y: {
            ticks: {
              maxTicksLimit: 6
            }
          }
        }
      }
    });
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
      ctrader
    ] = await Promise.all([
      getJSON(API.market),
      getJSON(API.marketState),
      getJSON(API.signal),
      getJSON(API.stats),
      getJSON(API.trackingStats),
      getJSON(API.history),
      getJSON(API.trackingHistory),
      getJSON(API.ctrader)
    ]);

    updateMarket(
      marketState ||
      market
    );

    updateSignal(signal);

    updateTrackingStats(
      stats
    );

    updateHistory(
      history
    );

    updateConnection(ctrader);

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

  function start() {
    refresh();

    setInterval(refresh, 5000);

    const connectButton = $("connectCtrader");

    if (connectButton) {
      connectButton.addEventListener("click", () => {
        window.location.href = "/auth/login";
      });
    }
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
          <div class="tracking-horizon-title">
            RECENT SIGNAL HISTORY
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

    const candidates = [
      document.querySelector(".database-card"),
      document.querySelector("#database"),
      document.querySelector(".dashboard"),
      document.querySelector("main"),
      document.body
    ];

    const target = candidates.find(Boolean);
    if (target && target !== document.body) {
      target.parentNode.insertBefore(panel, target);
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

  async function fetchTracking() {
    try {
      ensureTrackingPanel();

      const [statsResponse, historyResponse] = await Promise.all([
        fetch(STATS_URL, {
          cache: "no-store",
          headers: { "Accept": "application/json" }
        }),
        fetch(HISTORY_URL, {
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
        renderHistory(history);
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
   AURIXA SIGNAL TRACKING V2 DASHBOARD
   Analytics only. Does NOT modify trading logic.
   ============================================================ */

(function initAurixaSignalTrackingV2() {
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
          AURIXA SIGNAL TRACKING V2
        </div>

        <div class="tracking-v2-subtitle">
          Direction and confidence performance from stored signals
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

        <div id="trackingV2Updated" class="tracking-v2-updated">
          Waiting for analytics…
        </div>
      </div>
    `;

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

      set(
        "trackingV2Updated",
        `Updated ${new Date().toLocaleTimeString()}`
      );

    } catch (err) {
      console.error("AURIXA Signal Tracking V2:", err);

      set(
        "trackingV2Updated",
        "V2 analytics temporarily unavailable"
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
