const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

let marketEngine = null;

function setMarketEngine(engine) {
  marketEngine = engine;
}

function notifyMarket(method, value, extra) {
  try {
    if (
      marketEngine &&
      typeof marketEngine[method] === "function"
    ) {
      marketEngine[method](
        value,
        extra
      );
    }
  } catch (err) {
    console.error(
      "M5 market engine error:",
      err.message
    );
  }
}

const pendingRequests = new Map();

const state = {
  accessToken: null,
  refreshToken: null,
  expiresAt: 0,
  accountId: null,
  account: null,
  symbolId: null,
  symbolName: null,
  bid: null,
  ask: null,
  connected: false,
  authorized: false,
  lastUpdate: null,
  error: null,
  ws: null,
  accountCandidates: [],
  accountCandidateIndex: 0
};

const CLIENT_ID = process.env.CTRADER_CLIENT_ID;
const CLIENT_SECRET = process.env.CTRADER_CLIENT_SECRET;
const REDIRECT_URI =
  process.env.CTRADER_REDIRECT_URI ||
  "http://127.0.0.1:8787/auth/callback";

function safeError(err) {
  return err instanceof Error ? err.message : String(err);
}

async function reconcileTradeExecution(payload) {
  if (!dbPool || !payload) return;

  const clientMsgId =
    payload.clientMsgId ||
    payload.client_msg_id ||
    null;

  const orderId =
    payload.order?.orderId ||
    payload.orderId ||
    null;

  const positionId =
    payload.position?.positionId ||
    payload.positionId ||
    null;

  const executionPrice =
    payload.deal?.executionPrice ||
    payload.order?.executionPrice ||
    payload.position?.price ||
    null;

  const executionType = Number(payload.executionType);

  // cTrader ProtoOAExecutionType:
  // 2 = ORDER_ACCEPTED
  // 3 = ORDER_FILLED
  // 4 = ORDER_PARTIAL_FILL
  //
  // Only a filled/partial execution represents an opened
  // trading position. An accepted order is not yet OPEN.
  let tradeStatus = "ACCEPTED";

  if (executionType === 3) {
    tradeStatus = "OPEN";
  } else if (executionType === 4) {
    tradeStatus = "PARTIAL";
  }

  if (!clientMsgId) {
    console.log(
      "AURIXA execution received without clientMsgId; cannot match automatically"
    );
    return;
  }

  try {
    const result = await dbPool.query(
      `
      UPDATE aurixa.auto_trades
      SET
        order_id = COALESCE($2, order_id),
        position_id = COALESCE($3, position_id),
        signal_entry_price = COALESCE(signal_entry_price, $4),
        status = $5,
        opened_at = CASE
          WHEN $5 IN ('OPEN', 'PARTIAL')
            THEN COALESCE(opened_at, NOW())
          ELSE opened_at
        END,
        error = NULL
      WHERE client_msg_id = $1
      RETURNING
        id,
        signal_id,
        order_id,
        position_id,
        signal_entry_price,
        status
      `,
      [
        clientMsgId,
        orderId,
        positionId,
        executionPrice,
        tradeStatus
      ]
    );

    if (result.rows.length) {
      console.log(
        "AURIXA_TRADE_RECONCILED:",
        JSON.stringify(result.rows[0])
      );
    } else {
      console.log(
        "AURIXA execution clientMsgId not found:",
        clientMsgId
      );
    }
  } catch (err) {
    console.error(
      "AURIXA trade reconciliation error:",
      safeError(err)
    );
  }
}

function send(ws, payloadType, payload = {}, clientMsgId = null) {
  if (!ws || ws.readyState !== 1) {
    throw new Error("cTrader WebSocket is not connected");
  }

  const id = clientMsgId || crypto.randomUUID();

  ws.send(JSON.stringify({
    clientMsgId: id,
    payloadType,
    payload
  }));

  return id;
}

function request(
  ws,
  payloadType,
  payload = {},
  timeoutMs = 10000,
  options = {}
) {
  if (!ws || ws.readyState !== 1) {
    return Promise.reject(
      new Error("cTrader WebSocket is not connected")
    );
  }

  const clientMsgId = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(clientMsgId);
      reject(new Error(
        `cTrader request timeout: payloadType=${payloadType}`
      ));
    }, timeoutMs);

    pendingRequests.set(clientMsgId, {
      resolve,
      reject,
      timer,
      payloadType,
      clientMsgId,
      waitForExecution: options.waitForExecution === true
    });

    try {
      send(ws, payloadType, payload, clientMsgId);
    } catch (err) {
      clearTimeout(timer);
      pendingRequests.delete(clientMsgId);
      reject(err);
    }
  });
}


const TOKEN_FILE = path.join(__dirname, "..", ".ctrader-tokens.json");

const DATABASE_URL =
  process.env.AURIXA_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "";

const dbPool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes("render.com")
        ? { rejectUnauthorized: false }
        : undefined,
      max: 2
    })
  : null;

let dbReady = false;

