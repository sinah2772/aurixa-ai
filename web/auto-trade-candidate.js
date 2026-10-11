(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const nodes = {
    panel: $("autoTradeCandidatePanel"), symbol: $("candidateSymbol"),
    direction: $("candidateDirection"), approval: $("candidateApproval"),
    autoStatus: $("candidateAutoStatus"), brokerStatus: $("candidateBrokerStatus"),
    confidence: $("candidateConfidence"), entry: $("candidateEntry"),
    sl: $("candidateSL"), tp: $("candidateTP"), rr: $("candidateRR"),
    reason: $("candidateReason"), list: $("autoCandidateList"), updated: $("autoCandidateUpdated")
  };
  if (!nodes.panel || !nodes.list) return;

  const digitsFor = symbol => ({
    XAUUSD: 2, EURUSD: 5, NZDUSD: 5, USDCHF: 5, USDCAD: 5,
    AUDUSD: 5, USDJPY: 3, GBPUSD: 5, XAGUSD: 3, BTCUSD: 2
  })[String(symbol || "").toUpperCase()] ?? 2;
  const price = (value, symbol) => {
    const n = Number(value);
    return value == null || value === "" || !Number.isFinite(n)
      ? "—" : n.toLocaleString(undefined, { minimumFractionDigits: digitsFor(symbol), maximumFractionDigits: digitsFor(symbol) });
  };
  const safeText = (node, value) => { if (node) node.textContent = value == null ? "—" : String(value); };
  const clear = node => { while (node.firstChild) node.removeChild(node.firstChild); };

  function render(data) {
    const c = data.candidate;
    nodes.panel.classList.toggle("is-approved", data.selectedForAutoTrade === true);
    nodes.panel.classList.toggle("is-blocked", data.selectedForAutoTrade !== true);
    safeText(nodes.approval, data.selectionStatus || "CANDIDATE STATUS UNAVAILABLE");
    safeText(nodes.autoStatus, data.enabled === true ? "ON · DEMO · MANUAL CONTROL ACTIVE" : "OFF · MANUAL START REQUIRED");

    if (!c) {
      safeText(nodes.symbol, "WAITING");
      safeText(nodes.direction, "WAIT");
      safeText(nodes.brokerStatus, "NO CANDIDATE / NO ORDER");
      [nodes.confidence, nodes.entry, nodes.sl, nodes.tp, nodes.rr].forEach(n => safeText(n, "—"));
      safeText(nodes.reason, data.enabled
        ? "Waiting for fresh per-symbol strategy evaluations."
        : "Auto-trading is OFF. Scanner decisions will show bias and blocking reasons; no new entry can be submitted.");
      clear(nodes.list);
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No fresh scanner decisions yet. Wait for the next multi-market scan.";
      nodes.list.appendChild(empty);
      return;
    }

    safeText(nodes.symbol, c.symbol);
    safeText(nodes.direction, c.signal === "BUY" || c.signal === "SELL"
      ? c.signal : (c.bias ? "WAIT · " + c.bias + " BIAS" : "WAIT"));
    safeText(nodes.confidence, Number.isFinite(Number(c.confidence)) ? Number(c.confidence).toFixed(0) + "%" : "—");
    safeText(nodes.entry, price(c.entry, c.symbol));
    safeText(nodes.sl, price(c.stopLoss, c.symbol));
    safeText(nodes.tp, price(c.takeProfit, c.symbol));
    safeText(nodes.rr, c.rewardRisk == null ? "—" : Number(c.rewardRisk).toFixed(2) + "R");
    const executionStatus = c.executionStatus || (c.executionEligible ? "ENTRY GATES PASSED · AWAITING EXECUTION RESULT" : "NOT SUBMITTED · ENTRY NOT APPROVED");
    safeText(nodes.brokerStatus, executionStatus);
    const why = c.executionReason || c.reason || (c.executionEligible
      ? "Strategy gates passed; the broker outcome is not yet confirmed."
      : "No entry approved by the strategy.");
    safeText(nodes.reason, why + (c.selectedForAutoTrade ? " · SELECTED FOR AUTO-TRADE" : ""));

    clear(nodes.list);
    const rows = Array.isArray(data.candidates) ? data.candidates : [];
    for (const item of rows) {
      const row = document.createElement("div");
      row.className = "auto-candidate-row";
      const symbol = document.createElement("strong");
      symbol.textContent = item.symbol || "UNKNOWN";
      const bias = document.createElement("span");
      bias.textContent = item.signal === "BUY" || item.signal === "SELL"
        ? item.signal : (item.bias ? "WAIT · " + item.bias + " bias" : "WAIT");
      const gates = document.createElement("span");
      gates.textContent = item.executionEligible ? "ENTRY GATES PASSED"
        : (Array.isArray(item.blockedBy) && item.blockedBy.length
          ? item.blockedBy.join(", ") : item.reason || "Waiting for gates");
      const execution = document.createElement("span");
      execution.className = "candidate-status-cell";
      execution.textContent = !item.fresh ? "STALE · WAITING FOR REFRESH"
        : (item.selectedForAutoTrade ? "SELECTED · " + (item.executionStatus || "GATES PASSED")
          : (item.executionStatus || (item.executionEligible ? "GATES PASSED" : "NOT APPROVED")));
      row.append(symbol, bias, gates, execution);
      nodes.list.appendChild(row);
    }
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No market candidates are available.";
      nodes.list.appendChild(empty);
    }
  }

  async function refresh() {
    try {
      const response = await fetch("/api/auto-trader/candidate", {
        cache: "no-store", headers: { Accept: "application/json" }
      });
      const data = await response.json();
      if (!response.ok || data.ok !== true) throw new Error(data.error || "CANDIDATE_STATUS_UNAVAILABLE");
      render(data);
      safeText(nodes.updated, "SCANNER SNAPSHOT · " + new Date().toLocaleTimeString() +
        " · " + Number(data.scannerCount || 0) + " markets evaluated · refreshes every 5 seconds");
    } catch (error) {
      nodes.panel.classList.remove("is-approved");
      nodes.panel.classList.add("is-blocked");
      safeText(nodes.approval, "CANDIDATE STATUS UNAVAILABLE · RETRYING");
      safeText(nodes.brokerStatus, "STATUS UNKNOWN");
      safeText(nodes.reason, error.message || "Unable to read live scanner decision.");
      safeText(nodes.updated, "No verified candidate status available.");
    }
  }

  refresh();
  window.setInterval(refresh, 5000);
})();