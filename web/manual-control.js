(() => {
  "use strict";
  const button = document.getElementById("manualAutoTradingButton");
  const statusEl = document.getElementById("manualAutoTradingStatus");
  const modeEl = document.getElementById("manualTradingMode");
  const symbolSelect = document.getElementById("tradingSymbol");
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
  }

  async function readStatus() {
    try {
      const response = await fetch("/api/auto-trader/status", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || "STATUS_UNAVAILABLE");
      enabled = data.enabled === true;
      const demoReady = data.demoAccount === true && data.demoOnly === true;
      if (modeEl) modeEl.textContent = demoReady ? "DEMO ONLY · VERIFIED" : "DEMO ONLY · VERIFY ACCOUNT";
      if (data.symbol && canonical(data.symbol) !== selectedSymbol) {
        await refreshSymbols(data.symbol);
      }
      render(enabled ? "ENABLED · " + (data.symbol || selectedSymbol || "NO SYMBOL") : "OFF · MANUAL START REQUIRED",
        enabled && demoReady && data.connected && data.authorized ? "ready" : "");
    } catch (error) {
      render("STATUS / SYMBOL DISCOVERY UNAVAILABLE", "blocked");
    }
  }

  symbolSelect.addEventListener("change", async () => {
    const requested = symbolSelect.value;
    if (!requested || requested === selectedSymbol || busy) return;
    busy = true;
    render("VERIFYING SYMBOL · CHECKING OPEN POSITIONS…");
    try {
      const response = await fetch("/api/ctrader/select-symbol", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ symbol: requested })
      });
      const data = await response.json();
      if (!response.ok || data.ok !== true) {
        const messages = {
          OPEN_POSITIONS_MUST_BE_CLOSED_BEFORE_SWITCHING_SYMBOL: "CLOSE ACTIVE-SYMBOL POSITIONS BEFORE SWITCHING",
          CTRADER_NOT_READY: "CONNECT / AUTHORIZE cTRADER FIRST",
          "cTrader WebSocket is not connected": "cTRADER FEED DISCONNECTED"
        };
        throw new Error(messages[data.error] || data.error || "SYMBOL_SELECTION_FAILED");
      }
      selectedSymbol = canonical(data.symbol);
      await refreshSymbols(selectedSymbol);
      render("SELECTED · " + selectedSymbol + " · AUTO-TRADING OFF", "ready");
      window.location.reload();
    } catch (error) {
      await refreshSymbols(selectedSymbol).catch(() => {});
      render(error.message || "SYMBOL SELECTION FAILED", "blocked");
    } finally {
      busy = false;
      button.disabled = false;
      symbolSelect.disabled = symbolSelect.options.length === 0;
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
      render(enabled ? "ENABLED · DEMO ONLY · " + selectedSymbol : "OFF · NEW ENTRIES DISABLED",
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

  refreshSymbols().then(readStatus).catch(() => {
    render("WAITING FOR cTRADER SYMBOL DISCOVERY", "blocked");
  });
  window.setInterval(readStatus, 5000);
})();