"use strict";

/* AURIXA AI Auto-Trader V1
 * Execution-only layer for ai-trader-engine.
 * Demo-only by default. The AI engine decides; this module enforces execution gates.
 */

let cTrader=null, dbQuery=null, aiEngine=null;

function configure({ctrader,query,ai}){cTrader=ctrader;dbQuery=query;aiEngine=ai;}
function config(){return{
 enabled:String(process.env.AUTO_TRADING||"false").toLowerCase()==="true",
 demoOnly:String(process.env.AUTO_TRADING_DEMO_ONLY||"true").toLowerCase()!=="false",
 riskPercent:Math.max(.1,Math.min(1,Number(process.env.AUTO_TRADING_RISK_PERCENT||.5))),
 maxSpread:Math.max(.05,Number(process.env.AUTO_TRADING_MAX_SPREAD||.60)),
 maxTradesPerDay:Math.max(1,Math.floor(Number(process.env.AUTO_TRADING_MAX_TRADES_PER_DAY||2))),
 cooldownMinutes:Math.max(5,Number(process.env.AUTO_TRADING_COOLDOWN_MINUTES||30)),
 maxSignalAgeMinutes:Math.max(1,Number(process.env.AUTO_TRADING_MAX_SIGNAL_AGE_MINUTES||7)),
 maxVolume:Math.max(100,Math.floor(Number(process.env.AUTO_TRADING_MAX_VOLUME||1000))),
 breakevenR:Math.max(.75,Number(process.env.AUTO_TRADING_BREAKEVEN_R||1))
};}

function getStatus(){
 const cfg=config(),ct=cTrader?.getCTraderStatus?.()||{};
 return {enabled:cfg.enabled,strategy:"AURIXA_AI_TRADER_V1",demoOnly:cfg.demoOnly,demoAccount:ct.account?.isLive===false,blocked:cfg.demoOnly&&ct.account?.isLive!==false,riskPercent:cfg.riskPercent,maxSpread:cfg.maxSpread,maxTradesPerDay:cfg.maxTradesPerDay,cooldownMinutes:cfg.cooldownMinutes,connected:Boolean(ct.connected),authorized:Boolean(ct.authorized),symbol:String(ct.symbolName||ct.symbol||"").toUpperCase()};
}

