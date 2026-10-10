(() => {
  "use strict";
  const button = document.getElementById("manualAutoTradingButton");
  const statusEl = document.getElementById("manualAutoTradingStatus");
  const modeEl = document.getElementById("manualTradingMode");
  const symbolSelect = document.getElementById("tradingSymbol");
  if (!button || !statusEl) return;

  let enabled = false;
  let busy = false;

  function render(status, kind = "") {
    statusEl.textContent = status;
    statusEl.classList.remove("ready", "blocked");
    if (kind) statusEl.classList.add(kind);
    button.classList.toggle("enabled", enabled);
    button.setAttribute("aria-pressed", String(enabled));
    button.textContent = enabled ? "DISABLE AUTO-TRADING" : "ENABLE AUTO-TRADING";
    button.disabled = busy;
  }

  async function readStatus() {
    try {
      const response = await fetch("/api/auto-trader/status", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || data.ok === false) throw new Error(data.error || "STATUS_UNAVAILABLE");
      enabled = data.enabled === true;
      const demoReady = data.demoAccount === true && data.demoOnly === true;
      if (modeEl) modeEl.textContent = demoReady ? "DEMO ONLY · VERIFIED" : "DEMO ONLY · VERIFY ACCOUNT";
      render(enabled ? "ENABLED · " + (data.symbol || "XAUUSD") : "OFF · MANUAL START REQUIRED",
        enabled && demoReady && data.connected && data.authorized ? "ready" : "");
    } catch {
      render("COULD NOT READ TRADING STATUS", "blocked");
    }
  }

  button.addEventListener("click", async () => {
    if (busy) return;
    if (symbolSelect && symbolSelect.value !== "XAUUSD") {
      render("UNSUPPORTED SYMBOL — XAUUSD ONLY", "blocked");
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
          "UNSUPPORTED_SYMBOL: current auto-trader supports XAUUSD only": "BLOCKED · XAUUSD ONLY"
        };
        throw new Error(messages[data.error] || data.error || "CONTROL_REQUEST_FAILED");
      }
      enabled = data.enabled === true;
      render(enabled ? "ENABLED · DEMO ONLY · WAITING FOR VALID SIGNAL" : "OFF · NEW ENTRIES DISABLED",
        enabled ? "ready" : "");
    } catch (error) {
      render(error.message || "CONTROL REQUEST FAILED", "blocked");
      await readStatus();
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = enabled ? "DISABLE AUTO-TRADING" : "ENABLE AUTO-TRADING";
      button.setAttribute("aria-pressed", String(enabled));
      button.classList.toggle("enabled", enabled);
    }
  });

  readStatus();
  window.setInterval(readStatus, 5000);
})();