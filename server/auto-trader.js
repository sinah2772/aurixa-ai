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
 maxVolume:Math.max(1000,Math.floor(Number(process.env.AUTO_TRADING_MAX_VOLUME||1000))),
 volumeMin:Math.max(1,Math.floor(Number(process.env.AUTO_TRADING_VOLUME_MIN||1000))),
 volumeStep:Math.max(1,Math.floor(Number(process.env.AUTO_TRADING_VOLUME_STEP||1000))),
 breakevenR:Math.max(.75,Number(process.env.AUTO_TRADING_BREAKEVEN_R||1)),
 trailingEnabled:String(process.env.AUTO_TRADING_TRAILING_ENABLED||"true").toLowerCase()!=="false",
 trailingTriggerR:Math.max(.5,Number(process.env.AUTO_TRADING_TRAILING_TRIGGER_R||1)),
 trailingDistanceR:Math.max(.1,Number(process.env.AUTO_TRADING_TRAILING_DISTANCE_R||.5)),
 trailingFixedDistance:Math.max(.1,Number(process.env.AUTO_TRADING_TRAILING_FIXED_DISTANCE||1.5))
};}

function maxOpenPositionsConfig(){
 const raw=String(process.env.AURIXA_MAX_OPEN_POSITIONS||"3").trim().toLowerCase();
 const value=raw==="unlimited"?25:Math.floor(Number(raw));
 return Math.max(1,Math.min(25,Number.isFinite(value)?value:3));
}

function getStatus(){
 const cfg=config(),ct=cTrader?.getCTraderStatus?.()||{};
 return {enabled:cfg.enabled,strategy:"AURIXA_AI_TRADER_V1",demoOnly:cfg.demoOnly,demoAccount:ct.account?.isLive===false,blocked:cfg.demoOnly&&ct.account?.isLive!==false,maxOpenPositions:maxOpenPositionsConfig(),riskPercent:cfg.riskPercent,maxSpread:cfg.maxSpread,maxTradesPerDay:cfg.maxTradesPerDay,cooldownMinutes:cfg.cooldownMinutes,volumeMin:cfg.volumeMin,volumeStep:cfg.volumeStep,maxVolume:cfg.maxVolume,connected:Boolean(ct.connected),authorized:Boolean(ct.authorized),symbol:String(ct.symbolName||ct.symbol||"").toUpperCase()};
}

