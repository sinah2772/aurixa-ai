(() => {
  "use strict";
  const button = document.getElementById("manualAutoTradingButton");
  const statusEl = document.getElementById("manualAutoTradingStatus");
  const modeEl = document.getElementById("manualTradingMode");
  const symbolSelect = document.getElementById("tradingSymbol");
  const multiSymbolGrid = document.getElementById("multiSymbolGrid");
  const multiSymbolSummary = document.getElementById("multiSymbolSummary");
  const multiSymbolDialog = document.getElementById("multiSymbolDialog");
  const multiSymbolOpenButton = document.getElementById("multiSymbolOpenButton");
  const multiSymbolCloseButton = document.getElementById("multiSymbolCloseButton");
  if (multiSymbolOpenButton && multiSymbolDialog) {
    multiSymbolOpenButton.addEventListener("click", () => {
      if (!multiSymbolDialog.open) multiSymbolDialog.showModal();
    });
  }
  if (multiSymbolCloseButton && multiSymbolDialog) {
    multiSymbolCloseButton.addEventListener("click", () => multiSymbolDialog.close());
  }
  if (!button || !statusEl || !symbolSelect) return;

  let enabled = false;
  let symbolScoped = false;
  let busy = false;
  let selectedSymbol = "";
  let latestPositions = [];
  let enableBusy = false;
  let multiSymbolRefreshBusy = false;
  const expandedSymbols = new Set();

  function canonical(value) {
    return String(value || "").trim().toUpperCase().replace(/[\/\s_-]/g, "");
  }

  function render(status, kind = "") {
    statusEl.textContent = status;
    statusEl.classList.remove("ready", "blocked");
    if (kind) statusEl.classList.add(kind);
    button.classList.toggle("enabled", enabled);
    button.setAttribute("aria-pressed", String(enabled));
    button.textContent = enabled && symbolScoped ? "ENABLE ALL MARKETS" :
      enabled ? "DISABLE AUTO-TRADING" : "ENABLE AUTO-TRADING";
    button.disabled = busy;
    symbolSelect.disabled = busy || symbolSelect.options.length === 0;
  }

  async function refreshSymbols(preferred = "") {
    const response = await fetch("/api/ctrader/symbols", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || "SYMBOL_DISCOVERY_FAILED");
    const symbols = Array.isArray(data.symbols) ? data.symbols : [];
    const selected = canonical(preferred || data.selectedSymbol || selectedSymbol);
    symbolSelect.replaceChildren();
    for (const item of symbols) {
      const name = String(item.symbolName || "");
      const value = canonical(item.canonicalName || name);
      if (!value) continue;
      const option = document.createElement("option");
      option.value = value;
      option.textContent = (value === canonical(name) ? name : value + " (broker: " + name + ")") + " · broker ID " + item.symbolId;
      symbolSelect.appendChild(option);
    }
    if (!symbolSelect.options.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = data.connected ? "No supported symbols found on this account" : "Connect cTrader to discover symbols";
      symbolSelect.appendChild(option);
      symbolSelect.disabled = true;
      selectedSymbol = "";
      return;
    }
    const match = Array.from(symbolSelect.options).find(option => option.value === selected);
    symbolSelect.value = match ? selected : canonical(data.selectedSymbol || symbols[0].symbolName);
    selectedSymbol = symbolSelect.value;
    symbolSelect.disabled = busy;
    // Keep the scanner's selected-market highlight in sync with the dropdown.
    refreshMultiSymbolStatus();
  }

  function marketReasonLabel(reason) {
    const key = String(reason || "STATUS_UNKNOWN").toUpperCase();
    const labels = {
      READY: "Market data ready · entry not yet approved",
      OK: "Market data ready · entry not yet approved",
      QUOTE_STALE: "Quote is stale",
      STALE_QUOTE: "Quote is stale",
      INSUFFICIENT_CANDLES: "Waiting for more M5 candles",
      CANDLES_NOT_READY: "Waiting for M5 history",
      QUOTE_UNAVAILABLE: "No broker quote",
      SYMBOL_NOT_FOUND: "Symbol not available",
      CTRADER_DISCONNECTED: "cTrader disconnected",
      AUTO_TRADING_DISABLED: "Market ready · auto-trading off"
    };
    return labels[key] || key.replaceAll("_", " ").toLowerCase().replace(/^./, c => c.toUpperCase());
  }

  async function refreshMultiSymbolStatus() {
    if (!multiSymbolGrid || !multiSymbolSummary || multiSymbolRefreshBusy) return;
    multiSymbolRefreshBusy = true;
    try {
      const response = await fetch("/api/auto-trader/multi-symbol-status", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || data.ok !== true) throw new Error(data.error || "MULTI_SYMBOL_STATUS_UNAVAILABLE");
      const markets = Array.isArray(data.markets) ? data.markets : [];
      const readyCount = Number(data.readyCount ?? markets.filter(item => item.ready === true).length);
      const discoveredCount = Number(data.discovered ?? markets.length);
      multiSymbolSummary.textContent =
        readyCount + " / " + discoveredCount + " MARKETS WITH DATA READY  ·  " +
        (data.enabled ? (data.symbolScoped ? "PAIR-SCOPED AUTO-TRADING" : "AUTO-TRADING ON · ALL MARKETS") : "AUTO-TRADING OFF") +
        "  ·  DEMO ONLY  ·  DATA READY DOES NOT MEAN ENTRY APPROVED";
      // Position cards are backed by the live broker snapshot, never inferred
      // from strategy signals or planned entries.
      try {
        const positionResponse = await fetch("/api/auto-trader/positions", { cache: "no-store" });
        const positionData = await positionResponse.json();
        latestPositions = positionResponse.ok && positionData.ok === true && Array.isArray(positionData.positions)
          ? positionData.positions : [];
      } catch (_) { latestPositions = []; }
      multiSymbolGrid.replaceChildren();
      for (const market of markets) {
        const symbol = canonical(market.symbol || market.canonicalName || market.symbolName || "UNKNOWN");
        const selected = symbol === selectedSymbol;
        const card = document.createElement("article");
        card.className = "multi-symbol-card" + (selected ? " is-selected" : "");
        card.dataset.symbol = symbol;

        const head = document.createElement("div");
        head.className = "multi-symbol-card-head";
        const name = document.createElement("strong");
        name.textContent = symbol;
        const status = document.createElement("span");
        status.className = market.ready ? "market-ready" : "market-wait";
        status.textContent = market.ready ? "DATA READY" : "DATA WAIT";
        head.append(name, status);

        const quote = document.createElement("div");
        quote.className = "multi-symbol-quote";
        const bid = market.bid == null || market.bid === "" ? NaN : Number(market.bid);
        const ask = market.ask == null || market.ask === "" ? NaN : Number(market.ask);
        const digits = ({XAUUSD:2, EURUSD:5, NZDUSD:5, USDCHF:5, USDCAD:5, AUDUSD:5, USDJPY:3, GBPUSD:5, XAGUSD:3, BTCUSD:2})[symbol] ?? 2;
        const fmt = value => Number.isFinite(value) && value > 0 ? value.toLocaleString(undefined, {minimumFractionDigits:digits, maximumFractionDigits:digits}) : "—";
        quote.textContent = "BID " + fmt(bid) + "  ·  ASK " + fmt(ask);

        const detail = document.createElement("div");
        detail.className = "multi-symbol-detail";
        detail.textContent = "M5 HISTORY  " + String(market.candleCount || 0) + " candles · " +
          marketReasonLabel(market.reason) +
          (market.symbolName && market.symbolName !== symbol ? " · Broker: " + market.symbolName : "") +
          (market.symbolId != null ? " · ID " + market.symbolId : "");

        // Show the same server-evaluated studies used by the scanner. Null or
        // stale values remain unavailable instead of being fabricated in UI.
        const study = market.study || {};
        const studies = document.createElement("div");
        studies.className = "multi-symbol-studies";
        const studyRow = (label, value) => {
          const row = document.createElement("div");
          row.className = "multi-symbol-study-row";
          const key = document.createElement("span");
          key.textContent = label;
          const val = document.createElement("strong");
          val.textContent = value == null || value === "" ? "—" : String(value);
          row.append(key, val);
          return row;
        };
        const fmtStudy = (value, digits = 2) => {
          const n = Number(value);
          return value == null || value === "" || !Number.isFinite(n) ? "—" :
            n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
        };
        const signal = String(study.signal || "WAIT").toUpperCase();
        const signalRow = studyRow("AI SIGNAL", study.fresh ? signal + (study.confidence == null ? "" : " · " + Math.round(Number(study.confidence)) + "%") : "WAITING");
        signalRow.classList.add(signal === "BUY" ? "study-buy" : signal === "SELL" ? "study-sell" : "study-wait");
        studies.append(
          signalRow,
          studyRow("EMA TREND", study.fresh ? (study.trend || "—") : "—"),
          studyRow("RSI 14", study.fresh ? fmtStudy(study.rsi, 1) : "—"),
          studyRow("MOMENTUM", study.fresh ? fmtStudy(study.momentum, 2) + (study.momentum == null ? "" : " ATR") : "—"),
          studyRow("REGIME", study.fresh ? String(study.regime || "—").replaceAll("_", " ") : "—"),
          studyRow("RISK / R:R", study.fresh && study.rewardRisk != null ? fmtStudy(study.rewardRisk, 2) + "R" : "—")
        );
        const execution = document.createElement("div");
        execution.className = "multi-symbol-execution";
        execution.textContent = study.executionStatus || "WAITING FOR SCANNER";
        studies.appendChild(execution);
        const why = document.createElement("div");
        why.className = "multi-symbol-study-reason";
        why.textContent = study.reason || "Waiting for per-symbol strategy evaluation.";
        studies.appendChild(why);

        const marketAliases = new Set([symbol, canonical(market.symbolName), canonical(market.canonicalName)].filter(Boolean));
        const symbolPositions = latestPositions.filter(position =>
          marketAliases.has(canonical(position.symbol || position.symbolName)) ||
          marketAliases.has(canonical(position.symbolName)));
        const positionBadge = document.createElement("div");
        positionBadge.className = "multi-symbol-position-state" + (symbolPositions.length ? " has-position" : "");
        positionBadge.textContent = symbolPositions.length
          ? "ACTIVE BROKER TRADE · " + symbolPositions.length + " OPEN"
          : "NO OPEN BROKER POSITION";
        studies.appendChild(positionBadge);

        const controls = document.createElement("div");
        controls.className = "multi-symbol-card-controls";
        const detailsButton = document.createElement("button");
        detailsButton.type = "button";
        detailsButton.className = "multi-symbol-select multi-symbol-details-toggle";
        const details = document.createElement("div");
        details.className = "multi-symbol-expanded-details";
        details.hidden = !expandedSymbols.has(symbol);
        detailsButton.textContent = details.hidden ? "VIEW DETAILS" : "HIDE DETAILS";
        detailsButton.setAttribute("aria-expanded", String(!details.hidden));
        const detailLine = (label, value) => {
          const row = document.createElement("div");
          row.className = "multi-symbol-expanded-row";
          const key = document.createElement("span"); key.textContent = label;
          const val = document.createElement("strong"); val.textContent = value == null || value === "" ? "—" : String(value);
          row.append(key, val); details.appendChild(row);
        };
        detailLine("ENTRY", fmtStudy(study.entry, digits));
        detailLine("STOP LOSS", fmtStudy(study.stopLoss, digits));
        detailLine("TAKE PROFIT", fmtStudy(study.takeProfit, digits));
        detailLine("SIGNAL CONFIDENCE", study.fresh && study.confidence != null ? Math.round(Number(study.confidence)) + "%" : "—");
        detailLine("OF1 CONFIRMATION", study.orderFlowStatus || "NOT AVAILABLE");
        detailLine("OF1 EXPLANATION", study.orderFlowReason || "No OF1 conflict detail recorded");
        detailLine("SIGNAL CHECKED", study.checkedAt ? new Date(study.checkedAt).toLocaleTimeString() : "—");
        if (symbolPositions.length) {
          for (const position of symbolPositions) {
            const id = position.positionId == null ? "—" : String(position.positionId);
            const side = String(position.direction || "POSITION");
            detailLine(side + " · POSITION " + id, "ENTRY " + fmtStudy(position.entryPrice, digits) +
              " · SL " + fmtStudy(position.stopLoss, digits) + " · TP " + fmtStudy(position.takeProfit, digits) +
              " · P/L " + (position.unrealizedNetProfit == null ? "UNAVAILABLE" : Number(position.unrealizedNetProfit).toFixed(2)));
          }
        } else {
          detailLine("BROKER POSITION", "No open position confirmed");
        }
        detailsButton.addEventListener("click", () => {
          details.hidden = !details.hidden;
          if (details.hidden) expandedSymbols.delete(symbol);
          else expandedSymbols.add(symbol);
          detailsButton.setAttribute("aria-expanded", String(!details.hidden));
          detailsButton.textContent = details.hidden ? "VIEW DETAILS" : "HIDE DETAILS";
        });

        const chartButton = document.createElement("button");
        chartButton.type = "button";
        chartButton.className = "multi-symbol-select";
        chartButton.textContent = selected ? "CHART SELECTED" : "OPEN IN CHART";
        chartButton.setAttribute("aria-pressed", String(selected));
        chartButton.disabled = busy || !symbolSelect || !Array.from(symbolSelect.options).some(option => option.value === symbol);
        chartButton.addEventListener("click", () => {
          if (selected || busy) return;
          symbolSelect.value = symbol;
          symbolSelect.dispatchEvent(new Event("change", { bubbles: true }));
        });
        controls.append(detailsButton, chartButton);

        const isPairEnabled = market.autoTradeEnabled === true;
        const enableButton = document.createElement("button");
        enableButton.type = "button";
        enableButton.className = "multi-symbol-select multi-symbol-enable" + (isPairEnabled ? " enabled" : "");
        enableButton.textContent = isPairEnabled ? "DISABLE " + symbol + " AUTO-TRADING" : "ENABLE " + symbol + " AUTO-TRADING";
        enableButton.setAttribute("aria-pressed", String(isPairEnabled));
        enableButton.disabled = busy || enableBusy;
        enableButton.addEventListener("click", async () => {
          if (enableBusy) return;
          enableBusy = true;
          enableButton.disabled = true;
          enableButton.textContent = "VERIFYING " + symbol + "…";
          try {
            const response = await fetch("/api/auto-trader/control", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Accept": "application/json" },
              body: JSON.stringify({ enabled: !isPairEnabled, symbol })
            });
            const result = await response.json();
            if (!response.ok || result.ok !== true) {
              const messages = {
                CTRADER_NOT_READY: "Connect and authorize cTrader first",
                DEMO_ACCOUNT_REQUIRED: "Demo account required",
                BROKER_TRADING_PERMISSION_REQUIRED: "Broker trading permission required",
                UNSUPPORTED_SYMBOL_OR_NOT_DISCOVERED: "Pair is not supported/discovered"
              };
              throw new Error(messages[result.error] || result.error || "Pair control request failed");
            }
            await readStatus();
            await refreshMultiSymbolStatus();
          } catch (error) {
            statusEl.textContent = "PAIR CONTROL BLOCKED · " + (error.message || "REQUEST FAILED");
            statusEl.classList.add("blocked");
          } finally {
            enableBusy = false;
            await refreshMultiSymbolStatus();
          }
        });
        controls.appendChild(enableButton);
        card.append(head, quote, detail, studies, details, controls);
        multiSymbolGrid.appendChild(card);
      }
      if (!markets.length) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = "No supported symbols discovered on this cTrader account.";
        multiSymbolGrid.appendChild(empty);
      }
    } catch (error) {
      multiSymbolSummary.textContent = "SCANNER STATUS UNAVAILABLE · RETRYING";
      multiSymbolGrid.replaceChildren();
      const errorCard = document.createElement("div");
      errorCard.className = "empty-state";
      errorCard.textContent = "Unable to load broker market readiness. Auto-trading controls remain governed by the backend.";
      multiSymbolGrid.appendChild(errorCard);
    } finally {
      multiSymbolRefreshBusy = false;
    }
  }

  async function readStatus() {
    try {
      const response = await fetch("/api/auto-trader/status", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || "STATUS_UNAVAILABLE");
      enabled = data.enabled === true;
      symbolScoped = data.symbolScoped === true;
      const demoReady = data.demoAccount === true && data.demoOnly === true;
      if (modeEl) modeEl.textContent = demoReady ? "DEMO ONLY · VERIFIED" : "DEMO ONLY · VERIFY ACCOUNT";
      // The cTrader symbols endpoint is the source of truth for the active chart
      // symbol. Auto-trader status may report its own/default symbol and must not
      // silently reset a user's market selection in the dropdown.
      await refreshSymbols();
      render(!enabled ? "OFF · MANUAL START REQUIRED" :
        symbolScoped ? "PAIR-SCOPED MODE · TAP ENABLE ALL MARKETS TO ARM EVERY SUPPORTED PAIR" :
        "ON · ALL SUPPORTED MARKETS SCANNED · DEMO ONLY",
        enabled && demoReady && data.connected && data.authorized ? "ready" : "");
    } catch (error) {
      render("STATUS / SYMBOL DISCOVERY UNAVAILABLE", "blocked");
    }
  }

  symbolSelect.addEventListener("change", async () => {
    const requested = symbolSelect.value;
    if (!requested || requested === selectedSymbol || busy) return;
    busy = true;
    render("SWITCHING CHART · MULTI-MARKET SCANNER STAYS RUNNING…");
    try {
      const response = await fetch("/api/ctrader/select-symbol", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ symbol: requested })
      });
      const data = await response.json();
      if (!response.ok || data.ok !== true) {
        const messages = {
          CTRADER_NOT_READY: "CONNECT / AUTHORIZE cTRADER FIRST",
          "cTrader WebSocket is not connected": "cTRADER FEED DISCONNECTED"
        };
        throw new Error(messages[data.error] || data.error || "SYMBOL_SELECTION_FAILED");
      }
      selectedSymbol = canonical(data.symbol);
      await refreshSymbols(selectedSymbol);
      render("CHART SELECTED · " + selectedSymbol + " · MULTI-MARKET SCANNER CONTINUES", "ready");
      // The main dashboard refreshes prices and candles on its own polling
      // cycle; avoid a full reload that resets chart/UI state.
    } catch (error) {
      await refreshSymbols(selectedSymbol).catch(() => {});
      render(error.message || "SYMBOL SELECTION FAILED", "blocked");
    } finally {
      busy = false;
      button.disabled = false;
      symbolSelect.disabled = busy || symbolSelect.options.length === 0;
    }
  });

  button.addEventListener("click", async () => {
    if (busy) return;
    if (!symbolSelect.value) {
      render("NO BROKER-DISCOVERED SYMBOL AVAILABLE", "blocked");
      return;
    }
    // If only one pair is armed, the master control must promote that state
    // to global all-market mode instead of disabling auto-trading.
    const nextEnabled = !enabled || symbolScoped;
    busy = true;
    render(nextEnabled ? (enabled && symbolScoped ? "ENABLING ALL MARKETS…" : "VERIFYING DEMO ACCOUNT…") : "DISABLING…");
    try {
      const response = await fetch("/api/auto-trader/control", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled })
      });
      const data = await response.json();
      if (!response.ok || data.ok !== true) {
        const messages = {
          CTRADER_NOT_READY: "BLOCKED · CONNECT/AUTHORIZE cTRADER",
          DEMO_ACCOUNT_REQUIRED: "BLOCKED · DEMO ACCOUNT REQUIRED",
          BROKER_TRADING_PERMISSION_REQUIRED: "BLOCKED · BROKER TRADING PERMISSION",
          UNSUPPORTED_SYMBOL_OR_NOT_DISCOVERED: "BLOCKED · SYMBOL NOT DISCOVERED ON THIS DEMO ACCOUNT"
        };
        throw new Error(messages[data.error] || data.error || "CONTROL_REQUEST_FAILED");
      }
      enabled = data.enabled === true;
      symbolScoped = data.symbolScoped === true;
      render(!enabled ? "OFF · NEW ENTRIES DISABLED" :
        symbolScoped ? "PAIR-SCOPED MODE · ENABLE ALL MARKETS TO ARM EVERY SUPPORTED PAIR" :
        "ON · ALL SUPPORTED MARKETS SCANNED · DEMO ONLY", enabled ? "ready" : "");
    } catch (error) {
      render(error.message || "CONTROL REQUEST FAILED", "blocked");
      await readStatus();
    } finally {
      busy = false;
      button.disabled = false;
      symbolSelect.disabled = symbolSelect.options.length === 0;
      button.textContent = enabled && symbolScoped ? "ENABLE ALL MARKETS" :
        enabled ? "DISABLE AUTO-TRADING" : "ENABLE AUTO-TRADING";
      button.setAttribute("aria-pressed", String(enabled));
      button.classList.toggle("enabled", enabled);
    }
  });

  refreshMultiSymbolStatus();
  window.setInterval(refreshMultiSymbolStatus, 5000);
  refreshSymbols().then(readStatus).catch(() => {
    render("WAITING FOR cTRADER SYMBOL DISCOVERY", "blocked");
  });
  window.setInterval(readStatus, 5000);
})();