async function executeAiDecision(decision){
 const cfg=config();
 const reject=async(reason,extra={})=>{
   if(typeof dbQuery==="function")try{await dbQuery(`INSERT INTO aurixa.auto_trades(strategy,strategy_signal_key,symbol,timeframe,direction,signal_entry_price,volume,status,gate_reason,error) VALUES ('AURIXA_AI_TRADER_V1',$1,'XAUUSD','5m',$2,$3,0,'REJECTED',$4,$5) ON CONFLICT(strategy_signal_key) DO UPDATE SET status='REJECTED',gate_reason=EXCLUDED.gate_reason,error=EXCLUDED.error`,[key,decision?.signal||"BUY",decision?.entry||null,reason,extra.error||null]);}catch(e){console.error("AI trade audit failed:",e.message);}
   return {executed:false,strategy:"AURIXA_AI_TRADER_V1",decisionId:null,signal:decision?.signal||null,reason,...extra};
 };
 const key=`AURIXA_AI:${String(decision?.candleTime||"")}:${String(decision?.signal||"")}`;
 if(!cfg.enabled)return reject("AUTO_TRADING_DISABLED");
 if(!decision||!["BUY","SELL"].includes(decision.signal)||decision.executionEligible!==true)return reject("AI_DECISION_NOT_ELIGIBLE");
 const t=Number(decision.candleTime), ts=t<1e11?t*1000:t;
 if(!Number.isFinite(ts)||Date.now()-ts<0||Date.now()-ts>cfg.maxSignalAgeMinutes*60000)return reject("AI_SIGNAL_STALE");
 const st=cTrader?.getCTraderStatus?.();
 if(!st?.connected||!st?.authorized)return reject("CTRADER_NOT_READY");
 if(cfg.demoOnly&&st.account?.isLive!==false)return reject(st.account?.isLive===true?"LIVE_ACCOUNT_BLOCKED":"ACCOUNT_ENVIRONMENT_UNKNOWN");
 if(!st.tradingPermission)return reject("TRADE_PERMISSION_REQUIRED");
 if(String(st.symbolName||st.symbol||"").toUpperCase()!=="XAUUSD")return reject("XAUUSD_NOT_READY");
 const bid=Number(st.bid),ask=Number(st.ask); if(!Number.isFinite(bid)||!Number.isFinite(ask)||ask<=bid)return reject("LIVE_PRICE_UNAVAILABLE");
 const spread=ask-bid;if(spread>cfg.maxSpread)return reject("SPREAD_TOO_HIGH",{spread});
 const entry=decision.signal==="BUY"?ask:bid,stop=Number(decision.stopLoss),target=Number(decision.takeProfit);
 if(!Number.isFinite(stop)||!Number.isFinite(target))return reject("AI_SL_TP_MISSING");
 if(decision.signal==="BUY"&&(stop>=entry||target<=entry))return reject("BUY_PROTECTION_INVALID",{entry,stop,target});
 if(decision.signal==="SELL"&&(stop<=entry||target>=entry))return reject("SELL_PROTECTION_INVALID",{entry,stop,target});
 const riskDistance=Math.abs(entry-stop),targetDistance=Math.abs(target-entry);
 const rr=targetDistance/riskDistance;if(!Number.isFinite(rr)||rr<1.5)return reject("REWARD_RISK_TOO_LOW",{rr});
 const positions=await cTrader.getOpenXAUUSDPositions();if(positions.length>=1)return reject("XAUUSD_POSITION_ALREADY_OPEN",{openPositions:positions.length});
 if(typeof dbQuery==="function"){
   const dup=await dbQuery("SELECT id FROM aurixa.auto_trades WHERE strategy_signal_key=$1 LIMIT 1",[key]);if(dup.rows.length)return {executed:false,strategy:"AURIXA_AI_TRADER_V1",reason:"AI_SIGNAL_ALREADY_GATED",strategySignalKey:key};
   const lim=await dbQuery(`SELECT COUNT(*) FILTER(WHERE created_at>=CURRENT_DATE AND status IN ('OPEN','PARTIAL','CLOSED','SUBMITTED'))::int today,MAX(created_at) FILTER(WHERE status IN ('OPEN','PARTIAL','CLOSED','SUBMITTED')) last_trade FROM aurixa.auto_trades`);
   if(Number(lim.rows[0]?.today||0)>=cfg.maxTradesPerDay)return reject("MAX_DAILY_TRADES_REACHED");
   if(lim.rows[0]?.last_trade&&Date.now()-new Date(lim.rows[0].last_trade).getTime()<cfg.cooldownMinutes*60000)return reject("TRADE_COOLDOWN_ACTIVE");
 }
 const account=await cTrader.getAccountBalance?.();const balance=Number(account?.balance);if(!Number.isFinite(balance)||balance<=0)return reject("INVALID_ACCOUNT_BALANCE");
 const riskAmount=balance*cfg.riskPercent/100,volume=Math.min(cfg.maxVolume,Math.floor((riskAmount/riskDistance)/100)*100);if(volume<100)return reject("RISK_BUDGET_TOO_SMALL_FOR_VOLUME_STEP",{riskAmount,riskDistance});
 let result;try{result=await cTrader.placeDemoMarketOrder({direction:decision.signal,volume,stopLossDistance:riskDistance,takeProfitDistance:targetDistance});}catch(e){return reject("CTRADER_ORDER_REJECTED",{error:e.message});}
 if(typeof dbQuery==="function")try{await dbQuery(`INSERT INTO aurixa.auto_trades(strategy,strategy_signal_key,symbol,timeframe,direction,signal_entry_price,order_id,position_id,client_msg_id,volume,stop_loss_distance,take_profit_distance,status,opened_at,execution_entry_price,gate_reason,risk_percent,risk_amount,planned_entry_price,planned_stop_price,planned_take_profit_price) VALUES ('AURIXA_AI_TRADER_V1',$1,'XAUUSD','5m',$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $10 IN ('OPEN','PARTIAL') THEN NOW() ELSE NULL END,$11,'PASSED',$12,$13,$14,$15,$16) ON CONFLICT(strategy_signal_key) DO UPDATE SET order_id=EXCLUDED.order_id,position_id=EXCLUDED.position_id,status=EXCLUDED.status,execution_entry_price=EXCLUDED.execution_entry_price`,[key,decision.signal,decision.entry,result.orderId||null,result.positionId||null,result.clientMsgId||null,volume,riskDistance,targetDistance,result.status||"SUBMITTED",result.executionPrice||entry,cfg.riskPercent,riskAmount,entry,stop,target]);}catch(e){console.error("AI trade record failed:",e.message);}
 return {executed:["OPEN","PARTIAL"].includes(result.status),strategy:"AURIXA_AI_TRADER_V1",strategySignalKey:key,gate:"PASSED",direction:decision.signal,volume,riskAmount,plannedEntryPrice:entry,plannedStopPrice:stop,plannedTakeProfitPrice:target,...result};
}