async function executeAiDecision(decision, decisionId=null){
  const cfg=config();
  const key=`AURIXA_AI:${String(decision?.candleTime||"")}:${String(decision?.signal||"")}`;
  const reject=async(reason,extra={})=>{
    if(typeof dbQuery==="function")try{
      await dbQuery(`INSERT INTO aurixa.auto_trades(decision_id,strategy,strategy_signal_key,symbol,timeframe,direction,signal_entry_price,volume,status,gate_reason,error)
        VALUES ($1,'AURIXA_AI_TRADER_V1',$2,'XAUUSD','5m',$3,$4,0,'REJECTED',$5,$6)
        ON CONFLICT DO NOTHING`,
        [decisionId,key,decision?.signal||"BUY",decision?.entry||null,reason,extra.error||null]);
    await dbQuery(`UPDATE aurixa.auto_trades
      SET decision_id=$2,status='REJECTED',gate_reason=$3,error=$4,updated_at=NOW()
      WHERE strategy_signal_key=$1`,
      [key,decisionId,reason,extra.error||null]);
    }catch(e){console.error("AI trade audit failed:",e.message);}
    return {executed:false,strategy:"AURIXA_AI_TRADER_V1",decisionId,signal:decision?.signal||null,reason,...extra};
  };
  if(!cfg.enabled)return reject("AUTO_TRADING_DISABLED");
  if(!decision||!["BUY","SELL"].includes(decision.signal)||decision.executionEligible!==true)return reject("AI_DECISION_NOT_ELIGIBLE");
  const t=Number(decision.candleTime),ts=t<1e11?t*1000:t;
  if(!Number.isFinite(ts)||Date.now()-ts<0||Date.now()-ts>cfg.maxSignalAgeMinutes*60000)return reject("AI_SIGNAL_STALE");
  const st=cTrader?.getCTraderStatus?.();
  if(!st?.connected||!st?.authorized)return reject("CTRADER_NOT_READY");
  if(cfg.demoOnly&&st.account?.isLive!==false)return reject(st.account?.isLive===true?"LIVE_ACCOUNT_BLOCKED":"ACCOUNT_ENVIRONMENT_UNKNOWN");
  if(!st.tradingPermission)return reject("TRADE_PERMISSION_REQUIRED");
  if(String(st.symbolName||st.symbol||"").toUpperCase()!=="XAUUSD")return reject("XAUUSD_NOT_READY");
  const bid=Number(st.bid),ask=Number(st.ask);
  if(!Number.isFinite(bid)||!Number.isFinite(ask)||ask<=bid)return reject("LIVE_PRICE_UNAVAILABLE");
  const spread=ask-bid;if(spread>cfg.maxSpread)return reject("SPREAD_TOO_HIGH",{spread});
  const entry=decision.signal==="BUY"?ask:bid,stop=Number(decision.stopLoss),target=Number(decision.takeProfit);
  if(!Number.isFinite(stop)||!Number.isFinite(target))return reject("AI_SL_TP_MISSING");
  if(decision.signal==="BUY"&&(stop>=entry||target<=entry))return reject("BUY_PROTECTION_INVALID",{entry,stop,target});
  if(decision.signal==="SELL"&&(stop<=entry||target>=entry))return reject("SELL_PROTECTION_INVALID",{entry,stop,target});
  const riskDistance=Math.abs(entry-stop),targetDistance=Math.abs(target-entry),rr=targetDistance/Math.max(0.00001,riskDistance);
  if(!Number.isFinite(rr)||rr<2)return reject("REWARD_RISK_TOO_LOW",{rr,minRewardRisk:2});
  const positions=await cTrader.getOpenXAUUSDPositions();
  const maxOpenPositions=maxOpenPositionsConfig();\n  if(positions.length>=maxOpenPositions){
    const openPositions=positions.map(p=>({
      positionId:p?.positionId??null,
      symbolId:p?.tradeData?.symbolId??null,
      volume:p?.tradeData?.volume??null,
      tradeSide:p?.tradeData?.tradeSide??null,
      label:p?.tradeData?.label??p?.label??null,
      comment:p?.tradeData?.comment??p?.comment??null,
      status:p?.positionStatus??null
    }));
    return reject("MAX_OPEN_XAUUSD_POSITIONS_REACHED",{maxOpenPositions,openPositions:positions.length,positions:openPositions});
  }
  if(typeof dbQuery==="function"){
    const dup=await dbQuery("SELECT id FROM aurixa.auto_trades WHERE strategy_signal_key=$1 LIMIT 1",[key]);
    if(dup.rows.length)return {executed:false,strategy:"AURIXA_AI_TRADER_V1",decisionId,reason:"AI_SIGNAL_ALREADY_GATED",strategySignalKey:key};
    const lim=await dbQuery(`SELECT COUNT(*) FILTER(WHERE created_at>=CURRENT_DATE AND status IN ('OPEN','PARTIAL','CLOSED','SUBMITTED'))::int today,
      MAX(created_at) FILTER(WHERE status IN ('OPEN','PARTIAL','CLOSED','SUBMITTED')) last_trade FROM aurixa.auto_trades`);
    if(Number(lim.rows[0]?.today||0)>=cfg.maxTradesPerDay)return reject("MAX_DAILY_TRADES_REACHED");
    if(lim.rows[0]?.last_trade&&Date.now()-new Date(lim.rows[0].last_trade).getTime()<cfg.cooldownMinutes*60000)return reject("TRADE_COOLDOWN_ACTIVE");
  }
  // Read the live demo account immediately before sizing the order.
  // Volume is derived from account balance + risk %, then constrained by
  // the broker's actual XAUUSD min/step/max volume.
  const account=await cTrader.getAccountBalance?.();
  const balance=Number(account?.balance);
  const equity=Number(account?.equity);
  const freeMargin=Number(account?.freeMargin);
  if(!Number.isFinite(balance)||balance<=0)return reject("INVALID_ACCOUNT_BALANCE");
  const volumeRules=await cTrader.getXAUUSDVolumeConstraints?.();
  const brokerMin=Number(volumeRules?.minVolume);
  const brokerStep=Number(volumeRules?.stepVolume);
  const brokerMax=Number(volumeRules?.maxVolume);
  if(!Number.isFinite(brokerMin)||brokerMin<=0||!Number.isFinite(brokerStep)||brokerStep<=0){
    return reject("BROKER_VOLUME_RULES_UNAVAILABLE",{balance,equity,freeMargin});
  }
  const configuredMax=Number.isFinite(brokerMax)&&brokerMax>0?Math.min(cfg.maxVolume,brokerMax):cfg.maxVolume;
  const riskAmount=balance*cfg.riskPercent/100;
  const rawVolume=riskAmount/riskDistance;
  const volume=Math.min(configuredMax,Math.floor(rawVolume/brokerStep)*brokerStep);
  const requiredRiskAtMinVolume=brokerMin*riskDistance;
  if(volume<brokerMin){
    return reject("RISK_BUDGET_TOO_SMALL_FOR_BROKER_MIN_VOLUME",{
      accountBalance:balance,
      accountEquity:Number.isFinite(equity)?equity:null,
      freeMargin:Number.isFinite(freeMargin)?freeMargin:null,
      riskPercent:cfg.riskPercent,
      riskAmount,
      riskDistance,
      rawVolume,
      selectedVolume:0,
      brokerMinVolume:brokerMin,
      brokerVolumeStep:brokerStep,
      brokerMaxVolume:brokerMax,
      requiredRiskAtMinVolume
    });
  }
  console.log("AURIXA ACCOUNT VOLUME CHECK:",JSON.stringify({
    balance,equity:Number.isFinite(equity)?equity:null,
    freeMargin:Number.isFinite(freeMargin)?freeMargin:null,
    riskPercent:cfg.riskPercent,riskAmount,riskDistance,
    brokerMinVolume:brokerMin,brokerVolumeStep:brokerStep,
    brokerMaxVolume:brokerMax,selectedVolume:volume
  }));
  // ENTRY-FIRST EXECUTION:
  // Send the market order without waiting for SL/TP calculation at the
  // broker. The first priority is to get the XAUUSD position opened.
  let result;
  try{
    result=await cTrader.placeDemoMarketOrder({
      direction:decision.signal,
      volume
    });
  }catch(e){return reject("CTRADER_ORDER_REJECTED",{error:e.message});}

  // Only after cTrader confirms the position do we attach protection.
  // Protection is based on the actual fill price, not the pre-order quote.
  if(["OPEN","PARTIAL"].includes(result.status) && result.positionId && typeof cTrader.modifyPositionProtection==="function"){
    const actualEntry=Number(result.executionPrice);
    const protectionEntry=Number.isFinite(actualEntry)&&actualEntry>0?actualEntry:entry;
    const adjustedStop=decision.signal==="BUY"
      ? protectionEntry-riskDistance
      : protectionEntry+riskDistance;
    const adjustedTarget=decision.signal==="BUY"
      ? protectionEntry+targetDistance
      : protectionEntry-targetDistance;
    try{
      const protection=await cTrader.modifyPositionProtection(
        result.positionId,
        adjustedStop,
        adjustedTarget
      );
      result.stopLoss=adjustedStop;
      result.takeProfit=adjustedTarget;
      result.protectionStatus="SET";
      console.log("AURIXA_POST_FILL_PROTECTION:",JSON.stringify({
        positionId:result.positionId,
        entry:protectionEntry,
        stopLoss:adjustedStop,
        takeProfit:adjustedTarget,
        protection
      }));
    }catch(e){
      // The position is real, so never pretend it failed. Keep it OPEN and
      // surface the protection failure for reconciliation/monitoring.
      result.protectionStatus="FAILED";
      result.protectionError=e.message;
      console.error("AURIXA_POST_FILL_PROTECTION_FAILED:",JSON.stringify({
        positionId:result.positionId,
        error:e.message
      }));
    }
  }

  if(typeof dbQuery==="function")try{
    await dbQuery(`INSERT INTO aurixa.auto_trades(decision_id,strategy,strategy_signal_key,symbol,timeframe,direction,signal_entry_price,order_id,position_id,client_msg_id,volume,stop_loss_distance,take_profit_distance,status,opened_at,execution_entry_price,gate_reason,risk_percent,risk_amount,planned_entry_price,planned_stop_price,planned_take_profit_price)
      VALUES ($1,'AURIXA_AI_TRADER_V1',$2,'XAUUSD','5m',$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $11 IN ('OPEN','PARTIAL') THEN NOW() ELSE NULL END,$12,'PASSED',$13,$14,$15,$16,$17)
      ON CONFLICT DO NOTHING`,
      [decisionId,key,decision.signal,decision.entry,result.orderId||null,result.positionId||null,result.clientMsgId||null,volume,riskDistance,targetDistance,result.status||"SUBMITTED",result.executionPrice||entry,cfg.riskPercent,riskAmount,entry,stop,target]);
    await dbQuery(`UPDATE aurixa.auto_trades SET decision_id=$2,order_id=$3,position_id=$4,status=$5,execution_entry_price=$6,updated_at=NOW()
      WHERE strategy_signal_key=$1`,
      [key,decisionId,result.orderId||null,result.positionId||null,result.status||"SUBMITTED",result.executionPrice||entry]);
  }catch(e){console.error("AI trade record failed:",e.message);}
  return {executed:["OPEN","PARTIAL"].includes(result.status),strategy:"AURIXA_AI_TRADER_V1",decisionId,strategySignalKey:key,gate:"PASSED",direction:decision.signal,volume,riskAmount,plannedEntryPrice:entry,plannedStopPrice:stop,plannedTakeProfitPrice:target,...result};
}

