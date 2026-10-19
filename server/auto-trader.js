"use strict";

/* AURIXA AI Auto-Trader V1
 * Execution-only layer for ai-trader-engine.
 * Demo-only by default. The AI engine decides; this module enforces execution gates.
 */

const { normalizeSymbolName, isSupportedSymbol, getSymbolProfile, SUPPORTED_SYMBOLS } = require("./symbol-support");
const brokerVolume = require("./broker-volume");
const positionRisk = require("./position-risk-response");
const rewardRisk = require("./reward-risk");
const openPositionIntelligence = require("./open-position-intelligence");
const breakevenStrategy = require("./breakeven-strategy");
const { evaluatePortfolioRisk } = require("./portfolio-risk-manager");
const entryClusterGuard = require("./entry-cluster-guard");

let cTrader=null, dbQuery=null, aiEngine=null;
const inFlightSignalKeys = new Set();
const reversalConfirmations = new Map();
const reversalCloseAttempts = new Map();
const profitDetectedPositions = new Set();
const lossWarningPositions = new Set();
const lastPositionManagementAuditAt = new Map();
const positionIntelligenceSnapshots = new Map();
const positionActionInFlight = new Set();
function logPositionManagementAudit(key, event, payload, intervalMs = 60000) {
  const now = Date.now();
  const last = lastPositionManagementAuditAt.get(key) || 0;
  if (now - last < intervalMs) return;
  lastPositionManagementAuditAt.set(key, now);
  console.log(event + ":", JSON.stringify(payload));
}
// One symbol is backfilled per scanner cycle to avoid hammering cTrader deal history.
let closedBackfillSymbolIndex = 0;
let lastClosedBackfillAt = 0;

function configure({ctrader,query,ai}){cTrader=ctrader;dbQuery=query;aiEngine=ai;}

function getPositionIntelligence(positionId) {
  const value = positionIntelligenceSnapshots.get(String(positionId));
  return value ? { ...value } : null;
}

function isRealizedClosingDeal(deal, positionId) {
  const dealPosition = Number(deal?.positionId);
  const statusRaw = deal?.dealStatus;
  const status = statusRaw == null || statusRaw === "" ? NaN : Number(statusRaw);
  // cTrader ProtoOADealStatus: FILLED=1, PARTIALLY_FILLED=2.
  // Status 3 is REJECTED and must never be counted as a realized close.
  return (!Number.isFinite(dealPosition) || String(dealPosition) === String(positionId))
    && Boolean(deal?.closePositionDetail)
    && (!Number.isFinite(status) || status === 1 || status === 2);
}

function summarizeRealizedClosingDeals(deals, positionId) {
  const closing = (Array.isArray(deals) ? deals : [])
    .filter(deal => isRealizedClosingDeal(deal, positionId))
    .sort((a,b) => Number(a?.executionTimestamp || 0) - Number(b?.executionTimestamp || 0));
  if (!closing.length) return { profit: null, closePrice: null, closedAt: null, closingDeals: 0 };

  let totalProfit = 0;
  let hasProfit = false;
  let displayDigits = 2;
  for (const deal of closing) {
    const detail = deal?.closePositionDetail || {};
    const rawDigits = detail.moneyDigits ?? deal.moneyDigits;
    const digits = Number(rawDigits);
    const moneyDigits = Number.isFinite(digits) ? Math.max(0, Math.min(12, digits)) : 2;
    displayDigits = Math.max(displayDigits, moneyDigits);
    // cTrader versions/brokers may expose monetary fields either inside
    // closePositionDetail or on the deal itself. Prefer the close-detail
    // value and fall back to the deal-level value without double-counting.
    const rawMoneyValues = [
      detail.grossProfit ?? deal.grossProfit ?? deal.profit,
      detail.swap ?? deal.swap,
      detail.commission ?? deal.commission,
      detail.pnlConversionFee ?? deal.pnlConversionFee
    ];
    const values = rawMoneyValues
      .map(value => {
        if (value == null || value === "") return NaN;
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
        // protobuf Long values can arrive as {low, high} objects in some
        // runtime configurations. Their decimal string is the safest fallback.
        try {
          const decimal = Number(value.toString());
          return Number.isFinite(decimal) ? decimal : NaN;
        } catch {
          return NaN;
        }
      })
      .filter(Number.isFinite);
    if (values.length) {
      totalProfit += values.reduce((sum, value) => sum + value, 0) / (10 ** moneyDigits);
      hasProfit = true;
    }
  }
  const last = closing[closing.length - 1];
  const detail = last?.closePositionDetail || {};
  const rawExit = last?.executionPrice ?? last?.price ?? detail.entryPrice;
  const exitPrice = rawExit == null || rawExit === "" ? NaN : Number(rawExit);
  const rawTimestamp = Number(last?.executionTimestamp);
  const timestampMs = Number.isFinite(rawTimestamp) && rawTimestamp > 0
    ? (rawTimestamp < 1e12 ? rawTimestamp * 1000 : rawTimestamp)
    : NaN;
  return {
    profit: hasProfit ? Number(totalProfit.toFixed(Math.min(8, displayDigits))) : null,
    closePrice: Number.isFinite(exitPrice) && exitPrice > 0 ? exitPrice : null,
    closedAt: Number.isFinite(timestampMs) ? new Date(timestampMs) : null,
    closingDeals: closing.length
  };
}

async function executeAiDecision(decision, decisionId=null, approvalId=null) {
  const currentSymbol = cTrader?.getCTraderStatus?.()?.symbolName || cTrader?.getCTraderStatus?.()?.symbol || "XAUUSD";
  const symbol = normalizeSymbolName(decision?.symbol || currentSymbol);
  const key = `AURIXA_AI:${symbol}:${String(decision?.candleTime||"")}:${String(decision?.signal||"")}`;
  if (inFlightSignalKeys.has(key)) {
    return {executed:false,strategy:"AURIXA_AI_TRADER_V1",decisionId,signal:decision?.signal||null,reason:"AI_SIGNAL_ALREADY_IN_FLIGHT",strategySignalKey:key};
  }
  inFlightSignalKeys.add(key);
  try {
    return await executeAiDecisionInternal(decision, decisionId, approvalId);
  } finally {
    inFlightSignalKeys.delete(key);
  }
}
function config(){
 let enabledSymbols = [];
 try {
   const parsed = JSON.parse(process.env.AUTO_TRADING_SYMBOLS || "[]");
   if (Array.isArray(parsed)) enabledSymbols = [...new Set(parsed.map(normalizeSymbolName).filter(isSupportedSymbol))];
 } catch (_) { enabledSymbols = []; }
 const symbolScoped = String(process.env.AUTO_TRADING_SYMBOL_SCOPE || "false").toLowerCase() === "true";
 return {
 enabled:String(process.env.AUTO_TRADING||"false").toLowerCase()==="true",
 enabledSymbols, symbolScoped,
 demoOnly:String(process.env.AUTO_TRADING_DEMO_ONLY||"true").toLowerCase()!=="false",
 riskPercent:Math.max(.1,Math.min(1,Number(process.env.AUTO_TRADING_RISK_PERCENT||.5))),
 maxSpread:Math.max(.05,Number(process.env.AUTO_TRADING_MAX_SPREAD||.60)),
 maxTradesPerDay:Math.max(1,Math.floor(Number(process.env.AUTO_TRADING_MAX_TRADES_PER_DAY||2))),
 maxOpenPositions:Math.max(0,Math.floor(Number(process.env.AUTO_TRADING_MAX_OPEN_POSITIONS||0))),
 enforceDailyLimit:String(process.env.AUTO_TRADING_ENFORCE_DAILY_LIMIT||"false").toLowerCase()==="true",
 cooldownMinutes:Math.max(5,Number(process.env.AUTO_TRADING_COOLDOWN_MINUTES||30)),
 maxSignalAgeMinutes:Math.max(1,Number(process.env.AUTO_TRADING_MAX_SIGNAL_AGE_MINUTES||7)),
 // If no explicit cap is configured, let broker metadata provide the ceiling.
 // Position size is still derived from the risk budget and then capped at broker max.
 maxVolume:process.env.AUTO_TRADING_MAX_VOLUME == null || String(process.env.AUTO_TRADING_MAX_VOLUME).trim() === ""
   ? Number.MAX_SAFE_INTEGER
   : Math.max(1,Math.floor(Number(process.env.AUTO_TRADING_MAX_VOLUME))),
 volumeMin:Math.max(1,Math.floor(Number(process.env.AUTO_TRADING_VOLUME_MIN||1000))),
 volumeStep:Math.max(1,Math.floor(Number(process.env.AUTO_TRADING_VOLUME_STEP||1000))),
 breakevenR:Math.max(.75,Number(process.env.AUTO_TRADING_BREAKEVEN_R||1)),
 trailingEnabled:String(process.env.AUTO_TRADING_TRAILING_ENABLED||"true").toLowerCase()!=="false",
 trailingTriggerR:Math.max(.5,Number(process.env.AUTO_TRADING_TRAILING_TRIGGER_R||1)),
 trailingDistanceR:Math.max(.1,Number(process.env.AUTO_TRADING_TRAILING_DISTANCE_R||.5)),
 trailingFixedDistance:Math.max(.1,Number(process.env.AUTO_TRADING_TRAILING_FIXED_DISTANCE||1.5)),
 exitReversalEnabled:String(process.env.AUTO_TRADING_REVERSAL_EXIT_ENABLED||"true").toLowerCase()!=="false",
 exitReversalMinConfidence:Math.max(65,Math.min(95,Number(process.env.AUTO_TRADING_REVERSAL_MIN_CONFIDENCE||70))),
 exitReversalConfirmMs:Math.max(10000,Number(process.env.AUTO_TRADING_REVERSAL_CONFIRM_MS||15000))
};}

function getStatus(){
 const cfg=config(),ct=cTrader?.getCTraderStatus?.()||{};
 return {enabled:cfg.enabled,enabledSymbols:cfg.enabledSymbols,symbolScoped:cfg.symbolScoped,strategy:"AURIXA_AI_TRADER_V1",demoOnly:cfg.demoOnly,demoAccount:ct.account?.isLive===false,blocked:cfg.demoOnly&&ct.account?.isLive!==false,positionLimit:cfg.maxOpenPositions>0?cfg.maxOpenPositions:"DISABLED_UNLESS_CONFIGURED",riskPercent:cfg.riskPercent,maxSpread:getSymbolProfile(ct.symbolName||ct.symbol)?.maxSpread??cfg.maxSpread,dailyTradeLimit:cfg.enforceDailyLimit?cfg.maxTradesPerDay:"DISABLED_UNLESS_OPTED_IN",dailyTradeLimitEnforced:cfg.enforceDailyLimit,configuredDailyTradeLimit:cfg.maxTradesPerDay,cooldownMinutes:cfg.cooldownMinutes,volumeMin:cfg.volumeMin,volumeStep:cfg.volumeStep,maxVolume:cfg.maxVolume,connected:Boolean(ct.connected),authorized:Boolean(ct.authorized),symbol:normalizeSymbolName(ct.symbolName||ct.symbol||""),approvalRequired:false,executionMode:"AUTOMATIC_NO_PER_TRADE_APPROVAL"};
}

async function getPendingTradeApprovals(){
 if(typeof dbQuery!=="function") throw new Error("TRADE_APPROVAL_DATABASE_UNAVAILABLE");
 await dbQuery("UPDATE aurixa.trade_approvals SET status='EXPIRED',updated_at=NOW() WHERE status='PENDING' AND expires_at<=NOW()");
 const q=await dbQuery(`SELECT id,symbol,direction,created_at AS "createdAt",expires_at AS "expiresAt",
   planned_entry_price AS "entry",planned_stop_price AS "stopLoss",
   planned_take_profit_price AS "takeProfit",volume,risk_percent AS "riskPercent",
   risk_amount AS "riskAmount",reward_risk AS "rewardRisk",confidence,
   approval_reason AS "reason",strategy_signal_key AS "strategySignalKey"
   FROM aurixa.trade_approvals WHERE status='PENDING' AND expires_at>NOW()
   ORDER BY created_at ASC LIMIT 50`);
 return q.rows||[];
}

