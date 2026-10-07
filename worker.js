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
  background:#0f1117;
  color:#e8ecf1;
  font-family:Arial,system-ui,sans-serif
}
main{
  max-width:1000px;
  margin:auto;
  padding:20px
}
h1{margin:0 0 5px}
h2{margin-top:0}
.sub,.muted{color:#9aa4b2}
button{
  border:0;
  border-radius:9px;
  padding:10px 16px;
  background:#2d6cdf;
  color:white;
  font-weight:bold
}
.grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(190px,1fr));
  gap:12px;
  margin:15px 0
}
.card{
  background:#181c24;
  border:1px solid #2a303b;
  border-radius:14px;
  padding:16px;
  margin-bottom:12px
}
.label{
  color:#9aa4b2;
  font-size:13px
}
.big{
  font-size:28px;
  font-weight:bold;
  margin-top:6px
}
table{
  width:100%;
  border-collapse:collapse
}
th,td{
  padding:9px;
  border-bottom:1px solid #2a303b;
  text-align:left
}
.ind{
  display:inline-block;
  min-width:170px;
  padding:7px 0
}
li{margin:7px 0}
</style>
</head>

<body>
<main>

<h1>QuantVote V2</h1>

<div class="sub">
Technical Research Dashboard · Kraken Public Data
</div>

<div style="margin:15px 0">
<button onclick="loadData()">刷新数据</button>
<span id="status" class="muted"></span>
</div>

<div class="grid">

<div class="card">
<div class="label">BTC 价格</div>
<div id="price" class="big">—</div>
</div>

<div class="card">
<div class="label">1H QuantVote</div>
<div id="vote" class="big">—</div>
</div>

<div class="card">
<div class="label">1H Score</div>
<div id="score" class="big">—</div>
</div>

<div class="card">
<div class="label">风险</div>
<div id="risk" class="big">—</div>
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

<tbody id="multi">
<tr>
<td colspan="6">加载中…</td>
</tr>
</tbody>

</table>

</div>

<div class="card">

<h2>1H 指标</h2>

<div id="indicators">
加载中…
</div>

</div>

<div class="card">

<h2>1H 判断依据</h2>

<ul id="reasons">
<li>加载中…</li>
</ul>

</div>

<div class="card">

<h2>方法说明</h2>

<p class="muted">
QuantVote Technical Core V2：
EMA + RSI + MACD + KDJ + Bollinger + Volume。
这是规则化技术分析研究分数，不是价格预测，也不是投资建议。
</p>

</div>

</main>

<script>

async function api(path){

  const r=await fetch(path);

  if(!r.ok){
    throw new Error("HTTP "+r.status);
  }

  return r.json();

}

function fmt(v,n=2){

  if(
    v===null ||
    v===undefined ||
    !Number.isFinite(Number(v))
  ){
    return "—";
  }

  return Number(v).toFixed(n);

}

async function loadData(){

  const status=document.getElementById("status");

  status.textContent="正在加载…";

  try{

    const results=await Promise.all([
      api("/api/vote?symbol=BTCUSD&interval=60"),
      api("/api/multi?symbol=BTCUSD")
    ]);

    const vote=results[0];
    const multi=results[1];
    const i=vote.indicators||{};

    document.getElementById("price").textContent=
      fmt(vote.price);

    document.getElementById("vote").textContent=
      String(vote.vote||"—").toUpperCase();

    document.getElementById("score").textContent=
      (vote.score??"—")+" / "+(vote.maxScore??7);

    document.getElementById("risk").textContent=
      String(vote.risk||"—").toUpperCase();

    const indicatorList=[
      ["EMA20",i.ema20],
      ["EMA50",i.ema50],
      ["EMA200",i.ema200],
      ["RSI14",i.rsi14],
      ["MACD",i.macd],
      ["MACD Signal",i.macdSignal],
      ["K",i.k],
      ["D",i.d],
      ["J",i.j],
      ["Boll Middle",i.bollMiddle],
      ["Boll Upper",i.bollUpper],
      ["Boll Lower",i.bollLower],
      ["ATR14",i.atr14],
      ["ATR %",i.atrPercent],
      ["Volume Ratio",i.volumeRatio]
    ];

    document.getElementById("indicators").innerHTML=
      indicatorList.map(x=>
        '<span class="ind">'+
        '<span class="muted">'+x[0]+'：</span>'+
        '<b>'+fmt(x[1])+'</b>'+
        '</span>'
      ).join("");

    document.getElementById("reasons").innerHTML=
      (vote.reasons||[])
      .map(x=>"<li>"+x+"</li>")
      .join("") ||
      "<li>暂无数据</li>";

    document.getElementById("multi").innerHTML=
      (multi.timeframes||[])
      .map(x=>{
        const i=x.indicators||{};

        return "<tr>"+
          "<td>"+x.timeframe+"</td>"+
          "<td>"+fmt(x.price)+"</td>"+
          "<td>"+(x.score??"—")+"</td>"+
          "<td>"+(x.vote??"—")+"</td>"+
          "<td>"+(i.trend??"—")+"</td>"+
          "<td>"+fmt(i.rsi14)+"</td>"+
          "</tr>";
      })
      .join("");

    status.textContent=
      "更新："+new Date().toLocaleString();

  }catch(e){

    status.textContent=
      "加载失败："+e.message;

  }

}