async function dryRunAiTrader(){
  const candles=cTrader?.getMarketCandles?.()||[],st=cTrader?.getCTraderStatus?.()||{},decision=aiEngine?.decide(candles,st)||null;
  return {dryRun:true,wouldExecute:Boolean(decision?.executionEligible),orderSubmitted:false,strategy:"AURIXA_AI_TRADER_V1",decision,reason:decision?.executionEligible?"AI_SIGNAL_READY_NO_ORDER_SUBMITTED":"AI_WAIT_OR_BLOCKED"};
}

async function syncOpenPositions(){
  if(!cTrader?.getOpenXAUUSDPositions)return {updated:0,closed:0,protectedCount:0,trailingUpdated:0};
  const cfg=config();
  const positions=await cTrader.getOpenXAUUSDPositions();
  let updated=0,closed=0,protectedCount=0,trailingUpdated=0;

  // Trail EVERY open XAUUSD position independently. This intentionally runs
  // at the broker-position level so manually opened or previously untracked
  // XAUUSD positions are protected too. Demo-only is enforced by cTrader.
  if(cfg.trailingEnabled && typeof cTrader.modifyPositionProtection==="function"){
    for(const pos of positions){
      const positionId=pos?.positionId;
      const td=pos?.tradeData||{};
      const side=Number(td.tradeSide);
      const direction=side===1?"BUY":side===2?"SELL":null;
      const entry=Number(td.openPrice??td.price??pos.openPrice);
      const status=cTrader.getCTraderStatus?.()||{};
      const market=direction==="BUY"?Number(status.bid):Number(status.ask);
      const current=Number.isFinite(market)?market:Number(pos.currentPrice??td.currentPrice??td.price);
      if(!positionId||!direction||!Number.isFinite(entry)||!Number.isFinite(current))continue;

      const tracked=await dbQuery?.(
        "SELECT * FROM aurixa.auto_trades WHERE position_id=$1 AND status IN ('OPEN','PARTIAL') ORDER BY created_at DESC LIMIT 1",
        [String(positionId)]
      );
      const trade=tracked?.rows?.[0]||null;
      const baseRisk=trade?Math.abs(Number(trade.planned_entry_price)-Number(trade.planned_stop_price)):0;
      const profitMove=direction==="BUY"?current-entry:entry-current;
      const triggerDistance=baseRisk>0?baseRisk*cfg.trailingTriggerR:cfg.trailingFixedDistance;
      const trailDistance=baseRisk>0?baseRisk*cfg.trailingDistanceR:cfg.trailingFixedDistance;
      if(!Number.isFinite(profitMove)||profitMove<triggerDistance||!Number.isFinite(trailDistance)||trailDistance<=0)continue;

      const candidate=direction==="BUY"?current-trailDistance:current+trailDistance;
      const existingSL=Number(pos?.stopLoss??td?.stopLoss);
      // Never loosen an existing stop. If broker did not return the current
      // SL, the candidate is still valid and can establish the trailing SL.
      const improves=!Number.isFinite(existingSL)
        ? true
        : direction==="BUY"?candidate>existingSL: candidate<existingSL;
      if(!improves)continue;

      try{
        await cTrader.modifyPositionProtection(positionId,candidate,null);
        trailingUpdated++;
        console.log("AURIXA_TRAILING_STOP_UPDATED:",JSON.stringify({
          positionId,direction,entry,current,profitMove,triggerDistance,trailDistance,stopLoss:candidate
        }));
      }catch(e){
        console.warn("AURIXA_TRAILING_STOP_FAILED:",JSON.stringify({positionId,error:e.message}));
      }
    }
  }

  if(typeof dbQuery!=="function")return {updated,closed,protectedCount,trailingUpdated,brokerPositions:positions.length};
  const open=await dbQuery("SELECT * FROM aurixa.auto_trades WHERE status IN ('OPEN','PARTIAL') ORDER BY created_at DESC LIMIT 50");
  for(const t of open.rows){
    const pos=positions.find(p=>String(p?.positionId||"")===String(t.position_id||""));
    if(pos){
      const td=pos.tradeData||{},entry=Number(td.openPrice??td.price??t.execution_entry_price),current=Number(pos.currentPrice??td.currentPrice??td.price),pnl=Number(pos.unrealizedNetProfit??td.unrealizedNetProfit??pos.netProfit);
      const risk=Math.abs(Number(t.planned_entry_price)-Number(t.planned_stop_price)),move=t.direction==="BUY"?current-entry:entry-current,rVal=risk>0?move/risk:0;
      if(t.breakeven_applied!==true&&rVal>=cfg.breakevenR&&cTrader.modifyPositionProtection)try{
        await cTrader.modifyPositionProtection(t.position_id,entry,Number(t.planned_take_profit_price));
        await dbQuery("UPDATE aurixa.auto_trades SET breakeven_applied=true,updated_at=NOW() WHERE id=$1",[t.id]);protectedCount++;
      }catch(e){console.warn("AI breakeven:",e.message);}
      await dbQuery("UPDATE aurixa.auto_trades SET execution_entry_price=COALESCE(execution_entry_price,$2),status='OPEN',profit=$3,updated_at=NOW() WHERE id=$1",[t.id,Number.isFinite(entry)?entry:null,Number.isFinite(pnl)?pnl:null]);updated++;
    }else{
      let profit=null,closePrice=null,reason="BROKER_CLOSED";
      if(cTrader.getDealsByPositionId)try{
        const deals=await cTrader.getDealsByPositionId(t.position_id),last=Array.isArray(deals)&&deals.length?deals.at(-1):null;
        closePrice=Number(last?.executionPrice??last?.price);profit=Number(last?.netProfit??last?.profit);reason=String(last?.closeReason||reason);
      }catch(e){}
      await dbQuery("UPDATE aurixa.auto_trades SET status='CLOSED',closed_at=COALESCE(closed_at,NOW()),close_price=$2,profit=COALESCE($3,profit),exit_reason=$4,updated_at=NOW() WHERE id=$1",[t.id,Number.isFinite(closePrice)?closePrice:null,Number.isFinite(profit)?profit:null,reason]);closed++;
    }
  }
  return {updated,closed,protectedCount,trailingUpdated,brokerPositions:positions.length};
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
    error TEXT,partial_taken BOOLEAN NOT NULL DEFAULT false,breakeven_applied BOOLEAN NOT NULL DEFAULT false,exit_reason TEXT
  )`);
  await dbQuery("ALTER TABLE aurixa.auto_trades ADD COLUMN IF NOT EXISTS decision_id BIGINT");
  await dbQuery("ALTER TABLE aurixa.auto_trades ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await dbQuery("ALTER TABLE aurixa.auto_trades ADD COLUMN IF NOT EXISTS exit_reason TEXT");
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
  return true;
}
module.exports={configure,getStatus,executeAiDecision,dryRunAiTrader,syncOpenPositions,init};
