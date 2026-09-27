const $ = id => document.getElementById(id);

function setText(id,value){
  const el=$(id);
  if(el) el.textContent=value;
}

function updateClock(){
  setText("clock",new Date().toLocaleTimeString([],{
    hour12:false,
    hour:"2-digit",
    minute:"2-digit",
    second:"2-digit"
  }));
}

async function checkHealth(){
  try{
    const r=await fetch("/api/health",{cache:"no-store"});
    if(!r.ok) throw new Error("health");
    const d=await r.json();

    setText("systemStatus","ONLINE");

    const pill=document.querySelector(".status-pill i");
    if(pill) pill.style.background="var(--green)";

    if(d.ctrader){
      setText("ctraderStatus","cTrader service detected");
    }
  }catch{
    setText("systemStatus","OFFLINE");
  }
}

async function loadMarket(){
  try{
    const r=await fetch("/api/market",{cache:"no-store"});
    if(!r.ok) throw new Error("market");

    const d=await r.json();

    /*
      Do not fabricate market data.
      Only display fields that the backend actually returns.
    */

    if(d.price !== undefined && d.price !== null){
      setText("price",Number(d.price).toFixed(2));
      setText("dataStatus","LIVE");
      setText("liveBadge","LIVE DATA");
    }

    if(d.change !== undefined) setText("change",d.change);
    if(d.prediction) setText("prediction",d.prediction);
    if(d.confidence !== undefined) setText("confidence",d.confidence);

    if(d.ema9 !== undefined) setText("ema9",d.ema9);
    if(d.ema21 !== undefined) setText("ema21",d.ema21);
    if(d.rsi !== undefined) setText("rsi",d.rsi);
    if(d.atr !== undefined) setText("atr",d.atr);

    if(d.score !== undefined){
      const n=Math.max(-100,Math.min(100,Number(d.score)));
      const width=((n+100)/200)*100;
      const meter=$("meterFill");
      if(meter) meter.style.width=width+"%";
    }
  }catch{
    setText("dataStatus","NO FEED");
  }
}

$("connectBtn")?.addEventListener("click",()=>{
  window.location.href="/auth/login";
});

updateClock();
checkHealth();
loadMarket();

setInterval(updateClock,1000);
setInterval(checkHealth,10000);
setInterval(loadMarket,5000);