async function resolveTradeApproval(id, action){
 if(!["approve","reject"].includes(action)) return {ok:false,error:"INVALID_APPROVAL_ACTION"};
 if(typeof dbQuery!=="function") return {ok:false,error:"TRADE_APPROVAL_DATABASE_UNAVAILABLE"};
 const approvalId=String(id||"").trim();
 if(!/^\d+$/.test(approvalId)||Number(approvalId)<=0) return {ok:false,error:"INVALID_APPROVAL_ID"};
 if(action==="reject"){
   const q=await dbQuery(`UPDATE aurixa.trade_approvals SET status='REJECTED',resolved_at=NOW(),updated_at=NOW()
     WHERE id=$1 AND status='PENDING' AND expires_at>NOW() RETURNING id`,[approvalId]);
   return q.rows?.length?{ok:true,status:"REJECTED",approvalId}:{ok:false,error:"APPROVAL_EXPIRED_OR_ALREADY_RESOLVED"};
 }
 const q=await dbQuery(`UPDATE aurixa.trade_approvals SET status='APPROVING',approved_at=NOW(),updated_at=NOW()
   WHERE id=$1 AND status='PENDING' AND expires_at>NOW()
   RETURNING id,decision_id AS "decisionId",decision_json AS "decision"`,[approvalId]);
 const row=q.rows?.[0];
 if(!row) return {ok:false,error:"APPROVAL_EXPIRED_OR_ALREADY_RESOLVED"};
 const decision=row.decision;
 if(!decision||typeof decision!=="object"){
   await dbQuery("UPDATE aurixa.trade_approvals SET status='FAILED',updated_at=NOW() WHERE id=$1 AND status='APPROVING'",[approvalId]);
   return {ok:false,error:"APPROVAL_DECISION_UNAVAILABLE"};
 }
 let result;
 try {
   result=await executeAiDecision(decision,row.decisionId,approvalId);
 } catch(error) {
   await dbQuery("UPDATE aurixa.trade_approvals SET status='EXECUTION_UNCONFIRMED',approval_reason=$2,updated_at=NOW() WHERE id=$1 AND status IN ('APPROVING','EXECUTING')",[approvalId,error.message]).catch(()=>{});
   return {ok:false,error:"TRADE_EXECUTION_UNCONFIRMED",approvalId};
 }
 if(result.reason==="AI_SIGNAL_ALREADY_IN_FLIGHT") {
   await dbQuery("UPDATE aurixa.trade_approvals SET status='FAILED',approval_reason=$2,updated_at=NOW() WHERE id=$1 AND status='APPROVING'",[approvalId,result.reason]).catch(()=>{});
 }
 return {ok:true,status:result.executed===true?"EXECUTED":"NOT_EXECUTED",approvalId,result};
}

async function emergencyCloseAfterProtectionFailure(result, symbol, fallbackVolume, cause) {
  if (!positionRisk.shouldEmergencyCloseAfterProtectionFailure(result)) return;

  const protectionError = cause instanceof Error ? cause.message : String(cause || "SL/TP protection failed");
  result.protectionStatus = "FAILED";
  result.protectionError = protectionError;

  try {
    if (typeof cTrader?.getOpenXAUUSDPositions !== "function" ||
        typeof cTrader?.closeXAUUSDPosition !== "function") {
      throw new Error("Broker position lookup/close is unavailable");
    }

    const positions = await cTrader.getOpenXAUUSDPositions(true, symbol);
    const position = (Array.isArray(positions) ? positions : [])
      .find(item => String(item?.positionId || "") === String(result.positionId));
    if (!position) {
      throw new Error("Position is not present in a fresh broker snapshot; closure cannot be confirmed");
    }

    const tradeData = position.tradeData || {};
    const rawVolume = position.volume ?? tradeData.volume ?? fallbackVolume;
    const closeVolume = rawVolume == null || rawVolume === "" ? NaN : Number(rawVolume);
    if (!Number.isInteger(closeVolume) || closeVolume <= 0) {
      throw new Error("Broker position volume is unavailable for emergency close");
    }

    const closeResult = await cTrader.closeXAUUSDPosition(result.positionId, closeVolume, symbol);
    if (closeResult?.brokerConfirmed !== true) {
      throw new Error("Broker did not confirm the emergency close");
    }

    const rawClosePrice = closeResult.executionPrice;
    const closePrice = rawClosePrice == null || rawClosePrice === "" ? NaN : Number(rawClosePrice);
    result.status = "CLOSED";
    result.brokerConfirmed = false;
    result.closeBrokerConfirmed = true;
    result.closePrice = Number.isFinite(closePrice) && closePrice > 0 ? closePrice : null;
    result.exitReason = "PROTECTION_FAILURE_EMERGENCY_CLOSE";
    result.protectionStatus = "FAILED_CLOSED";

    console.error("AURIXA_PROTECTION_FAILURE_EMERGENCY_CLOSE_CONFIRMED:", JSON.stringify({
      positionId: result.positionId,
      symbol,
      closePrice: result.closePrice,
      brokerConfirmed: true,
      protectionError
    }));
  } catch (closeError) {
    result.protectionStatus = "FAILED_CLOSE_UNCONFIRMED";
    result.protectionError = protectionError + "; emergency close unconfirmed: " + closeError.message;
    console.error("AURIXA_PROTECTION_FAILURE_EMERGENCY_CLOSE_UNCONFIRMED:", JSON.stringify({
      positionId: result.positionId,
      symbol,
      protectionError,
      closeError: closeError.message,
      action: "KEEP_TRACKED_AND_REPAIR_PROTECTION"
    }));
  }
}

