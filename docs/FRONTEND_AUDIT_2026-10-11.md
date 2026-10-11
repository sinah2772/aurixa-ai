# AURIXA AI Frontend Audit
**Audit date:** 2026-10-11  
**Repository:** [sinah2772/aurixa-ai](https://github.com/sinah2772/aurixa-ai)  
**Production URL:** https://aurixa-ai.onrender.com  
**Scope:** Static source review of `web/index.html`, `web/app.js`, `web/manual-control.js`, `web/style.css`, and `web/multi-market-ui.css`; Render deployment metadata checked. This is not a full browser/device end-to-end test.

## Executive summary

The frontend has a clear dark trading-dashboard structure and now presents a multi-market scanner, current-market chart and AI decision, execution gate, account data, live positions, and closed-trade history. The top chart-symbol dropdown has been visually hidden; market cards are the intended visible chart switcher. Render confirmed the latest cache-busting commit is live.

**Overall assessment: functional structure, but not yet trustworthy enough for operational monitoring without targeted fixes.** The most important finding is that the compact account/auto-trader panel can be given fabricated “enabled/demo/connected” status by the 2-second open-position poll. The frontend should never synthesize trading authorization or connection status.

## What is present

- **Market header:** active symbol, M5 timeframe, price, bid/ask/spread, connection and session badges.
- **Manual authorization:** explicit enable/disable control and demo-only messaging; it says auto-trading starts OFF after a server restart.
- **Multi-market scanner:** cards display per-market bid/ask, M5 candle count, a READY/WAIT state, and a button to load a market into the chart.
- **AI decision and chart:** current signal/confidence, technical summaries, candle chart, and a final execution-gate panel.
- **Monitoring:** recent activity, confirmed BUY/SELL history, account/margin values, open broker positions, closed-trade results, and performance totals.
- **Responsive styling:** desktop/tablet/mobile breakpoints and overflow handling for dense history/position areas.
- **Basic markup check:** 87 HTML IDs were inspected; no duplicate IDs were found in the current `index.html`.

## Findings by priority

### P1 — Trading state can be shown incorrectly
**File:** `web/app.js`, `refreshOpenTrades()`

The dedicated open-position poll calls `updateAutoTrader()` with a synthetic status object that hard-codes `enabled: true`, `demoOnly: true`, `demoAccount: true`, `connected: true`, and `authorized: true`. That status is not a fresh response from the backend. Consequently, the compact account/execution panel may show READY or an armed demo state even when the actual auto-trader status is OFF, disconnected, or not authorized.

**Recommendation:** Keep position rendering and auto-trader status rendering separate. Refresh position details from the positions endpoint, but update authorization/enabled/connection fields only from the real status endpoint. Never infer “enabled” from the presence of an open position.

### P1 — Multi-market readiness can be mistaken for trade eligibility
**Files:** `web/manual-control.js`, `web/index.html`

The scanner shows market cards as READY/WAIT and a total “MARKETS READY”. That is useful for data availability, but the main UI does not clearly distinguish “quote/history ready” from “this symbol currently passes every entry gate”. Spread, risk sizing, stale quotes, daily limits, existing positions, account-currency conversion, and broker SL/TP protection can still block an entry.

**Recommendation:** Label scanner status explicitly as **MARKET DATA READY** and separately expose **ENTRY ELIGIBLE / BLOCKED**, with the backend's actual block reasons per symbol. Do not infer entry eligibility from quote/candle readiness.

### P1 — The multi-market scanner and the single-market decision view have different scopes
**Files:** `web/index.html`, `web/app.js`

The scanner represents several symbols, while the large AI signal, final trade gate, chart, and much of the activity summary are a single current-market view. The closed-trade list also renders direction, entry-to-exit, P/L, result, and time without a visible symbol field. With multiple markets, users can struggle to tell which symbol a decision or closed trade belongs to.

**Recommendation:** Clearly label the main signal and gate with the active symbol and show the symbol on every signal-history and closed-trade row. For simultaneous multi-market operation, provide a per-symbol decision/entry-status summary, rather than making the global chart selection look like the scanner's active trading symbol.

### P2 — Position status is fetched twice on the normal refresh cycle
**File:** `web/app.js`

The 5-second full refresh includes `/api/auto-trader/positions`, and the dedicated open-position poll fetches the same endpoint every 2 seconds. The dedicated poll is appropriate for fast position updates, but the full refresh also calls `renderOpenTrades()` and `updateAutoTrader()`, so both paths can compete to update the same UI. The full refresh has no top-level in-flight guard; slow requests can overlap subsequent 5-second cycles.

**Recommendation:** Give each UI area one owner. Let the 2-second position poll own live position cards only; let the slower status refresh own actual auto-trader state. Add a full-refresh in-flight guard and consider request timeouts/backoff for failed endpoints.

### P2 — Closed-trade history can look incomplete without explaining missing fields
**File:** `web/app.js`, `renderClosedTradeHistory()`

The frontend correctly avoids inventing P/L and labels missing values as P/L PENDING. However, it only renders trades returned by the latest `/api/auto-trader/trades?limit=100` response, and the compact rows omit symbol, SL/TP, exit reason, and currency context. If the backend has not reconciled broker history, the frontend cannot repair that missing data by itself.

**Recommendation:** Include symbol and account currency, show verified SL/TP and exit reason when available, distinguish “broker result not reconciled” from “P/L pending”, and display the date range/record count returned by the API. Backend reconciliation remains a separate requirement.

### P2 — Activity timestamp is a UI refresh time, not necessarily the AI evaluation time
**File:** `web/app.js`, `updateActivity()`

“LAST EVALUATION” is filled using the browser's current time whenever the panel refreshes. That can make an old or repeated decision appear newly evaluated.

**Recommendation:** Use a backend evaluation timestamp. If the API does not supply one, label the value “LAST UI UPDATE” instead of “LAST EVALUATION”.

### P2 — API failures can leave old values visible
**File:** `web/app.js`, `getJSON()`

Failed requests return `null`; many update functions then leave the previous values on screen. A connection or API failure can therefore leave old prices, account data, or decision details visible without a strong per-panel stale/error marker.

**Recommendation:** Track the last successful update per data group and visibly mark data as stale after a defined age. Keep the last value for context, but never present it as current when refresh failed.

### P3 — Frontend maintenance and validation
**Files:** `web/style.css`, `web/multi-market-ui.css`, `web/manual-control.js`

The stylesheet is large and contains multiple generations of layout overrides. The symbol dropdown is hidden with CSS (`:has(#tradingSymbol)`) while the select remains in the DOM because the market-card controls still use it internally. This is intentional for the current UI, but the dependency should be documented or eventually replaced with a dedicated symbol-switch function.

**Recommendation:** Consolidate duplicate/overridden CSS rules in a separate cleanup pass. Add automated checks for HTML IDs, JS syntax, mobile overflow, stale-data states, and the rule that the frontend never fabricates trading authorization.

## Deployment verification

- The Render service is `aurixa-ai` at https://aurixa-ai.onrender.com.
- The cache-busting commit `8b100888630190a7274fa1fa121c43a792209781` was confirmed **LIVE** on Render at the time of this audit.
- The top chart-symbol dropdown is still present in the HTML and JavaScript, but hidden by CSS; scanner market cards remain the visible chart-switch controls.
- A live browser/device test was not performed in this audit environment. The report therefore does not claim that every chart, API call, or mobile layout was exercised interactively.

## Recommended fix order

1. **Remove fabricated trading status** from the open-position polling path.
2. **Separate market-data readiness from entry eligibility**, with per-symbol reasons from the backend.
3. **Make symbol identity explicit** in decision, signal history, and closed-trade history.
4. **De-duplicate position polling and guard overlapping refreshes.**
5. **Use real evaluation timestamps and visible stale/error indicators.**
6. **Improve closed-trade metadata** after verifying what the backend actually returns.
7. **Run browser-based smoke tests** on mobile and desktop after the fixes.

## Audit boundary

This report assesses frontend code and deployment metadata only. It does not certify trading strategy quality, broker execution, position protection, P/L reconciliation, or profitability. Those require separate backend/broker verification.