async function initTokenStorage() {
  if (!dbPool) {
    console.log(
      "AURIXA storage: database URL not configured; using local token file"
    );
    return false;
  }

  try {
    await dbPool.query("CREATE SCHEMA IF NOT EXISTS aurixa");

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS aurixa.ctrader_tokens (
        id INTEGER PRIMARY KEY,
        refresh_token TEXT NOT NULL,
        access_token TEXT,
        expires_at BIGINT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    dbReady = true;
    console.log("AURIXA storage: aurixa.ctrader_tokens ready");
    return true;
  } catch (err) {
    dbReady = false;
    console.error("AURIXA storage initialization failed:", safeError(err));
    return false;
  }
}

async function saveTokens() {
  if (!state.refreshToken) return;

  if (dbReady) {
    try {
      await dbPool.query(
        `INSERT INTO aurixa.ctrader_tokens
          (id, refresh_token, access_token, expires_at, updated_at)
         VALUES (1, $1, $2, $3, NOW())
         ON CONFLICT (id)
         DO UPDATE SET
           refresh_token = EXCLUDED.refresh_token,
           access_token = EXCLUDED.access_token,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()`,
        [
          state.refreshToken,
          state.accessToken,
          Number(state.expiresAt || 0)
        ]
      );
      return;
    } catch (err) {
      console.error("AURIXA storage save failed:", safeError(err));
    }
  }

  try {
    fs.writeFileSync(
      TOKEN_FILE,
      JSON.stringify({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        expiresAt: state.expiresAt
      }),
      { mode: 0o600 }
    );
  } catch (err) {
    console.error("Local cTrader token save failed:", safeError(err));
  }
}

async function loadTokens() {
  if (dbReady) {
    try {
      const result = await dbPool.query(
        `SELECT access_token, refresh_token, expires_at
         FROM aurixa.ctrader_tokens
         WHERE id = 1
         LIMIT 1`
      );

      const row = result.rows[0];

      if (row?.refresh_token) {
        state.accessToken = row.access_token || null;
        state.refreshToken = row.refresh_token;
        state.expiresAt = Number(row.expires_at || 0);
        return true;
      }
    } catch (err) {
      console.error("AURIXA storage load failed:", safeError(err));
    }
  }

  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));

    if (data.refreshToken) {
      state.accessToken = data.accessToken || null;
      state.refreshToken = data.refreshToken;
      state.expiresAt = Number(data.expiresAt || 0);
      return true;
    }
  } catch {}

  return false;
}

async function refreshAccessToken() {
  if (!state.refreshToken) return false;

  const url = new URL("https://openapi.ctrader.com/apps/token");

  url.searchParams.set("grant_type", "refresh_token");
  url.searchParams.set("refresh_token", state.refreshToken);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("client_secret", CLIENT_SECRET);

  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" }
  });

  const data = await response.json();

  if (!response.ok || data.errorCode || !data.accessToken) {
    throw new Error(
      data.description ||
      data.errorCode ||
      "Token refresh failed"
    );
  }

  state.accessToken = data.accessToken;
  state.refreshToken = data.refreshToken || state.refreshToken;
  state.expiresAt =
    Date.now() + Number(data.expiresIn || 0) * 1000;

  await saveTokens();

  return true;
}

async function exchangeCode(code) {
  const url = new URL("https://openapi.ctrader.com/apps/token");

  url.searchParams.set("grant_type", "authorization_code");
  url.searchParams.set("code", code);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("client_secret", CLIENT_SECRET);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  const data = await response.json();

  if (!response.ok || data.errorCode || !data.accessToken) {
    throw new Error(
      data.description ||
      data.errorCode ||
      `Token exchange failed (${response.status})`
    );
  }

  state.accessToken = data.accessToken;
  state.refreshToken = data.refreshToken || null;
  state.expiresAt = Date.now() + Number(data.expiresIn || 0) * 1000;
  await saveTokens();

  return data;
}


function trendbarToCandle(bar) {
  if (!bar) return null;

  const lowRaw = Number(bar.low);
  const deltaOpen = Number(bar.deltaOpen || 0);
  const deltaClose = Number(bar.deltaClose || 0);
  const deltaHigh = Number(bar.deltaHigh || 0);

  if (!Number.isFinite(lowRaw)) return null;

  const scale = 100000;

  const low = lowRaw / scale;
  const open = (lowRaw + deltaOpen) / scale;
  const close = (lowRaw + deltaClose) / scale;
  const high = (lowRaw + deltaHigh) / scale;

  const minute = Number(bar.utcTimestampInMinutes);

  if (!Number.isFinite(minute)) return null;

  return {
    time: minute,
    open,
    high,
    low,
    close,
    volume:
      bar.volume == null
        ? null
        : Number(bar.volume)
  };
}

