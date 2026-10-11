(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const nodes = {
    status: $("autoCandidateStatus"), symbol: $("autoCandidateSymbol"),
    direction: $("autoCandidateDirection"), confidence: $("autoCandidateConfidence"),
    entry: $("autoCandidateEntry"), sl: $("autoCandidateSL"), tp: $("autoCandidateTP"),
    rr: $("autoCandidateRR"), reason: $("autoCandidateReason"),
    list: $("autoCandidateList"), updated: $("autoCandidateUpdated")
  };
  if (!nodes.status || !nodes.list) return;

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

  function renderCandidate(data) {
    const c = data.candidate;
    nodes.status.classList.remove("is-approved", "is-blocked");
    nodes.status.classList.add(data.selectedForAutoTrade ? "is-approved" : "is-blocked");
    safeText(nodes.status, data.selectionStatus || "CANDIDATE STATUS UNAVAILABLE");
    if (!c) {
      safeText(nodes.symbol, "—");
      safeText(nodes.direction, "WAIT");
      nodes.direction.className = "candidate-direction";
      safeText(nodes.confidence, "CONFIDENCE —");
      [nodes.entry, nodes.sl, nodes.tp, nodes.rr].forEach(n => safeText(n, "—"));
      safeText(nodes.reason, data.enabled ? "Waiting for fresh per-market strategy evaluations." : "Auto-trading is OFF. Scanner evaluations will show candidate bias and blocking reasons, but no entry is approved.");
      clear(nodes.list);
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No fresh scanner decisions yet. Wait for the next multi-market scan.";
      nodes.list.appendChild(empty);
      return;
    }

    safeText(nodes.symbol, c.symbol);
    safeText(nodes.direction, c.signal === "BUY" || c.signal === "SELL" ? c.signal : (c.bias ? "WAIT · " + c.bias + " BIAS" : "WAIT"));
    nodes.direction.className = "candidate-direction" + (c.bias === "BUY" ? " is-buy" : c.bias === "SELL" ? " is-sell" : "");
    safeText(nodes.confidence, "CONFIDENCE " + (Number.isFinite(Number(c.confidence)) ? Number(c.confidence).toFixed(0) + "%" : "—"));
    safeText(nodes.entry, price(c.entry, c.symbol));
    safeText(nodes.sl, price(c.stopLoss, c.symbol));
    safeText(nodes.tp, price(c.takeProfit, c.symbol));
    safeText(nodes.rr, c.rewardRisk == null ? "—" : Number(c.rewardRisk).toFixed(2) + "R");
    const why = c.executionReason || c.reason || (c.executionEligible ? "Strategy gates passed; awaiting broker confirmation." : "No entry approved by the strategy.");
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
      gates.textContent = item.executionEligible ? "ENTRY GATES PASSED" :
        (Array.isArray(item.blockedBy) && item.blockedBy.length ? item.blockedBy.join(", ") : item.reason || "Waiting for gates");
      const execution = document.createElement("span");
      execution.className = "candidate-status-cell";
      execution.textContent = !item.fresh ? "STALE · WAITING FOR REFRESH" :
        (item.selectedForAutoTrade ? "SELECTED · " + (item.executionStatus || "GATES PASSED") :
          (item.executionStatus || (item.executionEligible ? "GATES PASSED" : "NOT APPROVED")));
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
      renderCandidate(data);
      safeText(nodes.updated, "SCANNER SNAPSHOT · " + new Date().toLocaleTimeString() +
        " · " + Number(data.scannerCount || 0) + " markets evaluated · refreshes every 5 seconds");
    } catch (error) {
      nodes.status.classList.remove("is-approved");
      nodes.status.classList.add("is-blocked");
      safeText(nodes.status, "CANDIDATE STATUS UNAVAILABLE · RETRYING");
      safeText(nodes.reason, error.message || "Unable to read live scanner decision.");
      safeText(nodes.updated, "No verified candidate status available.");
    }
  }

  refresh();
  window.setInterval(refresh, 5000);
})();