loadData();

setInterval(loadData,60000);

</script>

</body>
</html>`;

function json(data,status=200){

  return new Response(
    JSON.stringify(data,null,2),
    {
      status,
      headers:{
        "Content-Type":"application/json;charset=UTF-8",
        ...CORS_HEADERS
      }
    }
  );

}

function error(message,status=400,extra={}){

  return json({
    status:"error",
    error:message,
    ...extra
  },status);

}

function html(){

  return new Response(HTML,{
    status:200,
    headers:{
      "Content-Type":"text/html;charset=UTF-8",
      ...CORS_HEADERS
    }
  });

}

function average(values){

  if(!values.length)return null;

  return values.reduce((a,b)=>a+b,0)/values.length;

}

function clamp(v,min,max){

  return Math.max(min,Math.min(max,v));

}

function ema(values,period){

  if(!values.length)return null;

  const p=Math.min(period,values.length);

  let result=average(values.slice(0,p));

  const multiplier=2/(period+1);

  for(let i=p;i<values.length;i++){

    result=
      (values[i]-result)*multiplier+
      result;

  }

  return result;

}

function rsi(values,period=14){

  if(values.length<period+1)return null;

  let gains=0;
  let losses=0;

  for(let i=1;i<=period;i++){

    const diff=
      values[i]-values[i-1];

    if(diff>=0){
      gains+=diff;
    }else{
      losses+=Math.abs(diff);
    }

  }

  let avgGain=gains/period;
  let avgLoss=losses/period;

  for(
    let i=period+1;
    i<values.length;
    i++
  ){

    const diff=
      values[i]-values[i-1];

    const gain=Math.max(diff,0);
    const loss=Math.max(-diff,0);

    avgGain=
      ((avgGain*(period-1))+gain)/
      period;

    avgLoss=
      ((avgLoss*(period-1))+loss)/
      period;

  }

  if(avgLoss===0)return 100;

  const rs=avgGain/avgLoss;

  return 100-(100/(1+rs));

}

function macd(
  values,
  fast=12,
  slow=26,
  signalPeriod=9
){

  if(values.length<slow+signalPeriod){

    return{
      macd:null,
      signal:null,
      histogram:null
    };

  }

  const fastEma=[];
  const slowEma=[];

  let ef=average(
    values.slice(0,fast)
  );

  let es=average(
    values.slice(0,slow)
  );

  fastEma.push(ef);
  slowEma.push(es);

  const mf=2/(fast+1);
  const ms=2/(slow+1);

  for(let i=fast;i<values.length;i++){

    ef=
      (values[i]-ef)*mf+ef;

    fastEma.push(ef);

  }

  for(let i=slow;i<values.length;i++){

    es=
      (values[i]-es)*ms+es;

    slowEma.push(es);

  }

  const offset=slow-fast;
  const series=[];

  for(let i=0;i<slowEma.length;i++){

    const fi=i+offset;

    if(fi<fastEma.length){

      series.push(
        fastEma[fi]-slowEma[i]
      );

    }

  }

  const signal=ema(
    series,
    signalPeriod
  );

  const current=
    series[series.length-1];

  return{
    macd:current,
    signal,
    histogram:current-signal
  };

}

function bollinger(
  values,
  period=20,
  multiplier=2
){

  if(values.length<period){

    return{
      middle:null,
      upper:null,
      lower:null,
      width:null
    };

  }

  const slice=
    values.slice(-period);

  const middle=
    average(slice);

  const variance=
    average(
      slice.map(
        v=>Math.pow(v-middle,2)
      )
    );

  const std=Math.sqrt(variance);

  const upper=
    middle+multiplier*std;

  const lower=
    middle-multiplier*std;

  const width=
    middle!==0
    ? ((upper-lower)/middle)*100
    : null;

  return{
    middle,
    upper,
    lower,
    width
  };

}

function kdj(candles,period=9){

  if(candles.length<period){

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

    const window=
      candles.slice(
        i-period+1,
        i+1
      );

    const high=Math.max(
      ...window.map(x=>x.high)
    );

    const low=Math.min(
      ...window.map(x=>x.low)
    );

    const close=candles[i].close;

    const range=high-low;

    const rsv=
      range===0
      ? 50
      : ((close-low)/range)*100;

    k=(2*k+rsv)/3;
    d=(2*d+k)/3;

  }

  return{
    k,
    d,
    j:3*k-2*d
  };

}

function atr(candles,period=14){

  if(candles.length<period+1)
    return null;

  const trs=[];

  for(let i=1;i<candles.length;i++){

    const c=candles[i];
    const p=candles[i-1];

    trs.push(
      Math.max(
        c.high-c.low,
        Math.abs(c.high-p.close),
        Math.abs(c.low-p.close)
      )
    );

  }

  return average(
    trs.slice(-period)
  );

}

function calculateIndicators(candles){

  const closes=
    candles.map(x=>x.close);

  const volumes=
    candles.map(x=>x.volume);

  const price=
    closes[closes.length-1];

  const ema20=
    ema(closes,20);

  const ema50=
    ema(closes,50);

  const ema200=
    ema(closes,200);

  const rsi14=
    rsi(closes,14);

  const macdData=
    macd(closes,12,26,9);

  const kdjData=
    kdj(candles,9);

  const boll=
    bollinger(closes,20,2);

  const atr14=
    atr(candles,14);

  const volumeAverage=
    volumes.length>=20
    ? average(volumes.slice(-20))
    : average(volumes);

  const volume=
    volumes[volumes.length-1];

  const volumeRatio=
    volumeAverage
    ? volume/volumeAverage
    : null;

  const atrPercent=
    atr14&&price
    ? (atr14/price)*100
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
      trend="strong_bullish";
    }
    else if(
      price<ema20&&
      ema20<ema50&&
      ema50<ema200
    ){
      trend="strong_bearish";
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
    macd:macdData.macd,
    macdSignal:macdData.signal,
    macdHistogram:macdData.histogram,
    k:kdjData.k,
    d:kdjData.d,
    j:kdjData.j,
    bollMiddle:boll.middle,
    bollUpper:boll.upper,
    bollLower:boll.lower,
    bollWidth:boll.width,
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
        "RSI14="+rsi14.toFixed(1)+
        "，进入超卖区域"
      );

    }
    else if(rsi14>70){

      score-=1;

      reasons.push(
        "RSI14="+rsi14.toFixed(1)+
        "，进入超买区域"
      );

    }
    else if(rsi14>=50){

      score+=1;

      reasons.push(
        "RSI14="+rsi14.toFixed(1)+
        "，动能偏强"
      );

    }
    else{

      score-=1;

      reasons.push(
        "RSI14="+rsi14.toFixed(1)+
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

  if(k!==null&&d!==null){

    if(k>d){

      score+=1;

      reasons.push(
        "KDJ K 线上穿 D 线，短线动能偏多"
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

  score=clamp(score,-7,7);

  let vote="neutral";

  if(score>=2)vote="bullish";
  else if(score<=-2)vote="bearish";

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
    atrPercent:i.atrPercent,
    bollWidth:i.bollWidth,
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

  const s=
    String(symbol||"BTCUSD")
    .toUpperCase();

  const map={
    BTCUSD:"XBTUSD",
    BTCUSDT:"XBTUSD",
    XBTUSD:"XBTUSD",
    ETHUSD:"ETHUSD",
    ETHUSDT:"ETHUSD",
    SOLUSD:"SOLUSD",
    SOLUSDT:"SOLUSD"
  };

  return map[s]||s;

}

async function fetchKraken(
  symbol,
  interval,
  limit=720
){

  const pair=
    normalizeSymbol(symbol);

  const endpoint=
    "https://api.kraken.com/0/public/OHLC"+
    "?pair="+
    encodeURIComponent(pair)+
    "&interval="+
    interval;

  const response=
    await fetch(endpoint,{
      headers:{
        "User-Agent":"QuantVote/2.0"
      }
    });

  if(!response.ok){

    throw new Error(
      "Kraken HTTP "+
      response.status
    );

  }

  const data=
    await response.json();

  if(
    data.error&&
    data.error.length
  ){

    throw new Error(
      data.error.join(", ")
    );

  }

  const result=data.result||{};

  const key=
    Object.keys(result)
    .find(k=>k!=="last");

  if(
    !key||
    !Array.isArray(result[key])
  ){

    throw new Error(
      "Kraken returned no OHLC data"
    );

  }

  const rows=
    result[key].slice(-limit);

  const candles=
    rows.map(row=>({
      time:Number(row[0]),
      open:Number(row[1]),
      high:Number(row[2]),
      low:Number(row[3]),
      close:Number(row[4]),
      vwap:Number(row[5]),
      volume:Number(row[6]),
      trades:Number(row[7])
    }));

  return{
    pair,
    candles
  };

}

async function voteEndpoint(url){

  const symbol=
    url.searchParams.get("symbol")||
    "BTCUSD";

  const interval=
    parseInterval(
      url.searchParams.get("interval")||
      "60"
    );

  const result=
    await fetchKraken(
      symbol,
      interval,
      720
    );

  const candles=result.candles;

  if(candles.length<50){

    throw new Error(
      "K线数量不足"
    );

  }

  const indicators=
    calculateIndicators(candles);

  const vote=
    quantVote(indicators);

  const risk=
    calculateRisk(indicators);

  return{
    status:"ok",
    source:"kraken",
    symbol:String(symbol).toUpperCase(),
    pair:result.pair,
    interval,
    timestamp:
      candles[candles.length-1].time,
    price:indicators.price,
    indicators,
    score:vote.score,
    maxScore:vote.maxScore,
    minScore:vote.minScore,
    vote:vote.vote,
    risk:risk.level,
    riskDetail:risk,
    reasons:vote.reasons,
    methodology:{
      name:"QuantVote Technical Core V2",
      scoring:
        "EMA + RSI + MACD + KDJ + Bollinger + Volume",
      note:
        "这是规则化技术分析研究分数，不是价格预测，也不是投资建议。"
    }
  };

}

async function indicatorsEndpoint(url){

  const symbol=
    url.searchParams.get("symbol")||
    "BTCUSD";

  const interval=
    parseInterval(
      url.searchParams.get("interval")||
      "60"
    );

  const result=
    await fetchKraken(
      symbol,
      interval,
      720
    );

  const indicators=
    calculateIndicators(
      result.candles
    );

  return{
    status:"ok",
    source:"kraken",
    symbol:String(symbol).toUpperCase(),
    pair:result.pair,
    interval,
    timestamp:
      result.candles[
        result.candles.length-1
      ].time,
    indicators
  };

}

async function marketEndpoint(url){

  const symbol=
    url.searchParams.get("symbol")||
    "BTCUSD";

  const interval=
    parseInterval(
      url.searchParams.get("interval")||
      "60"
    );

  const requested=
    Number(
      url.searchParams.get("limit")||
      "300"
    );

  const limit=
    clamp(
      Number.isFinite(requested)
      ? requested
      : 300,
      20,
      720
    );

  const result=
    await fetchKraken(
      symbol,
      interval,
      limit
    );

  return{
    status:"ok",
    source:"kraken",
    symbol:String(symbol).toUpperCase(),
    pair:result.pair,
    interval,
    count:result.candles.length,
    candles:result.candles.map(c=>[
      c.time,
      c.open,
      c.high,
      c.low,
      c.close,
      c.vwap,
      c.volume,
      c.trades
    ])
  };

}

async function multiEndpoint(url){

  const symbol=
    url.searchParams.get("symbol")||
    "BTCUSD";

  const periods=[
    ["15m",15],
    ["1H",60],
    ["4H",240],
    ["1D",1440]
  ];

  const results=[];

  for(const [name,interval] of periods){

    try{

      const result=
        await fetchKraken(
          symbol,
          interval,
          720
        );

      const indicators=
        calculateIndicators(
          result.candles
        );

      const vote=
        quantVote(indicators);

      const risk=
        calculateRisk(indicators);

      results.push({
        timeframe:name,
        interval,
        status:"ok",
        source:"kraken",
        pair:result.pair,
        timestamp:
          result.candles[
            result.candles.length-1
          ].time,
        price:indicators.price,
        indicators,
        score:vote.score,
        maxScore:vote.maxScore,
        minScore:vote.minScore,
        vote:vote.vote,
        risk:risk.level,
        riskDetail:risk,
        reasons:vote.reasons
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

  const valid=
    results.filter(
      x=>x.status==="ok"
    );

  const averageScore=
    valid.length
    ? valid.reduce(
        (a,x)=>a+x.score,
        0
      )/valid.length
    :0;

  let overallVote="neutral";

  if(averageScore>=1.5)
    overallVote="bullish";

  else if(averageScore<=-1.5)
    overallVote="bearish";

  return{
    status:"ok",
    source:"kraken",
    symbol:String(symbol).toUpperCase(),
    timeframes:results,
    summary:{
      validTimeframes:valid.length,
      totalTimeframes:results.length,
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

  const symbol=
    url.searchParams.get("symbol")||
    "BTCUSD";

  const interval=
    parseInterval(
      url.searchParams.get("interval")||
      "60"
    );

  const result=
    await fetchKraken(
      symbol,
      interval,
      720
    );

  const indicators=
    calculateIndicators(
      result.candles
    );

  let regime="mixed";

  if(indicators.trend==="strong_bullish")
    regime="bull_trend";

  else if(indicators.trend==="bullish")
    regime="bullish";

  else if(indicators.trend==="strong_bearish")
    regime="bear_trend";

  else if(indicators.trend==="bearish")
    regime="bearish";

  return{
    status:"ok",
    source:"kraken",
    symbol:String(symbol).toUpperCase(),
    interval,
    regime,
    trend:indicators.trend,
    volatility:{
      atrPercent:indicators.atrPercent,
      bollWidth:indicators.bollWidth
    }
  };

}

async function backtestEndpoint(url){

  const symbol=
    url.searchParams.get("symbol")||
    "BTCUSD";

  const interval=
    parseInterval(
      url.searchParams.get("interval")||
      "60"
    );

  const result=
    await fetchKraken(
      symbol,
      interval,
      720
    );

  const candles=result.candles;

  if(candles.length<100){

    throw new Error(
      "历史K线不足，无法进行基础回测"
    );

  }

  let position=0;
  let entry=0;
  let equity=1;
  let trades=0;
  let wins=0;

  const equityCurve=[];

  for(let i=60;i<candles.length;i++){

    const slice=
      candles.slice(0,i+1);

    const indicators=
      calculateIndicators(slice);

    const vote=
      quantVote(indicators);

    const price=
      candles[i].close;

    if(position===0){

      if(vote.score>=3){

        position=1;
        entry=price;
        trades++;

      }

    }else{

      if(vote.score<=0){

        const returnPct=
          (price-entry)/entry;

        equity*=
          1+returnPct;

        if(returnPct>0)
          wins++;

        position=0;
        entry=0;

      }

    }

    equityCurve.push({
      time:candles[i].time,
      equity
    });

  }

  if(position===1){

    const price=
      candles[candles.length-1].close;

    const returnPct=
      (price-entry)/entry;

    equity*=1+returnPct;

    if(returnPct>0)
      wins++;

  }

  return{
    status:"ok",
    source:"kraken",
    symbol:String(symbol).toUpperCase(),
    interval,
    candles:candles.length,
    result:{
      initialEquity:1,
      finalEquity:equity,
      totalReturnPercent:
        (equity-1)*100,
      trades,
      wins,
      winRatePercent:
        trades>0
        ? (wins/trades)*100
        : 0
    },
    methodology:{
      name:"QuantVote Basic Backtest",
      entry:"score >= 3",
      exit:"score <= 0",
      position:"long only",
      fees:"not included",
      slippage:"not included",
      note:
        "这是基础历史模拟，不代表未来表现。"
    },
    equityCurve
  };

}

export default{

  async fetch(request){

    if(request.method==="OPTIONS"){
      return new Response(null,{
        status:204,
        headers:CORS_HEADERS
      });
    }

    const url=
      new URL(request.url);

    const path=
      url.pathname;

    try{

      // 首页：直接显示 QuantVote 网页
      if(path==="/"||path===""){
        return html();
      }

      if(path==="/api/health"){

        return json({
          status:"ok",
          service:"QuantVote",
          version:"v2-worker-ui",
          data_source:
            "kraken-public-api",
          engine:
            "worker-native-technical-core"
        });

      }

      if(path==="/api/market"){
        return json(
          await marketEndpoint(url)
        );
      }

      if(path==="/api/indicators"){
        return json(
          await indicatorsEndpoint(url)
        );
      }

      if(path==="/api/vote"){
        return json(
          await voteEndpoint(url)
        );
      }

      if(path==="/api/multi"){
        return json(
          await multiEndpoint(url)
        );
      }

      if(path==="/api/regime"){
        return json(
          await regimeEndpoint(url)
        );
      }

      if(path==="/api/backtest"){
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
        e?.message||"Internal Error",
        500
      );

    }

  }

};
