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
  font-family:Arial,"Microsoft YaHei",sans-serif;
  background:#0f1115;
  color:#f2f4f7;
}
.container{
  max-width:1100px;
  margin:auto;
  padding:20px;
}
h1{margin:0 0 6px}
.subtitle{
  color:#9ca3af;
  margin-bottom:20px;
}
.card{
  background:#181b21;
  border:1px solid #292e38;
  border-radius:14px;
  padding:18px;
  margin-bottom:16px;
}
.search-box{
  display:flex;
  gap:10px;
  flex-wrap:wrap;
}
.search-box input{
  flex:1;
  min-width:180px;
  padding:12px;
  border-radius:8px;
  border:1px solid #3a404c;
  background:#101319;
  color:#fff;
  font-size:16px;
}
button{
  padding:12px 18px;
  border:0;
  border-radius:8px;
  background:#2563eb;
  color:white;
  font-size:15px;
  cursor:pointer;
}
button:active{opacity:.8}
.search-results{
  margin-top:10px;
}
.search-result{
  padding:12px;
  border-bottom:1px solid #292e38;
  cursor:pointer;
}
.search-result:hover{
  background:#20242c;
}
.search-symbol{
  font-weight:bold;
}
.search-pair{
  color:#9ca3af;
  font-size:13px;
  margin-top:4px;
}
.current{
  color:#9ca3af;
  margin-top:10px;
}
.grid{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:12px;
}
.metric{
  background:#101319;
  border-radius:10px;
  padding:14px;
}
.metric-title{
  color:#9ca3af;
  font-size:13px;
}
.metric-value{
  font-size:24px;
  font-weight:bold;
  margin-top:8px;
}
table{
  width:100%;
  border-collapse:collapse;
}
th,td{
  padding:10px;
  border-bottom:1px solid #292e38;
  text-align:left;
}
th{color:#9ca3af}
.reason{
  margin:8px 0;
}
pre{
  white-space:pre-wrap;
  word-break:break-word;
}
@media(max-width:700px){
  .grid{grid-template-columns:repeat(2,1fr)}
  .container{padding:12px}
  th,td{font-size:13px}
}
</style>
</head>

<body>
<div class="container">

<h1>QuantVote V2</h1>
<div class="subtitle">
Technical Research Dashboard · Kraken Public Data
</div>

<div class="card">
<h2>搜索交易对</h2>

<div class="search-box">
<input
  id="pairSearch"
  placeholder="输入 BTC、ETH、SOL 或其他币种名称 / Symbol"
  autocomplete="off"
/>
<button id="searchBtn">搜索</button>
</div>

<div id="searchResults" class="search-results"></div>

<div id="currentPair" class="current">
当前：BTCUSD · XBTUSD
</div>
</div>

<div class="card">
<button id="refreshBtn">刷新数据</button>
</div>

<div class="grid">

<div class="metric">
<div class="metric-title" id="priceTitle">BTC 价格</div>
<div class="metric-value" id="price">—</div>
</div>

<div class="metric">
<div class="metric-title">1H QuantVote</div>
<div class="metric-value" id="vote">—</div>
</div>

<div class="metric">
<div class="metric-title">1H Score</div>
<div class="metric-value" id="score">—</div>
</div>

<div class="metric">
<div class="metric-title">风险</div>
<div class="metric-value" id="risk">—</div>
</div>

</div>

<div class="card">
<h2>多周期</h2>

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
<tbody id="multiBody">
<tr>
<td colspan="6">加载中…</td>
</tr>
</tbody>
</table>
</div>

<div class="card">
<h2>1H 指标</h2>
<div id="indicators">加载中…</div>
</div>

<div class="card">
<h2>1H 判断依据</h2>
<div id="reasons">加载中…</div>
</div>

<div class="card">
<h2>方法说明</h2>
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

function escapeHtml(value){
  return String(value ?? "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#39;");
}

async function doPairsSearch(){

  const input =
    document.getElementById("pairSearch");

  const results =
    document.getElementById("searchResults");

  const q =
    String(input.value || "").trim();

  if(!q){
    results.innerHTML = "";
    return;
  }

  results.innerHTML = "搜索中…";

  try{

    const response =
      await fetch(
        "/api/pairs?q="+
        encodeURIComponent(q)
      );

    const data =
      await response.json();

    if(
      data.status !== "ok" ||
      !Array.isArray(data.results)
    ){
      results.innerHTML =
        "搜索失败";
      return;
    }

    if(!data.results.length){
      results.innerHTML =
        "没有找到交易对";
      return;
    }

    results.innerHTML =
      data.results.map(function(x){

        const symbol =
          String(x.symbol || "")
            .replace(/'/g,"\\\\'");

        const pair =
          String(x.pair || "")
            .replace(/'/g,"\\\\'");

        const display =
          x.display
            ? " · "+escapeHtml(x.display)
            : "";

        return (
          '<div class="search-result" '+
          'onclick="selectPair(\\''+
          symbol+
          '\\',\\''+
          pair+
          '\\')">'+

            '<div class="search-symbol">'+
              escapeHtml(x.symbol)+
            '</div>'+

            '<div class="search-pair">'+
              escapeHtml(x.pair)+
              display+
            '</div>'+

          '</div>'
        );

      }).join("");

  }catch(e){

    results.innerHTML =
      "搜索失败："+escapeHtml(e.message);

  }
}

function selectPair(symbol,pair){

  currentSymbol =
    String(symbol || "").toUpperCase();

  currentPair =
    String(pair || "").toUpperCase();

  document.getElementById(
    "currentPair"
  ).textContent =
    "当前："+currentSymbol+
    " · "+currentPair;

  document.getElementById(
    "priceTitle"
  ).textContent =
    currentSymbol+" 价格";

  document.getElementById(
    "searchResults"
  ).innerHTML = "";

  document.getElementById(
    "pairSearch"
  ).value = "";

  loadData();
}

function fmt(value,digits=2){

  if(
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ){
    return "—";
  }

  return Number(value).toFixed(digits);
}

function voteText(vote){

  if(vote === "bullish")
    return "BULLISH";

  if(vote === "bearish")
    return "BEARISH";

  return "NEUTRAL";
}

function loadIndicators(data){

  const i =
    data.indicators || {};

  document.getElementById(
    "indicators"
  ).innerHTML =
    "<pre>"+
    escapeHtml(
      JSON.stringify(
        {
          price:i.price,
          ema20:i.ema20,
          ema50:i.ema50,
          ema200:i.ema200,
          rsi14:i.rsi14,
          macd:i.macd,
          macdSignal:i.macdSignal,
          macdHistogram:i.macdHistogram,
          k:i.k,
          d:i.d,
          j:i.j,
          bollMiddle:i.bollMiddle,
          bollUpper:i.bollUpper,
          bollLower:i.bollLower,
          bollWidth:i.bollWidth,
          atr14:i.atr14,
          atrPercent:i.atrPercent,
          volume:i.volume,
          volumeAverage:i.volumeAverage,
          volumeRatio:i.volumeRatio,
          trend:i.trend
        },
        null,
        2
      )
    )+
    "</pre>";
}

function loadReasons(data){

  const reasons =
    Array.isArray(data.reasons)
      ? data.reasons
      : [];

  document.getElementById(
    "reasons"
  ).innerHTML =
    reasons.length
      ? reasons.map(function(x){
          return '<div class="reason">• '+
            escapeHtml(x)+
            '</div>';
        }).join("")
      : "暂无判断依据";
}

async function loadData(){

  document.getElementById(
    "price"
  ).textContent = "加载中…";

  try{

    const voteResponse =
      await fetch(
        "/api/vote?symbol="+
        encodeURIComponent(currentSymbol)+
        "&pair="+
        encodeURIComponent(currentPair)+
        "&interval=60"
      );

    const voteData =
      await voteResponse.json();

    if(voteData.status === "ok"){

      document.getElementById(
        "price"
      ).textContent =
        fmt(voteData.price,2);

      document.getElementById(
        "vote"
      ).textContent =
        voteText(voteData.vote);

      document.getElementById(
        "score"
      ).textContent =
        String(voteData.score)+
        " / 7";

      document.getElementById(
        "risk"
      ).textContent =
        String(voteData.risk || "—")
          .toUpperCase();

      loadIndicators(voteData);
      loadReasons(voteData);

    }else{

      document.getElementById(
        "price"
      ).textContent = "错误";

      document.getElementById(
        "vote"
      ).textContent = "错误";

      document.getElementById(
        "score"
      ).textContent = "—";

      document.getElementById(
        "risk"
      ).textContent = "—";

      document.getElementById(
        "indicators"
      ).textContent =
        voteData.error || "数据错误";

    }

  }catch(e){

    document.getElementById(
      "price"
    ).textContent = "错误";

    document.getElementById(
      "vote"
    ).textContent = "错误";

    document.getElementById(
      "indicators"
    ).textContent =
      e.message;

  }

  try{

    const response =
      await fetch(
        "/api/multi?symbol="+
        encodeURIComponent(currentSymbol)+
        "&pair="+
        encodeURIComponent(currentPair)
      );

    const data =
      await response.json();

    const body =
      document.getElementById("multiBody");

    if(
      data.status !== "ok" ||
      !Array.isArray(data.timeframes)
    ){

      body.innerHTML =
        '<tr><td colspan="6">多周期数据错误</td></tr>';

      return;
    }

    body.innerHTML =
      data.timeframes.map(function(x){

        if(x.status !== "ok"){

          return (
            "<tr>"+
            "<td>"+escapeHtml(x.timeframe)+"</td>"+
            "<td colspan='5'>"+
            escapeHtml(x.error || "错误")+
            "</td>"+
            "</tr>"
          );

        }

        return (
          "<tr>"+
          "<td>"+escapeHtml(x.timeframe)+"</td>"+
          "<td>"+fmt(x.price,2)+"</td>"+
          "<td>"+escapeHtml(x.score)+"</td>"+
          "<td>"+escapeHtml(
            voteText(x.vote)
          )+"</td>"+
          "<td>"+escapeHtml(
            x.indicators &&
            x.indicators.trend
              ? x.indicators.trend
              : "—"
          )+"</td>"+
          "<td>"+fmt(
            x.indicators &&
            x.indicators.rsi14,
            1
          )+"</td>"+
          "</tr>"
        );

      }).join("");

  }catch(e){

    document.getElementById(
      "multiBody"
    ).innerHTML =
      '<tr><td colspan="6">'+
      escapeHtml(e.message)+
      '</td></tr>';

  }
}

document.getElementById(
  "searchBtn"
).addEventListener(
  "click",
  doPairsSearch
);

document.getElementById(
  "pairSearch"
).addEventListener(
  "keydown",
  function(e){
    if(e.key === "Enter"){
      doPairsSearch();
    }
  }
);

document.getElementById(
  "refreshBtn"
).addEventListener(
  "click",
  loadData
);

loadData();

setInterval(
  loadData,
  60000
);
</script>

</body>
</html>`;

function json(data,status=200){

  return new Response(
    JSON.stringify(data,null,2),
    {
      status,
      headers:{
        "Content-Type":
          "application/json;charset=UTF-8",
        ...CORS_HEADERS
      }
    }
  );

}

function error(message,status=400,extra={}){

  return json(
    {
      status:"error",
      error:message,
      ...extra
    },
    status
  );

}

function html(){

  return new Response(
    HTML,
    {
      status:200,
      headers:{
        "Content-Type":
          "text/html;charset=UTF-8",
        ...CORS_HEADERS
      }
    }
  );

}

function average(values){

  if(!values.length)
    return null;

  return values.reduce(
    (a,b)=>a+b,
    0
  )/values.length;

}

function clamp(v,min,max){

  return Math.max(
    min,
    Math.min(max,v)
  );

}

function ema(values,period){

  if(!values.length)
    return null;

  const p =
    Math.min(
      period,
      values.length
    );

  let result =
    average(
      values.slice(0,p)
    );

  const multiplier =
    2/(period+1);

  for(
    let i=p;
    i<values.length;
    i++
  ){

    result =
      (values[i]-result)*
      multiplier+
      result;

  }

  return result;

}

function rsi(values,period=14){

  if(
    values.length<
    period+1
  ){
    return null;
  }

  let gains=0;
  let losses=0;

  for(
    let i=1;
    i<=period;
    i++
  ){

    const diff =
      values[i]-values[i-1];

    if(diff>=0){

      gains+=diff;

    }else{

      losses+=Math.abs(diff);

    }

  }

  let avgGain =
    gains/period;

  let avgLoss =
    losses/period;

  for(
    let i=period+1;
    i<values.length;
    i++
  ){

    const diff =
      values[i]-values[i-1];

    const gain =
      Math.max(diff,0);

    const loss =
      Math.max(-diff,0);

    avgGain =
      (
        avgGain*(period-1)+
        gain
      )/period;

    avgLoss =
      (
        avgLoss*(period-1)+
        loss
      )/period;

  }

  if(avgLoss===0)
    return 100;

  const rs =
    avgGain/avgLoss;

  return 100-
    (100/(1+rs));

}

function macd(
  values,
  fast=12,
  slow=26,
  signalPeriod=9
){

  if(
    values.length<
    slow+signalPeriod
  ){

    return{
      macd:null,
      signal:null,
      histogram:null
    };

  }

  const fastEma=[];
  const slowEma=[];

  let ef =
    average(
      values.slice(0,fast)
    );

  let es =
    average(
      values.slice(0,slow)
    );

  fastEma.push(ef);
  slowEma.push(es);

  const mf =
    2/(fast+1);

  const ms =
    2/(slow+1);

  for(
    let i=fast;
    i<values.length;
    i++
  ){

    ef =
      (values[i]-ef)*
      mf+
      ef;

    fastEma.push(ef);

  }

  for(
    let i=slow;
    i<values.length;
    i++
  ){

    es =
      (values[i]-es)*
      ms+
      es;

    slowEma.push(es);

  }

  const offset =
    slow-fast;

  const series=[];

  for(
    let i=0;
    i<slowEma.length;
    i++
  ){

    const fi =
      i+offset;

    if(
      fi<fastEma.length
    ){

      series.push(
        fastEma[fi]-
        slowEma[i]
      );

    }

  }

  const signal =
    ema(
      series,
      signalPeriod
    );

  const current =
    series[
      series.length-1
    ];

  return{
    macd:current,
    signal,
    histogram:
      current-signal
  };

}

function bollinger(
  values,
  period=20,
  multiplier=2
){

  if(
    values.length<
    period
  ){

    return{
      middle:null,
      upper:null,
      lower:null,
      width:null
    };

  }

  const slice =
    values.slice(-period);

  const middle =
    average(slice);

  const variance =
    average(
      slice.map(
        v=>Math.pow(
          v-middle,
          2
        )
      )
    );

  const std =
    Math.sqrt(variance);

  const upper =
    middle+
    multiplier*std;

  const lower =
    middle-
    multiplier*std;

  const width =
    middle!==0
      ? (
          (upper-lower)/
          middle
        )*100
      : null;

  return{
    middle,
    upper,
    lower,
    width
  };

}

function kdj(
  candles,
  period=9
){

  if(
    candles.length<
    period
  ){

    return{
      k:null,
      d:null,
      j:null
    };

  }

  let k=50;
  let d=50;

  for(
    let i=period-1;
    i<candles.length;
    i++
  ){

    const window =
      candles.slice(
        i-period+1,
        i+1
      );

    const high =
      Math.max(
        ...window.map(
          x=>x.high
        )
      );

    const low =
      Math.min(
        ...window.map(
          x=>x.low
        )
      );

    const close =
      candles[i].close;

    const range =
      high-low;

    const rsv =
      range===0
        ? 50
        : (
            (close-low)/
            range
          )*100;

    k =
      (2*k+rsv)/3;

    d =
      (2*d+k)/3;

  }

  return{
    k,
    d,
    j:
      3*k-2*d
  };

}

function atr(
  candles,
  period=14
){

  if(
    candles.length<
    period+1
  ){
    return null;
  }

  const trs=[];

  for(
    let i=1;
    i<candles.length;
    i++
  ){

    const c =
      candles[i];

    const p =
      candles[i-1];

    trs.push(
      Math.max(
        c.high-c.low,
        Math.abs(
          c.high-p.close
        ),
        Math.abs(
          c.low-p.close
        )
      )
    );

  }

  return average(
    trs.slice(-period)
  );

}

function calculateIndicators(candles){

  const closes =
    candles.map(
      x=>x.close
    );

  const volumes =
    candles.map(
      x=>x.volume
    );

  const price =
    closes[
      closes.length-1
    ];

  const ema20 =
    ema(closes,20);

  const ema50 =
    ema(closes,50);

  const ema200 =
    ema(closes,200);

  const rsi14 =
    rsi(closes,14);

  const macdData =
    macd(
      closes,
      12,
      26,
      9
    );

  const kdjData =
    kdj(
      candles,
      9
    );

  const boll =
    bollinger(
      closes,
      20,
      2
    );

  const atr14 =
    atr(
      candles,
      14
    );

  const volumeAverage =
    volumes.length>=20
      ? average(
          volumes.slice(-20)
        )
      : average(volumes);

  const volume =
    volumes[
      volumes.length-1
    ];

  const volumeRatio =
    volumeAverage
      ? volume/volumeAverage
      : null;

  const atrPercent =
    atr14&&price
      ? (
          atr14/price
        )*100
      : null;

  let trend="mixed";

  if(
    ema20!==null&&
    ema50!==null&&
    ema200!==null
  ){

    if(
      price>ema20&&
      ema20>ema50&&
      ema50>ema200
    ){

      trend=
        "strong_bullish";

    }

    else if(
      price<ema20&&
      ema20<ema50&&
      ema50<ema200
    ){

      trend=
        "strong_bearish";

    }

    else if(
      price>ema50&&
      ema20>ema50
    ){

      trend="bullish";

    }

    else if(
      price<ema50&&
      ema20<ema50
    ){

      trend="bearish";

    }

  }

  return{
    price,
    ema20,
    ema50,
    ema200,
    rsi14,
    macd:
      macdData.macd,
    macdSignal:
      macdData.signal,
    macdHistogram:
      macdData.histogram,
    k:
      kdjData.k,
    d:
      kdjData.d,
    j:
      kdjData.j,
    bollMiddle:
      boll.middle,
    bollUpper:
      boll.upper,
    bollLower:
      boll.lower,
    bollWidth:
      boll.width,
    atr14,
    atrPercent,
    volume,
    volumeAverage,
    volumeRatio,
    trend
  };

}

function quantVote(i){

  let score=0;

  const reasons=[];

  const{
    price,
    ema20,
    ema50,
    ema200,
    rsi14,
    macd:mv,
    macdSignal,
    macdHistogram,
    k,
    d,
    bollUpper,
    bollLower,
    volumeRatio
  }=i;

  if(
    price!==null&&
    ema20!==null&&
    ema50!==null&&
    ema200!==null
  ){

    if(
      price>ema20&&
      ema20>ema50&&
      ema50>ema200
    ){

      score+=3;

      reasons.push(
        "价格位于 EMA20/50/200 上方，均线多头排列"
      );

    }

    else if(
      price<ema20&&
      ema20<ema50&&
      ema50<ema200
    ){

      score-=3;

      reasons.push(
        "价格位于 EMA20/50/200 下方，均线空头排列"
      );

    }

    else if(
      price>ema50&&
      ema20>ema50
    ){

      score+=2;

      reasons.push(
        "价格和短期均线仍高于 EMA50"
      );

    }

    else if(
      price<ema50&&
      ema20<ema50
    ){

      score-=2;

      reasons.push(
        "价格和短期均线仍低于 EMA50"
      );

    }

    else{

      reasons.push(
        "均线结构混合"
      );

    }

  }

  if(rsi14!==null){

    if(rsi14<30){

      score+=1;

      reasons.push(
        "RSI14="+
        rsi14.toFixed(1)+
        "，进入超卖区域"
      );

    }

    else if(rsi14>70){

      score-=1;

      reasons.push(
        "RSI14="+
        rsi14.toFixed(1)+
        "，进入超买区域"
      );

    }

    else if(rsi14>=50){

      score+=1;

      reasons.push(
        "RSI14="+
        rsi14.toFixed(1)+
        "，动能偏强"
      );

    }

    else{

      score-=1;

      reasons.push(
        "RSI14="+
        rsi14.toFixed(1)+
        "，动能偏弱"
      );

    }

  }

  if(
    mv!==null&&
    macdSignal!==null&&
    macdHistogram!==null
  ){

    if(
      mv>macdSignal&&
      macdHistogram>0
    ){

      score+=1;

      reasons.push(
        "MACD 位于信号线上方，动能偏多"
      );

    }

    else if(
      mv<macdSignal&&
      macdHistogram<0
    ){

      score-=1;

      reasons.push(
        "MACD 位于信号线下方，动能偏空"
      );

    }

    else{

      reasons.push(
        "MACD 动能处于混合状态"
      );

    }

  }

  if(
    k!==null&&
    d!==null
  ){

    if(k>d){

      score+=1;

      reasons.push(
        "KDJ K 线高于 D 线，短线动能偏多"
      );

    }

    else if(k<d){

      score-=1;

      reasons.push(
        "KDJ K 线低于 D 线，短线动能偏空"
      );

    }

  }

  if(
    price!==null&&
    bollUpper!==null&&
    bollLower!==null
  ){

    if(price>bollUpper){

      score-=1;

      reasons.push(
        "价格高于布林上轨，短线偏热"
      );

    }

    else if(price<bollLower){

      score+=1;

      reasons.push(
        "价格低于布林下轨，短线出现超跌"
      );

    }

  }

  if(volumeRatio!==null){

    if(volumeRatio>=1.5){

      reasons.push(
        "成交量约为20周期均量的 "+
        volumeRatio.toFixed(2)+
        " 倍，市场活动明显放大"
      );

    }

    else if(volumeRatio<=0.6){

      reasons.push(
        "成交量约为20周期均量的 "+
        volumeRatio.toFixed(2)+
        " 倍，市场活动偏低"
      );

    }

  }

  score =
    clamp(
      score,
      -7,
      7
    );

  let vote="neutral";

  if(score>=2)
    vote="bullish";

  else if(score<=-2)
    vote="bearish";

  return{
    score,
    maxScore:7,
    minScore:-7,
    vote,
    reasons
  };

}

function calculateRisk(i){

  let score=0;

  if(i.atrPercent!==null){

    if(i.atrPercent>=5)
      score+=2;

    else if(i.atrPercent>=3)
      score+=1;

  }

  if(i.bollWidth!==null){

    if(i.bollWidth>=12)
      score+=2;

    else if(i.bollWidth>=7)
      score+=1;

  }

  let level="low";

  if(score>=3)
    level="high";

  else if(score>=1)
    level="medium";

  return{
    level,
    score,
    atrPercent:
      i.atrPercent,
    bollWidth:
      i.bollWidth,
    methodology:
      "ATR波动率 + 布林带宽度的简单风险分级"
  };

}

function parseInterval(v){

  const map={
    "1":1,
    "5":5,
    "15":15,
    "30":30,
    "60":60,
    "1h":60,
    "240":240,
    "4h":240,
    "1440":1440,
    "1d":1440
  };

  return map[
    String(v||"60").toLowerCase()
  ]||60;

}

function normalizeSymbol(symbol){

  const s =
    String(
      symbol||"BTCUSD"
    ).toUpperCase();

  const map={
    BTCUSD:"XBTUSD",
    XBTUSD:"XBTUSD"
  };

  return map[s]||s;

}

async function fetchKraken(
  symbol,
  interval,
  limit=720,
  pairOverride=null
){

  const pair =
    pairOverride||
    normalizeSymbol(symbol);

  const endpoint =
    "https://api.kraken.com/0/public/OHLC"+
    "?pair="+
    encodeURIComponent(pair)+
    "&interval="+
    interval;

  const response =
    await fetch(
      endpoint,
      {
        headers:{
          "User-Agent":
            "QuantVote/2.0"
        }
      }
    );

  if(!response.ok){

    throw new Error(
      "Kraken HTTP "+
      response.status
    );

  }

  const data =
    await response.json();

  if(
    data.error&&
    data.error.length
  ){

    throw new Error(
      data.error.join(", ")
    );

  }

  const result =
    data.result||{};

  const key =
    Object.keys(result)
      .find(
        k=>k!=="last"
      );

  if(
    !key||
    !Array.isArray(
      result[key]
    )
  ){

    throw new Error(
      "Kraken returned no OHLC data"
    );

  }

  const rows =
    result[key].slice(-limit);

  const candles =
    rows.map(
      row=>({

        time:
          Number(row[0]),

        open:
          Number(row[1]),

        high:
          Number(row[2]),

        low:
          Number(row[3]),

        close:
          Number(row[4]),

        vwap:
          Number(row[5]),

        volume:
          Number(row[6]),

        trades:
          Number(row[7])

      })
    );

  return{
    pair,
    candles
  };

}

async function pairsEndpoint(url){

  const q =
    (
      url.searchParams.get("q")||
      ""
    )
    .trim()
    .toUpperCase();

  if(!q){

    return{
      status:"ok",
      source:"kraken",
      query:"",
      count:0,
      results:[]
    };

  }

  const endpoint =
    "https://api.kraken.com/0/public/AssetPairs";

  const response =
    await fetch(
      endpoint,
      {
        headers:{
          "User-Agent":
            "QuantVote/2.0"
        }
      }
    );

  if(!response.ok){

    throw new Error(
      "Kraken AssetPairs HTTP "+
      response.status
    );

  }

  const data =
    await response.json();

  if(
    data.error&&
    data.error.length
  ){

    throw new Error(
      data.error.join(", ")
    );

  }

  const result =
    data.result||{};

  const results=[];

  for(
    const key of Object.keys(result)
  ){

    const item =
      result[key]||{};

    const altname =
      String(
        item.altname||""
      ).toUpperCase();

    const wsname =
      String(
        item.wsname||""
      ).toUpperCase();

    const base =
      String(
        item.base||""
      ).toUpperCase();

    const quote =
      String(
        item.quote||""
      ).toUpperCase();

    const searchable =
      [
        key,
        altname,
        wsname,
        base,
        quote
      ]
      .join(" ")
      .toUpperCase();

    if(
      !searchable.includes(q)
    ){
      continue;
    }

    const display =
      wsname||
      altname||
      key;

    let symbol =
      altname||
      wsname||
      key;

    symbol =
      symbol.replace(
        /^XBT/,
        "BTC"
      );

    if(
      symbol.includes("/")
    ){

      symbol =
        symbol.replace(
          /\//g,
          ""
        );

    }

    results.push({
      symbol,
      pair:
        altname||
        key,
      display
    });

  }

  const unique=[];
  const seen=new Set();

  for(
    const item of results
  ){

    const id =
      item.pair+
      "|"+
      item.symbol;

    if(seen.has(id))
      continue;

    seen.add(id);
    unique.push(item);

  }

  unique.sort(
    (a,b)=>
      String(a.symbol)
        .localeCompare(
          String(b.symbol)
        )
  );

  return{
    status:"ok",
    source:"kraken",
    query:q,
    count:
      unique.length,
    results:
      unique.slice(0,50)
  };

}

async function voteEndpoint(url){

  const symbol =
    url.searchParams.get(
      "symbol"
    )||
    "BTCUSD";

  const pair =
    url.searchParams.get(
      "pair"
    )||
    null;

  const interval =
    parseInterval(
      url.searchParams.get(
        "interval"
      )||
      "60"
    );

  const result =
    await fetchKraken(
      symbol,
      interval,
      720,
      pair
    );

  const candles =
    result.candles;

  if(candles.length<50){

    throw new Error(
      "K线数量不足"
    );

  }

  const indicators =
    calculateIndicators(
      candles
    );

  const vote =
    quantVote(
      indicators
    );

  const risk =
    calculateRisk(
      indicators
    );

  return{
    status:"ok",
    source:"kraken",
    symbol:
      String(symbol)
        .toUpperCase(),
    pair:
      result.pair,
    interval,
    timestamp:
      candles[
        candles.length-1
      ].time,
    price:
      indicators.price,
    indicators,
    score:
      vote.score,
    maxScore:
      vote.maxScore,
    minScore:
      vote.minScore,
    vote:
      vote.vote,
    risk:
      risk.level,
    riskDetail:
      risk,
    reasons:
      vote.reasons,
    methodology:{
      name:
        "QuantVote Technical Core V2",
      scoring:
        "EMA + RSI + MACD + KDJ + Bollinger + Volume",
      note:
        "这是规则化技术分析研究分数，不是价格预测，也不是投资建议。"
    }
  };

}

async function indicatorsEndpoint(url){

  const symbol =
    url.searchParams.get(
      "symbol"
    )||
    "BTCUSD";

  const pair =
    url.searchParams.get(
      "pair"
    )||
    null;

  const interval =
    parseInterval(
      url.searchParams.get(
        "interval"
      )||
      "60"
    );

  const result =
    await fetchKraken(
      symbol,
      interval,
      720,
      pair
    );

  const indicators =
    calculateIndicators(
      result.candles
    );

  return{
    status:"ok",
    source:"kraken",
    symbol:
      String(symbol)
        .toUpperCase(),
    pair:
      result.pair,
    interval,
    timestamp:
      result.candles[
        result.candles.length-1
      ].time,
    indicators
  };

}

async function marketEndpoint(url){

  const symbol =
    url.searchParams.get(
      "symbol"
    )||
    "BTCUSD";

  const pair =
    url.searchParams.get(
      "pair"
    )||
    null;

  const interval =
    parseInterval(
      url.searchParams.get(
        "interval"
      )||
      "60"
    );

  const requested =
    Number(
      url.searchParams.get(
        "limit"
      )||
      "300"
    );

  const limit =
    clamp(
      Number.isFinite(requested)
        ? requested
        : 300,
      20,
      720
    );

  const result =
    await fetchKraken(
      symbol,
      interval,
      limit,
      pair
    );

  return{
    status:"ok",
    source:"kraken",
    symbol:
      String(symbol)
        .toUpperCase(),
    pair:
      result.pair,
    interval,
    count:
      result.candles.length,
    candles:
      result.candles.map(
        c=>[
          c.time,
          c.open,
          c.high,
          c.low,
          c.close,
          c.vwap,
          c.volume,
          c.trades
        ]
      )
  };

}

async function multiEndpoint(url){

  const symbol =
    url.searchParams.get(
      "symbol"
    )||
    "BTCUSD";

  const pair =
    url.searchParams.get(
      "pair"
    )||
    null;

  const periods=[
    ["15m",15],
    ["1H",60],
    ["4H",240],
    ["1D",1440]
  ];

  const results=[];

  for(
    const [name,interval]
    of periods
  ){

    try{

      const result =
        await fetchKraken(
          symbol,
          interval,
          720,
          pair
        );

      const indicators =
        calculateIndicators(
          result.candles
        );

      const vote =
        quantVote(
          indicators
        );

      const risk =
        calculateRisk(
          indicators
        );

      results.push({

        timeframe:name,

        interval,

        status:"ok",

        source:"kraken",

        pair:
          result.pair,

        timestamp:
          result.candles[
            result.candles.length-1
          ].time,

        price:
          indicators.price,

        indicators,

        score:
          vote.score,

        maxScore:
          vote.maxScore,

        minScore:
          vote.minScore,

        vote:
          vote.vote,

        risk:
          risk.level,

        riskDetail:
          risk,

        reasons:
          vote.reasons

      });

    }catch(e){

      results.push({

        timeframe:name,

        interval,

        status:"error",

        error:e.message

      });

    }

  }

  const valid =
    results.filter(
      x=>x.status==="ok"
    );

  const averageScore =
    valid.length
      ? valid.reduce(
          (a,x)=>
            a+x.score,
          0
        )/valid.length
      : 0;

  let overallVote =
    "neutral";

  if(
    averageScore>=1.5
  ){

    overallVote =
      "bullish";

  }

  else if(
    averageScore<=-1.5
  ){

    overallVote =
      "bearish";

  }

  return{
    status:"ok",
    source:"kraken",
    symbol:
      String(symbol)
        .toUpperCase(),
    pair,
    timeframes:
      results,
    summary:{
      validTimeframes:
        valid.length,
      totalTimeframes:
        results.length,
      averageScore,
      overallVote
    },
    methodology:{
      name:
        "QuantVote Multi-Timeframe Core V2",
      note:
        "不同周期独立计算后进行简单汇总，不代表未来价格预测。"
    }
  };

}

async function regimeEndpoint(url){

  const symbol =
    url.searchParams.get(
      "symbol"
    )||
    "BTCUSD";

  const pair =
    url.searchParams.get(
      "pair"
    )||
    null;

  const interval =
    parseInterval(
      url.searchParams.get(
        "interval"
      )||
      "60"
    );

  const result =
    await fetchKraken(
      symbol,
      interval,
      720,
      pair
    );

  const indicators =
    calculateIndicators(
      result.candles
    );

  let regime="mixed";

  if(
    indicators.trend===
    "strong_bullish"
  ){

    regime=
      "bull_trend";

  }

  else if(
    indicators.trend===
    "bullish"
  ){

    regime=
      "bullish";

  }

  else if(
    indicators.trend===
    "strong_bearish"
  ){

    regime=
      "bear_trend";

  }

  else if(
    indicators.trend===
    "bearish"
  ){

    regime=
      "bearish";

  }

  return{
    status:"ok",
    source:"kraken",
    symbol:
      String(symbol)
        .toUpperCase(),
    pair:
      result.pair,
    interval,
    regime,
    trend:
      indicators.trend,
    volatility:{
      atrPercent:
        indicators.atrPercent,
      bollWidth:
        indicators.bollWidth
    }
  };

}

async function backtestEndpoint(url){

  const symbol =
    url.searchParams.get(
      "symbol"
    )||
    "BTCUSD";

  const pair =
    url.searchParams.get(
      "pair"
    )||
    null;

  const interval =
    parseInterval(
      url.searchParams.get(
        "interval"
      )||
      "60"
    );

  const result =
    await fetchKraken(
      symbol,
      interval,
      720,
      pair
    );

  const candles =
    result.candles;

  if(candles.length<100){

    throw new Error(
      "历史K线不足，无法进行基础回测"
    );

  }

  let position=0;
  let entry=0;
  let entryTime=0;
  let equity=1;

  const completedTrades=[];
  const equityCurve=[];

  for(
    let i=60;
    i<candles.length;
    i++
  ){

    const slice =
      candles.slice(
        0,
        i+1
      );

    const indicators =
      calculateIndicators(
        slice
      );

    const vote =
      quantVote(
        indicators
      );

    const price =
      candles[i].close;

    const time =
      candles[i].time;

    if(position===0){

      if(vote.score>=3){

        position=1;
        entry=price;
        entryTime=time;

      }

    }

    else{

      if(vote.score<=0){

        const returnPct =
          (
            (price-entry)/
            entry
          )*100;

        const equityBefore =
          equity;

        equity*=
          1+
          (returnPct/100);

        completedTrades.push({

          trade:
            completedTrades.length+1,

          entryTime,

          exitTime:
            time,

          entryPrice:
            entry,

          exitPrice:
            price,

          returnPercent:
            returnPct,

          equityBefore,

          equityAfter:
            equity,

          result:
            returnPct>0
              ?"win"
              :"loss"

        });

        position=0;
        entry=0;
        entryTime=0;

      }

    }

    equityCurve.push({

      time,
      equity

    });

  }

  if(position===1){

    const price =
      candles[
        candles.length-1
      ].close;

    const time =
      candles[
        candles.length-1
      ].time;

    const returnPct =
      (
        (price-entry)/
        entry
      )*100;

    const equityBefore =
      equity;

    equity*=
      1+
      (returnPct/100);

    completedTrades.push({

      trade:
        completedTrades.length+1,

      entryTime,

      exitTime:
        time,

      entryPrice:
        entry,

      exitPrice:
        price,

      returnPercent:
        returnPct,

      equityBefore,

      equityAfter:
        equity,

      result:
        returnPct>0
          ?"win"
          :"loss",

      forcedExit:true

    });

    position=0;

  }

  const wins =
    completedTrades.filter(
      x=>x.returnPercent>0
    );

  const losses =
    completedTrades.filter(
      x=>x.returnPercent<=0
    );

  const winReturns =
    wins.map(
      x=>x.returnPercent
    );

  const lossReturns =
    losses.map(
      x=>Math.abs(
        x.returnPercent
      )
    );

  const averageWinPercent =
    winReturns.length
      ? average(winReturns)
      : 0;

  const averageLossPercent =
    lossReturns.length
      ? average(lossReturns)
      : 0;

  const winLossRatio =
    averageLossPercent>0
      ? averageWinPercent/
        averageLossPercent
      : null;

  const grossProfit =
    winReturns.reduce(
      (a,b)=>a+b,
      0
    );

  const grossLoss =
    lossReturns.reduce(
      (a,b)=>a+b,
      0
    );

  const profitFactor =
    grossLoss>0
      ? grossProfit/
        grossLoss
      : null;

  let currentWinningStreak=0;
  let currentLosingStreak=0;
  let maxWinningStreak=0;
  let maxLosingStreak=0;

  for(
    const trade of completedTrades
  ){

    if(
      trade.returnPercent>0
    ){

      currentWinningStreak++;

      currentLosingStreak=0;

      maxWinningStreak=
        Math.max(
          maxWinningStreak,
          currentWinningStreak
        );

    }

    else{

      currentLosingStreak++;

      currentWinningStreak=0;

      maxLosingStreak=
        Math.max(
          maxLosingStreak,
          currentLosingStreak
        );

    }

  }

  let peakEquity=1;
  let maxDrawdownPercent=0;

  for(
    const point of equityCurve
  ){

    if(
      point.equity>
      peakEquity
    ){

      peakEquity=
        point.equity;

    }

    if(
      peakEquity>0
    ){

      const drawdown =
        (
          (
            point.equity/
            peakEquity
          )-1
        )*100;

      if(
        drawdown<
        maxDrawdownPercent
      ){

        maxDrawdownPercent=
          drawdown;

      }

    }

  }

  const maxDrawdown =
    Math.abs(
      maxDrawdownPercent
    );

  const totalReturnPercent =
    (equity-1)*100;

  const trades =
    completedTrades.length;

  const winsCount =
    wins.length;

  const winRatePercent =
    trades>0
      ? (
          winsCount/
          trades
        )*100
      : 0;

  return{

    status:"ok",

    source:"kraken",

    symbol:
      String(symbol)
        .toUpperCase(),

    pair:
      result.pair,

    interval,

    candles:
      candles.length,

    result:{

      initialEquity:1,

      finalEquity:
        equity,

      totalReturnPercent,

      trades,

      wins:
        winsCount,

      losses:
        losses.length,

      winRatePercent,

      averageWinPercent,

      averageLossPercent,

      winLossRatio,

      grossProfitPercent:
        grossProfit,

      grossLossPercent:
        grossLoss,

      profitFactor,

      maxDrawdownPercent:
        maxDrawdown,

      maxWinningStreak,

      maxLosingStreak

    },

    tradeDetails:
      completedTrades,

    equityCurve,

    methodology:{

      name:
        "QuantVote Basic Backtest V2",

      entry:
        "score >= 3",

      exit:
        "score <= 0",

      position:
        "long only",

      sizing:
        "100% equity per position",

      fees:
        "not included",

      slippage:
        "not included",

      maxDrawdown:
        "基于历史权益曲线计算",

      profitFactor:
        "总盈利百分比 / 总亏损百分比",

      note:
        "这是基础历史模拟，不代表未来表现。"

    }

  };

}

export default{

  async fetch(request){

    if(
      request.method==="OPTIONS"
    ){

      return new Response(
        null,
        {
          status:204,
          headers:CORS_HEADERS
        }
      );

    }

    const url =
      new URL(
        request.url
      );

    const path =
      url.pathname;

    try{

      if(
        path==="/"||
        path===""
      ){

        return html();

      }

      if(
        path==="/api/health"
      ){

        return json({

          status:"ok",

          service:"QuantVote",

          version:
            "v2-worker-ui",

          data_source:
            "kraken-public-api",

          engine:
            "worker-native-technical-core"

        });

      }

      if(
        path==="/api/pairs"
      ){

        return json(
          await pairsEndpoint(url)
        );

      }

      if(
        path==="/api/market"
      ){

        return json(
          await marketEndpoint(url)
        );

      }

      if(
        path==="/api/indicators"
      ){

        return json(
          await indicatorsEndpoint(url)
        );

      }

      if(
        path==="/api/vote"
      ){

        return json(
          await voteEndpoint(url)
        );

      }

      if(
        path==="/api/multi"
      ){

        return json(
          await multiEndpoint(url)
        );

      }

      if(
        path==="/api/regime"
      ){

        return json(
          await regimeEndpoint(url)
        );

      }

      if(
        path==="/api/backtest"
      ){

        return json(
          await backtestEndpoint(url)
        );

      }

      return error(
        "Not Found",
        404,
        {
          path,

          available:[
            "/",
            "/api/health",
            "/api/pairs",
            "/api/market",
            "/api/indicators",
            "/api/vote",
            "/api/multi",
            "/api/regime",
            "/api/backtest"
          ]
        }
      );

    }catch(e){

      return error(
        e?.message||
        "Internal Error",
        500
      );

    }

  }

};