async function executeAiDecisionInternal(decision, decisionId=null, approvalId=null){
  const cfg=config();
  const decisionSymbol=normalizeSymbolName(decision?.symbol||"");
  const statusAtStart=cTrader?.getCTraderStatusForSymbol?.(decisionSymbol)||cTrader?.getCTraderStatus?.()||{};
  const activeSymbol=normalizeSymbolName(statusAtStart.symbolName||statusAtStart.symbol||"");
  const symbolProfile=getSymbolProfile(decisionSymbol);
  const key=`AURIXA_AI:${decisionSymbol}:${String(decision?.candleTime||"")}:${String(decision?.signal||"")}`;
  const reject=async(reason,extra={})=>{
    if(typeof dbQuery==="function")try{
      await dbQuery(`INSERT INTO aurixa.auto_trades(decision_id,strategy,strategy_signal_key,symbol,timeframe,direction,signal_entry_price,volume,status,gate_reason,error)
        VALUES ($1,'AURIXA_AI_TRADER_V1',$2,$7,'5m',$3,$4,0,'REJECTED',$5,$6)
        ON CONFLICT DO NOTHING`,
        [decisionId,key,decision?.signal||"BUY",decision?.entry||null,reason,extra.error||null,decisionSymbol]);
    // A later scan can reject the same candle after an order was already
    // submitted or filled. Never let that later rejection overwrite the
    // lifecycle of an existing trade with broker order/position identifiers.
    // Only refresh a rejected audit row that has never reached execution.
    await dbQuery(`UPDATE aurixa.auto_trades
      SET decision_id=$2,status='REJECTED',gate_reason=$3,error=$4,updated_at=NOW()
      WHERE strategy_signal_key=$1
        AND status='REJECTED'
        AND order_id IS NULL
        AND position_id IS NULL`,
      [key,decisionId,reason,extra.error||null]);
    }catch(e){console.error("AI trade audit failed:",e.message);}
    if(approvalId && typeof dbQuery==="function"){
      try { await dbQuery("UPDATE aurixa.trade_approvals SET status='BLOCKED',approval_reason=$2,updated_at=NOW() WHERE id=$1 AND status IN ('APPROVING','EXECUTING')",[approvalId,reason]); }
      catch(error){ console.error("AURIXA_APPROVAL_BLOCK_AUDIT_FAILED:",error.message); }
    }
    return {executed:false,strategy:"AURIXA_AI_TRADER_V1",decisionId,signal:decision?.signal||null,reason,...extra};
  };
  if(!cfg.enabled)return reject("AUTO_TRADING_DISABLED");
  if(cfg.symbolScoped && !cfg.enabledSymbols.includes(decisionSymbol)) {
    return reject("SYMBOL_NOT_ARMED", {symbol:decisionSymbol, enabledSymbols:cfg.enabledSymbols});
  }
  if(typeof dbQuery!=="function")return reject("TRADE_DATABASE_UNAVAILABLE");
  if(!decision||!["BUY","SELL"].includes(decision.signal)||decision.executionEligible!==true)return reject("AI_DECISION_NOT_ELIGIBLE");
  // Candle timestamps can be epoch seconds, epoch milliseconds, or ISO strings
  // depending on whether they came from the broker feed or persisted history.
  const rawCandleTime=decision?.candleTime;
  const numericCandleTime=typeof rawCandleTime==="number"||/^\d+(?:\.\d+)?$/.test(String(rawCandleTime??""))
    ? Number(rawCandleTime) : Date.parse(String(rawCandleTime??""));
  const ts=Number.isFinite(numericCandleTime)
    ? (numericCandleTime>0&&numericCandleTime<1e11?numericCandleTime*1000:numericCandleTime)
    : NaN;
  if(!Number.isFinite(ts)||Date.now()-ts<0||Date.now()-ts>cfg.maxSignalAgeMinutes*60000)return reject("AI_SIGNAL_STALE",{candleTime:rawCandleTime??null});
  const st=statusAtStart;
  if(!st?.connected||!st?.authorized)return reject("CTRADER_NOT_READY");
  if(cfg.demoOnly&&st.account?.isLive!==false)return reject(st.account?.isLive===true?"LIVE_ACCOUNT_BLOCKED":"ACCOUNT_ENVIRONMENT_UNKNOWN");
  if(!st.tradingPermission)return reject("TRADE_PERMISSION_REQUIRED");
  if(!isSupportedSymbol(activeSymbol)||!symbolProfile)return reject("UNSUPPORTED_SYMBOL");
  if(decisionSymbol!==activeSymbol)return reject("DECISION_SYMBOL_MISMATCH",{decisionSymbol,activeSymbol});
  // Fail closed if any existing XAUUSD broker position is missing either
  // protection. Known AURIXA positions are repaired by syncOpenPositions;
  // unknown/manual positions require an operator to set a safe SL/TP.
  if(typeof cTrader.getOpenXAUUSDPositions==="function"){
    try {
      const brokerPositions=await cTrader.getOpenXAUUSDPositions(true, decisionSymbol);
      const unprotected=(Array.isArray(brokerPositions)?brokerPositions:[]).filter(position=>{
        const td=position?.tradeData||{};
        const side=Number(td.tradeSide ?? position?.tradeSide);
        const direction=side===1?"BUY":side===2?"SELL":null;
        const entryValue=position?.price ?? td.openPrice ?? td.price ?? position?.openPrice ?? td.entryPrice;
        const entry=entryValue==null||entryValue===""?NaN:Number(entryValue);
        const marketValue=direction==="BUY"?st.bid:direction==="SELL"?st.ask:NaN;
        const current=marketValue==null||marketValue===""?NaN:Number(marketValue);
        return !positionRisk.hasValidProtection(position,direction,entry,current);
      });
      if(unprotected.length){
        console.error("AURIXA_ORDER_BLOCKED_UNPROTECTED_BROKER_POSITION:",JSON.stringify({
          signal:decision.signal,
          positionIds:unprotected.map(position=>position.positionId).filter(Boolean),
          unprotectedCount:unprotected.length
        }));
        return reject("OPEN_POSITION_MISSING_SL_OR_TP",{unprotectedPositionIds:unprotected.map(position=>position.positionId).filter(Boolean)});
      }
      // Prevent repeated same-direction entries inside an existing position's
      // price zone. This uses a fresh broker snapshot and never alters positions.
      const candidateEntry=Number(decision.signal==="BUY"?st.ask:st.bid);
      const cluster=entryClusterGuard.evaluateEntryCluster({
        symbol:decisionSymbol,
        direction:decision.signal,
        entry:candidateEntry,
        atr:decision.atr,
        positions:brokerPositions,
        zonePercent:process.env.AUTO_TRADING_ENTRY_ZONE_PERCENT,
        atrMultiplier:process.env.AUTO_TRADING_ENTRY_ZONE_ATR_MULTIPLIER
      });
      if(!cluster.allowed){
        console.warn("AURIXA_ENTRY_CLUSTER_BLOCKED:",JSON.stringify({
          symbol:decisionSymbol,signal:decision.signal,entry:candidateEntry,
          matchedPositionId:cluster.positionId,matchedEntry:cluster.positionEntry,
          distance:cluster.distance,zone:cluster.zone,zonePercent:cluster.zonePercent,
          reason:cluster.reason
        }));
        return reject("SAME_DIRECTION_ENTRY_PRICE_ZONE_OCCUPIED",cluster);
      }
    } catch(e) {
      console.error("AURIXA_OPEN_POSITION_PROTECTION_CHECK_FAILED:",e.message);
      return reject("OPEN_POSITION_PROTECTION_CHECK_FAILED",{error:e.message});
    }
  }
  const bid=Number(st.bid),ask=Number(st.ask);
  if(!Number.isFinite(bid)||!Number.isFinite(ask)||ask<=bid)return reject("LIVE_PRICE_UNAVAILABLE");
  const spread=ask-bid;
  const symbolMaxSpread=Number(symbolProfile.maxSpread);
  const symbolSpreadOverride=Number(process.env["AUTO_TRADING_MAX_SPREAD_"+decisionSymbol]);
  const configuredSpread=Number.isFinite(symbolSpreadOverride)&&symbolSpreadOverride>0?symbolSpreadOverride:(decisionSymbol==="XAUUSD"?cfg.maxSpread:symbolMaxSpread);
  const maxAllowedSpread=Number.isFinite(symbolMaxSpread)?Math.min(configuredSpread,symbolMaxSpread):configuredSpread;
  if(spread>maxAllowedSpread)return reject("SPREAD_TOO_HIGH",{spread,maxAllowedSpread,symbol:decisionSymbol});
  const entry=decision.signal==="BUY"?ask:bid,stop=Number(decision.stopLoss),target=Number(decision.takeProfit);
  if(!Number.isFinite(stop)||!Number.isFinite(target))return reject("AI_SL_TP_MISSING");
  if(decision.signal==="BUY"&&(stop>=entry||target<=entry))return reject("BUY_PROTECTION_INVALID",{entry,stop,target});
  if(decision.signal==="SELL"&&(stop<=entry||target>=entry))return reject("SELL_PROTECTION_INVALID",{entry,stop,target});

  const signalEntry=Number(decision.entry);
  if(!Number.isFinite(signalEntry)||signalEntry<=0)return reject("AI_SIGNAL_ENTRY_MISSING");
  const digits=Number.isInteger(symbolProfile?.digits)?symbolProfile.digits:2;
  const signalCheck=rewardRisk.evaluatePlannedRewardRisk({
    signal:decision.signal,entry:signalEntry,stop,target,digits,minRewardRisk:2
  });
  const riskDistance=Math.abs(entry-stop);
  const targetDistance=riskDistance*2;
  const rr=targetDistance/Math.max(0.00001,riskDistance);
  if(!signalCheck.allowed){
    const rrDiagnostics={
      symbol:decisionSymbol,signal:decision.signal,candleTime:decision.candleTime??null,
      signalEntry,liveEntry:entry,stop,signalTarget:target,
      ...signalCheck,
      executionRiskDistance:riskDistance,executionTargetDistance:targetDistance,
      executionRR:Number.isFinite(rr)?rr:null,minRewardRisk:2,
      quoteBid:Number.isFinite(bid)?bid:null,quoteAsk:Number.isFinite(ask)?ask:null,
      source:"SIGNAL_PLAN_TICK_TOLERANCE_WITH_LIVE_ENTRY_EXECUTION"
    };
    console.warn("AURIXA_REWARD_RISK_GATE_DIAGNOSTICS:",JSON.stringify({decisionId,...rrDiagnostics}));
    return reject("REWARD_RISK_TOO_LOW",rrDiagnostics);
  }
  const normalizedTarget=rewardRisk.normalizeTargetPrice({
    signal:decision.signal,entry,stop,digits,minRewardRisk:2
  });
  // No fixed XAUUSD position-count, daily-trade, or global cooldown limit.
  // Confirmed BUY/SELL signals may open additional demo positions.
  // Balance/free-margin, risk sizing, spread, stale-signal, broker-volume,
  // duplicate-signal, RR and demo-only protections remain enforced.
  if(typeof dbQuery==="function"){
    const dup=await dbQuery(`SELECT id, status, order_id, position_id
      FROM aurixa.auto_trades
      WHERE strategy_signal_key=$1
        AND (
          status IN ('OPEN','PARTIAL','SUBMITTED','CLOSED')
          OR order_id IS NOT NULL
          OR position_id IS NOT NULL
        )
      LIMIT 1`,[key]);
    // Rejected attempts must not permanently consume a confirmed candle.
    // Only an actual/submitted trade attempt gates the same candle+direction.
    if(dup.rows.length)return {executed:false,strategy:"AURIXA_AI_TRADER_V1",decisionId,reason:"AI_SIGNAL_ALREADY_GATED",strategySignalKey:key};
    // Protect against repeated scanner cycles and broker-sync lag. Only active
    // same-symbol/same-direction submissions in the existing cooldown window
    // block a new entry; opposite directions and other symbols are unaffected.
    const recentSameDirection=await dbQuery(`SELECT id,position_id AS "positionId",created_at AS "createdAt"
      FROM aurixa.auto_trades
      WHERE symbol=$1 AND direction=$2
        AND status IN ('SUBMITTED','OPEN','PARTIAL')
        AND created_at >= NOW() - ($3 * INTERVAL '1 minute')
      ORDER BY created_at DESC LIMIT 1`,[decisionSymbol,decision.signal,cfg.cooldownMinutes]);
    if(recentSameDirection.rows.length){
      return reject("SAME_DIRECTION_ENTRY_COOLDOWN",{
        symbol:decisionSymbol,direction:decision.signal,
        cooldownMinutes:cfg.cooldownMinutes,
        existingTradeId:recentSameDirection.rows[0].id??null,
        existingPositionId:recentSameDirection.rows[0].positionId??null,
        existingTradeCreatedAt:recentSameDirection.rows[0].createdAt??null
      });
    }
    // Existing risk, spread, RR, stale-signal, broker-volume and demo-only gates remain.
  }
  // Account-wide risk limits are opt-in so the existing demo cadence is unchanged
  // unless an operator explicitly configures AUTO_TRADING_MAX_OPEN_POSITIONS
  // or AUTO_TRADING_ENFORCE_DAILY_LIMIT=true.
  if (cfg.maxOpenPositions > 0 || cfg.enforceDailyLimit) {
    let openPositionCount = null;
    let dailyTradeCount = null;
    try {
      if (cfg.maxOpenPositions > 0) {
        if (typeof cTrader.getOpenSymbolPositions !== "function") {
          return reject("PORTFOLIO_POSITION_SNAPSHOT_UNAVAILABLE");
        }
        const brokerPositions = await cTrader.getOpenSymbolPositions(true);
        if (!Array.isArray(brokerPositions)) {
          return reject("PORTFOLIO_POSITION_SNAPSHOT_UNAVAILABLE");
        }
        openPositionCount = brokerPositions.length;
      }
      if (cfg.enforceDailyLimit) {
        const dailyResult = await dbQuery(`
          SELECT COUNT(*)::int AS count
          FROM aurixa.auto_trades
          WHERE created_at >= date_trunc('day', NOW())
            AND status IN ('SUBMITTED','OPEN','PARTIAL','CLOSED')
        `);
        const rawCount = dailyResult?.rows?.[0]?.count;
        const parsedCount = rawCount === null || rawCount === undefined || rawCount === "" ? NaN : Number(rawCount);
        if (!Number.isInteger(parsedCount) || parsedCount < 0) {
          return reject("DAILY_TRADE_COUNT_UNAVAILABLE");
        }
        dailyTradeCount = parsedCount;
      }
      const portfolioDecision = evaluatePortfolioRisk({
        openPositionCount,
        dailyTradeCount,
        maxOpenPositions: cfg.maxOpenPositions,
        maxTradesPerDay: cfg.maxTradesPerDay,
        enforceDailyLimit: cfg.enforceDailyLimit
      });
      if (!portfolioDecision.allowed) return reject(portfolioDecision.reason, portfolioDecision);
    } catch (error) {
      console.error("AURIXA_PORTFOLIO_RISK_CHECK_FAILED:", error.message);
      return reject("PORTFOLIO_RISK_CHECK_FAILED", { error: error.message });
    }
  }

  // Read the live demo account immediately before sizing the order.
  // Volume is derived from account balance + risk %, then constrained by
  // the broker's actual XAUUSD min/step/max volume.
  const account=await cTrader.getAccountBalance?.();
  const balance=Number(account?.balance);
  const equity=Number(account?.equity);
  const freeMargin=Number(account?.freeMargin);
  if(!Number.isFinite(balance)||balance<=0)return reject("INVALID_ACCOUNT_BALANCE");
  const volumeRules=await (cTrader.getSymbolVolumeConstraints||cTrader.getActiveSymbolVolumeConstraints||cTrader.getXAUUSDVolumeConstraints)?.(decisionSymbol);
  const brokerMin=Number(volumeRules?.minVolume);
  const brokerStep=Number(volumeRules?.stepVolume);
  const brokerMax=Number(volumeRules?.maxVolume);
  const brokerMinStopDistance=volumeRules?.minStopDistance==null?NaN:Number(volumeRules.minStopDistance);
  if(!Number.isFinite(brokerMin)||brokerMin<=0||!Number.isFinite(brokerStep)||brokerStep<=0){
    return reject("BROKER_VOLUME_RULES_UNAVAILABLE",{balance,equity,freeMargin});
  }
  if(!Number.isFinite(brokerMinStopDistance)||brokerMinStopDistance<0){
    return reject("BROKER_MIN_STOP_DISTANCE_UNAVAILABLE",{symbol:decisionSymbol,brokerMinStopDistance:null});
  }
  const brokerStopReference=decision.signal==="BUY"?bid:ask;
  const stopDistanceFromExecutableSide=decision.signal==="BUY"?brokerStopReference-stop:stop-brokerStopReference;
  const targetDistanceFromExecutableSide=decision.signal==="BUY"?target-ask:bid-target;
  if(!Number.isFinite(stopDistanceFromExecutableSide)||stopDistanceFromExecutableSide<brokerMinStopDistance||
     !Number.isFinite(targetDistanceFromExecutableSide)||targetDistanceFromExecutableSide<brokerMinStopDistance){
    return reject("BROKER_MIN_STOP_DISTANCE_VIOLATION",{symbol:decisionSymbol,brokerMinStopDistance,stopDistanceFromExecutableSide,targetDistanceFromExecutableSide,stop,target,bid,ask});
  }
  const configuredMax=Number.isFinite(brokerMax)&&brokerMax>0?Math.min(cfg.maxVolume,brokerMax):cfg.maxVolume;
  const riskAmount=balance*cfg.riskPercent/100;
  // cTrader volume is expressed in hundredths of the instrument's base units.
  // Convert quote-currency P/L into the demo account's assumed USD risk budget
  // for USD-quoted pairs. USDJPY/USDCHF/USDCAD require a fresh inverse conversion
  // quote; if it is unavailable, fail closed rather than silently mis-size risk.
  const volumeUnitScale=100;
  const quoteCurrency=decisionSymbol.slice(-3);
  let quoteToUsdRate=1;
  if (quoteCurrency !== "USD") {
    const conversion = cTrader.getMultiSymbolMarket?.("USD" + quoteCurrency);
    const conversionMid = Number(conversion?.mid);
    const conversionTime = conversion?.lastUpdate ? Date.parse(conversion.lastUpdate) : NaN;
    if (!conversion || !Number.isFinite(conversionMid) || conversionMid <= 0 ||
        !Number.isFinite(conversionTime) || Date.now() - conversionTime > 30000) {
      return reject("ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE", {symbol:decisionSymbol,quoteCurrency});
    }
    quoteToUsdRate = 1 / conversionMid;
  }
  let executionRiskDistance=riskDistance;
  let executionStop=decision.signal==="BUY"?entry-riskDistance:entry+riskDistance;
  let executionTarget=normalizedTarget;
  let riskAdjustedForBrokerMinimum=false;
  const rawVolume=(riskAmount*volumeUnitScale)/(executionRiskDistance*quoteToUsdRate);
  let volume=brokerVolume.normalizeVolume(rawVolume, volumeRules, configuredMax);

  // Never tighten a structure-based stop to force the broker's minimum lot size.
  // If the actual-distance risk calculation cannot support broker minimum volume,
  // reject the trade and preserve both the planned stop and configured risk ceiling.
  const executionStopDistanceFromBrokerSide=decision.signal==="BUY"?bid-executionStop:executionStop-ask;
  const executionTargetDistanceFromBrokerSide=decision.signal==="BUY"?executionTarget-ask:bid-executionTarget;
  if(executionStopDistanceFromBrokerSide<brokerMinStopDistance||executionTargetDistanceFromBrokerSide<brokerMinStopDistance){
    return reject("BROKER_MIN_STOP_DISTANCE_VIOLATION",{symbol:decisionSymbol,brokerMinStopDistance,executionStopDistanceFromBrokerSide,executionTargetDistanceFromBrokerSide,executionStop,executionTarget,bid,ask});
  }
  const requiredRiskAtMinVolume=(brokerMin/volumeUnitScale)*executionRiskDistance*quoteToUsdRate;
  if(volume<brokerMin){
    const diagnostics={
      symbol:decisionSymbol,
      accountBalance:balance,
      accountEquity:Number.isFinite(equity)?equity:null,
      freeMargin:Number.isFinite(freeMargin)?freeMargin:null,
      riskPercent:cfg.riskPercent,
      riskAmount,
      riskDistance,
      executionRiskDistance,
      riskAdjustedForBrokerMinimum,
      volumeUnitScale,
      rawVolume,
      configuredMaxVolume:configuredMax,
      selectedVolume:0,
      brokerMinVolume:brokerMin,
      brokerVolumeStep:brokerStep,
      brokerMaxVolume:brokerMax,
      requiredRiskAtMinVolume,
      riskBudgetCoversBrokerMinimum:requiredRiskAtMinVolume <= riskAmount * 0.995
    };
    if(configuredMax < brokerMin){
      return reject("CONFIGURED_MAX_VOLUME_BELOW_BROKER_MINIMUM",diagnostics);
    }
    if(requiredRiskAtMinVolume > riskAmount * 0.995){
      return reject("RISK_BUDGET_TOO_SMALL_FOR_BROKER_MIN_VOLUME",diagnostics);
    }
    return reject("BROKER_VOLUME_SIZE_OR_STEP_UNSUPPORTED",diagnostics);
  }
  console.log("AURIXA ACCOUNT VOLUME CHECK:",JSON.stringify({
    balance,equity:Number.isFinite(equity)?equity:null,
    freeMargin:Number.isFinite(freeMargin)?freeMargin:null,
    riskPercent:cfg.riskPercent,riskAmount,riskDistance,quoteToUsdRate,
    executionRiskDistance,
    riskAdjustedForBrokerMinimum,
    volumeUnitScale:100,
    brokerMinVolume:brokerMin,brokerVolumeStep:brokerStep,
    brokerMaxVolume:brokerMax,selectedVolume:volume
  }));
  // Automatic mode: no per-trade approval/PIN gate. Every execution safety
  // check above has passed; reserve this unique signal durably before ordering.
  // Reserve the signal durably BEFORE sending an order. The unique key also
  // protects against overlapping timer cycles and multiple service instances.
  let reservationId=null;
  try {
    const reservation=await dbQuery(`INSERT INTO aurixa.auto_trades(
        decision_id,strategy,strategy_signal_key,symbol,timeframe,direction,
        signal_entry_price,volume,stop_loss_distance,take_profit_distance,status,
        risk_percent,risk_amount,planned_entry_price,planned_stop_price,planned_take_profit_price
      )
      VALUES ($1,'AURIXA_AI_TRADER_V1',$2,$13,'5m',$3,$4,$5,$6,$7,'SUBMITTED',$8,$9,$10,$11,$12)
      ON CONFLICT (strategy_signal_key) DO UPDATE
        SET decision_id=EXCLUDED.decision_id,volume=EXCLUDED.volume,
            stop_loss_distance=EXCLUDED.stop_loss_distance,
            take_profit_distance=EXCLUDED.take_profit_distance,
            status='SUBMITTED',gate_reason=NULL,error=NULL,updated_at=NOW()
        WHERE aurixa.auto_trades.status='REJECTED'
          AND aurixa.auto_trades.order_id IS NULL
          AND aurixa.auto_trades.position_id IS NULL
      RETURNING id`,
      [decisionId,key,decision.signal,decision.entry,volume,executionRiskDistance,executionRiskDistance*2,cfg.riskPercent,riskAmount,entry,executionStop,executionTarget,decisionSymbol]);
    if(!reservation.rows.length) {
      return {executed:false,strategy:"AURIXA_AI_TRADER_V1",decisionId,signal:decision.signal,reason:"AI_SIGNAL_ALREADY_GATED",strategySignalKey:key};
    }
    reservationId=reservation.rows[0].id;
  } catch(e) {
    console.error("AURIXA_TRADE_RESERVATION_FAILED:",JSON.stringify({strategySignalKey:key,error:e.message}));
    if(approvalId) await dbQuery("UPDATE aurixa.trade_approvals SET status='FAILED',updated_at=NOW() WHERE id=$1 AND status='EXECUTING'",[approvalId]).catch(()=>{});
    return {executed:false,strategy:"AURIXA_AI_TRADER_V1",decisionId,signal:decision.signal,reason:"TRADE_RESERVATION_FAILED",error:e.message};
  }

  // An order timeout has an unknown outcome: do not automatically retry the
  // same signal because cTrader may already have filled it.
  let result;
  try{
    result=await cTrader.placeDemoMarketOrder({
      direction:decision.signal,
      volume,
      symbol:decisionSymbol
    });
  }catch(e){
    try {
      await dbQuery("UPDATE aurixa.auto_trades SET error=$2,gate_reason='CTRADER_ORDER_OUTCOME_UNKNOWN',updated_at=NOW() WHERE id=$1",
        [reservationId,e.message]);
    } catch(recordError) {
      console.error("AURIXA_ORDER_OUTCOME_RECORD_FAILED:",recordError.message);
    }
    console.error("AURIXA_CTRADER_ORDER_OUTCOME_UNKNOWN:",JSON.stringify({reservationId,strategySignalKey:key,error:e.message}));
    if(approvalId) await dbQuery("UPDATE aurixa.trade_approvals SET status='EXECUTION_UNCONFIRMED',updated_at=NOW() WHERE id=$1 AND status='EXECUTING'",[approvalId]).catch(()=>{});
    return {executed:false,strategy:"AURIXA_AI_TRADER_V1",decisionId,signal:decision.signal,reason:"CTRADER_ORDER_OUTCOME_UNKNOWN",error:e.message,strategySignalKey:key};
  }

  // A filled position must have broker-verified SL and TP. If either cannot
  // be established, try a broker-confirmed emergency close; if that fails,
  // keep the position tracked and let the position manager continue repairs.
  if(["OPEN","PARTIAL"].includes(result.status) && result.positionId){
    if(typeof cTrader.modifyPositionProtection!=="function"){
      await emergencyCloseAfterProtectionFailure(
        result, decisionSymbol, volume,
        new Error("Broker protection amendment is unavailable")
      );
    }else{
      const actualEntry=Number(result.executionPrice);
      const protectionEntry=Number.isFinite(actualEntry)&&actualEntry>0?actualEntry:entry;
      const adjustedStop=decision.signal==="BUY"
        ? protectionEntry-executionRiskDistance
        : protectionEntry+executionRiskDistance;
      const adjustedTarget=decision.signal==="BUY"
        ? protectionEntry+executionRiskDistance*2
        : protectionEntry-executionRiskDistance*2;
      try{
        const protection=await cTrader.modifyPositionProtection(
          result.positionId,
          adjustedStop,
          adjustedTarget,
          decisionSymbol
        );
        if(protection?.verified!==true){
          throw new Error("Broker did not confirm both SL and TP after order execution");
        }
        result.stopLoss=Number.isFinite(Number(protection.stopLoss))?Number(protection.stopLoss):adjustedStop;
        result.takeProfit=Number.isFinite(Number(protection.takeProfit))?Number(protection.takeProfit):adjustedTarget;
        result.protectionStatus="SET";
        console.log("AURIXA_POST_FILL_PROTECTION:",JSON.stringify({
          positionId:result.positionId,
          entry:protectionEntry,
          stopLoss:adjustedStop,
          takeProfit:adjustedTarget,
          protection
        }));
      }catch(e){
        await emergencyCloseAfterProtectionFailure(result, decisionSymbol, volume, e);
      }
    }
  }

  try{
    await dbQuery(`UPDATE aurixa.auto_trades
      SET decision_id=$2,order_id=$3,position_id=$4,client_msg_id=$5,status=$6,
          execution_entry_price=$7,gate_reason=$8,error=$9,
          opened_at=CASE WHEN $4 IS NOT NULL AND $6 IN ('OPEN','PARTIAL','CLOSED') THEN COALESCE(opened_at,NOW()) ELSE opened_at END,
          closed_at=CASE WHEN $6='CLOSED' THEN COALESCE(closed_at,NOW()) ELSE closed_at END,
          close_price=COALESCE($10,close_price),
          exit_reason=COALESCE($11,exit_reason),updated_at=NOW()
      WHERE id=$1`,
      [reservationId,decisionId,result.orderId||null,result.positionId||null,result.clientMsgId||null,
       result.status||"SUBMITTED",result.executionPrice||entry,
       result.status==="CLOSED"?"PROTECTION_FAILURE_EMERGENCY_CLOSE":(String(result.protectionStatus||"").startsWith("FAILED")?"PROTECTION_FAILED":"PASSED"),
       result.protectionError||null,result.closePrice||null,result.exitReason||null]);
  }catch(e){console.error("AI trade record update failed:",e.message);}
  const brokerPositionVerified=result.brokerConfirmed===true;
  const executionReason=result.status==="CLOSED"&&result.closeBrokerConfirmed===true
    ? "PROTECTION_FAILURE_EMERGENCY_CLOSE"
    : (brokerPositionVerified?null:
      (["OPEN","PARTIAL"].includes(result.status)?"BROKER_POSITION_NOT_VERIFIED":"CTRADER_ORDER_NOT_FILLED"));
  if(!brokerPositionVerified && !(result.status==="CLOSED" && result.closeBrokerConfirmed===true)){
    console.error("AURIXA_EXECUTION_REQUIRES_RECONCILIATION:",JSON.stringify({
      reservationId,strategySignalKey:key,symbol:decisionSymbol,
      orderId:result.orderId||null,positionId:result.positionId||null,
      executionType:result.executionType??null,status:result.status||null,
      protectionStatus:result.protectionStatus||null
    }));
  }
  const executed=["OPEN","PARTIAL"].includes(result.status)&&brokerPositionVerified;
  if(approvalId){
    try { await dbQuery("UPDATE aurixa.trade_approvals SET status=$2,trade_id=$3,updated_at=NOW() WHERE id=$1 AND status='EXECUTING'",
      [approvalId,executed?"EXECUTED":"EXECUTION_UNCONFIRMED",reservationId]); }
    catch(error){ console.error("AURIXA_APPROVAL_FINALIZE_FAILED:",error.message); }
  }
  return {executed,
    reason:executionReason,strategy:"AURIXA_AI_TRADER_V1",decisionId,strategySignalKey:key,
    gate:"PASSED",direction:decision.signal,volume,riskAmount,
    plannedEntryPrice:entry,plannedStopPrice:executionStop,plannedTakeProfitPrice:executionTarget,
    originalPlannedStopPrice:stop,originalPlannedTakeProfitPrice:target,
    riskAdjustedForBrokerMinimum,brokerPositionVerified,...result};
}

