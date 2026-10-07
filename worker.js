const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
};

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QuantVote V2</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;
  padding:18px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  background:#f5f7fb;
  color:#18202a
}
.container{max-width:980px;margin:auto}
h1{margin:0 0 5px;font-size:25px}
.subtitle{color:#687384;margin-bottom:18px}
.card{
  background:white;
  border:1px solid #e2e7ef;
  border-radius:14px;
  padding:16px;
  margin-bottom:14px;
  box-shadow:0 2px 8px rgba(0,0,0,.04)
}
.search{
  display:flex;
  gap:8px;
  margin-bottom:8px
}
input{
  flex:1;
  min-width:0;
  padding:12px;
  border:1px solid #ccd4df;
  border-radius:9px;
  font-size:16px
}
button{
  padding:12px 16px;
  border:0;
  border-radius:9px;
  background:#1f2937;
  color:white;
  font-size:15px
}
button:active{opacity:.8}
.search-results{
  display:none;
  max-height:330px;
  overflow:auto;
  border:1px solid #e0e5ec;
  border-radius:10px;
  margin-top:8px
}
.search-result{
  padding:11px 12px;
  border-bottom:1px solid #edf0f4;
  cursor:pointer
}
.search-result:last-child{border-bottom:0}
.search-result:hover{background:#f4f6f9}
.result-symbol{font-weight:700}
.result-display{font-size:13px;color:#687384;margin-top:3px}
.current{font-size:14px;color:#586273;margin:10px 0}
.refresh{margin-top:8px}
.price-title{color:#687384;font-size:14px}
.price{font-size:30px;font-weight:700;margin:3px 0 15px}
.vote{
  display:inline-block;
  padding:6px 10px;
  border-radius:8px;
  font-weight:700;
  margin:5px 0
}
.bullish{background:#e7f7ed;color:#187a42}
.bearish{background:#fdeaea;color:#a52222}
.neutral{background:#eef1f5;color:#596273}
table{
  width:100%;
  border-collapse:collapse;
  font-size:14px
}
th,td{
  padding:9px 6px;
  border-bottom:1px solid #edf0f4;
  text-align:left
}
pre{
  white-space:pre-wrap;
  word-break:break-word;
  background:#f7f8fa;
  padding:12px;
  border-radius:9px;
  overflow:auto;
  font-size:12px
}
.reason{margin:5px 0}
.small{font-size:13px;color:#697586;line-height:1.6}
.error{color:#b42318}
@media(max-width:600px){
  body{padding:10px}
  .card{padding:13px}
  th,td{font-size:12px;padding:7px 3px}
  .price{font-size:27px}
}
</style>
</head>
<body>
<div class="container">

<h1>QuantVote V2</h1>
<div class="subtitle">Technical Research Dashboard · Kraken Public Data</div>

<div class="card">
  <div class="search">
    <input id="searchInput" placeholder="输入 BTC、ETH、SOL 或其他币种名称 / Symbol">
    <button onclick="doPairsSearch()">搜索</button>
  </div>

  <div id="searchResults" class="search-results"></div>

  <div class="current" id="currentPairText">当前：BTCUSD · XBTUSD</div>
  <button class="refresh" onclick="loadData()">刷新数据</button>
</div>

<div class="card">
  <div class="price-title" id="priceTitle">BTC 价格</div>
  <div class="price" id="price">—</div>

  <div id="voteBox">加载中...</div>

  <div style="margin-top:12px">
    <strong>多周期</strong>
    <table>
      <thead>
        <tr>
          <th>周期</th>
          <th>价格</th>
          <th>Score</th>
          <th>Vote</th>
          <th>Trend</th>
          <th>RSI</th>
        </tr>
      </thead>
      <tbody id="multiBody"></tbody>
    </table>
  </div>
</div>

<div class="card">
  <strong>1H 指标</strong>
  <pre id="indicators">加载中...</pre>

  <strong>1H 判断依据</strong>
  <div id="reasons" class="small">加载中...</div>
</div>

<div class="card small">
  <strong>方法说明</strong>
  <p>
    QuantVote Technical Core V2：
  </p>
  <p>
    EMA + RSI + MACD + KDJ + Bollinger + Volume。
  </p>
  <p>
    这是规则化技术分析研究分数，不是价格预测，也不是投资建议。
  </p>
</div>

</div>

<script>
let currentSymbol = "BTCUSD";
let currentPair = "XBTUSD";
let refreshTimer = null;

function esc(v){
  return String(v ?? "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#39;");
}

function cls(v){
  const x=String(v||"").toLowerCase();
  if(x.includes("bull")) return "bullish";
  if(x.includes("bear")) return "bearish";
  return "neutral";
}

function fmtPrice(v){
  if(v===null || v===undefined || !isFinite(Number(v))) return "—";
  const n=Number(v);
  if(n>=1000) return n.toFixed(2);
  if(n>=1) return n.toFixed(4);
  if(n>=0.01) return n.toFixed(6);
  return n.toFixed(8);
}

async function api(path){
  const r=await fetch(path,{cache:"no-store"});
  const j=await r.json();
  if(!r.ok || j.status==="error"){
    throw new Error(j.error || "API 请求失败");
  }
  return j;
}

async function doPairsSearch(){
  const q=document.getElementById("searchInput").value.trim();

  if(!q){
    document.getElementById("searchResults").style.display="none";
    return;
  }

  const box=document.getElementById("searchResults");
  box.style.display="block";
  box.innerHTML="<div class='search-result'>搜索中...</div>";

  try{
    const data=await api("/api/pairs?q="+encodeURIComponent(q));

    if(!data.results || !data.results.length){
      box.innerHTML="<div class='search-result'>没有找到交易对</div>";
      return;
    }

    box.innerHTML=data.results.map(x =>
      "<div class='search-result' onclick='selectPair("+
      JSON.stringify(x.symbol)+","+
      JSON.stringify(x.pair)+")'>"+
      "<div class='result-symbol'>"+esc(x.symbol)+"</div>"+
      "<div class='result-display'>"+esc(x.display)+"</div>"+
      "</div>"
    ).join("");

  }catch(e){
    box.innerHTML="<div class='search-result error'>搜索失败："+esc(e.message)+"</div>";
  }
}

async function selectPair(symbol,pair){
  currentSymbol=symbol;
  currentPair=pair;

  document.getElementById("searchResults").style.display="none";

  document.getElementById("currentPairText").textContent=
    "当前："+symbol+" · "+pair;

  document.getElementById("priceTitle").textContent=
    symbol.replace(/USD$|USDT$|USDC$|XBT$/,"")+" 价格";

  await loadData();
}

async function loadData(){
  try{
    document.getElementById("voteBox").textContent="加载中...";

    const pairParam="pair="+encodeURIComponent(currentPair);

    const [market,multi,vote,ind] = await Promise.all([
      api("/api/market?"+pairParam),
      api("/api/multi?"+pairParam),
      api("/api/vote?"+pairParam),
      api("/api/indicators?"+pairParam)
    ]);

    document.getElementById("price").textContent=
      fmtPrice(market.price);

    const voteClass=cls(vote.vote);

    document.getElementById("voteBox").innerHTML=
      "<div>1H QuantVote</div>"+
      "<div class='vote "+voteClass+"'>"+esc(vote.vote)+"</div>"+
      "<div><strong>1H Score</strong><br>"+
      esc(vote.score)+" / 7</div>"+
      "<div style='margin-top:8px'><strong>风险</strong><br>"+
      esc(vote.risk || "LOW")+
      "</div>";

    const rows=(multi.timeframes || []).map(x =>
      "<tr>"+
      "<td>"+esc(x.intervalLabel || x.interval)+"</td>"+
      "<td>"+fmtPrice(x.price)+"</td>"+
      "<td>"+esc(x.score)+"</td>"+
      "<td class='"+cls(x.vote)+"'>"+esc(x.vote)+"</td>"+
      "<td>"+esc(x.trend)+"</td>"+
      "<td>"+(Number(x.rsi).toFixed(1))+"</td>"+
      "</tr>"
    ).join("");

    document.getElementById("multiBody").innerHTML=rows;

    document.getElementById("indicators").textContent=
      JSON.stringify(ind.indicators || ind,null,2);

    const reasons=vote.reasons || [];

    document.getElementById("reasons").innerHTML=
      reasons.length
      ? reasons.map(x=>"<div class='reason'>• "+esc(x)+"</div>").join("")
      : "暂无判断依据";

  }catch(e){
    document.getElementById("voteBox").innerHTML=
      "<div class='error'>数据加载失败："+esc(e.message)+"</div>";
  }
}

document.getElementById("searchInput").addEventListener("keydown",function(e){
  if(e.key==="Enter") doPairsSearch();
});

loadData();

refreshTimer=setInterval(function(){
  loadData();
},60000);
</script>
</body>
</html>`;

function json(data,status=200){
  return new Response(JSON.stringify(data,null,2),{
    status,
    headers:{
      ...CORS_HEADERS,
      "Content-Type":"application/json;charset=UTF-8"
    }
  });
}

function normalizeSymbol(symbol){
  const s=String(symbol||"").toUpperCase();

  if(s==="BTCUSD" || s==="XBTUSD"){
    return "XBTUSD";
  }

  return s;
}

function cleanNumber(v){
  const n=Number(v);
  return Number.isFinite(n) ? n : null;
}

function sma(values,period){
  if(values.length<period) return null;
  let sum=0;
  for(let i=values.length-period;i<values.length;i++){
    sum+=values[i];
  }
  return sum/period;
}

function emaSeries(values,period){
  if(values.length<period) return [];

  const out=new Array(values.length).fill(null);
  let sum=0;

  for(let i=0;i<period;i++) sum+=values[i];

  let prev=sum/period;
  out[period-1]=prev;

  const k=2/(period+1);

  for(let i=period;i<values.length;i++){
    prev=values[i]*k+prev*(1-k);
    out[i]=prev;
  }

  return out;
}

function ema(values,period){
  const s=emaSeries(values,period);
  return s.length ? s[s.length-1] : null;
}

function rsi(values,period=14){
  if(values.length<period+1) return null;

  let gain=0;
  let loss=0;

  for(let i=1;i<=period;i++){
    const d=values[i]-values[i-1];
    if(d>=0) gain+=d;
    else loss-=d;
  }

  gain/=period;
  loss/=period;

  for(let i=period+1;i<values.length;i++){
    const d=values[i]-values[i-1];
    const g=d>0?d:0;
    const l=d<0?-d:0;

    gain=(gain*(period-1)+g)/period;
    loss=(loss*(period-1)+l)/period;
  }

  if(loss===0) return 100;

  const rs=gain/loss;
  return 100-(100/(1+rs));
}

function macd(values){
  if(values.length<35){
    return {
      macd:null,
      signal:null,
      histogram:null
    };
  }

  const e12=emaSeries(values,12);
  const e26=emaSeries(values,26);
  const line=[];

  for(let i=0;i<values.length;i++){
    if(e12[i]!==null && e26[i]!==null){
      line.push(e12[i]-e26[i]);
    }
  }

  const signalSeries=emaSeries(line,9);

  const m=line[line.length-1];
  const s=signalSeries[signalSeries.length-1];

  return {
    macd:m,
    signal:s,
    histogram:m!==null && s!==null ? m-s : null
  };
}

function bollinger(values,period=20,mult=2){
  if(values.length<period){
    return {
      middle:null,
      upper:null,
      lower:null,
      width:null
    };
  }

  const middle=sma(values,period);

  let sum=0;

  for(let i=values.length-period;i<values.length;i++){
    sum+=Math.pow(values[i]-middle,2);
  }

  const sd=Math.sqrt(sum/period);

  const upper=middle+mult*sd;
  const lower=middle-mult*sd;

  return {
    middle,
    upper,
    lower,
    width:middle!==0 ? ((upper-lower)/middle)*100 : null
  };
}

function atr(candles,period=14){
  if(candles.length<period+1) return null;

  const tr=[];

  for(let i=1;i<candles.length;i++){
    const c=candles[i];
    const prev=candles[i-1];

    tr.push(
      Math.max(
        c.high-c.low,
        Math.abs(c.high-prev.close),
        Math.abs(c.low-prev.close)
      )
    );
  }

  return sma(tr,period);
}

function kdj(candles,period=9){
  if(candles.length<period) {
    return {k:null,d:null,j:null};
  }

  let k=50;
  let d=50;

  for(let i=period-1;i<candles.length;i++){
    let high=-Infinity;
    let low=Infinity;

    for(let j=i-period+1;j<=i;j++){
      high=Math.max(high,candles[j].high);
      low=Math.min(low,candles[j].low);
    }

    const close=candles[i].close;

    const rsv=
      high===low
      ? 50
      : ((close-low)/(high-low))*100;

    k=(2*k+rsv)/3;
    d=(2*d+k)/3;
  }

  return {
    k,
    d,
    j=3*k-2*d
  };
}

function calculateIndicators(candles){
  const closes=candles.map(x=>x.close);

  const price=closes[closes.length-1];

  const ema20=ema(closes,20);
  const ema50=ema(closes,50);
  const ema200=ema(closes,200);

  const rsi14=rsi(closes,14);

  const m=macd(closes);

  const kd=kdj(candles,9);

  const bb=bollinger(closes,20,2);

  const atr14=atr(candles,14);

  const volumes=candles.map(x=>x.volume);
  const volume=volumes[volumes.length-1];
  const volumeAverage=sma(volumes,20);

  let trend="mixed";

  if(
    ema20!==null &&
    ema50!==null &&
    ema200!==null
  ){
    if(
      price>ema20 &&
      ema20>ema50 &&
      ema50>ema200
    ){
      trend="strong_bullish";
    }else if(
      price<ema20 &&
      ema20<ema50 &&
      ema50<ema200
    ){
      trend="strong_bearish";
    }else if(price>ema50){
      trend="bullish";
    }else if(price<ema50){
      trend="bearish";
    }
  }

  return {
    price,
    ema20,
    ema50,
    ema200,
    rsi14,
    macd:m.macd,
    macdSignal:m.signal,
    macdHistogram:m.histogram,
    k:kd.k,
    d:kd.d,
    j:kd.j,
    bollMiddle:bb.middle,
    bollUpper:bb.upper,
    bollLower:bb.lower,
    bollWidth:bb.width,
    atr14,
    atrPercent:
      atr14!==null && price
      ? (atr14/price)*100
      : null,
    volume,
    volumeAverage,
    volumeRatio:
      volumeAverage && volumeAverage!==0
      ? volume/volumeAverage
      : 0,
    trend
  };
}

function calculateVote(ind){
  let score=0;
  const reasons=[];

  if(
    ind.price!==null &&
    ind.ema20!==null &&
    ind.ema50!==null &&
    ind.ema200!==null
  ){
    if(
      ind.price>ind.ema20 &&
      ind.ema20>ind.ema50 &&
      ind.ema50>ind.ema200
    ){
      score+=3;
      reasons.push("价格位于 EMA20/50/200 上方，均线多头排列");
    }else if(
      ind.price<ind.ema20 &&
      ind.ema20<ind.ema50 &&
      ind.ema50<ind.ema200
    ){
      score-=3;
      reasons.push("价格位于 EMA20/50/200 下方，均线空头排列");
    }

    if(ind.price>ind.ema50 && ind.ema20>ind.ema50){
      score+=2;
    }else if(ind.price<ind.ema50 && ind.ema20<ind.ema50){
      score-=2;
    }
  }

  if(ind.rsi14!==null){
    if(ind.rsi14<30){
      score+=1;
      reasons.push(
        "RSI14="+ind.rsi14.toFixed(1)+"，进入超卖区域"
      );
    }else if(ind.rsi14>70){
      score-=1;
      reasons.push(
        "RSI14="+ind.rsi14.toFixed(1)+"，进入超买区域"
      );
    }else if(ind.rsi14>=50){
      score+=1;
      reasons.push(
        "RSI14="+ind.rsi14.toFixed(1)+"，动能偏强"
      );
    }else{
      score-=1;
      reasons.push(
        "RSI14="+ind.rsi14.toFixed(1)+"，动能偏弱"
      );
    }
  }

  if(
    ind.macd!==null &&
    ind.macdSignal!==null &&
    ind.macdHistogram!==null
  ){
    if(
      ind.macd>ind.macdSignal &&
      ind.macdHistogram>0
    ){
      score+=1;
      reasons.push("MACD 位于信号线上方，动能偏多");
    }else if(
      ind.macd<ind.macdSignal &&
      ind.macdHistogram<0
    ){
      score-=1;
      reasons.push("MACD 位于信号线下方，动能偏空");
    }
  }

  if(ind.k!==null && ind.d!==null){
    if(ind.k>ind.d){
      score+=1;
      reasons.push("KDJ K 线高于 D 线，短线动能偏多");
    }else if(ind.k<ind.d){
      score-=1;
      reasons.push("KDJ K 线低于 D 线，短线动能偏空");
    }
  }

  if(
    ind.bollUpper!==null &&
    ind.bollLower!==null
  ){
    if(ind.price>ind.bollUpper){
      score-=1;
    }else if(ind.price<ind.bollLower){
      score+=1;
    }
  }

  score=Math.max(-7,Math.min(7,score));

  let vote="NEUTRAL";

  if(score>=2) vote="BULLISH";
  else if(score<=-2) vote="BEARISH";

  return {
    score,
    vote,
    reasons
  };
}

function calculateRisk(ind){
  const atrPct=ind.atrPercent || 0;
  const bw=ind.bollWidth || 0;

  if(atrPct>=1 || bw>=10) return "HIGH";
  if(atrPct>=0.5 || bw>=5) return "MEDIUM";

  return "LOW";
}

function intervalToKraken(interval){
  if(interval==="15m") return 15;
  if(interval==="1H") return 60;
  if(interval==="4H") return 240;
  if(interval==="1D") return 1440;
  return 60;
}

function intervalLabel(interval){
  return interval;
}

async function fetchKraken(
  symbol,
  interval,
  limit=720,
  pairOverride=null
){
  const pair=pairOverride || normalizeSymbol(symbol);
  const krakenInterval=intervalToKraken(interval);

  const url=
    "https://api.kraken.com/0/public/OHLC?pair="+
    encodeURIComponent(pair)+
    "&interval="+
    krakenInterval;

  const response=await fetch(url,{
    headers:{
      "User-Agent":"QuantVote-V2"
    }
  });

  if(!response.ok){
    throw new Error("Kraken HTTP "+response.status);
  }

  const data=await response.json();

  if(data.error && data.error.length){
    throw new Error(data.error.join(", "));
  }

  const result=data.result || {};

  const key=Object.keys(result).find(k=>k!=="last");

  if(!key || !Array.isArray(result[key])){
    throw new Error("Kraken 没有返回K线数据");
  }

  const rows=result[key].slice(-limit);

  return rows.map(r=>({
    time:Number(r[0]),
    open:Number(r[1]),
    high:Number(r[2]),
    low:Number(r[3]),
    close:Number(r[4]),
    vwap:Number(r[5]),
    volume:Number(r[6]),
    count:Number(r[7])
  }));
}

async function fetchPairs(){
  const url="https://api.kraken.com/0/public/AssetPairs";

  const response=await fetch(url,{
    headers:{
      "User-Agent":"QuantVote-V2"
    }
  });

  if(!response.ok){
    throw new Error("Kraken AssetPairs HTTP "+response.status);
  }

  const data=await response.json();

  if(data.error && data.error.length){
    throw new Error(data.error.join(", "));
  }

  return data.result || {};
}

function pairBase(pair){
  const p=String(pair||"").toUpperCase();

  if(p.endsWith("XBT")) return p.slice(0,-3);
  if(p.endsWith("BTC")) return p.slice(0,-3);
  if(p.endsWith("USDT")) return p.slice(0,-4);
  if(p.endsWith("USDC")) return p.slice(0,-4);
  if(p.endsWith("USD")) return p.slice(0,-3);
  if(p.endsWith("EUR")) return p.slice(0,-3);
  if(p.endsWith("GBP")) return p.slice(0,-3);
  if(p.endsWith("JPY")) return p.slice(0,-3);
  if(p.endsWith("AUD")) return p.slice(0,-3);
  if(p.endsWith("CAD")) return p.slice(0,-3);
  if(p.endsWith("CHF")) return p.slice(0,-3);
  if(p.endsWith("ETH")) return p.slice(0,-3);

  return "";
}

function pairQuote(pair){
  const p=String(pair||"").toUpperCase();

  const quotes=[
    "USDT",
    "USDC",
    "PYUSD",
    "EURC",
    "SOFID",
    "FIDD",
    "EUROP",
    "XBT",
    "BTC",
    "ETH",
    "USD",
    "EUR",
    "GBP",
    "JPY",
    "AUD",
    "CAD",
    "CHF"
  ];

  for(const q of quotes){
    if(p.endsWith(q)) return q;
  }

  return "";
}

function scorePair(item,q){
  const symbol=String(item.symbol||"").toUpperCase();
  const pair=String(item.pair||"").toUpperCase();
  const alt=String(item.altname||"").toUpperCase();
  const ws=String(item.wsname||"").toUpperCase();
  const query=String(q||"").toUpperCase().trim();

  const base=String(item.base||"").toUpperCase();
  const quote=String(item.quote||"").toUpperCase();

  let score=0;

  const exactBase=
    base===query ||
    pairBase(pair)===query ||
    pairBase(alt)===query ||
    pairBase(ws.replace("/",""))===query;

  const exactSymbol=
    symbol===query ||
    alt===query ||
    ws.replace("/","")===query;

  if(exactSymbol) score+=10000;

  if(exactBase) score+=8000;

  const isMajorQuote=[
    "USD",
    "USDT",
    "USDC",
    "EUR",
    "GBP",
    "JPY",
    "AUD",
    "CAD",
    "CHF",
    "XBT",
    "BTC"
  ].includes(quote) ||
  [
    "USD",
    "USDT",
    "USDC",
    "EUR",
    "GBP",
    "JPY",
    "AUD",
    "CAD",
    "CHF",
    "XBT",
    "BTC"
  ].includes(pairQuote(pair));

  if(exactBase && isMajorQuote) score+=5000;

  if(exactBase && quote==="USD") score+=3000;
  if(exactBase && quote==="USDT") score+=2900;
  if(exactBase && quote==="USDC") score+=2800;

  if(
    symbol.startsWith(query) ||
    alt.startsWith(query) ||
    ws.replace("/","").startsWith(query)
  ){
    score+=1000;
  }

  if(pair.includes(query)) score+=100;

  return score;
}

function displayPair(item){
  const pair=
    item.wsname ||
    item.altname ||
    item.symbol ||
    "";

  return pair;
}

async function handlePairs(url){
  const q=(url.searchParams.get("q") || "").trim();

  if(!q){
    return json({
      status:"ok",
      source:"kraken",
      query:"",
      count:0,
      results:[]
    });
  }

  const all=await fetchPairs();

  const query=q.toUpperCase();

  const list=[];

  for(const [key,item] of Object.entries(all)){
    const symbol=String(key||"").toUpperCase();

    const alt=String(item.altname||"").toUpperCase();
    const ws=String(item.wsname||"").toUpperCase();
    const base=String(item.base||"").toUpperCase();
    const quote=String(item.quote||"").toUpperCase();

    const text=
      symbol+" "+
      alt+" "+
      ws+" "+
      base+" "+
      quote;

    if(!text.includes(query)) continue;

    list.push({
      symbol:key,
      pair:item.altname || key,
      display:displayPair(item),
      altname:item.altname || "",
      wsname:item.wsname || "",
      base:item.base || "",
      quote:item.quote || "",
      _score:scorePair({
        symbol:key,
        pair:item.altname || key,
        ...item
      },q)
    });
  }

  list.sort((a,b)=>{
    if(b._score!==a._score){
      return b._score-a._score;
    }

    return String(a.display).localeCompare(
      String(b.display)
    );
  });

  const results=list.slice(0,50).map(x=>({
    symbol:x.symbol,
    pair:x.pair,
    display:x.display
  }));

  return json({
    status:"ok",
    source:"kraken",
    query:q,
    count:results.length,
    results
  });
}

async function handleMarket(url){
  const pair=url.searchParams.get("pair") || "XBTUSD";

  const candles=await fetchKraken(
    pair,
    "1H",
    10,
    pair
  );

  const last=candles[candles.length-1];

  return json({
    status:"ok",
    source:"kraken",
    symbol:pair==="XBTUSD" ? "BTCUSD" : pair,
    pair,
    interval:60,
    timestamp:last.time,
    price:last.close
  });
}

async function handleIndicators(url){
  const pair=url.searchParams.get("pair") || "XBTUSD";

  const candles=await fetchKraken(
    pair,
    "1H",
    720,
    pair
  );

  const indicators=calculateIndicators(candles);

  return json({
    status:"ok",
    source:"kraken",
    symbol:pair==="XBTUSD" ? "BTCUSD" : pair,
    pair,
    interval:60,
    timestamp:candles[candles.length-1].time,
    indicators
  });
}

async function handleVote(url){
  const pair=url.searchParams.get("pair") || "XBTUSD";

  const candles=await fetchKraken(
    pair,
    "1H",
    720,
    pair
  );

  const indicators=calculateIndicators(candles);
  const result=calculateVote(indicators);
  const risk=calculateRisk(indicators);

  if(indicators.volumeAverage){
    result.reasons.push(
      "成交量约为20周期均量的 "+
      (indicators.volumeRatio || 0).toFixed(2)+
      " 倍，市场活动偏"+
      (
        indicators.volumeRatio<0.8
        ? "低"
        : indicators.volumeRatio>1.2
        ? "高"
        : "正常"
      )
    );
  }

  return json({
    status:"ok",
    source:"kraken",
    symbol:pair==="XBTUSD" ? "BTCUSD" : pair,
    pair,
    interval:60,
    price:indicators.price,
    score:result.score,
    vote:result.vote,
    risk,
    trend:indicators.trend,
    reasons:result.reasons
  });
}

async function handleMulti(url){
  const pair=url.searchParams.get("pair") || "XBTUSD";

  const intervals=["15m","1H","4H","1D"];

  const result=[];

  for(const interval of intervals){
    const candles=await fetchKraken(
      pair,
      interval,
      720,
      pair
    );

    const indicators=calculateIndicators(candles);
    const vote=calculateVote(indicators);

    result.push({
      interval,
      intervalLabel:interval,
      price:indicators.price,
      score:vote.score,
      vote:vote.vote,
      trend:indicators.trend,
      rsi:indicators.rsi14
    });
  }

  return json({
    status:"ok",
    source:"kraken",
    symbol:pair==="XBTUSD" ? "BTCUSD" : pair,
    pair,
    timeframes:result
  });
}

async function handleRegime(url){
  const pair=url.searchParams.get("pair") || "XBTUSD";

  const candles=await fetchKraken(
    pair,
    "1D",
    720,
    pair
  );

  const ind=calculateIndicators(candles);

  let regime="RANGE";

  if(ind.trend==="strong_bullish"){
    regime="BULL";
  }else if(ind.trend==="strong_bearish"){
    regime="BEAR";
  }else if(ind.trend==="bullish"){
    regime="BULLISH_BIAS";
  }else if(ind.trend==="bearish"){
    regime="BEARISH_BIAS";
  }

  return json({
    status:"ok",
    source:"kraken",
    symbol:pair==="XBTUSD" ? "BTCUSD" : pair,
    pair,
    regime,
    trend:ind.trend,
    price:ind.price,
    rsi:ind.rsi14
  });
}

function runBacktest(candles){
  if(candles.length<220){
    return {
      trades:0,
      winRate:0,
      cumulativeReturn:0,
      maxDrawdown:0,
      sharpe:0,
      profitFactor:0,
      longTrades:0,
      shortTrades:0
    };
  }

  let equity=1;
  let peak=1;
  let maxDD=0;

  let inPosition=false;
  let entry=0;

  const returns=[];
  const wins=[];
  const losses=[];

  for(let i=200;i<candles.length;i++){
    const slice=candles.slice(0,i+1);
    const ind=calculateIndicators(slice);
    const vote=calculateVote(ind);

    const price=candles[i].close;

    if(!inPosition && vote.score>=3){
      inPosition=true;
      entry=price;
      continue;
    }

    if(inPosition && vote.score<=0){
      const ret=(price-entry)-Math.abs(price-entry)*0.001;
      const pct=ret/entry;

      equity*=1+pct;

      returns.push(pct);

      if(pct>0) wins.push(pct);
      else losses.push(pct);

      peak=Math.max(peak,equity);

      const dd=(peak-equity)/peak;
      maxDD=Math.max(maxDD,dd);

      inPosition=false;
      entry=0;
    }
  }

  if(inPosition){
    const price=candles[candles.length-1].close;
    const ret=(price-entry)-Math.abs(price-entry)*0.001;
    const pct=ret/entry;

    equity*=1+pct;
    returns.push(pct);

    if(pct>0) wins.push(pct);
    else losses.push(pct);

    peak=Math.max(peak,equity);

    const dd=(peak-equity)/peak;
    maxDD=Math.max(maxDD,dd);
  }

  const n=returns.length;

  const winRate=
    n
    ? wins.length/n
    : 0;

  const avg=
    n
    ? returns.reduce((a,b)=>a+b,0)/n
    : 0;

  let variance=0;

  if(n>1){
    variance=
      returns.reduce(
        (s,x)=>s+Math.pow(x-avg,2),
        0
      )/(n-1);
  }

  const sd=Math.sqrt(variance);

  const sharpe=
    sd
    ? avg/sd*Math.sqrt(365)
    : 0;

  const grossProfit=
    wins.reduce((a,b)=>a+b,0);

  const grossLoss=
    Math.abs(
      losses.reduce((a,b)=>a+b,0)
    );

  const profitFactor=
    grossLoss
    ? grossProfit/grossLoss
    : 0;

  return {
    trades:n,
    winRate,
    cumulativeReturn:equity-1,
    maxDrawdown:maxDD,
    sharpe,
    profitFactor,
    longTrades:n,
    shortTrades:0
  };
}

async function handleBacktest(url){
  const pair=url.searchParams.get("pair") || "XBTUSD";

  const candles=await fetchKraken(
    pair,
    "1H",
    720,
    pair
  );

  const result=runBacktest(candles);

  return json({
    status:"ok",
    source:"kraken",
    symbol:pair==="XBTUSD" ? "BTCUSD" : pair,
    pair,
    interval:"1H",
    method:"baseline_rule_backtest",
    fee:0.001,
    ...result
  });
}

async function handleRequest(request){
  const url=new URL(request.url);

  if(request.method==="OPTIONS"){
    return new Response(null,{
      status:204,
      headers:CORS_HEADERS
    });
  }

  if(request.method!=="GET"){
    return json({
      status:"error",
      error:"Method Not Allowed"
    },405);
  }

  const path=url.pathname;

  try{
    if(path==="/"){
      return new Response(HTML,{
        headers:{
          ...CORS_HEADERS,
          "Content-Type":"text/html;charset=UTF-8"
        }
      });
    }

    if(path==="/api/health"){
      return json({
        status:"ok",
        service:"QuantVote",
        version:"v2-worker",
        source:"kraken",
        endpoints:[
          "/api/health",
          "/api/market",
          "/api/indicators",
          "/api/vote",
          "/api/multi",
          "/api/regime",
          "/api/backtest",
          "/api/pairs"
        ]
      });
    }

    if(path==="/api/pairs"){
      return await handlePairs(url);
    }

    if(path==="/api/market"){
      return await handleMarket(url);
    }

    if(path==="/api/indicators"){
      return await handleIndicators(url);
    }

    if(path==="/api/vote"){
      return await handleVote(url);
    }

    if(path==="/api/multi"){
      return await handleMulti(url);
    }

    if(path==="/api/regime"){
      return await handleRegime(url);
    }

    if(path==="/api/backtest"){
      return await handleBacktest(url);
    }

    return json({
      status:"error",
      error:"Not Found"
    },404);

  }catch(error){
    return json({
      status:"error",
      error:error instanceof Error
        ? error.message
        : String(error)
    },500);
  }
}

export default {
  async fetch(request){
    return handleRequest(request);
  }
};
