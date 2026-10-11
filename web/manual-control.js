(() => {
  "use strict";
  const button = document.getElementById("manualAutoTradingButton");
  const statusEl = document.getElementById("manualAutoTradingStatus");
  const modeEl = document.getElementById("manualTradingMode");
  const symbolSelect = document.getElementById("tradingSymbol");
  const multiSymbolGrid = document.getElementById("multiSymbolGrid");
  const multiSymbolSummary = document.getElementById("multiSymbolSummary");
  if (!button || !statusEl || !symbolSelect) return;

  let enabled = false;
  let busy = false;
  let selectedSymbol = "";

  function canonical(value) {
    return String(value || "").trim().toUpperCase().replace(/[\/\s_-]/g, "");
  }

  function render(status, kind = "") {
    statusEl.textContent = status;
    statusEl.classList.remove("ready", "blocked");
    if (kind) statusEl.classList.add(kind);
    button.classList.toggle("enabled", enabled);
    button.setAttribute("aria-pressed", String(enabled));
    button.textContent = enabled ? "DISABLE AUTO-TRADING" : "ENABLE AUTO-TRADING";
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
    if (!multiSymbolGrid || !multiSymbolSummary) return;
    try {
      const response = await fetch("/api/auto-trader/multi-symbol-status", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || data.ok !== true) throw new Error(data.error || "MULTI_SYMBOL_STATUS_UNAVAILABLE");
      const markets = Array.isArray(data.markets) ? data.markets : [];
      const readyCount = Number(data.readyCount || markets.filter(item => item.ready === true).length);
      const discoveredCount = Number(data.discovered || markets.length);
      multiSymbolSummary.textContent =
        readyCount + " / " + discoveredCount + " MARKETS WITH DATA READY  ·  " +
        (data.enabled ? "AUTO-TRADING ON" : "AUTO-TRADING OFF") +
        "  ·  DEMO ONLY  ·  DATA READY DOES NOT MEAN ENTRY APPROVED";
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
        const bid = Number(market.bid), ask = Number(market.ask);
        const digits = ({XAUUSD:2, EURUSD:5, NZDUSD:5, USDCHF:5, USDCAD:5, AUDUSD:5, USDJPY:3, GBPUSD:5, XAGUSD:3, BTCUSD:2})[symbol] ?? 2;
        const fmt = value => Number.isFinite(value) ? value.toLocaleString(undefined, {minimumFractionDigits:digits, maximumFractionDigits:digits}) : "—";
        quote.textContent = "BID " + fmt(bid) + "  ·  ASK " + fmt(ask);

        const detail = document.createElement("div");
        detail.className = "multi-symbol-detail";
        detail.textContent = "M5 HISTORY  " + String(market.candleCount || 0) + " candles · " +
          marketReasonLabel(market.reason) +
          (market.symbolName && market.symbolName !== symbol ? " · Broker: " + market.symbolName : "") +
          (market.symbolId != null ? " · ID " + market.symbolId : "");

        const select = document.createElement("button");
        select.type = "button";
        select.className = "multi-symbol-select";
        select.textContent = selected ? "CHART SELECTED" : "OPEN IN CHART";
        select.setAttribute("aria-pressed", String(selected));
        select.disabled = busy || !symbolSelect || !Array.from(symbolSelect.options).some(option => option.value === symbol);
        select.addEventListener("click", () => {
          if (selected || busy) return;
          symbolSelect.value = symbol;
          symbolSelect.dispatchEvent(new Event("change", { bubbles: true }));
        });
        card.append(head, quote, detail, select);
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
    }
  }

  async function readStatus() {
    try {
      const response = await fetch("/api/auto-trader/status", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || "STATUS_UNAVAILABLE");
      enabled = data.enabled === true;
      const demoReady = data.demoAccount === true && data.demoOnly === true;
      if (modeEl) modeEl.textContent = demoReady ? "DEMO ONLY · VERIFIED" : "DEMO ONLY · VERIFY ACCOUNT";
      // The cTrader symbols endpoint is the source of truth for the active chart
      // symbol. Auto-trader status may report its own/default symbol and must not
      // silently reset a user's market selection in the dropdown.
      await refreshSymbols();
      render(enabled ? "ENABLED · DEMO ONLY · ALL MARKETS SCANNED" : "OFF · MANUAL START REQUIRED",
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
    const nextEnabled = !enabled;
    busy = true;
    render(nextEnabled ? "VERIFYING DEMO ACCOUNT…" : "DISABLING…");
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
      render(enabled ? "ENABLED · DEMO ONLY · ALL MARKETS SCANNED" : "OFF · NEW ENTRIES DISABLED",
        enabled ? "ready" : "");
    } catch (error) {
      render(error.message || "CONTROL REQUEST FAILED", "blocked");
      await readStatus();
    } finally {
      busy = false;
      button.disabled = false;
      symbolSelect.disabled = symbolSelect.options.length === 0;
      button.textContent = enabled ? "DISABLE AUTO-TRADING" : "ENABLE AUTO-TRADING";
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