async function dryRunAiTrader(){
  const candles=cTrader?.getMarketCandles?.()||[],st=cTrader?.getCTraderStatus?.()||{},decision=aiEngine?.decide(candles,st)||null;
  return {dryRun:true,wouldExecute:Boolean(decision?.executionEligible),orderSubmitted:false,strategy:"AURIXA_AI_TRADER_V1",decision,reason:decision?.executionEligible?"AI_SIGNAL_READY_NO_ORDER_SUBMITTED":"AI_WAIT_OR_BLOCKED"};
}

async function syncOpenPositions(symbolName=null){
  const liveDefault=cTrader?.getCTraderStatus?.()||{};
  const targetSymbol=normalizeSymbolName(symbolName||liveDefault.symbolName||liveDefault.symbol||"");
  if(!cTrader?.getOpenXAUUSDPositions)return {symbol:targetSymbol,updated:0,closed:0,protectedCount:0,trailingUpdated:0};
  const cfg=config();
  const positions=await cTrader.getOpenXAUUSDPositions(true,targetSymbol);
  let updated=0,closed=0,protectedCount=0,trailingUpdated=0;
  const liveStatus=cTrader.getCTraderStatusForSymbol?.(targetSymbol)||liveDefault;
  const liveCandles=cTrader.getMultiSymbolMarket?.(targetSymbol)?.candles||cTrader.getMarketCandles?.()||[];
  const marketDecision=aiEngine?.decide(liveCandles,liveStatus)||null;
  const exitDecision=cfg.exitReversalEnabled ? marketDecision : null;
  const activeProfile=getSymbolProfile(targetSymbol||liveStatus.symbolName||liveStatus.symbol);
  const now=Date.now();
  const eligibleReversal=Boolean(
    exitDecision?.executionEligible===true &&
    ["BUY","SELL"].includes(exitDecision.signal) &&
    Number(exitDecision.confidence)>=cfg.exitReversalMinConfidence &&
    ((exitDecision.signal==="BUY" && exitDecision.trend==="BULLISH") ||
     (exitDecision.signal==="SELL" && exitDecision.trend==="BEARISH"))
  );

  // Trail every open position for the selected symbol independently.
  // Symbol switching is blocked while positions are open, keeping its live
  // quote and candle stream available for protection repair and trailing.
  if(typeof cTrader.modifyPositionProtection==="function"){
    for(const pos of positions){
      const positionId=pos?.positionId;
      const td=pos?.tradeData||{};
      const side=Number(td.tradeSide ?? pos?.tradeSide);
      const direction=side===1?"BUY":side===2?"SELL":null;
      const numericPrice=(...values)=>{
        for(const value of values){
          if(value===null||value===undefined||value==="")continue;
          const n=Number(value);
          if(Number.isFinite(n)&&n>0)return n;
        }
        return NaN;
      };
      // ProtoOAReconcileRes places the actual position entry in position.price;
      // tradeData commonly has no openPrice/price field.
      let entry=numericPrice(pos.price,td.openPrice,td.price,pos.openPrice,td.entryPrice);
      const status=cTrader.getCTraderStatusForSymbol?.(targetSymbol)||cTrader.getCTraderStatus?.()||{};
      const market=direction==="BUY"?numericPrice(status.bid):direction==="SELL"?numericPrice(status.ask):NaN;
      const current=Number.isFinite(market)?market:numericPrice(pos.currentPrice,td.currentPrice,td.price);
      if(!positionId||!direction){
        console.warn("AURIXA_PROTECTION_RECONCILIATION_SKIPPED:",JSON.stringify({
          positionId,direction,reason:"POSITION_ID_OR_SIDE_UNAVAILABLE"
        }));
        continue;
      }

      const tracked=await dbQuery?.(
        "SELECT * FROM aurixa.auto_trades WHERE position_id=$1 AND (status IN ('OPEN','PARTIAL') OR (status='REJECTED' AND order_id IS NOT NULL)) ORDER BY created_at DESC LIMIT 1",
        [String(positionId)]
      );
      let trade=tracked?.rows?.[0]||null;

      // The broker's live open-position list is authoritative. Repair a false
      // REJECTED status only when this exact position ID is currently present
      // at cTrader and the stored row has its broker order ID.
      if(trade && String(trade.status).toUpperCase()==="REJECTED" && trade.order_id && trade.position_id){
        let brokerOpenedAt=null;
        const rawOpenedAt=td.openTimestamp ?? pos.openTime ?? pos.openedAt;
        if(rawOpenedAt!==null && rawOpenedAt!==undefined && rawOpenedAt!==""){
          const numericTimestamp=Number(rawOpenedAt);
          const openedDate=Number.isFinite(numericTimestamp) && /^\\d+$/.test(String(rawOpenedAt))
            ? new Date(numericTimestamp) : new Date(rawOpenedAt);
          if(Number.isFinite(openedDate.getTime())) brokerOpenedAt=openedDate.toISOString();
        }
        try{
          const repaired=await dbQuery(
            `UPDATE aurixa.auto_trades
             SET status='OPEN',gate_reason='PASSED',error=NULL,
                 opened_at=COALESCE(opened_at,$2,created_at),updated_at=NOW()
             WHERE id=$1 AND status='REJECTED'
               AND order_id IS NOT NULL AND position_id IS NOT NULL`,
            [trade.id,brokerOpenedAt]
          );
          if(Number(repaired?.rowCount||0)===1){
            console.warn("AURIXA_EXECUTED_TRADE_RECORD_REPAIRED_FROM_BROKER_OPEN_POSITION:",JSON.stringify({
              tradeId:trade.id,orderId:trade.order_id,positionId:trade.position_id,
              symbol:targetSymbol,openedAt:brokerOpenedAt,source:"CTRADER_OPEN_POSITION_LIST"
            }));
            trade={...trade,status:"OPEN",gate_reason:"PASSED",error:null,opened_at:trade.opened_at||brokerOpenedAt||trade.created_at};
          }
        }catch(repairError){
          console.error("AURIXA_EXECUTED_TRADE_RECORD_REPAIR_FAILED:",JSON.stringify({
            tradeId:trade.id,orderId:trade.order_id,positionId:trade.position_id,
            symbol:targetSymbol,error:repairError.message
          }));
        }
      }
      if(!Number.isFinite(entry)) entry=numericPrice(trade?.execution_entry_price,trade?.planned_entry_price);

      // Persist peak favorable movement so a restart cannot erase the profit-protection reference.
      const riskState=positionRisk.classifyPositionRisk(direction,entry,current);
      const currentFavorableMove=Number.isFinite(entry)&&Number.isFinite(current)?(direction==="BUY"?current-entry:entry-current):NaN;
      const rawPeakMove=trade?.peak_favorable_move;
      const peakMoveBefore=rawPeakMove==null||rawPeakMove===""?0:Math.max(0,Number(rawPeakMove)||0);
      const peakMoveNow=Number.isFinite(currentFavorableMove)?Math.max(peakMoveBefore,currentFavorableMove):peakMoveBefore;
      const rawPeakPrice=trade?.peak_favorable_price;
      const peakPriceBefore=rawPeakPrice==null||rawPeakPrice===""?NaN:Number(rawPeakPrice);
      const peakPriceNow=Number.isFinite(currentFavorableMove)&&currentFavorableMove>peakMoveBefore?current:(Number.isFinite(peakPriceBefore)&&peakPriceBefore>0?peakPriceBefore:(currentFavorableMove>0?current:NaN));
      if(trade&&peakMoveNow>peakMoveBefore){
        try{
          await dbQuery("UPDATE aurixa.auto_trades SET peak_favorable_move=$2,peak_favorable_price=$3,updated_at=NOW() WHERE id=$1 AND status IN ('OPEN','PARTIAL')",[trade.id,peakMoveNow,Number.isFinite(peakPriceNow)?peakPriceNow:null]);
          trade.peak_favorable_move=peakMoveNow;trade.peak_favorable_price=Number.isFinite(peakPriceNow)?peakPriceNow:trade.peak_favorable_price;
          console.log("AURIXA_PEAK_PROFIT_TRACKED:",JSON.stringify({tradeId:trade.id,positionId,symbol:targetSymbol,direction,currentFavorableMove,peakFavorableMove:peakMoveNow,peakFavorablePrice:trade.peak_favorable_price}));
        }catch(e){console.warn("AURIXA_PEAK_PROFIT_PERSIST_FAILED:",JSON.stringify({tradeId:trade.id,positionId,symbol:targetSymbol,error:e.message}));}
      }
      if(riskState==="ADVERSE"&&!lossWarningPositions.has(String(positionId))){
        lossWarningPositions.add(String(positionId));
        console.warn("AURIXA_POSITION_ADVERSE_MOVE:",JSON.stringify({positionId,direction,entry,current,adverseMove:direction==="BUY"?entry-current:current-entry,action:"MONITOR_PROTECTION_AND_REASSESS_COMPLETED_CANDLES",automaticReverse:false}));
      }else if(riskState!=="ADVERSE"){
        lossWarningPositions.delete(String(positionId));
      }
      // Record the transition into unrealized profit once per broker position.
      // Trailing only moves a stop in the protective direction and its broker
      // confirmation is required before the update is logged as successful.
      if(Number.isFinite(entry)&&Number.isFinite(current)){
        const profitMoveNow=direction==="BUY"?current-entry:entry-current;
        if(profitMoveNow>0&&!profitDetectedPositions.has(String(positionId))){
          profitDetectedPositions.add(String(positionId));
          console.log("AURIXA_POSITION_PROFIT_DETECTED:",JSON.stringify({
            positionId,direction,entry,current,profitMove:profitMoveNow,
            accountId:liveStatus.accountId||null
          }));
        }else if(profitMoveNow<=0){
          profitDetectedPositions.delete(String(positionId));
        }
      }

      const quoteTime = liveStatus?.lastUpdate ? Date.parse(liveStatus.lastUpdate) : NaN;
      const quoteFresh = Number.isFinite(quoteTime) && now - quoteTime >= 0 && now - quoteTime <= 30000;
      const brokerSLRaw = pos?.stopLoss ?? td?.stopLoss;
      const brokerTPRaw = pos?.takeProfit ?? td?.takeProfit;
      const initialRisk = Number(trade?.stop_loss_distance) > 0
        ? Number(trade.stop_loss_distance)
        : (Number.isFinite(Number(trade?.planned_entry_price)) && Number.isFinite(Number(trade?.planned_stop_price))
          ? Math.abs(Number(trade.planned_entry_price) - Number(trade.planned_stop_price)) : NaN);
      const pnlRaw = pos?.unrealizedNetProfit ?? td?.unrealizedNetProfit ?? pos?.netProfit ?? pos?.profit ?? td?.profit;
      const intelligence = openPositionIntelligence.evaluatePosition({
        positionId, symbol: targetSymbol, direction, entry, current, pnl: pnlRaw,
        stopLoss: brokerSLRaw, takeProfit: brokerTPRaw, initialRisk, quoteFresh,
        tracked: Boolean(trade), partialTaken: trade?.partial_taken === true,
        demoAccount: liveStatus?.account?.isLive === false,
        mainDecision: marketDecision, now
      });
      positionIntelligenceSnapshots.set(String(positionId), intelligence);
      logPositionManagementAudit("position-intelligence:" + String(positionId), "AURIXA_OPEN_POSITION_INTELLIGENCE", intelligence, 60000);

      // Conservative partial reduction is only allowed for a tracked demo
      // position after at least 0.5R adverse movement and explicit OF1
      // confirmation of an eligible opposing V1 signal. Verify the broker's
      // remaining volume before recording the action.
      if (intelligence.action === "REDUCE" && trade && !positionActionInFlight.has(String(positionId))) {
        positionActionInFlight.add(String(positionId));
        try {
          const rawVolume = pos?.volume ?? td?.volume;
          const currentVolume = rawVolume == null || rawVolume === "" ? NaN : Number(rawVolume);
          const rules = await (cTrader.getSymbolVolumeConstraints || cTrader.getActiveSymbolVolumeConstraints || cTrader.getXAUUSDVolumeConstraints)?.(targetSymbol);
          const minVolume = Number(rules?.minVolume);
          const reduceVolume = Number.isFinite(currentVolume) && currentVolume > 0 && Number.isFinite(minVolume) && minVolume > 0
            ? brokerVolume.normalizeVolume(currentVolume * 0.5, rules, currentVolume - minVolume) : 0;
          if (!Number.isSafeInteger(currentVolume) || !Number.isSafeInteger(reduceVolume) ||
              reduceVolume < minVolume || reduceVolume >= currentVolume || currentVolume - reduceVolume < minVolume) {
            throw new Error("BROKER_VOLUME_RULES_DO_NOT_ALLOW_SAFE_PARTIAL_REDUCTION");
          }
          const reduceResult = await cTrader.closeXAUUSDPosition(positionId, reduceVolume, targetSymbol, { allowPartial: true });
          if (reduceResult?.brokerConfirmed !== true || reduceResult?.status !== "PARTIALLY_CLOSED" ||
              !Number.isFinite(Number(reduceResult.remainingVolume)) || Number(reduceResult.remainingVolume) <= 0) {
            throw new Error("BROKER_PARTIAL_REDUCTION_NOT_CONFIRMED");
          }
          const write = await dbQuery(
            "UPDATE aurixa.auto_trades SET partial_taken=true,updated_at=NOW() WHERE id=$1 AND status IN ('OPEN','PARTIAL')",
            [trade.id]
          );
          if (Number(write?.rowCount || 0) !== 1) throw new Error("BROKER_REDUCTION_CONFIRMED_BUT_TRADE_AUDIT_NOT_UPDATED");
          positionIntelligenceSnapshots.set(String(positionId), {
            ...intelligence, action: "REDUCE", brokerActionStatus: "CONFIRMED",
            reason: "Reduced exposure after 0.5R adverse move and confirmed OF1 opposing signal",
            reducedVolume: reduceVolume, remainingVolume: Number(reduceResult.remainingVolume),
            brokerOrderId: reduceResult.orderId || null, checkedAt: new Date().toISOString()
          });
          console.log("AURIXA_POSITION_REDUCTION_CONFIRMED:", JSON.stringify({
            tradeId: trade.id, positionId, symbol: targetSymbol, reduceVolume,
            remainingVolume: Number(reduceResult.remainingVolume), brokerConfirmed: true,
            reason: "ADVERSE_MOVE_AND_OF1_CONFIRMED_OPPOSING_SIGNAL"
          }));
          continue;
        } catch (reduceError) {
          positionIntelligenceSnapshots.set(String(positionId), {
            ...intelligence, action: "HOLD", brokerActionStatus: "FAILED",
            reason: "Partial reduction was not verified; keep existing broker SL active",
            actionError: reduceError.message, checkedAt: new Date().toISOString()
          });
          console.error("AURIXA_POSITION_REDUCTION_UNCONFIRMED:", JSON.stringify({
            positionId, symbol: targetSymbol, error: reduceError.message,
            brokerActionStatus: "FAILED"
          }));
        } finally {
          positionActionInFlight.delete(String(positionId));
        }
      }

      // Exit only AURIXA-tracked positions after a high-confidence, fully
      // eligible opposite signal is stable across consecutive monitor cycles.
      // Manual/untracked positions are never direction-closed automatically.
      if(trade && cfg.exitReversalEnabled){
        const pidKey=String(positionId);
        const opposite=positionRisk.shouldExitOnReversal({tracked:Boolean(trade),enabled:cfg.exitReversalEnabled,eligible:eligibleReversal,signal:exitDecision?.signal,direction});
        if(!opposite){
          logPositionManagementAudit(`reversal:${pidKey}`, "AURIXA_REVERSAL_EXIT_MONITOR", {
            positionId, tracked: true, enabled: cfg.exitReversalEnabled,
            oppositeSignal: exitDecision?.signal || null,
            confidence: Number.isFinite(Number(exitDecision?.confidence)) ? Number(exitDecision.confidence) : null,
            minimumConfidence: cfg.exitReversalMinConfidence,
            trend: exitDecision?.trend || null,
            executionEligible: exitDecision?.executionEligible === true,
            positionDirection: direction,
            reason: !cfg.exitReversalEnabled ? "REVERSAL_EXIT_DISABLED" :
              !["BUY", "SELL"].includes(exitDecision?.signal) ? "NO_DIRECTIONAL_SIGNAL" :
              exitDecision.signal === direction ? "SIGNAL_NOT_OPPOSITE" :
              exitDecision?.executionEligible !== true ? "SIGNAL_NOT_EXECUTION_ELIGIBLE" :
              Number(exitDecision?.confidence) < cfg.exitReversalMinConfidence ? "CONFIDENCE_BELOW_THRESHOLD" :
              !((exitDecision?.signal === "BUY" && exitDecision?.trend === "BULLISH") ||
                (exitDecision?.signal === "SELL" && exitDecision?.trend === "BEARISH")) ? "TREND_NOT_CONFIRMED" :
              "REVERSAL_NOT_QUALIFIED"
          });
          reversalConfirmations.delete(pidKey);
        }else{
          const prior=reversalConfirmations.get(pidKey);
          if(!prior || prior.signal!==exitDecision.signal){
            reversalConfirmations.set(pidKey,{signal:exitDecision.signal,firstSeenAt:now,candleTime:exitDecision.candleTime||null,confirmedCandles:exitDecision.candleTime?[String(exitDecision.candleTime)]:[]});
            console.log("AURIXA_REVERSAL_EXIT_CANDIDATE:",JSON.stringify({
              positionId,positionDirection:direction,oppositeSignal:exitDecision.signal,
              confidence:exitDecision.confidence,trend:exitDecision.trend,
              candleTime:exitDecision.candleTime||null,
              confirmMs:cfg.exitReversalConfirmMs
            }));
          }else{
            const observedCandle=exitDecision.candleTime==null?"":String(exitDecision.candleTime);
            if(observedCandle&&!prior.confirmedCandles.includes(observedCandle))prior.confirmedCandles.push(observedCandle);
            const twoCompletedCandles=prior.confirmedCandles.length>=2;
            if(now-prior.firstSeenAt>=cfg.exitReversalConfirmMs&&twoCompletedCandles){
            const lastAttempt=reversalCloseAttempts.get(pidKey)||0;
            if(now-lastAttempt>=30000){
              const rawVolume=pos?.volume??td?.volume;
              const closeVolume=rawVolume==null||rawVolume===""?NaN:Number(rawVolume);
              if(!Number.isInteger(closeVolume)||closeVolume<=0){
                console.error("AURIXA_REVERSAL_EXIT_BLOCKED:",JSON.stringify({
                  positionId,reason:"BROKER_POSITION_VOLUME_UNAVAILABLE"
                }));
              }else{
                reversalCloseAttempts.set(pidKey,now);
                positionIntelligenceSnapshots.set(pidKey, { ...intelligence, action: "CLOSE", reason: "Opposing main-strategy signal confirmed across two completed candles", brokerActionStatus: "SUBMITTED", checkedAt: new Date().toISOString() });
                console.log("AURIXA_REVERSAL_EXIT_SUBMITTED:",JSON.stringify({
                  positionId,positionDirection:direction,oppositeSignal:exitDecision.signal,
                  confidence:exitDecision.confidence,trend:exitDecision.trend,
                  closeVolume,reason:"CONFIRMED_MARKET_DIRECTION_REVERSAL"
                }));
                try{
                  const closeResult=await cTrader.closeXAUUSDPosition(positionId,closeVolume,targetSymbol);
                  if(!positionRisk.isBrokerCloseConfirmed(closeResult)){
                    throw new Error("Broker did not confirm that the position was fully closed");
                  }
                  const closeWrite = await dbQuery(
                    `UPDATE aurixa.auto_trades
                     SET status='CLOSED',closed_at=COALESCE(closed_at,NOW()),
                         close_price=COALESCE($2,close_price),profit=NULL,
                         exit_reason='AI_DIRECTION_REVERSAL',gate_reason='BROKER_CLOSE_CONFIRMED',
                         error=NULL,updated_at=NOW()
                     WHERE id=$1 AND status IN ('OPEN','PARTIAL')`,
                    [trade.id,closeResult.executionPrice==null||closeResult.executionPrice===""?null:(Number.isFinite(Number(closeResult.executionPrice))?Number(closeResult.executionPrice):null)]
                  );
                  if (Number(closeWrite?.rowCount || 0) !== 1) {
                    throw new Error("Broker confirms the position is closed, but the tracked AURIXA trade row was not updated");
                  }
                  console.log("AURIXA_REVERSAL_EXIT_CONFIRMED:",JSON.stringify({
                    tradeId:trade.id,positionId,closeOrderId:closeResult.orderId||null,
                    closePrice:closeResult.executionPrice??null,
                    brokerConfirmed:true,reason:"AI_DIRECTION_REVERSAL"
                  }));
                  positionIntelligenceSnapshots.set(pidKey, { ...intelligence, action: "CLOSE", reason: "Position close confirmed by cTrader broker snapshot", brokerActionStatus: "CONFIRMED", brokerOrderId: closeResult.orderId || null, closePrice: closeResult.executionPrice ?? null, checkedAt: new Date().toISOString() });
                  reversalConfirmations.delete(pidKey);
                  reversalCloseAttempts.delete(pidKey);
                  profitDetectedPositions.delete(pidKey);
                  closed++;
                  continue;
                }catch(closeError){
                  positionIntelligenceSnapshots.set(pidKey, { ...intelligence, action: "CLOSE", reason: "Close request failed or broker closure could not be verified; existing position remains under monitoring", brokerActionStatus: "UNCONFIRMED", actionError: closeError.message, checkedAt: new Date().toISOString() });
                  console.error("AURIXA_REVERSAL_EXIT_UNCONFIRMED:",JSON.stringify({
                    tradeId:trade.id,positionId,error:closeError.message,
                    retryAfterMs:30000
                  }));
                }
              }
            }
            }else if(now-prior.firstSeenAt>=cfg.exitReversalConfirmMs&&!twoCompletedCandles){
              logPositionManagementAudit(`reversal-candles:${pidKey}`,"AURIXA_REVERSAL_EXIT_MONITOR",{positionId,symbol:targetSymbol,positionDirection:direction,oppositeSignal:exitDecision.signal,confirmedCandles:prior.confirmedCandles.length,requiredCandles:2,latestCandleTime:observedCandle||null,reason:"WAITING_FOR_SECOND_COMPLETED_CANDLE"});
            }
          }
        }
      }

      // Protection reconciliation: if an open broker position has lost or
      // never received its SL/TP, restore both from the original trade plan
      // using the ACTUAL fill price. This runs before trailing logic and does
      // not wait for the position to reach profit.
      if (trade && typeof cTrader.modifyPositionProtection==="function") {
        const existingSL=Number(pos?.stopLoss ?? td?.stopLoss);
        const existingTP=Number(pos?.takeProfit ?? td?.takeProfit);
        const riskDistance=Number(trade.stop_loss_distance);
        const targetDistance=Number(trade.take_profit_distance);
        const plannedSL=Number(trade.planned_stop_price);
        const plannedTP=Number(trade.planned_take_profit_price);

        const slDistance=Number.isFinite(riskDistance) && riskDistance>0
          ? riskDistance
          : (Number.isFinite(plannedSL) ? Math.abs(Number(trade.planned_entry_price)-plannedSL) : NaN);
        const tpDistance=Number.isFinite(targetDistance) && targetDistance>0
          ? targetDistance
          : (Number.isFinite(plannedTP) ? Math.abs(plannedTP-Number(trade.planned_entry_price)) : NaN);

        const desiredSL=Number.isFinite(slDistance) && slDistance>0
          ? (direction==="BUY" ? entry-slDistance : entry+slDistance)
          : NaN;
        const desiredTP=Number.isFinite(tpDistance) && tpDistance>0
          ? (direction==="BUY" ? entry+tpDistance : entry-tpDistance)
          : NaN;

        const missingSL=!Number.isFinite(existingSL) || existingSL<=0;
        const missingTP=!Number.isFinite(existingTP) || existingTP<=0;
        // A profitable trailing stop can legitimately cross the entry price.
        // Judge SL placement against the live executable-side quote instead.
        const wrongSideSL=Number.isFinite(current)&&Number.isFinite(existingSL)&&
          (direction==="BUY" ? existingSL>=current : direction==="SELL" ? existingSL<=current : false);
        const wrongSideTP=Number.isFinite(entry)&&Number.isFinite(existingTP)&&
          (direction==="BUY" ? existingTP<=entry : direction==="SELL" ? existingTP>=entry : false);
        const invalidSL=missingSL||wrongSideSL;
        const invalidTP=missingTP||wrongSideTP;

        if ((invalidSL && Number.isFinite(desiredSL)) || (invalidTP && Number.isFinite(desiredTP))) {
          const repairSL=invalidSL && Number.isFinite(desiredSL) ? desiredSL : (Number.isFinite(existingSL) && existingSL>0 ? existingSL : null);
          const repairTP=invalidTP && Number.isFinite(desiredTP) ? desiredTP : (Number.isFinite(existingTP) && existingTP>0 ? existingTP : null);
          try {
            const protection=await cTrader.modifyPositionProtection(
              positionId,
              repairSL,
              repairTP,
              targetSymbol
            );
            if (protection?.verified !== true) {
              throw new Error("Broker did not confirm repaired SL/TP");
            }
            positionIntelligenceSnapshots.set(String(positionId), { ...intelligence, action: "PROTECT", reason: "Stop-loss/take-profit protection repaired and broker-verified", brokerActionStatus: "CONFIRMED", stopLoss: protection.stopLoss ?? repairSL, takeProfit: protection.takeProfit ?? repairTP, checkedAt: new Date().toISOString() });
            console.log("AURIXA_PROTECTION_REPAIRED:",JSON.stringify({
              positionId,direction,entry,
              stopLoss:protection.stopLoss ?? repairSL,
              takeProfit:protection.takeProfit ?? repairTP,
              verified:true
            }));
            protectedCount++;
          } catch (e) {
            positionIntelligenceSnapshots.set(String(positionId), { ...intelligence, action: "PROTECT", reason: "Broker protection repair failed; manual review required", brokerActionStatus: "FAILED", actionError: e.message, checkedAt: new Date().toISOString() });
            console.error("AURIXA_PROTECTION_REPAIR_FAILED:",JSON.stringify({
              positionId,direction,entry,stopLoss:repairSL,takeProfit:repairTP,
              verified:false,error:e.message
            }));
          }
        }
      }

      if(!cfg.trailingEnabled) continue;

      // Prefer cTrader's native trailing-stop flag. The broker then advances
      // the already verified stop-loss server-side, even if AURIXA's web page
      // is closed. Do not run a second app-managed trailing algorithm.
      if(typeof cTrader.modifyPositionProtection!=="function"){
        console.error("AURIXA_NATIVE_TRAILING_STOP_UNAVAILABLE:",JSON.stringify({positionId,symbol:targetSymbol,reason:"BROKER_AMENDMENT_UNAVAILABLE"}));
        continue;
      }
      const brokerTrailingRaw=pos?.trailingStopLoss ?? td?.trailingStopLoss;
      if(brokerTrailingRaw === true){
        logPositionManagementAudit(`native-trailing:${String(positionId)}`,"AURIXA_NATIVE_TRAILING_STOP_VERIFIED",{positionId,symbol:targetSymbol,enabled:true,source:"CTRADER_OPEN_POSITION_LIST"});
        continue;
      }
      try{
        const nativeResult=await cTrader.modifyPositionProtection(positionId,null,null,targetSymbol,{trailingStopLoss:true});
        if(nativeResult?.verified!==true || nativeResult?.trailingStopLoss!==true){
          throw new Error("cTrader did not confirm native trailingStopLoss=true");
        }
        console.log("AURIXA_NATIVE_TRAILING_STOP_ENABLED:",JSON.stringify({positionId,symbol:targetSymbol,enabled:true,brokerVerified:true,stopLoss:nativeResult.stopLoss??brokerSLRaw??null,takeProfit:nativeResult.takeProfit??brokerTPRaw??null}));
      }catch(nativeError){
        console.error("AURIXA_NATIVE_TRAILING_STOP_FAILED:",JSON.stringify({positionId,symbol:targetSymbol,error:nativeError.message}));
      }
      // Native cTrader trailing is the sole trailing mechanism; never also
      // calculate and send app-managed trailing SL amendments.
      continue;

      if(!Number.isFinite(entry)||!Number.isFinite(current)){
        console.warn("AURIXA_TRAILING_STOP_SKIPPED:",JSON.stringify({
          positionId,direction,entry,current,reason:"MARKET_OR_ENTRY_PRICE_UNAVAILABLE"
        }));
        continue;
      }
      const plannedEntry=numericPrice(trade?.planned_entry_price,entry);
      const plannedStop=numericPrice(trade?.planned_stop_price);
      const storedRisk=numericPrice(trade?.stop_loss_distance);
      const baseRisk=storedRisk>0?storedRisk:
        (Number.isFinite(plannedStop)?Math.abs(plannedEntry-plannedStop):0);
      const profitMove=direction==="BUY"?current-entry:entry-current;
      // For manual/untracked positions, derive trailing distances from the
      // active symbol's live ATR; use a symbol-scaled floor if candles are not ready.
      const fallbackTrailBase=Number(marketDecision?.atr)>0
        ? Number(marketDecision.atr)
        : Math.max(Number(activeProfile?.stopBuffer||0),0.00001)*10;
      const triggerDistance=baseRisk>0?baseRisk*cfg.trailingTriggerR:fallbackTrailBase*cfg.trailingTriggerR;
      const trailDistance=baseRisk>0?baseRisk*cfg.trailingDistanceR:fallbackTrailBase*cfg.trailingDistanceR;
      const peakMove=Math.max(peakMoveNow,Number.isFinite(profitMove)?profitMove:0);
      const giveback=peakMove>0?(peakMove-profitMove)/peakMove:0;
      const givebackTriggered=peakMove>=triggerDistance&&giveback>=0.30&&profitMove>0;
      if(!Number.isFinite(profitMove)||(!givebackTriggered&&profitMove<triggerDistance)||!Number.isFinite(trailDistance)||trailDistance<=0){
        logPositionManagementAudit(`trailing:${String(positionId)}`, "AURIXA_TRAILING_STOP_EVALUATION", {
          positionId, symbol: targetSymbol, direction, entry, current, profitMove,
          triggerDistance, trailDistance, trailingEnabled: cfg.trailingEnabled,
          reason: !Number.isFinite(profitMove) ? "PROFIT_MOVE_UNAVAILABLE" :
            !Number.isFinite(trailDistance) || trailDistance <= 0 ? "TRAIL_DISTANCE_INVALID" :
            profitMove < triggerDistance && !givebackTriggered ? "PROFIT_BELOW_TRAILING_TRIGGER" : "TRAILING_NOT_ELIGIBLE"
        });
        continue;
      }

      const peakPriceForTrail=Number.isFinite(peakPriceNow)?peakPriceNow:peakPriceBefore;
      const candidate=givebackTriggered&&Number.isFinite(peakPriceForTrail)?(direction==="BUY"?peakPriceForTrail-trailDistance:peakPriceForTrail+trailDistance):(direction==="BUY"?current-trailDistance:current+trailDistance);
      if(givebackTriggered&&(direction==="BUY"?candidate>=current:candidate<=current)){
        logPositionManagementAudit(`giveback-invalid:${String(positionId)}`,"AURIXA_PROFIT_GIVEBACK_GUARD",{positionId,symbol:targetSymbol,direction,entry,current,profitMove,peakMove,givebackPercent:Number((giveback*100).toFixed(2)),peakPrice:peakPriceForTrail,candidateStopLoss:candidate,reason:"PEAK_ANCHORED_STOP_NOT_VALID_RELATIVE_TO_MARKET"});
        continue;
      }
      // Null/missing SL means no stop was reported. Number(null) is 0 in JS,
      // which incorrectly prevented SELL trailing candidates (positive price < 0).
      const rawExistingSL=pos?.stopLoss ?? td?.stopLoss;
      const existingSL=rawExistingSL===null||rawExistingSL===undefined||rawExistingSL===""
        ? NaN : Number(rawExistingSL);
      // Never loosen an existing stop; an absent SL may be established by trailing.
      const improves=positionRisk.shouldImproveStop(direction,candidate,existingSL);
      if(!improves){
        logPositionManagementAudit(`trailing:${String(positionId)}`, "AURIXA_TRAILING_STOP_EVALUATION", {
          positionId, symbol: targetSymbol, direction, entry, current, profitMove, peakMove,
          givebackPercent:Number((giveback*100).toFixed(2)),givebackTriggered,
          existingStopLoss: Number.isFinite(existingSL) ? existingSL : null,
          candidateStopLoss: candidate, triggerDistance, trailDistance,
          reason: "CANDIDATE_WOULD_NOT_IMPROVE_EXISTING_STOP"
        });
        continue;
      }

      try{
        const result=await cTrader.modifyPositionProtection(positionId,candidate,null,targetSymbol);
        trailingUpdated++;
        console.log("AURIXA_TRAILING_STOP_VERIFIED:",JSON.stringify({symbol:targetSymbol,positionId,direction,requestedStopLoss:candidate,result}));
        console.log("AURIXA_TRAILING_STOP_UPDATED:",JSON.stringify({symbol:targetSymbol,positionId,direction,entry,current,profitMove,peakMove,givebackPercent:Number((giveback*100).toFixed(2)),givebackTriggered,triggerDistance,trailDistance,stopLoss:candidate}));
        if(givebackTriggered)console.log("AURIXA_PROFIT_GIVEBACK_PROTECTED:",JSON.stringify({symbol:targetSymbol,positionId,direction,entry,current,profitMove,peakMove,givebackPercent:Number((giveback*100).toFixed(2)),stopLoss:candidate,brokerVerified:true}));
      }catch(e){
        console.warn("AURIXA_TRAILING_STOP_FAILED:",JSON.stringify({positionId,error:e.message}));
      }
    }
  }

  if(typeof dbQuery!=="function")return {updated,closed,protectedCount,trailingUpdated,brokerPositions:positions.length};
  const open=await dbQuery("SELECT * FROM aurixa.auto_trades WHERE status IN ('OPEN','PARTIAL') AND symbol=$1 ORDER BY created_at DESC LIMIT 100",[targetSymbol]);
  for(const t of open.rows){
    const pos=positions.find(p=>String(p?.positionId||"")===String(t.position_id||""));
    if(pos){
      const td=pos.tradeData||{},liveStatus=cTrader.getCTraderStatusForSymbol?.(targetSymbol)||cTrader.getCTraderStatus?.()||{};
      const entry=Number(pos.price??td.openPrice??td.price??t.execution_entry_price);
      const current=Number((t.direction==="BUY"?liveStatus.bid:liveStatus.ask)??pos.currentPrice??td.currentPrice??td.price);
      const pnl=Number(pos.unrealizedNetProfit??td.unrealizedNetProfit??pos.netProfit);
      const rawSL=pos.stopLoss??td.stopLoss;
      const currentSL=rawSL==null||rawSL===""?NaN:Number(rawSL);
      const plannedEntry=Number(t.planned_entry_price);
      const plannedStop=Number(t.planned_stop_price);
      const storedRisk=Number(t.stop_loss_distance);
      const initialRisk=Number.isFinite(storedRisk)&&storedRisk>0
        ? storedRisk
        : Number.isFinite(plannedEntry)&&Number.isFinite(plannedStop)&&plannedEntry>0&&plannedStop>0
          ? Math.abs(plannedEntry-plannedStop) : NaN;
      const beStatus=liveStatus;
      const beEvaluation=breakevenStrategy.evaluateBreakeven({
        direction:t.direction,
        entryPrice:entry,
        currentPrice:current,
        initialRisk,
        triggerR:cfg.breakevenR,
        bid:Number(beStatus.bid),
        ask:Number(beStatus.ask),
        existingStopLoss:currentSL
      });
      if(beEvaluation.triggered&&cTrader.modifyPositionProtection){
        try{
          if(beEvaluation.alreadyProtected){
            // Existing positions may have been marked breakeven by the older
            // entry-only rule. Reconcile the broker stop against the new
            // spread-aware target before deciding the strategy is complete.
            if(t.breakeven_applied!==true){
              await dbQuery("UPDATE aurixa.auto_trades SET breakeven_applied=true,updated_at=NOW() WHERE id=$1",[t.id]);
              console.log("AURIXA_BREAKEVEN_ALREADY_PROTECTED:",JSON.stringify({
                tradeId:t.id,positionId:t.position_id,symbol:targetSymbol,direction:t.direction,
                entry,targetStopLoss:beEvaluation.targetStopLoss,brokerStopLoss:currentSL,
                triggerR:cfg.breakevenR,spreadAllowance:beEvaluation.spreadAllowance,brokerVerified:true
              }));
              protectedCount++;
            }
          }else if(beEvaluation.shouldMove){
            // Passing null for TP preserves the broker's current TP. The
            // cTrader adapter verifies the amended SL against a fresh broker snapshot.
            const amendment=await cTrader.modifyPositionProtection(
              t.position_id,beEvaluation.targetStopLoss,null,targetSymbol
            );
            const confirmedSL=Number(amendment?.stopLoss);
            const confirmedAtOrBeyondTarget=amendment?.verified===true&&
              Number.isFinite(confirmedSL)&&confirmedSL>0&&
              (t.direction==="BUY"
                ? confirmedSL>=beEvaluation.targetStopLoss-1e-8
                : confirmedSL<=beEvaluation.targetStopLoss+1e-8);
            if(!confirmedAtOrBeyondTarget) throw new Error("Broker did not verify the cost-aware breakeven stop");
            await dbQuery("UPDATE aurixa.auto_trades SET breakeven_applied=true,updated_at=NOW() WHERE id=$1",[t.id]);
            console.log("AURIXA_BREAKEVEN_VERIFIED:",JSON.stringify({
              tradeId:t.id,positionId:t.position_id,symbol:targetSymbol,direction:t.direction,
              entry,current,targetStopLoss:beEvaluation.targetStopLoss,brokerStopLoss:confirmedSL,
              triggerR:cfg.breakevenR,spreadAllowance:beEvaluation.spreadAllowance,
              brokerVerified:true,takeProfitPreserved:true
            }));
            protectedCount++;
          }else{
            logPositionManagementAudit("breakeven:"+String(t.position_id),"AURIXA_BREAKEVEN_WAITING",{
              tradeId:t.id,positionId:t.position_id,symbol:targetSymbol,direction:t.direction,
              entry,current,initialRisk,triggerR:cfg.breakevenR,
              existingStopLoss:Number.isFinite(currentSL)?currentSL:null,
              targetStopLoss:beEvaluation.targetStopLoss,reason:beEvaluation.reason
            });
          }
        }catch(e){
          console.warn("AURIXA_BREAKEVEN_FAILED:",JSON.stringify({
            tradeId:t.id,positionId:t.position_id,symbol:targetSymbol,
            targetStopLoss:beEvaluation.targetStopLoss,error:e.message,
            retryOnNextManagementCycle:true
          }));
        }
      }else if(!beEvaluation.triggered){
        logPositionManagementAudit("breakeven:"+String(t.position_id),"AURIXA_BREAKEVEN_WAITING",{
          tradeId:t.id,positionId:t.position_id,symbol:targetSymbol,direction:t.direction,
          entry,current,initialRisk,triggerR:cfg.breakevenR,reason:beEvaluation.reason
        });
      }
      await dbQuery("UPDATE aurixa.auto_trades SET execution_entry_price=COALESCE(execution_entry_price,$2),status='OPEN',profit=$3,updated_at=NOW() WHERE id=$1",[t.id,Number.isFinite(entry)?entry:null,Number.isFinite(pnl)?pnl:null]);updated++;
    }else{
      // BROKER is the source of truth for closure. If a position disappears
      // from the live cTrader position list, it was closed outside AURIXA
      // (manual close, SL, TP, broker action, etc.). Reconcile the closing
      // deal before marking the AURIXA trade CLOSED.
      let profit=null,closePrice=null,closedAt=null,reason="BROKER_CLOSED";
      if(cTrader.getDealsByPositionId)try{
        const dealFrom = new Date(t.opened_at || t.created_at || Date.now()-30*86400000).getTime();
        const deals=await cTrader.getDealsByPositionId(t.position_id, dealFrom, Date.now());
        const summary=summarizeRealizedClosingDeals(deals,t.position_id);
        closePrice=summary.closePrice;
        profit=summary.profit;
        closedAt=summary.closedAt;
        if(summary.closingDeals>0) reason="BROKER_CLOSED";
      }catch(e){
        console.warn("AURIXA_CLOSE_RECONCILIATION_FAILED:",JSON.stringify({
          positionId:t.position_id,error:e.message
        }));
      }
      // Open rows store unrealized P/L during monitoring. Replace it with the
      // broker's realized close result, or NULL until a verified deal is found.
      await dbQuery("UPDATE aurixa.auto_trades SET status='CLOSED',closed_at=COALESCE($5,closed_at,NOW()),close_price=COALESCE($2,close_price),profit=$3,exit_reason=COALESCE($4,exit_reason),updated_at=NOW() WHERE id=$1",[t.id,Number.isFinite(closePrice)?closePrice:null,Number.isFinite(profit)?profit:null,reason,closedAt]);
      console.log("AURIXA_BROKER_POSITION_CLOSED:",JSON.stringify({
        tradeId:t.id,positionId:t.position_id,reason,
        closePrice:Number.isFinite(closePrice)?closePrice:null,
        profit:Number.isFinite(profit)?profit:null,
        detectedBy:"live cTrader position reconciliation"
      }));
      closed++;
    }
  }
  // Closed-trade history repair is deliberately throttled across symbols.
  // syncOpenPositions runs once per supported symbol every scanner cycle; the
  // previous global LIMIT 100 query ran for every symbol and could issue up to
  // 1,000 broker-history requests per cycle. Rotate one symbol per cycle and
  // repair at most five rows, filtering by symbol to keep broker API traffic bounded.
  if(typeof dbQuery==="function" && cTrader.getDealsByPositionId &&
      SUPPORTED_SYMBOLS.length > 0 &&
      Date.now() - lastClosedBackfillAt >= 15000 &&
      targetSymbol === SUPPORTED_SYMBOLS[closedBackfillSymbolIndex % SUPPORTED_SYMBOLS.length]){
    lastClosedBackfillAt = Date.now();
    try{
      // Track attempts so records without a currently available deal do not
      // pin the queue forever; older closures are worked through in order.
      const missing=await dbQuery(`SELECT id,position_id,opened_at,created_at FROM aurixa.auto_trades
        WHERE status='CLOSED' AND UPPER(BTRIM(symbol))=$1 AND position_id IS NOT NULL
          AND (broker_reconciled_at IS NULL OR profit IS NULL OR close_price IS NULL)
          AND (broker_reconcile_attempted_at IS NULL OR broker_reconcile_attempted_at < NOW() - INTERVAL '60 minutes')
        ORDER BY broker_reconciled_at ASC NULLS FIRST,
                 broker_reconcile_attempted_at ASC NULLS FIRST,
                 closed_at ASC NULLS FIRST,id ASC LIMIT 5`,[targetSymbol]);
      for(const t of missing.rows){
        try{
          const dealFrom = new Date(t.opened_at || t.created_at || Date.now()-30*86400000).getTime();
          const deals=await cTrader.getDealsByPositionId(t.position_id, dealFrom, Date.now());
          const summary=summarizeRealizedClosingDeals(deals,t.position_id);
          if(summary.closingDeals===0){
            await dbQuery("UPDATE aurixa.auto_trades SET broker_reconcile_attempted_at=NOW(),updated_at=NOW() WHERE id=$1",[t.id]);
            console.log("AURIXA_CLOSED_TRADE_BACKFILL_PENDING:",JSON.stringify({tradeId:t.id,positionId:t.position_id,reason:"NO_VERIFIED_CLOSING_DEAL"}));
            continue;
          }
          await dbQuery(`UPDATE aurixa.auto_trades
            SET close_price=COALESCE($2,close_price),profit=$3,
                closed_at=COALESCE($4,closed_at),
                exit_reason=COALESCE(exit_reason,'BROKER_CLOSED'),
                broker_reconciled_at=NOW(),broker_reconcile_attempted_at=NOW(),updated_at=NOW()
            WHERE id=$1`,[t.id,summary.closePrice,summary.profit,summary.closedAt]);
          console.log("AURIXA_CLOSED_TRADE_BACKFILLED:",JSON.stringify({tradeId:t.id,positionId:t.position_id,closePrice:summary.closePrice,profit:summary.profit,closedAt:summary.closedAt,closingDeals:summary.closingDeals}));
        }catch(e){
          try { await dbQuery("UPDATE aurixa.auto_trades SET broker_reconcile_attempted_at=NOW(),updated_at=NOW() WHERE id=$1",[t.id]); } catch {}
          console.warn("AURIXA_CLOSED_TRADE_BACKFILL_FAILED:",JSON.stringify({tradeId:t.id,positionId:t.position_id,error:e.message}));
        }
      }
    }catch(e){
      console.warn("AURIXA_CLOSED_TRADE_BACKFILL_QUERY_FAILED:",e.message);
    } finally {
      closedBackfillSymbolIndex = (closedBackfillSymbolIndex + 1) % SUPPORTED_SYMBOLS.length;
    }
  }

  // Final broker-side audit after repairs/trailing amendments. This counts
  // protections from a fresh cTrader response rather than assuming a request
  // succeeded. The order gate uses the same broker fields before any new entry.
  let protectionAudit = {
    checked: positions.length,
    fullyProtected: 0,
    missingStopLoss: [],
    missingTakeProfit: [],
    invalidStopLoss: [],
    invalidTakeProfit: [],
    unverifiable: [],
    error: null
  };
  try {
    const auditedPositions = await cTrader.getOpenXAUUSDPositions(true,targetSymbol);
    protectionAudit.checked = auditedPositions.length;
    for (const position of auditedPositions) {
      const td = position?.tradeData || {};
      const side = Number(td.tradeSide ?? position?.tradeSide);
      const direction = side === 1 ? "BUY" : side === 2 ? "SELL" : null;
      const entry = Number(position?.price ?? td.openPrice ?? td.price ?? position?.openPrice ?? td.entryPrice);
      const status = cTrader.getCTraderStatusForSymbol?.(targetSymbol) || cTrader.getCTraderStatus?.() || {};
      const current = direction === "BUY" ? Number(status.bid) : direction === "SELL" ? Number(status.ask) : NaN;
      const rawSL = position?.stopLoss ?? td.stopLoss;
      const rawTP = position?.takeProfit ?? td.takeProfit;
      const sl = rawSL == null || rawSL === "" ? NaN : Number(rawSL);
      const tp = rawTP == null || rawTP === "" ? NaN : Number(rawTP);
      const pid = position?.positionId;
      if (!Number.isFinite(sl) || sl <= 0) protectionAudit.missingStopLoss.push(pid);
      else if (direction && Number.isFinite(current) &&
        (direction === "BUY" ? sl >= current : sl <= current)) protectionAudit.invalidStopLoss.push(pid);
      if (!Number.isFinite(tp) || tp <= 0) protectionAudit.missingTakeProfit.push(pid);
      else if (direction && Number.isFinite(entry) &&
        (direction === "BUY" ? tp <= entry : tp >= entry)) protectionAudit.invalidTakeProfit.push(pid);
      if (!direction || !Number.isFinite(entry) || entry <= 0 || !Number.isFinite(current) || current <= 0) {
        protectionAudit.unverifiable.push(pid);
      }
      const valid = Number.isFinite(sl) && sl > 0 && Number.isFinite(tp) && tp > 0 &&
        Boolean(direction) && Number.isFinite(entry) && entry > 0 &&
        Number.isFinite(current) && current > 0 &&
        !(direction === "BUY" ? sl >= current || tp <= entry : sl <= current || tp >= entry);
      if (valid) protectionAudit.fullyProtected++;
    }
    console.log("AURIXA_BROKER_PROTECTION_AUDIT:", JSON.stringify({
      accountId: cTrader.getCTraderStatus?.()?.accountId || null,
      ...protectionAudit,
      unprotectedCount: new Set([
        ...protectionAudit.missingStopLoss,
        ...protectionAudit.missingTakeProfit,
        ...protectionAudit.invalidStopLoss,
        ...protectionAudit.invalidTakeProfit,
        ...protectionAudit.unverifiable
      ]).size
    }));
  } catch (e) {
    protectionAudit.error = e.message;
    console.error("AURIXA_BROKER_PROTECTION_AUDIT_FAILED:", JSON.stringify({error:e.message}));
  }

  const livePositionIds=new Set(positions.map(p=>String(p?.positionId||"")));
  for(const key of reversalConfirmations.keys()) if(!livePositionIds.has(key)) reversalConfirmations.delete(key);
  for(const key of reversalCloseAttempts.keys()) if(!livePositionIds.has(key)) reversalCloseAttempts.delete(key);
  for(const key of profitDetectedPositions) if(!livePositionIds.has(key)) profitDetectedPositions.delete(key);
  for(const key of lossWarningPositions) if(!livePositionIds.has(key)) lossWarningPositions.delete(key);
  for(const key of positionIntelligenceSnapshots.keys()) if(!livePositionIds.has(key)) positionIntelligenceSnapshots.delete(key);
  return {symbol:targetSymbol,updated,closed,protectedCount,trailingUpdated,brokerPositions:positions.length,protectionAudit};
}

