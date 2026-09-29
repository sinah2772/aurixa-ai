const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

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

function send(ws, payloadType, payload = {}) {
  if (!ws || ws.readyState !== 1) {
    throw new Error("cTrader WebSocket is not connected");
  }

  ws.send(JSON.stringify({
    clientMsgId: crypto.randomUUID(),
    payloadType,
    payload
  }));
}


const TOKEN_FILE = path.join(__dirname, "..", ".ctrader-tokens.json");

function saveTokens() {
  if (!state.refreshToken) return;

  fs.writeFileSync(
    TOKEN_FILE,
    JSON.stringify({
      accessToken: state.accessToken,
      refreshToken: state.refreshToken,
      expiresAt: state.expiresAt
    }),
    { mode: 0o600 }
  );
}

function loadTokens() {
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

  saveTokens();

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
  saveTokens();

  return data;
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

        const safePayloadObject = JSON.parse(
          JSON.stringify(payload)
        );

        for (const key of [
          "accessToken",
          "refreshToken",
          "clientSecret",
          "clientId"
        ]) {
          if (safePayloadObject[key]) {
            safePayloadObject[key] = "[redacted]";
          }
        }

        const safePayload = JSON.stringify(
          safePayloadObject
        );

        console.log(
          "cTrader RX:",
          msg.payloadType,
          safePayload.slice(0, 1200)
        );

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
          console.log("cTrader SYMBOLS RESPONSE:", JSON.stringify(payload));
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

          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }

        // ProtoOASpotEvent
        if (msg.payloadType === 2131) {
          if (
            state.symbolId !== null &&
            Number(payload.symbolId) !== state.symbolId
          ) {
            return;
          }

          if (payload.bid !== undefined) {
            state.bid = Number(payload.bid) / 100000;
          }

          if (payload.ask !== undefined) {
            state.ask = Number(payload.ask) / 100000;
          }

          state.lastUpdate =
            payload.timestamp
              ? new Date(Number(payload.timestamp)).toISOString()
              : new Date().toISOString();
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
  loadTokens();

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
    url.searchParams.set("scope", "accounts");
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
      autoTrading: process.env.AUTO_TRADING === "true",
      paperTrading: process.env.PAPER_TRADING === "true"
    });
  });
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
    autoTrading: process.env.AUTO_TRADING === "true",
    paperTrading: process.env.PAPER_TRADING === "true"
  };
}

module.exports = {
  registerCTrader,
  getCTraderStatus
};