function feedHistoricalTrendbars(bars) {
  if (!marketEngine || !Array.isArray(bars)) {
    console.warn("cTrader: historical M5 bars unavailable");
    return;
  }

  console.log(
    "cTrader: received historical M5 bars:",
    bars.length
  );

  const candles = bars
    .map(trendbarToCandle)
    .filter(Boolean)
    .sort((a, b) => Number(a.time) - Number(b.time));

  console.log(
    "cTrader: converted historical M5 candles:",
    candles.length
  );

  if (!candles.length) {
    console.warn(
      "cTrader: historical M5 response contained no valid candles"
    );
    return;
  }

  const unique = [];
  const seen = new Set();

  for (const candle of candles) {
    const key = String(candle.time);

    if (seen.has(key)) continue;

    seen.add(key);
    unique.push(candle);
  }

  console.log(
    "cTrader: feeding unique historical M5 candles:",
    unique.length
  );

  marketEngine.setHistoricalCandles(unique);

  const state = marketEngine.getState();

  console.log(
    "cTrader: market engine candle count after historical load:",
    state.candleCount
  );
}

function feedLiveTrendbars(bars) {
  if (!marketEngine || !Array.isArray(bars)) return;

  for (const bar of bars) {
    const candle = trendbarToCandle(bar);

    if (!candle) continue;

    marketEngine.updateLiveCandle(candle);
  }
}