async function init(){
  if(typeof dbQuery!=="function")return false;
  await dbQuery("CREATE SCHEMA IF NOT EXISTS aurixa");
  await dbQuery(`CREATE TABLE IF NOT EXISTS aurixa.auto_trades(
    id BIGSERIAL PRIMARY KEY,
    decision_id BIGINT NULL,
    signal_id BIGINT NULL,
    strategy TEXT NOT NULL DEFAULT 'AURIXA_AI_TRADER_V1',
    strategy_signal_key TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    symbol TEXT NOT NULL DEFAULT 'XAUUSD',
    timeframe TEXT NOT NULL DEFAULT '5m',
    direction TEXT NOT NULL CHECK(direction IN ('BUY','SELL')),
    signal_entry_price NUMERIC(18,5),
    execution_entry_price NUMERIC(18,5),
    order_id TEXT,position_id TEXT,client_msg_id TEXT,
    volume BIGINT NOT NULL DEFAULT 0,
    stop_loss_distance NUMERIC(18,5) NOT NULL DEFAULT 0,
    take_profit_distance NUMERIC(18,5),
    planned_entry_price NUMERIC(18,5),planned_stop_price NUMERIC(18,5),planned_take_profit_price NUMERIC(18,5),
    risk_percent NUMERIC(8,4),risk_amount NUMERIC(18,5),gate_reason TEXT,
    status TEXT NOT NULL DEFAULT 'SUBMITTED',
    opened_at TIMESTAMPTZ,closed_at TIMESTAMPTZ,close_price NUMERIC(18,5),profit NUMERIC(18,5),
    broker_reconciled_at TIMESTAMPTZ,broker_reconcile_attempted_at TIMESTAMPTZ,
    peak_favorable_price NUMERIC(18,5),peak_favorable_move NUMERIC(18,5),
    error TEXT,partial_taken BOOLEAN NOT NULL DEFAULT false,breakeven_applied BOOLEAN NOT NULL DEFAULT false,exit_reason TEXT
  )`);
  await dbQuery("ALTER TABLE aurixa.auto_trades ADD COLUMN IF NOT EXISTS decision_id BIGINT");
  await dbQuery("ALTER TABLE aurixa.auto_trades ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await dbQuery("ALTER TABLE aurixa.auto_trades ADD COLUMN IF NOT EXISTS exit_reason TEXT");
  await dbQuery("ALTER TABLE aurixa.auto_trades ADD COLUMN IF NOT EXISTS broker_reconciled_at TIMESTAMPTZ");
  await dbQuery("ALTER TABLE aurixa.auto_trades ADD COLUMN IF NOT EXISTS broker_reconcile_attempted_at TIMESTAMPTZ");
  await dbQuery("ALTER TABLE aurixa.auto_trades ADD COLUMN IF NOT EXISTS peak_favorable_price NUMERIC(18,5)");
  await dbQuery("ALTER TABLE aurixa.auto_trades ADD COLUMN IF NOT EXISTS peak_favorable_move NUMERIC(18,5)");
  // Older deployments may have the table without a unique constraint.
  // Deduplicate historical keys before creating the constraint required by
  // future writes; the application no longer depends on the constraint for
  // ON CONFLICT targeting, but keeping it prevents duplicate signal rows.
  await dbQuery(`DELETE FROM aurixa.auto_trades a
    USING aurixa.auto_trades b
    WHERE a.id > b.id
      AND a.strategy_signal_key IS NOT NULL
      AND a.strategy_signal_key = b.strategy_signal_key`);
  await dbQuery(`CREATE UNIQUE INDEX IF NOT EXISTS auto_trades_strategy_signal_key_uidx
    ON aurixa.auto_trades(strategy_signal_key)`);
  await dbQuery(`CREATE TABLE IF NOT EXISTS aurixa.trade_approvals(
    id BIGSERIAL PRIMARY KEY,
    decision_id BIGINT NULL,
    strategy_signal_key TEXT NOT NULL UNIQUE,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('BUY','SELL')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    approved_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'PENDING',
    planned_entry_price NUMERIC(18,5),
    planned_stop_price NUMERIC(18,5),
    planned_take_profit_price NUMERIC(18,5),
    volume BIGINT NOT NULL DEFAULT 0,
    risk_percent NUMERIC(8,4),
    risk_amount NUMERIC(18,5),
    reward_risk NUMERIC(8,3),
    confidence NUMERIC(8,3),
    approval_reason TEXT,
    decision_json JSONB NOT NULL,
    trade_id BIGINT
  )`);
  await dbQuery("CREATE INDEX IF NOT EXISTS trade_approvals_pending_idx ON aurixa.trade_approvals(status,expires_at,created_at)");
  return true;
}
module.exports={configure,getStatus,executeAiDecision,dryRunAiTrader,syncOpenPositions,init,summarizeRealizedClosingDeals,getPositionIntelligence,getPendingTradeApprovals,resolveTradeApproval};