async function dryRunOrderflow(){
 const candles=cTrader?.getMarketCandles?.()||[],st=cTrader?.getCTraderStatus?.()||{};
 const decision=aiEngine?.decide(candles,st)||null;
 return {dryRun:true,wouldExecute:Boolean(decision?.executionEligible),orderSubmitted:false,strategy:"AURIXA_AI_TRADER_V1",decision,reason:decision?.executionEligible?"AI_SIGNAL_READY_NO_ORDER_SUBMITTED":"AI_WAIT_OR_BLOCKED"};
}

async function init(){
 if(typeof dbQuery!=="function")return false;
 await dbQuery("CREATE SCHEMA IF NOT EXISTS aurixa");
 await dbQuery(`CREATE TABLE IF NOT EXISTS aurixa.auto_trades(
 id BIGSERIAL PRIMARY KEY,signal_id BIGINT NULL UNIQUE REFERENCES aurixa.signals(id) ON DELETE CASCADE,
 strategy TEXT NOT NULL DEFAULT 'AURIXA_AI_TRADER_V1',strategy_signal_key TEXT UNIQUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 symbol TEXT NOT NULL DEFAULT 'XAUUSD',timeframe TEXT NOT NULL DEFAULT '5m',direction TEXT NOT NULL CHECK(direction IN ('BUY','SELL')),
 signal_entry_price NUMERIC(18,5),execution_entry_price NUMERIC(18,5),order_id TEXT,position_id TEXT,client_msg_id TEXT,volume BIGINT NOT NULL DEFAULT 0,
 stop_loss_distance NUMERIC(18,5) NOT NULL DEFAULT 0,take_profit_distance NUMERIC(18,5),planned_entry_price NUMERIC(18,5),planned_stop_price NUMERIC(18,5),planned_take_profit_price NUMERIC(18,5),
 risk_percent NUMERIC(8,4),risk_amount NUMERIC(18,5),gate_reason TEXT,status TEXT NOT NULL DEFAULT 'SUBMITTED',opened_at TIMESTAMPTZ,closed_at TIMESTAMPTZ,close_price NUMERIC(18,5),profit NUMERIC(18,5),error TEXT,partial_taken BOOLEAN NOT NULL DEFAULT false,breakeven_applied BOOLEAN NOT NULL DEFAULT false)`);
 return true;
}
module.exports={configure,getStatus,executeAiDecision,dryRunOrderflow,init};