function connectOpenApi() {
  return new Promise((resolve, reject) => {
    if (state.ws && state.ws.readyState === 1) {
      return resolve();
    }

    if (typeof WebSocket === "undefined") {
      return reject(
        new Error("Node WebSocket API is unavailable in this Node runtime")
      );
    }

    const isLive =
      state.account?.isLive === true;

    const host = isLive
      ? "live.ctraderapi.com"
      : "demo.ctraderapi.com";

    console.log(
      `cTrader: connecting to ${host} for account ${state.accountId || "unknown"}`
    );

    const ws = new WebSocket(`wss://${host}:5036`);
    state.ws = ws;

    let settled = false;

    const fail = (err) => {
      state.connected = false;
      state.authorized = false;
      state.error = safeError(err);

      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    ws.addEventListener("open", () => {
      state.connected = true;
      state.error = null;

      try {
        // ProtoOAApplicationAuthReq
        send(ws, 2100, {
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET
        });
      } catch (err) {
        fail(err);
      }
    });

    ws.addEventListener("error", event => {
      fail(new Error("cTrader WebSocket error"));
    });

    ws.addEventListener("close", () => {
      state.connected = false;
      state.authorized = false;
      state.ws = null;

      console.log(
        "cTrader WebSocket closed; reconnecting in 5 seconds..."
      );

      setTimeout(() => {
        restoreCTraderSession().catch(err => {
          state.error = safeError(err);
          console.error(
            "cTrader reconnect failed:",
            err.message
          );
        });
      }, 5000);
    });

    ws.addEventListener("message", async event => {
      try {
        const raw =
          typeof event.data === "string"
            ? event.data
            : Buffer.from(await event.data.arrayBuffer()).toString("utf8");

        const msg = JSON.parse(raw);
        const payload = msg.payload || {};

        // Never dump complete cTrader payloads in production logs.
        const payloadType = Number(msg.payloadType);

        // Do NOT resolve a pending 2106 order here.
        // 2106 is completed by the specialized 2126 execution handler
        // or rejected by the specialized 2132 order-error handler.
        // Resolving it here first removes the pending request before those
        // handlers can reconcile the PostgreSQL auto_trades record.

        if (
          msg.clientMsgId &&
          pendingRequests.has(msg.clientMsgId) &&
          payloadType !== 2126 &&
          payloadType !== 2132
        ) {
          const pending = pendingRequests.get(msg.clientMsgId);

          // Trade requests must wait for the actual 2126 execution event.
          if (!pending.waitForExecution) {
            clearTimeout(pending.timer);
            pendingRequests.delete(msg.clientMsgId);
            pending.resolve(msg);
          }
        }

        // ProtoOAApplicationAuthRes
        if (msg.payloadType === 2101) {
          // Application authorization succeeded.
          // Account authorization happens separately.
          state.error = null;

          // ProtoOAGetAccountListByAccessTokenReq
          send(ws, 2149, {
            accessToken: state.accessToken
          });
          return;
        }

        // ProtoOAGetAccountListByAccessTokenRes
        if (msg.payloadType === 2150) {
          const accounts = payload.ctidTraderAccount || [];

          if (!accounts.length) {
            throw new Error("No cTrader accounts were granted to AURIXA AI");
          }

          const liveAccounts = accounts.filter(a => a.isLive === true);
          const configuredId = String(
            process.env.CTRADER_ACCOUNT_ID || ""
          ).trim();

          const ordered = configuredId
            ? [
                ...accounts.filter(
                  a => String(a.ctidTraderAccountId) === configuredId
                ),
                ...liveAccounts.filter(
                  a => String(a.ctidTraderAccountId) !== configuredId
                ),
                ...accounts.filter(
                  a =>
                    String(a.ctidTraderAccountId) !== configuredId &&
                    !a.isLive
                )
              ]
            : [
                ...liveAccounts,
                ...accounts.filter(a => !a.isLive)
              ];

                    state.accountCandidates = ordered;
          state.accountCandidateIndex = 0;

          const preferred = ordered[0];

          state.account = preferred;
          state.accountId = String(
            preferred.ctidTraderAccountId
          );

          // Account environment must match WebSocket environment.
          const preferredIsLive = preferred.isLive === true;

          const currentHostIsLive =
            String(
              ws.url ||
              state.ws?.url ||
              ""
            ).includes("live.ctraderapi.com");

          if (preferredIsLive !== currentHostIsLive) {
            console.log(
              "cTrader: switching endpoint for selected account",
              state.accountId,
              preferredIsLive ? "LIVE" : "DEMO"
            );

            try {
              ws.close();
            } catch {}

            return;
          }

          // ProtoOAAccountAuthReq
          send(ws, 2102, {
            ctidTraderAccountId: Number(state.accountId),
            accessToken: state.accessToken
          });
          return;
        }

        // AURIXA trade execution event.
        if (payloadType === 2126) {
          const executionType = Number(payload.executionType);

          console.log(
            "AURIXA_CTRADER_EXECUTION:",
            JSON.stringify({
              clientMsgId: msg.clientMsgId || payload.clientMsgId || null,
              executionType,
              orderId: payload.order?.orderId || null,
              positionId: payload.position?.positionId || null,
              dealId: payload.deal?.dealId || null,
              executionPrice:
                payload.deal?.executionPrice ||
                payload.order?.executionPrice ||
                payload.position?.price ||
                null
            })
          );

          let responseClientMsgId =
            msg.clientMsgId ||
            payload.clientMsgId ||
            null;

          if (!responseClientMsgId) {
            const pendingOrder = [...pendingRequests.entries()]
              .find(([, pending]) =>
                Number(pending.payloadType) === 2106 &&
                pending.waitForExecution === true
              );

            if (pendingOrder) {
              const [pendingId] = pendingOrder;
              responseClientMsgId = pendingId;
            }
          }

          const orderId =
            payload.order?.orderId ||
            payload.orderId ||
            null;

          const positionId =
            payload.position?.positionId ||
            payload.positionId ||
            null;

          const executionPrice =
            payload.deal?.executionPrice ||
            payload.order?.executionPrice ||
            payload.position?.price ||
            null;

          // Never classify an execution event with no usable order/position
          // reference as a confirmed order.
          if (!orderId && !positionId) {
            console.error(
              "AURIXA_CTRADER_EXECUTION_AMBIGUOUS:",
              JSON.stringify({
                clientMsgId: responseClientMsgId,
                executionType,
                orderId: null,
                positionId: null,
                dealId: payload.deal?.dealId || null,
                executionPrice
              })
            );

            if (responseClientMsgId) {
              await reconcileTradeExecution({
                ...payload,
                clientMsgId: responseClientMsgId
              });
            }

            return;
          }

          await reconcileTradeExecution({
            ...payload,
            clientMsgId: responseClientMsgId
          });

          // Trade requests are resolved only by a real execution event.
          if (
            responseClientMsgId &&
            pendingRequests.has(responseClientMsgId)
          ) {
            const pending = pendingRequests.get(responseClientMsgId);

            if (
              pending.waitForExecution &&
              (
                Number(pending.payloadType) === 2106 ||
                Number(pending.payloadType) === 2111
              )
            ) {
              // 3 = ORDER_FILLED
              // 4 = PARTIAL_FILL
              if (executionType === 3 || executionType === 4) {
                clearTimeout(pending.timer);
                pendingRequests.delete(responseClientMsgId);
                pending.resolve(msg);
              }

              // Reject/cancel/error execution states.
              else if (
                executionType === 5 ||
                executionType === 6 ||
                executionType === 7 ||
                executionType === 8 ||
                executionType === 9 ||
                executionType === 10
              ) {
                clearTimeout(pending.timer);
                pendingRequests.delete(responseClientMsgId);

                const failure =
                  payload.description ||
                  payload.errorCode ||
                  `cTrader order execution failed: executionType=${executionType}`;

                pending.reject(new Error(failure));
              }
            }
          }

          return;
        }

        // AURIXA order error event.
        if (payloadType === 2132) {
          let clientMsgId =
            msg.clientMsgId ||
            payload.clientMsgId ||
            null;

          const errorCode =
            payload.errorCode || "UNKNOWN";

          const description =
            payload.description || null;

          console.error(
            "AURIXA_CTRADER_ORDER_ERROR:",
            JSON.stringify({
              clientMsgId,
              errorCode,
              description,
              orderId: payload.orderId || null,
              positionId: payload.positionId || null
            })
          );

          if (!clientMsgId) {
            const pendingOrder = [...pendingRequests.entries()]
              .find(([, pending]) => Number(pending.payloadType) === 2106);

            if (pendingOrder) {
              const [pendingId, pending] = pendingOrder;
              clientMsgId = pendingId;

              clearTimeout(pending.timer);
              pendingRequests.delete(pendingId);

              pending.reject(
                new Error(
                  `cTrader order rejected: ${errorCode}: ${description || "unknown error"}`
                )
              );
            }
          }

          if (dbPool && clientMsgId) {
            try {
              const result = await dbPool.query(
                `
                UPDATE aurixa.auto_trades
                SET
                  status = 'ERROR',
                  error = $2,
                  order_id = COALESCE($3, order_id),
                  position_id = COALESCE($4, position_id)
                WHERE client_msg_id = $1
                RETURNING id, signal_id, status, error
                `,
                [
                  clientMsgId,
                  `${errorCode}: ${description || "cTrader order rejected"}`,
                  payload.orderId || null,
                  payload.positionId || null
                ]
              );

              if (result.rows.length) {
                console.log(
                  "AURIXA_TRADE_ERROR_RECONCILED:",
                  JSON.stringify(result.rows[0])
                );
              }
            } catch (err) {
              console.error(
                "AURIXA trade error reconciliation failed:",
                safeError(err)
              );
            }
          }

          return;
        }

        // ProtoOAErrorRes
        if (msg.payloadType === 2142) {
          const code =
            payload.errorCode || "UNKNOWN_ERROR";

          const description =
            payload.description ||
            "cTrader account request failed";

          console.error(
            "cTrader ERROR:",
            code,
            description
          );

          if (code === "RET_ACCOUNT_DISABLED") {
            const nextIndex =
              state.accountCandidateIndex + 1;

            if (
              nextIndex <
              state.accountCandidates.length
            ) {
              state.accountCandidateIndex =
                nextIndex;

              const next =
                state.accountCandidates[nextIndex];

              state.account = next;
              state.accountId =
                String(next.ctidTraderAccountId);

              state.symbolId = null;
              state.symbolName = null;
              state.bid = null;
              state.ask = null;
              state.lastUpdate = null;

              state.error =
                "Account " +
                state.accountId +
                " disabled; trying another authorized FxPro account";

              console.log(
                "cTrader: trying next account",
                state.accountId
              );

              send(ws, 2102, {
                ctidTraderAccountId:
                  Number(state.accountId),
                accessToken:
                  state.accessToken
              });

              return;
            }
          }

          state.authorized = false;
          state.error =
            "cTrader " +
            code +
            ": " +
            description;

          if (!settled) {
            settled = true;
            reject(
              new Error(state.error)
            );
          }

          return;
        }

        // ProtoOAAccountAuthRes
        if (msg.payloadType === 2103) {
          state.authorized = true;
          state.accountId = String(payload.ctidTraderAccountId);

          console.log(
            "cTrader: account authorized, requesting symbol list for",
            state.accountId
          );

          // ProtoOASymbolsListReq
          send(ws, 2114, {
            ctidTraderAccountId: Number(state.accountId),
            includeArchivedSymbols: false
          });
          return;
        }

        // ProtoOASymbolsListRes
        if (msg.payloadType === 2115) {
          // Production: do not log full symbol response.
          const symbols = Array.isArray(payload.symbol)
            ? payload.symbol
            : [];

          console.log(
            "cTrader: received",
            symbols.length,
            "symbols"
          );

          console.log(
            "cTrader: first symbols:",
            symbols
              .slice(0, 20)
              .map(s => ({
                id: s.symbolId,
                name: s.symbolName
              }))
          );

          const exact = symbols.find(
            s => String(s.symbolName || "").toUpperCase() === "XAUUSD"
          );

          const fallback = symbols.find(
            s => String(s.symbolName || "").toUpperCase().includes("XAUUSD")
          );

          const symbol = exact || fallback;

          if (!symbol) {
            const available = symbols
              .map(s => String(s.symbolName || ""))
              .filter(Boolean)
              .slice(0, 100);

            throw new Error(
              "XAUUSD was not found. Available symbols: " +
              available.join(", ")
            );
          }

          state.symbolId = Number(symbol.symbolId);
          state.symbolName = symbol.symbolName || "XAUUSD";

          // ProtoOASubscribeSpotsReq
          send(ws, 2127, {
            ctidTraderAccountId: Number(state.accountId),
            symbolId: [state.symbolId],
            subscribeToSpotTimestamp: true
          });

          // ProtoOASubscribeLiveTrendbarReq
          // Subscribe to live XAUUSD M5 candles.
          send(ws, 2135, {
            ctidTraderAccountId: Number(state.accountId),
            symbolId: Number(state.symbolId),
            period: 5
          });

          // ProtoOAGetTrendbarsReq
          // Request the latest 300 XAUUSD M5 candles.
          // Using toTimestamp + count avoids an unnecessarily
          // wide historical time range.
          const now = Date.now();

          // Use a bounded historical window.
          // Two days provides more than 300 M5 candles.
          const fromTimestamp =
            now - (2 * 24 * 60 * 60 * 1000);

          const historicalRequest = {
            ctidTraderAccountId: Number(state.accountId),
            symbolId: Number(state.symbolId),
            period: 5,
            count: 300,
            fromTimestamp,
            toTimestamp: now
          };

          console.log(
            "AURIXA_HISTORICAL_REQUEST:",
            JSON.stringify({
              payloadType: 2137,
              accountId: historicalRequest.ctidTraderAccountId,
              symbolId: historicalRequest.symbolId,
              period: historicalRequest.period,
              count: historicalRequest.count,
              toTimestamp: historicalRequest.toTimestamp
            })
          );

          send(ws, 2137, historicalRequest);

          // Resolve connection once the symbol and
          // live spot stream are established.
          if (!settled) {
            settled = true;
            resolve();
          }

          return;
        }

        // ProtoOAGetTrendbarsRes
        // Historical XAUUSD M5 candles.
        if (payloadType === 2138) {
          const bars = Array.isArray(payload.trendbar)
            ? payload.trendbar
            : [];

          console.log(
            "AURIXA_HISTORICAL_M5:",
            JSON.stringify({
              payloadType: Number(msg.payloadType),
              payloadKeys: Object.keys(payload),
              barCount: bars.length,
              firstBarKeys: bars.length
                ? Object.keys(bars[0])
                : []
            })
          );

          if (bars.length) {
            console.log(
              "cTrader: historical payload fields:",
              Object.keys(payload)
            );

            console.log(
              "cTrader: historical trendbar fields:",
              Object.keys(bars[0])
            );
          }

          feedHistoricalTrendbars(bars);
          return;
        }

        // ProtoOASpotEvent
        // cTrader delivers live trendbars INSIDE the SpotEvent.
        // The trendbar field contains the current/live M5 bar data.
        if (msg.payloadType === 2131) {
          if (
            state.symbolId !== null &&
            Number(payload.symbolId) !== state.symbolId
          ) {
            return;
          }

          // ------------------------------------------------------------
          // LIVE BID / ASK
          // ------------------------------------------------------------
          if (payload.bid !== undefined) {
            const bid = Number(payload.bid) / 100000;

            if (Number.isFinite(bid) && bid > 0) {
              state.bid = bid;
            }
          }

          if (payload.ask !== undefined) {
            const ask = Number(payload.ask) / 100000;

            if (Number.isFinite(ask) && ask > 0) {
              state.ask = ask;
            }
          }

          // ------------------------------------------------------------
          // LIVE M5 TRENDBARS
          //
          // ProtoOASpotEvent.trendbar is repeated, so normalize it
          // to an array before feeding the market engine.
          // ------------------------------------------------------------
          if (Array.isArray(payload.trendbar) && payload.trendbar.length) {
            const bars = payload.trendbar;

            console.log(
              "AURIXA_LIVE_M5:",
              JSON.stringify({
                symbolId: Number(payload.symbolId),
                barCount: bars.length,
                bars: bars.map(bar => ({
                  time: bar.utcTimestampInMinutes,
                  low: bar.low,
                  deltaOpen: bar.deltaOpen,
                  deltaClose: bar.deltaClose,
                  deltaHigh: bar.deltaHigh,
                  volume: bar.volume
                }))
              })
            );

            feedLiveTrendbars(bars);
          }

          // ------------------------------------------------------------
          // UPDATE LAST LIVE SPOT TIME
          // ------------------------------------------------------------
          state.lastUpdate =
            payload.timestamp
              ? new Date(Number(payload.timestamp)).toISOString()
              : new Date().toISOString();

          return;
        }

      } catch (err) {
        state.error = safeError(err);

        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    });
  });
}


async function restoreCTraderSession() {
  await initTokenStorage();
  await loadTokens();

  if (!state.accessToken) {
    console.log("cTrader: no saved OAuth token; authorization required");
    return;
  }

  try {
    if (!state.expiresAt || Date.now() >= state.expiresAt - 60000) {
      if (!state.refreshToken) {
        console.log("cTrader: saved access token expired and no refresh token");
        return;
      }
      console.log("cTrader: refreshing saved OAuth token...");
      await refreshAccessToken();
    }

    console.log("cTrader: restoring saved session...");
    await connectOpenApi();
  } catch (err) {
    state.error = err.message;
    console.error("cTrader session restore failed:", err.message);
  }
}


async function getDatabaseHealth() {
  const checkedAt = new Date().toISOString();

  if (!dbPool) {
    return {
      status: "NOT_CONFIGURED",
      connected: false,
      provider: "postgresql",
      schema: "aurixa",
      table: "ctrader_tokens",
      tokenStored: false,
      latencyMs: null,
      checkedAt,
      detail: "Database URL is not configured"
    };
  }

  const started = Date.now();

  try {
    const result = await dbPool.query(
      "SELECT " +
      "EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'aurixa') AS schema_exists, " +
      "EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'aurixa' AND table_name = 'ctrader_tokens') AS table_exists, " +
      "EXISTS (SELECT 1 FROM aurixa.ctrader_tokens WHERE id = 1) AS token_stored"
    );

    const row = result.rows[0] || {};

    return {
      status: "HEALTHY",
      connected: true,
      provider: "postgresql",
      schema: "aurixa",
      table: "ctrader_tokens",
      schemaReady: row.schema_exists === true,
      tableReady: row.table_exists === true,
      tokenStored: row.token_stored === true,
      latencyMs: Date.now() - started,
      checkedAt,
      detail: "Live PostgreSQL health check passed"
    };
  } catch (err) {
    return {
      status: "ERROR",
      connected: false,
      provider: "postgresql",
      schema: "aurixa",
      table: "ctrader_tokens",
      tokenStored: false,
      latencyMs: Date.now() - started,
      checkedAt,
      detail: safeError(err)
    };
  }
}

function registerCTrader(app) {
  setTimeout(() => restoreCTraderSession(), 500);

  app.get("/auth/login", (req, res) => {
    if (!CLIENT_ID || !CLIENT_SECRET) {
      return res.status(500).send("cTrader credentials are not configured.");
    }

    const url = new URL(
      "https://id.ctrader.com/my/settings/openapi/grantingaccess/"
    );

    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("scope", "trading");
    url.searchParams.set("product", "web");

    res.redirect(url.toString());
  });

  app.get("/auth/callback", async (req, res) => {
    try {
      if (req.query.error) {
        throw new Error(
          `${req.query.error}: ${req.query.description || "authorization denied"}`
        );
      }

      const code = req.query.code;

      if (!code) {
        throw new Error("cTrader authorization code was not received");
      }

      await exchangeCode(code);
      await connectOpenApi();

      res.redirect("/?ctrader=connected");
    } catch (err) {
      state.error = safeError(err);

      res.status(500).send(`
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <title>AURIXA AI - cTrader</title>
          <style>
            body{
              background:#050505;
              color:#fff;
              font-family:Arial,sans-serif;
              padding:30px;
            }
            .box{
              max-width:600px;
              margin:auto;
              background:#101010;
              border:1px solid #292929;
              border-radius:18px;
              padding:24px;
            }
            h2{color:#d8b35a}
            code{color:#aaa;word-break:break-word}
          </style>
        </head>
        <body>
          <div class="box">
            <h2>AURIXA AI cTrader connection failed</h2>
            <p>${safeError(err)}</p>
            <p>Return to the AURIXA AI app and try again after correcting the cTrader application settings.</p>
          </div>
        </body>
        </html>
      `);
    }
  });

  app.get("/api/ctrader/status", (req, res) => {
    res.json({
      configured: Boolean(CLIENT_ID && CLIENT_SECRET),
      connected: state.connected,
      authorized: state.authorized,
      accountId: state.accountId,
      account: state.account
        ? {
            ctidTraderAccountId: state.account.ctidTraderAccountId,
            traderLogin: state.account.traderLogin,
            brokerTitleShort: state.account.brokerTitleShort,
            isLive: state.account.isLive
          }
        : null,
      symbol: state.symbolName,
      symbolId: state.symbolId,
      bid: state.bid,
      ask: state.ask,
      mid:
        state.bid !== null && state.ask !== null
          ? (state.bid + state.ask) / 2
          : null,
      lastUpdate: state.lastUpdate,
      error: state.error,
      autoTrading: false,
      paperTrading: true
    });
  });
}

async function getOpenXAUUSDPositions() {
  if (!state.ws || state.ws.readyState !== 1) {
    throw new Error("cTrader WebSocket is not connected");
  }

  if (!state.connected || !state.authorized || !state.accountId) {
    throw new Error("cTrader account is not authorized");
  }

  const msg = await request(
    state.ws,
    2124,
    {
      ctidTraderAccountId: Number(state.accountId),
      returnProtectionOrders: false
    },
    10000
  );

  const payload = msg.payload || {};
  const positions = Array.isArray(payload.position)
    ? payload.position
    : [];

  return positions.filter(position => {
    const symbolId = Number(position?.tradeData?.symbolId);
    const positionStatus = Number(position?.positionStatus);

    return (
      symbolId === Number(state.symbolId) &&
      positionStatus === 1
    );
  });
}

async function inspectOpenXAUUSDPositions() {
  if (!state.ws || state.ws.readyState !== 1) {
    throw new Error("cTrader WebSocket is not connected");
  }

  if (!state.connected || !state.authorized || !state.accountId) {
    throw new Error("cTrader account is not authorized");
  }

  const msg = await request(
    state.ws,
    2124,
    {
      ctidTraderAccountId: Number(state.accountId),
      returnProtectionOrders: false
    },
    10000
  );

  const payload = msg.payload || {};
  const positions = Array.isArray(payload.position)
    ? payload.position
    : [];

  return positions.filter(position => {
    const symbolId = Number(position?.tradeData?.symbolId);
    const positionStatus = Number(position?.positionStatus);

    return (
      symbolId === Number(state.symbolId) &&
      positionStatus === 1
    );
  });
}

async function placeDemoMarketOrder({
  direction,
  volume,
  stopLossDistance,
  takeProfitDistance = 0
}) {
  if (!state.ws || state.ws.readyState !== 1) {
    throw new Error("cTrader WebSocket is not connected");
  }

  if (!state.connected || !state.authorized) {
    throw new Error("cTrader account is not authorized");
  }

  // Absolute demo-only protection.
  if (state.account?.isLive === true) {
    throw new Error("LIVE ACCOUNT BLOCKED: demo auto-trading only");
  }

  if (state.account?.isLive !== false) {
    throw new Error("ACCOUNT ENVIRONMENT UNKNOWN");
  }

  if (String(state.symbolName || "").toUpperCase() !== "XAUUSD") {
    throw new Error("XAUUSD is not the active trading symbol");
  }

  if (!Number.isInteger(Number(volume)) || Number(volume) <= 0) {
    throw new Error("Invalid cTrader volume");
  }

  if (
    !Number.isFinite(Number(stopLossDistance)) ||
    Number(stopLossDistance) <= 0
  ) {
    throw new Error("A positive stop-loss distance is required");
  }

  const openPositions = await getOpenXAUUSDPositions();

  if (openPositions.length >= 1) {
    throw new Error("Maximum XAUUSD position limit reached");
  }

  const tradeSide =
    direction === "BUY"
      ? 1
      : direction === "SELL"
        ? 2
        : null;

  if (!tradeSide) {
    throw new Error("Invalid trade direction");
  }

  const payload = {
    ctidTraderAccountId: Number(state.accountId),
    symbolId: Number(state.symbolId),
    orderType: 1,
    tradeSide,
    volume: Number(volume),
    relativeStopLoss: Math.round(
      Number(stopLossDistance) * 100000
    ),
    label: "AURIXA-DEMO-V1",
    comment: "AURIXA closed-candle demo signal"
  };

  if (Number(takeProfitDistance) > 0) {
    payload.relativeTakeProfit = Math.round(
      Number(takeProfitDistance) * 100000
    );
  }

  // 2106 is asynchronous. Do not treat an intermediary response
  // as an executed trade. Wait for 2126 execution confirmation.
  const response = await request(
    state.ws,
    2106,
    payload,
    20000,
    { waitForExecution: true }
  );

  const responsePayload = response?.payload || {};

  const orderId =
    responsePayload.order?.orderId ||
    responsePayload.orderId ||
    null;

  const positionId =
    responsePayload.position?.positionId ||
    responsePayload.positionId ||
    null;

  const executionPrice =
    responsePayload.deal?.executionPrice ||
    responsePayload.order?.executionPrice ||
    responsePayload.position?.price ||
    null;

  if (!orderId && !positionId) {
    throw new Error(
      "cTrader reported execution without an orderId or positionId"
    );
  }

  const executionType = Number(responsePayload.executionType);

  return {
    status: executionType === 4 ? "PARTIAL" : "OPEN",
    clientMsgId: response?.clientMsgId || null,
    orderId,
    positionId,
    executionPrice,
    volume: Number(volume),
    direction,
    stopLossDistance: Number(stopLossDistance),
    takeProfitDistance: Number(takeProfitDistance) || 0
  };
}


async function closeXAUUSDPosition(positionId, volume) {
  if (!state.ws || state.ws.readyState !== 1) {
    throw new Error("cTrader WebSocket is not connected");
  }

  if (!state.connected || !state.authorized || !state.accountId) {
    throw new Error("cTrader account is not authorized");
  }

  if (state.account?.isLive === true) {
    throw new Error("LIVE ACCOUNT BLOCKED: demo auto-trading only");
  }

  if (state.account?.isLive !== false) {
    throw new Error("ACCOUNT ENVIRONMENT UNKNOWN");
  }

  const pid = Number(positionId);
  const vol = Number(volume);

  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error("Invalid cTrader position ID");
  }

  if (!Number.isInteger(vol) || vol <= 0) {
    throw new Error("Invalid cTrader close volume");
  }

  const response = await request(
    state.ws,
    2111,
    {
      ctidTraderAccountId: Number(state.accountId),
      positionId: pid,
      volume: vol
    },
    15000
  );

  const payload = response?.payload || {};

  return {
    status: "CLOSED",
    clientMsgId: response?.clientMsgId || null,
    positionId: pid,
    volume: vol,
    orderId:
      payload.order?.orderId ||
      payload.orderId ||
      null,
    executionPrice:
      payload.deal?.executionPrice ||
      payload.order?.executionPrice ||
      payload.position?.price ||
      null
  };
}

function getCTraderStatus() {
  return {
    configured: Boolean(CLIENT_ID && CLIENT_SECRET),
    connected: state.connected,
    authorized: state.authorized,
    accountId: state.accountId,
    account: state.account ? { ctidTraderAccountId: state.account.ctidTraderAccountId, traderLogin: state.account.traderLogin, brokerTitleShort: state.account.brokerTitleShort, isLive: state.account.isLive } : null,
    symbol: state.symbolName,
    symbolId: state.symbolId,
    bid: state.bid,
    ask: state.ask,
    mid: state.bid !== null && state.ask !== null ? (state.bid + state.ask) / 2 : null,
    lastUpdate: state.lastUpdate,
    error: state.error,
    autoTrading: false,
    paperTrading: true
  };
}

async function queryDatabase(text, params = []) {
  if (!dbPool) {
    throw new Error("Database URL is not configured");
  }

  return dbPool.query(text, params);
}

module.exports = {
  registerCTrader,
  getCTraderStatus,
  setMarketEngine,
  getDatabaseHealth,
  queryDatabase,
  getOpenXAUUSDPositions,
  inspectOpenXAUUSDPositions,
  closeXAUUSDPosition,
  placeDemoMarketOrder
};
