const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
};

/* =========================================================
   Kraken 请求稳定层
   ========================================================= */

const OHLC_CACHE = new Map();
const OHLC_INFLIGHT = new Map();

let PAIRS_CACHE = null;
let PAIRS_CACHE_TIME = 0;
let PAIRS_INFLIGHT = null;

let krakenQueue = Promise.resolve();
let lastKrakenRequestAt = 0;

const OHLC_CACHE_TTL = 20000;
const PAIRS_CACHE_TTL = 60000;
const KRAKEN_REQUEST_GAP = 350;

function sleep(ms){
  return new Promise(resolve => setTimeout(resolve,ms));
}

async function queueKrakenRequest(task){
  const previous = krakenQueue;

  let release;

  krakenQueue = new Promise(resolve => {
    release = resolve;
  });

  await previous;

  try{
    const now = Date.now();

    const wait =
      Math.max(
        0,
        KRAKEN_REQUEST_GAP -
        (now-lastKrakenRequestAt)
      );

    if(wait>0){
      await sleep(wait);
    }

    return await task();

  }finally{
    lastKrakenRequestAt = Date.now();
    release();
  }
}

/* =========================================================
   HTML
   ========================================================= */

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

.container{
  max-width:980px;
  margin:auto
}

h1{
  margin:0 0 5px;
  font-size:25px
}

.subtitle{
  color:#687384;
  margin-bottom:18px
}

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

button:active{
  opacity:.8
}

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

.search-result:last-child{
  border-bottom:0
}

.search-result:hover{
  background:#f4f6f9
}

.result-symbol{
  font-weight:700
}

.result-display{
  font-size:13px;
  color:#687384;
  margin-top:3px
}

.current{
  font-size:14px;
  color:#586273;
  margin:10px 0
}

.refresh{
  margin-top:8px
}

.price-title{
  color:#687384;
  font-size:14px
}

.price{
  font-size:30px;
  font-weight:700;
  margin:3px 0 15px
}

.vote{
  display:inline-block;
  padding:6px 10px;
  border-radius:8px;
  font-weight:700;
  margin:5px 0
}

.bullish{
  background:#e7f7ed;
  color:#187a42
}

.bearish{
  background:#fdeaea;
  color:#a52222
}

.neutral{
  background:#eef1f5;
  color:#596273
}

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

.indicator-table{
  margin-top:12px
}

.indicator-table th{
  background:#f7f8fa;
  font-weight:700
}

.indicator-name{
  font-weight:600;
  color:#273241
}

.indicator-value{
  font-weight:700;
  white-space:nowrap
}

.indicator-meaning{
  color:#596273;
  line-height:1.5
}

.indicator-impact{
  font-weight:600
}

details{
  margin-top:14px;
  border-top:1px solid #edf0f4;
  padding-top:12px
}

summary{
  cursor:pointer;
  color:#596273;
  font-size:14px;
  font-weight:600
}

pre{
  white-space:pre-wrap;
  word-break:break-word;
  background:#f7f8fa;
  padding:12px;
  border-radius:9px;
  overflow:auto;
  font-size:12px;
  margin-top:10px
}

.reason{
  margin:5px 0
}

.small{
  font-size:13px;
  color:#697586;
  line-height:1.6
}

.error{
  color:#b42318
}

.section-note{
  margin-top:8px;
  color:#697586;
  font-size:12px;
  line-height:1.5
}

@media(max-width:700px){

  body{
    padding:10px
  }

  .card{
    padding:13px
  }

  th,td{
    font-size:12px;
    padding:7px 4px
  }

  .price{
    font-size:27px
  }

  .indicator-table{
    display:block;
    overflow-x:auto;
  }

  .indicator-table table{
    min-width:650px
  }
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

  <div class="search">

    <input
      id="searchInput"
      placeholder="输入 BTC、ETH、SOL 或其他币种名称 / Symbol"
    >

    <button onclick="doPairsSearch()">
      搜索
    </button>

  </div>

  <div
    id="searchResults"
    class="search-results"
  ></div>

  <div
    class="current"
    id="currentPairText"
  >
    当前：BTCUSD · XBTUSD
  </div>

  <button
    class="refresh"
    onclick="loadData()"
  >
    刷新数据
  </button>

</div>

<div class="card">

  <div
    class="price-title"
    id="priceTitle"
  >
    BTC 价格
  </div>

  <div
    class="price"
    id="price"
  >
    —
  </div>

  <div id="voteBox">
    加载中...
  </div>

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

  <strong>1H 技术指标</strong>

  <div
    class="section-note"
  >
    以下内容已经转换为中文说明。计算公式和 QuantVote 分数没有改变。
  </div>

  <div
    id="indicatorReadable"
  >
    加载中...
  </div>

  <details>

    <summary>
      查看完整原始指标数据
    </summary>

    <pre id="indicatorsRaw">
加载中...
    </pre>

  </details>

  <div style="margin-top:18px">

    <strong>1H 判断依据</strong>

    <div
      id="reasons"
      class="small"
    >
      加载中...
    </div>

  </div>

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
let loadingData = false;

/* =========================================================
   基础显示
   ========================================================= */

function esc(v){

  return String(v ?? "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#39;");
}

function cls(v){

  const x=
    String(v||"")
      .toLowerCase();

  if(x.includes("bull"))
    return "bullish";

  if(x.includes("bear"))
    return "bearish";

  return "neutral";
}

function fmtPrice(v){

  if(
    v===null ||
    v===undefined ||
    !isFinite(Number(v))
  ){
    return "—";
  }

  const n=Number(v);

  if(n>=1000)
    return n.toFixed(2);

  if(n>=1)
    return n.toFixed(4);

  if(n>=0.01)
    return n.toFixed(6);

  return n.toFixed(8);
}

function fmtNumber(v,digits=2){

  if(
    v===null ||
    v===undefined ||
    !isFinite(Number(v))
  ){
    return "—";
  }

  return Number(v).toFixed(digits);
}

/* =========================================================
   指标中文解释
   ========================================================= */

function indicatorRow(
  name,
  value,
  meaning,
  impact,
  impactClass
){

  return \`
    <tr>

      <td class="indicator-name">
        \${esc(name)}
      </td>

      <td class="indicator-value">
        \${esc(value)}
      </td>

      <td class="indicator-meaning">
        \${esc(meaning)}
      </td>

      <td class="indicator-impact \${impactClass}">
        \${esc(impact)}
      </td>

    </tr>
  \`;
}

function getRsiMeaning(rsi){

  if(rsi===null)
    return {
      meaning:"暂无数据",
      impact:"未知",
      cls:"neutral"
    };

  if(rsi<30)
    return {
      meaning:"进入超卖区域",
      impact:"短线存在反弹可能，但趋势仍需确认",
      cls:"bullish"
    };

  if(rsi>70)
    return {
      meaning:"进入超买区域",
      impact:"短线存在回调风险",
      cls:"bearish"
    };

  if(rsi>=50)
    return {
      meaning:"动能偏强",
      impact:"偏多",
      cls:"bullish"
    };

  return {
    meaning:"动能偏弱",
    impact:"偏空",
    cls:"bearish"
  };
}

function getMacdMeaning(ind){

  if(
    ind.macd===null ||
    ind.macdSignal===null ||
    ind.macdHistogram===null
  ){

    return {
      meaning:"暂无数据",
      impact:"未知",
      cls:"neutral"
    };
  }

  if(
    ind.macd>ind.macdSignal &&
    ind.macdHistogram>0
  ){

    return {
      meaning:"MACD 在信号线上方，柱体为正",
      impact:"多头动能",
      cls:"bullish"
    };
  }

  if(
    ind.macd<ind.macdSignal &&
    ind.macdHistogram<0
  ){

    return {
      meaning:"MACD 在信号线下方，柱体为负",
      impact:"空头动能",
      cls:"bearish"
    };
  }

  return {
    meaning:"MACD 与信号线方向不完全一致",
    impact:"信号较弱",
    cls:"neutral"
  };
}

function getKdjMeaning(ind){

  if(
    ind.k===null ||
    ind.d===null
  ){

    return {
      meaning:"暂无数据",
      impact:"未知",
      cls:"neutral"
    };
  }

  if(ind.k>ind.d){

    return {
      meaning:"K 线高于 D 线",
      impact:"短线动能偏多",
      cls:"bullish"
    };
  }

  if(ind.k<ind.d){

    return {
      meaning:"K 线低于 D 线",
      impact:"短线动能偏空",
      cls:"bearish"
    };
  }

  return {
    meaning:"K 线与 D 线接近",
    impact:"中性",
    cls:"neutral"
  };
}

function getTrendMeaning(trend){

  if(trend==="strong_bullish"){

    return {
      meaning:"价格高于 EMA20/50/200，均线多头排列",
      impact:"强多头趋势",
      cls:"bullish"
    };
  }

  if(trend==="strong_bearish"){

    return {
      meaning:"价格低于 EMA20/50/200，均线空头排列",
      impact:"强空头趋势",
      cls:"bearish"
    };
  }

  if(trend==="bullish"){

    return {
      meaning:"整体价格结构偏多",
      impact:"多头倾向",
      cls:"bullish"
    };
  }

  if(trend==="bearish"){

    return {
      meaning:"整体价格结构偏空",
      impact:"空头倾向",
      cls:"bearish"
    };
  }

  return {
    meaning:"均线结构没有形成明确方向",
    impact:"中性",
    cls:"neutral"
  };
}

function renderIndicators(ind){

  if(!ind){

    document.getElementById(
      "indicatorReadable"
    ).innerHTML=
      "<div class='error'>暂无指标数据</div>";

    return;
  }

  const rsiInfo=
    getRsiMeaning(ind.rsi14);

  const macdInfo=
    getMacdMeaning(ind);

  const kdjInfo=
    getKdjMeaning(ind);

  const trendInfo=
    getTrendMeaning(ind.trend);

  let volumeMeaning="";

  let volumeImpact="";
  let volumeClass="neutral";

  if(
    ind.volumeRatio===null ||
    ind.volumeRatio===undefined
  ){

    volumeMeaning="暂无成交量数据";
    volumeImpact="未知";

  }else{

    if(ind.volumeRatio<0.8){

      volumeMeaning=
        "当前成交量低于20周期平均成交量";

      volumeImpact=
        "市场活动偏低";

      volumeClass="neutral";

    }else if(ind.volumeRatio>1.2){

      volumeMeaning=
        "当前成交量高于20周期平均成交量";

      volumeImpact=
        "市场活动较高";

      volumeClass="bullish";

    }else{

      volumeMeaning=
        "当前成交量接近20周期平均水平";

      volumeImpact=
        "市场活动正常";

      volumeClass="neutral";
    }
  }

  let priceVsEma20="";

  if(
    ind.price!==null &&
    ind.ema20!==null
  ){

    priceVsEma20=
      ind.price>ind.ema20
      ? "价格高于 EMA20"
      : "价格低于 EMA20";
  }else{

    priceVsEma20="暂无数据";
  }

  let emaStructure="";

  if(
    ind.ema20!==null &&
    ind.ema50!==null &&
    ind.ema200!==null
  ){

    if(
      ind.ema20>ind.ema50 &&
      ind.ema50>ind.ema200
    ){

      emaStructure="EMA20 > EMA50 > EMA200，多头排列";

    }else if(
      ind.ema20<ind.ema50 &&
      ind.ema50<ind.ema200
    ){

      emaStructure="EMA20 < EMA50 < EMA200，空头排列";

    }else{

      emaStructure="均线没有形成完整多空排列";
    }

  }else{

    emaStructure="暂无完整均线数据";
  }

  let bollMeaning="";

  let bollImpact="";

  let bollClass="neutral";

  if(
    ind.price!==null &&
    ind.bollUpper!==null &&
    ind.bollLower!==null
  ){

    if(ind.price>ind.bollUpper){

      bollMeaning=
        "价格突破布林上轨";

      bollImpact=
        "短线偏强，注意回落风险";

      bollClass="bearish";

    }else if(ind.price<ind.bollLower){

      bollMeaning=
        "价格跌破布林下轨";

      bollImpact=
        "短线偏弱，注意超跌反弹";

      bollClass="bullish";

    }else{

      bollMeaning=
        "价格位于布林带内部";

      bollImpact=
        "暂无极端突破信号";

      bollClass="neutral";
    }

  }else{

    bollMeaning="暂无布林带数据";
    bollImpact="未知";
  }

  const html=\`

    <div class="indicator-table">

      <table>

        <thead>

          <tr>
            <th>指标</th>
            <th>当前值</th>
            <th>怎么看</th>
            <th>对判断的影响</th>
          </tr>

        </thead>

        <tbody>

          \${indicatorRow(
            "当前价格",
            fmtPrice(ind.price),
            "当前市场价格",
            "基准价格",
            "neutral"
          )}

          \${indicatorRow(
            "EMA20",
            fmtPrice(ind.ema20),
            "20周期指数移动平均线",
            priceVsEma20,
            ind.price<ind.ema20
              ? "bearish"
              : "bullish"
          )}

          \${indicatorRow(
            "EMA50",
            fmtPrice(ind.ema50),
            "50周期趋势参考线",
            "中期趋势参考",
            "neutral"
          )}

          \${indicatorRow(
            "EMA200",
            fmtPrice(ind.ema200),
            "200周期长期趋势参考线",
            "长期趋势参考",
            "neutral"
          )}

          \${indicatorRow(
            "均线结构",
            trendInfo.meaning,
            emaStructure,
            trendInfo.impact,
            trendInfo.cls
          )}

          \${indicatorRow(
            "RSI14",
            fmtNumber(ind.rsi14,1),
            rsiInfo.meaning,
            rsiInfo.impact,
            rsiInfo.cls
          )}

          \${indicatorRow(
            "MACD",
            fmtNumber(ind.macd,3),
            macdInfo.meaning,
            macdInfo.impact,
            macdInfo.cls
          )}

          \${indicatorRow(
            "MACD 信号线",
            fmtNumber(ind.macdSignal,3),
            "MACD 的比较基准",
            ind.macd!==null &&
            ind.macdSignal!==null &&
            ind.macd>ind.macdSignal
              ? "MACD 在信号线上方"
              : "MACD 在信号线下方",
            ind.macd!==null &&
            ind.macdSignal!==null &&
            ind.macd>ind.macdSignal
              ? "bullish"
              : "bearish"
          )}

          \${indicatorRow(
            "MACD 柱体",
            fmtNumber(ind.macdHistogram,3),
            ind.macdHistogram!==null &&
            ind.macdHistogram>0
              ? "柱体为正"
              : "柱体为负",
            ind.macdHistogram!==null &&
            ind.macdHistogram>0
              ? "多头动能"
              : "空头动能",
            ind.macdHistogram!==null &&
            ind.macdHistogram>0
              ? "bullish"
              : "bearish"
          )}

          \${indicatorRow(
            "KDJ-K",
            fmtNumber(ind.k,1),
            kdjInfo.meaning,
            kdjInfo.impact,
            kdjInfo.cls
          )}

          \${indicatorRow(
            "KDJ-D",
            fmtNumber(ind.d,1),
            "KDJ 的趋势参考线",
            ind.k!==null &&
            ind.d!==null &&
            ind.k>ind.d
              ? "K 高于 D"
              : "K 低于 D",
            ind.k!==null &&
            ind.d!==null &&
            ind.k>ind.d
              ? "bullish"
              : "bearish"
          )}

          \${indicatorRow(
            "KDJ-J",
            fmtNumber(ind.j,1),
            "KDJ 强化指标",
            "辅助判断短线动能",
            "neutral"
          )}

          \${indicatorRow(
            "布林中轨",
            fmtPrice(ind.bollMiddle),
            "20周期价格波动中线",
            "价格位置参考",
            "neutral"
          )}

          \${indicatorRow(
            "布林上轨",
            fmtPrice(ind.bollUpper),
            "短期价格波动上边界",
            "压力区域参考",
            "neutral"
          )}

          \${indicatorRow(
            "布林下轨",
            fmtPrice(ind.bollLower),
            "短期价格波动下边界",
            "支撑区域参考",
            "neutral"
          )}

          \${indicatorRow(
            "布林带宽度",
            fmtNumber(ind.bollWidth,2)+"%",
            "衡量当前价格波动范围",
            ind.bollWidth!==null &&
            ind.bollWidth>=5
              ? "波动较大"
              : "波动相对正常",
            ind.bollWidth!==null &&
            ind.bollWidth>=5
              ? "bearish"
              : "neutral"
          )}

          \${indicatorRow(
            "ATR14",
            fmtNumber(ind.atr14,3),
            "平均真实波动幅度",
            "衡量市场波动大小",
            "neutral"
          )}

          \${indicatorRow(
            "ATR / 价格",
            fmtNumber(ind.atrPercent,2)+"%",
            "ATR 相对于当前价格的比例",
            ind.atrPercent!==null &&
            ind.atrPercent>=0.5
              ? "波动偏高"
              : "波动较低",
            ind.atrPercent!==null &&
            ind.atrPercent>=0.5
              ? "bearish"
              : "neutral"
          )}

          \${indicatorRow(
            "当前成交量",
            fmtNumber(ind.volume,2),
            "最近一个周期的成交量",
            volumeImpact,
            volumeClass
          )}

          \${indicatorRow(
            "20周期平均成交量",
            fmtNumber(ind.volumeAverage,2),
            "最近20个周期的平均成交量",
            "成交量比较基准",
            "neutral"
          )}

          \${indicatorRow(
            "成交量 / 均量",
            fmtNumber(ind.volumeRatio,2)+"倍",
            volumeMeaning,
            volumeImpact,
            volumeClass
          )}

          \${indicatorRow(
            "趋势",
            ind.trend,
            trendInfo.meaning,
            trendInfo.impact,
            trendInfo.cls
          )}

        </tbody>

      </table>

    </div>
  \`;

  document.getElementById(
    "indicatorReadable"
  ).innerHTML=html;
}

/* =========================================================
   API
   ========================================================= */

async function api(path){

  const r=
    await fetch(
      path,
      {
        cache:"no-store"
      }
    );

  const j=
    await r.json();

  if(
    !r.ok ||
    j.status==="error"
  ){

    throw new Error(
      j.error ||
      "API 请求失败"
    );
  }

  return j;
}

/* =========================================================
   搜索
   ========================================================= */

async function doPairsSearch(){

  const q=
    document
      .getElementById("searchInput")
      .value
      .trim();

  if(!q){

    document
      .getElementById("searchResults")
      .style.display="none";

    return;
  }

  const box=
    document.getElementById(
      "searchResults"
    );

  box.style.display="block";

  box.innerHTML=
    "<div class='search-result'>搜索中...</div>";

  try{

    const data=
      await api(
        "/api/pairs?q="+
        encodeURIComponent(q)
      );

    if(
      !data.results ||
      !data.results.length
    ){

      box.innerHTML=
        "<div class='search-result'>没有找到交易对</div>";

      return;
    }

    box.innerHTML=
      data.results.map(
        x =>

        "<div class='search-result' onclick='selectPair("+
        JSON.stringify(x.symbol)+","+
        JSON.stringify(x.pair)+")'>"+

        "<div class='result-symbol'>"+
        esc(x.symbol)+
        "</div>"+

        "<div class='result-display'>"+
        esc(x.display)+
        "</div>"+

        "</div>"

      ).join("");

  }catch(e){

    box.innerHTML=
      "<div class='search-result error'>搜索失败："+
      esc(e.message)+
      "</div>";
  }
}

async function selectPair(
  symbol,
  pair
){

  currentSymbol=symbol;
  currentPair=pair;

  document
    .getElementById(
      "searchResults"
    )
    .style.display="none";

  document
    .getElementById(
      "currentPairText"
    )
    .textContent=
      "当前："+symbol+" · "+pair;

  document
    .getElementById(
      "priceTitle"
    )
    .textContent=
      symbol.replace(
        /USD$|USDT$|USDC$|XBT$/,
        ""
      )+
      " 价格";

  await loadData();
}

/* =========================================================
   加载
   ========================================================= */

async function loadData(){

  if(loadingData){
    return;
  }

  loadingData=true;

  try{

    document
      .getElementById(
        "voteBox"
      )
      .textContent=
        "加载中...";

    const pairParam=
      "pair="+
      encodeURIComponent(
        currentPair
      );

    const [
      market,
      multi,
      vote,
      ind
    ]=
      await Promise.all([

        api(
          "/api/market?"+
          pairParam
        ),

        api(
          "/api/multi?"+
          pairParam
        ),

        api(
          "/api/vote?"+
          pairParam
        ),

        api(
          "/api/indicators?"+
          pairParam
        )

      ]);

    document
      .getElementById(
        "price"
      )
      .textContent=
        fmtPrice(
          market.price
        );

    const voteClass=
      cls(vote.vote);

    document
      .getElementById(
        "voteBox"
      )
      .innerHTML=

        "<div>1H QuantVote</div>"+

        "<div class='vote "+
        voteClass+
        "'>"+
        esc(vote.vote)+
        "</div>"+

        "<div><strong>1H Score</strong><br>"+
        esc(vote.score)+
        " / 7</div>"+

        "<div style='margin-top:8px'>"+
        "<strong>风险</strong><br>"+
        esc(
          vote.risk ||
          "LOW"
        )+
        "</div>";

    const rows=
      (
        multi.timeframes ||
        []
      ).map(
        x =>

        "<tr>"+

        "<td>"+
        esc(
          x.intervalLabel ||
          x.interval
        )+
        "</td>"+

        "<td>"+
        fmtPrice(
          x.price
        )+
        "</td>"+

        "<td>"+
        esc(x.score)+
        "</td>"+

        "<td class='"+
        cls(x.vote)+
        "'>"+
        esc(x.vote)+
        "</td>"+

        "<td>"+
        esc(x.trend)+
        "</td>"+

        "<td>"+
        (
          Number(x.rsi)
            .toFixed(1)
        )+
        "</td>"+

        "</tr>"
      ).join("");

    document
      .getElementById(
        "multiBody"
      )
      .innerHTML=
        rows;

    const indicatorData=
      ind.indicators ||
      ind;

    renderIndicators(
      indicatorData
    );

    document
      .getElementById(
        "indicatorsRaw"
      )
      .textContent=
        JSON.stringify(
          indicatorData,
          null,
          2
        );

    const reasons=
      vote.reasons ||
      [];

    document
      .getElementById(
        "reasons"
      )
      .innerHTML=

        reasons.length

        ? reasons.map(
            x =>
            "<div class='reason'>• "+
            esc(x)+
            "</div>"
          ).join("")

        : "暂无判断依据";

  }catch(e){

    document
      .getElementById(
        "voteBox"
      )
      .innerHTML=
        "<div class='error'>数据加载失败："+
        esc(e.message)+
        "</div>";

  }finally{

    loadingData=false;

  }
}

/* =========================================================
   Enter 搜索
   ========================================================= */

document
  .getElementById(
    "searchInput"
  )
  .addEventListener(
    "keydown",
    function(e){

      if(e.key==="Enter"){
        doPairsSearch();
      }

    }
  );

/* =========================================================
   首次加载 + 60秒刷新
   ========================================================= */

loadData();

refreshTimer=
  setInterval(
    function(){
      loadData();
    },
    60000
  );

</script>

</body>
</html>`;

/* =========================================================
   JSON
   ========================================================= */

function json(
  data,
  status=200
){

  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,
      headers:{
        ...CORS_HEADERS,
        "Content-Type":
          "application/json;charset=UTF-8"
      }
    }
  );
}

/* =========================================================
   基础工具
   ========================================================= */

function normalizeSymbol(symbol){

  const s=
    String(symbol||"")
      .toUpperCase();

  if(
    s==="BTCUSD" ||
    s==="XBTUSD"
  ){

    return "XBTUSD";
  }

  return s;
}

function cleanNumber(v){

  const n=Number(v);

  return Number.isFinite(n)
    ? n
    : null;
}

function sma(
  values,
  period
){

  if(values.length<period)
    return null;

  let sum=0;

  for(
    let i=values.length-period;
    i<values.length;
    i++
  ){

    sum+=values[i];
  }

  return sum/period;
}

function emaSeries(
  values,
  period
){

  if(values.length<period)
    return [];

  const out=
    new Array(
      values.length
    ).fill(null);

  let sum=0;

  for(
    let i=0;
    i<period;
    i++
  ){

    sum+=values[i];
  }

  let prev=
    sum/period;

  out[period-1]=prev;

  const k=
    2/(period+1);

  for(
    let i=period;
    i<values.length;
    i++
  ){

    prev=
      values[i]*k+
      prev*(1-k);

    out[i]=prev;
  }

  return out;
}

function ema(
  values,
  period
){

  const s=
    emaSeries(
      values,
      period
    );

  return s.length
    ? s[s.length-1]
    : null;
}

function rsi(
  values,
  period=14
){

  if(
    values.length<
    period+1
  ){

    return null;
  }

  let gain=0;
  let loss=0;

  for(
    let i=1;
    i<=period;
    i++
  ){

    const d=
      values[i]-
      values[i-1];

    if(d>=0){

      gain+=d;

    }else{

      loss-=d;
    }
  }

  gain/=period;
  loss/=period;

  for(
    let i=period+1;
    i<values.length;
    i++
  ){

    const d=
      values[i]-
      values[i-1];

    const g=
      d>0
      ? d
      : 0;

    const l=
      d<0
      ? -d
      : 0;

    gain=
      (
        gain*(period-1)+g
      )/period;

    loss=
      (
        loss*(period-1)+l
      )/period;
  }

  if(loss===0){
    return 100;
  }

  const rs=
    gain/loss;

  return 100-
    (100/(1+rs));
}

function macd(values){

  if(values.length<35){

    return {
      macd:null,
      signal:null,
      histogram:null
    };
  }

  const e12=
    emaSeries(
      values,
      12
    );

  const e26=
    emaSeries(
      values,
      26
    );

  const line=[];

  for(
    let i=0;
    i<values.length;
    i++
  ){

    if(
      e12[i]!==null &&
      e26[i]!==null
    ){

      line.push(
        e12[i]-e26[i]
      );
    }
  }

  const signalSeries=
    emaSeries(
      line,
      9
    );

  const m=
    line[
      line.length-1
    ];

  const s=
    signalSeries[
      signalSeries.length-1
    ];

  return {

    macd:m,

    signal:s,

    histogram:
      m!==null &&
      s!==null
      ? m-s
      : null
  };
}

function bollinger(
  values,
  period=20,
  mult=2
){

  if(
    values.length<
    period
  ){

    return {
      middle:null,
      upper:null,
      lower:null,
      width:null
    };
  }

  const middle=
    sma(
      values,
      period
    );

  let sum=0;

  for(
    let i=values.length-period;
    i<values.length;
    i++
  ){

    sum+=
      Math.pow(
        values[i]-middle,
        2
      );
  }

  const sd=
    Math.sqrt(
      sum/period
    );

  const upper=
    middle+
    mult*sd;

  const lower=
    middle-
    mult*sd;

  return {

    middle,

    upper,

    lower,

    width:
      middle!==0
      ? (
          (upper-lower)/
          middle
        )*100
      : null
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

  const tr=[];

  for(
    let i=1;
    i<candles.length;
    i++
  ){

    const c=
      candles[i];

    const prev=
      candles[i-1];

    tr.push(
      Math.max(
        c.high-c.low,

        Math.abs(
          c.high-prev.close
        ),

        Math.abs(
          c.low-prev.close
        )
      )
    );
  }

  return sma(
    tr,
    period
  );
}

function kdj(
  candles,
  period=9
){

  if(
    candles.length<
    period
  ){

    return {
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

    let high=-Infinity;
    let low=Infinity;

    for(
      let j=i-period+1;
      j<=i;
      j++
    ){

      high=
        Math.max(
          high,
          candles[j].high
        );

      low=
        Math.min(
          low,
          candles[j].low
        );
    }

    const close=
      candles[i].close;

    const rsv=
      high===low
      ? 50
      : (
          (close-low)/
          (high-low)
        )*100;

    k=
      (2*k+rsv)/3;

    d=
      (2*d+k)/3;
  }

  return {

    k,

    d,

    j:
      3*k-2*d
  };
}

/* =========================================================
   指标
   ========================================================= */

function calculateIndicators(
  candles
){

  const closes=
    candles.map(
      x=>x.close
    );

  const price=
    closes[
      closes.length-1
    ];

  const ema20=
    ema(
      closes,
      20
    );

  const ema50=
    ema(
      closes,
      50
    );

  const ema200=
    ema(
      closes,
      200
    );

  const rsi14=
    rsi(
      closes,
      14
    );

  const m=
    macd(closes);

  const kd=
    kdj(
      candles,
      9
    );

  const bb=
    bollinger(
      closes,
      20,
      2
    );

  const atr14=
    atr(
      candles,
      14
    );

  const volumes=
    candles.map(
      x=>x.volume
    );

  const volume=
    volumes[
      volumes.length-1
    ];

  const volumeAverage=
    sma(
      volumes,
      20
    );

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

      trend=
        "strong_bullish";

    }else if(
      price<ema20 &&
      ema20<ema50 &&
      ema50<ema200
    ){

      trend=
        "strong_bearish";

    }else if(
      price>ema50
    ){

      trend=
        "bullish";

    }else if(
      price<ema50
    ){

      trend=
        "bearish";
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
function calculateAdx(
  candles,
  period=14
){

  if(
    candles.length <
    period*2+1
  ){

    return {
      adx:null,
      plusDI:null,
      minusDI:null
    };
  }

  const tr=[];
  const plusDM=[];
  const minusDM=[];

  for(
    let i=1;
    i<candles.length;
    i++
  ){

    const current=
      candles[i];

    const previous=
      candles[i-1];

    const upMove=
      current.high-
      previous.high;

    const downMove=
      previous.low-
      current.low;

    const trueRange=
      Math.max(
        current.high-current.low,
        Math.abs(
          current.high-
          previous.close
        ),
        Math.abs(
          current.low-
          previous.close
        )
      );

    tr.push(trueRange);

    plusDM.push(
      upMove>downMove &&
      upMove>0
        ? upMove
        : 0
    );

    minusDM.push(
      downMove>upMove &&
      downMove>0
        ? downMove
        : 0
    );
  }

  if(tr.length<period*2){
    return {
      adx:null,
      plusDI:null,
      minusDI:null
    };
  }

  let trSmooth=0;
  let plusSmooth=0;
  let minusSmooth=0;

  for(
    let i=0;
    i<period;
    i++
  ){

    trSmooth+=tr[i];
    plusSmooth+=plusDM[i];
    minusSmooth+=minusDM[i];
  }

  const dx=[];

  let lastPlusDI=null;
  let lastMinusDI=null;

  for(
    let i=period;
    i<tr.length;
    i++
  ){

    trSmooth=
      trSmooth-
      trSmooth/period+
      tr[i];

    plusSmooth=
      plusSmooth-
      plusSmooth/period+
      plusDM[i];

    minusSmooth=
      minusSmooth-
      minusSmooth/period+
      minusDM[i];

    const plusDI=
      trSmooth!==0
        ? 100*plusSmooth/trSmooth
        : 0;

    const minusDI=
      trSmooth!==0
        ? 100*minusSmooth/trSmooth
        : 0;

    lastPlusDI=plusDI;
    lastMinusDI=minusDI;

    const denominator=
      plusDI+
      minusDI;

    const value=
      denominator!==0
        ? 100*
          Math.abs(
            plusDI-minusDI
          )/
          denominator
        : 0;

    dx.push(value);
  }

  if(dx.length<period){

    return {
      adx:null,
      plusDI:lastPlusDI,
      minusDI:lastMinusDI
    };
  }

  let adx=0;

  for(
    let i=0;
    i<period;
    i++
  ){

    adx+=dx[i];
  }

  adx/=period;

  for(
    let i=period;
    i<dx.length;
    i++
  ){

    adx=
      (
        adx*(period-1)+
        dx[i]
      )/
      period;
  }

  return {

    adx,

    plusDI:lastPlusDI,

    minusDI:lastMinusDI

  };
}

function calculateObv(
  candles
){

  if(
    candles.length<2
  ){

    return {
      obv:null,
      obvPrevious:null,
      obvChange:null
    };
  }

  let obv=0;

  for(
    let i=1;
    i<candles.length;
    i++
  ){

    if(
      candles[i].close>
      candles[i-1].close
    ){

      obv+=
        candles[i].volume;

    }else if(
      candles[i].close<
      candles[i-1].close
    ){

      obv-=
        candles[i].volume;
    }
  }

  let previousObv=0;

  for(
    let i=1;
    i<candles.length-1;
    i++
  ){

    if(
      candles[i].close>
      candles[i-1].close
    ){

      previousObv+=
        candles[i].volume;

    }else if(
      candles[i].close<
      candles[i-1].close
    ){

      previousObv-=
        candles[i].volume;
    }
  }

  return {

    obv,

    obvPrevious:
      previousObv,

    obvChange:
      obv-
      previousObv

  };
}

function calculateIndicators(
  candles
){

  const closes=
    candles.map(
      x=>x.close
    );

  const price=
    closes[
      closes.length-1
    ];

  const ema20=
    ema(
      closes,
      20
    );

  const ema50=
    ema(
      closes,
      50
    );

  const ema100=
    ema(
      closes,
      100
    );

  const ema200=
    ema(
      closes,
      200
    );

  const rsi14=
    rsi(
      closes,
      14
    );

  const m=
    macd(closes);

  const kd=
    kdj(
      candles,
      9
    );

  const bb=
    bollinger(
      closes,
      20,
      2
    );

  const atr14=
    atr(
      candles,
      14
    );

  const adxData=
    calculateAdx(
      candles,
      14
    );

  const obvData=
    calculateObv(
      candles
    );

  const volumes=
    candles.map(
      x=>x.volume
    );

  const volume=
    volumes[
      volumes.length-1
    ];

  const volumeAverage=
    sma(
      volumes,
      20
    );

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

      trend=
        "strong_bullish";

    }else if(
      price<ema20 &&
      ema20<ema50 &&
      ema50<ema200
    ){

      trend=
        "strong_bearish";

    }else if(
      price>ema50
    ){

      trend=
        "bullish";

    }else if(
      price<ema50
    ){

      trend=
        "bearish";
    }
  }

  let trendStrength=
    "WEAK";

  if(
    adxData.adx!==null
  ){

    if(adxData.adx>=35){

      trendStrength=
        "STRONG";

    }else if(adxData.adx>=25){

      trendStrength=
        "MODERATE";
    }
  }

  let diBias="NEUTRAL";

  if(
    adxData.plusDI!==null &&
    adxData.minusDI!==null
  ){

    if(
      adxData.plusDI>
      adxData.minusDI
    ){

      diBias="BULLISH";

    }else if(
      adxData.plusDI<
      adxData.minusDI
    ){

      diBias="BEARISH";
    }
  }

  return {

    price,

    ema20,
    ema50,
    ema100,
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
      atr14!==null &&
      price
      ? (
          atr14/price
        )*100
      : null,

    volume,

    volumeAverage,

    volumeRatio:
      volumeAverage &&
      volumeAverage!==0
      ? volume/volumeAverage
      : 0,

    adx:
      adxData.adx,

    plusDI:
      adxData.plusDI,

    minusDI:
      adxData.minusDI,

    diBias,

    obv:
      obvData.obv,

    obvPrevious:
      obvData.obvPrevious,

    obvChange:
      obvData.obvChange,

    trend,

    trendStrength

  };
    }
/* =========================================================
   Vote
   ========================================================= */

function calculateVote(
  ind
){

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

      reasons.push(
        "价格位于 EMA20/50/200 上方，均线多头排列"
      );

    }else if(
      ind.price<ind.ema20 &&
      ind.ema20<ind.ema50 &&
      ind.ema50<ind.ema200
    ){

      score-=3;

      reasons.push(
        "价格位于 EMA20/50/200 下方，均线空头排列"
      );
    }

    if(
      ind.price>ind.ema50 &&
      ind.ema20>ind.ema50
    ){

      score+=2;

    }else if(
      ind.price<ind.ema50 &&
      ind.ema20<ind.ema50
    ){

      score-=2;
    }
  }

  if(
    ind.rsi14!==null
  ){

    if(ind.rsi14<30){

      score+=1;

      reasons.push(
        "RSI14="+
        ind.rsi14.toFixed(1)+
        "，进入超卖区域"
      );

    }else if(
      ind.rsi14>70
    ){

      score-=1;

      reasons.push(
        "RSI14="+
        ind.rsi14.toFixed(1)+
        "，进入超买区域"
      );

    }else if(
      ind.rsi14>=50
    ){

      score+=1;

      reasons.push(
        "RSI14="+
        ind.rsi14.toFixed(1)+
        "，动能偏强"
      );

    }else{

      score-=1;

      reasons.push(
        "RSI14="+
        ind.rsi14.toFixed(1)+
        "，动能偏弱"
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

      reasons.push(
        "MACD 位于信号线上方，动能偏多"
      );

    }else if(
      ind.macd<ind.macdSignal &&
      ind.macdHistogram<0
    ){

      score-=1;

      reasons.push(
        "MACD 位于信号线下方，动能偏空"
      );
    }
  }

  if(
    ind.k!==null &&
    ind.d!==null
  ){

    if(ind.k>ind.d){

      score+=1;

      reasons.push(
        "KDJ K 线高于 D 线，短线动能偏多"
      );

    }else if(
      ind.k<ind.d
    ){

      score-=1;

      reasons.push(
        "KDJ K 线低于 D 线，短线动能偏空"
      );
    }
  }

  if(
    ind.bollUpper!==null &&
    ind.bollLower!==null
  ){

    if(
      ind.price>ind.bollUpper
    ){

      score-=1;

    }else if(
      ind.price<ind.bollLower
    ){

      score+=1;
    }
  }

  score=
    Math.max(
      -7,
      Math.min(
        7,
        score
      )
    );

  let vote="NEUTRAL";

  if(score>=2){

    vote="BULLISH";

  }else if(
    score<=-2
  ){

    vote="BEARISH";
  }

  return {
    score,
    vote,
    reasons
  };
}

/* =========================================================
   Risk
   ========================================================= */

function calculateRisk(
  ind
){

  const atrPct=
    ind.atrPercent ||
    0;

  const bw=
    ind.bollWidth ||
    0;

  if(
    atrPct>=1 ||
    bw>=10
  ){

    return "HIGH";
  }

  if(
    atrPct>=0.5 ||
    bw>=5
  ){

    return "MEDIUM";
  }

  return "LOW";
}

/* =========================================================
   周期
   ========================================================= */

function intervalToKraken(
  interval
){

  if(interval==="15m")
    return 15;

  if(interval==="1H")
    return 60;

  if(interval==="4H")
    return 240;

  if(interval==="1D")
    return 1440;

  return 60;
}

function intervalLabel(
  interval
){

  return interval;
}

/* =========================================================
   Kraken OHLC
   ========================================================= */

async function fetchKraken(
  symbol,
  interval,
  limit=720,
  pairOverride=null
){

  const pair=
    pairOverride ||
    normalizeSymbol(symbol);

  const krakenInterval=
    intervalToKraken(
      interval
    );

  const cacheKey=
    pair+
    "|"+
    krakenInterval;

  const now=
    Date.now();

  const cached=
    OHLC_CACHE.get(
      cacheKey
    );

  if(
    cached &&
    now-cached.time<
      OHLC_CACHE_TTL
  ){

    return cached.rows.slice(
      -limit
    );
  }

  if(
    OHLC_INFLIGHT.has(
      cacheKey
    )
  ){

    const rows=
      await OHLC_INFLIGHT.get(
        cacheKey
      );

    return rows.slice(
      -limit
    );
  }

  const promise=
    queueKrakenRequest(
      async ()=>{

        const url=
          "https://api.kraken.com/0/public/OHLC?pair="+
          encodeURIComponent(pair)+
          "&interval="+
          krakenInterval;

        const response=
          await fetch(
            url,
            {
              headers:{
                "User-Agent":
                  "QuantVote-V2"
              }
            }
          );

        if(!response.ok){

          throw new Error(
            "Kraken HTTP "+
            response.status
          );
        }

        const data=
          await response.json();

        if(
          data.error &&
          data.error.length
        ){

          throw new Error(
            data.error.join(", ")
          );
        }

        const result=
          data.result ||
          {};

        const key=
          Object.keys(result)
            .find(
              k=>k!=="last"
            );

        if(
          !key ||
          !Array.isArray(
            result[key]
          )
        ){

          throw new Error(
            "Kraken 没有返回K线数据"
          );
        }

        const rows=
          result[key].map(
            r=>({

              time:Number(r[0]),
              open:Number(r[1]),
              high:Number(r[2]),
              low:Number(r[3]),
              close:Number(r[4]),
              vwap:Number(r[5]),
              volume:Number(r[6]),
              count:Number(r[7])

            })
          );

        OHLC_CACHE.set(
          cacheKey,
          {
            time:Date.now(),
            rows
          }
        );

        return rows;
      }
    );

  OHLC_INFLIGHT.set(
    cacheKey,
    promise
  );

  try{

    const rows=
      await promise;

    return rows.slice(
      -limit
    );

  }finally{

    OHLC_INFLIGHT.delete(
      cacheKey
    );
  }
}

/* =========================================================
   Kraken AssetPairs
   ========================================================= */

async function fetchPairs(){

  const now=
    Date.now();

  if(
    PAIRS_CACHE &&
    now-PAIRS_CACHE_TIME<
      PAIRS_CACHE_TTL
  ){

    return PAIRS_CACHE;
  }

  if(PAIRS_INFLIGHT){

    return await PAIRS_INFLIGHT;
  }

  PAIRS_INFLIGHT=
    queueKrakenRequest(
      async ()=>{

        const url=
          "https://api.kraken.com/0/public/AssetPairs";

        const response=
          await fetch(
            url,
            {
              headers:{
                "User-Agent":
                  "QuantVote-V2"
              }
            }
          );

        if(!response.ok){

          throw new Error(
            "Kraken AssetPairs HTTP "+
            response.status
          );
        }

        const data=
          await response.json();

        if(
          data.error &&
          data.error.length
        ){

          throw new Error(
            data.error.join(", ")
          );
        }

        const result=
          data.result ||
          {};

        PAIRS_CACHE=
          result;

        PAIRS_CACHE_TIME=
          Date.now();

        return result;
      }
    );

  try{

    return await PAIRS_INFLIGHT;

  }finally{

    PAIRS_INFLIGHT=
      null;
  }
}

/* =========================================================
   Pair 解析
   ========================================================= */

function pairBase(pair){

  const p=
    String(pair||"")
      .toUpperCase();

  if(p.endsWith("XBT"))
    return p.slice(0,-3);

  if(p.endsWith("BTC"))
    return p.slice(0,-3);

  if(p.endsWith("USDT"))
    return p.slice(0,-4);

  if(p.endsWith("USDC"))
    return p.slice(0,-4);

  if(p.endsWith("USD"))
    return p.slice(0,-3);

  if(p.endsWith("EUR"))
    return p.slice(0,-3);

  if(p.endsWith("GBP"))
    return p.slice(0,-3);

  if(p.endsWith("JPY"))
    return p.slice(0,-3);

  if(p.endsWith("AUD"))
    return p.slice(0,-3);

  if(p.endsWith("CAD"))
    return p.slice(0,-3);

  if(p.endsWith("CHF"))
    return p.slice(0,-3);

  if(p.endsWith("ETH"))
    return p.slice(0,-3);

  return "";
}

function pairQuote(pair){

  const p=
    String(pair||"")
      .toUpperCase();

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

  for(
    const q of quotes
  ){

    if(p.endsWith(q)){
      return q;
    }
  }

  return "";
}

/* =========================================================
   Pair 搜索评分
   ========================================================= */

function scorePair(
  item,
  q
){

  const symbol=
    String(item.symbol||"")
      .toUpperCase();

  const pair=
    String(item.pair||"")
      .toUpperCase();

  const alt=
    String(item.altname||"")
      .toUpperCase();

  const ws=
    String(item.wsname||"")
      .toUpperCase();

  const query=
    String(q||"")
      .toUpperCase()
      .trim();

  const base=
    String(item.base||"")
      .toUpperCase();

  const quote=
    String(item.quote||"")
      .toUpperCase();

  let score=0;

  const exactBase=
    base===query ||
    pairBase(pair)===query ||
    pairBase(alt)===query ||
    pairBase(
      ws.replace("/","")
    )===query;

  const exactSymbol=
    symbol===query ||
    alt===query ||
    ws.replace("/","")===query;

  if(exactSymbol)
    score+=10000;

  if(exactBase)
    score+=8000;

  const isMajorQuote=
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
    ].includes(quote)
    ||
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
    ].includes(
      pairQuote(pair)
    );

  if(
    exactBase &&
    isMajorQuote
  ){

    score+=5000;
  }

  if(
    exactBase &&
    quote==="USD"
  ){

    score+=3000;
  }

  if(
    exactBase &&
    quote==="USDT"
  ){

    score+=2900;
  }

  if(
    exactBase &&
    quote==="USDC"
  ){

    score+=2800;
  }

  if(
    symbol.startsWith(query) ||
    alt.startsWith(query) ||
    ws.replace("/","")
      .startsWith(query)
  ){

    score+=1000;
  }

  if(pair.includes(query)){
    score+=100;
  }

  return score;
}

function displayPair(
  item
){

  const pair=
    item.wsname ||
    item.altname ||
    item.symbol ||
    "";

  return pair;
}

/* =========================================================
   Pairs
   ========================================================= */

async function handlePairs(
  url
){

  const q=
    (
      url.searchParams.get("q") ||
      ""
    ).trim();

  if(!q){

    return json({
      status:"ok",
      source:"kraken",
      query:"",
      count:0,
      results:[]
    });
  }

  const all=
    await fetchPairs();

  const query=
    q.toUpperCase();

  const list=[];

  for(
    const [key,item]
    of Object.entries(all)
  ){

    const symbol=
      String(key||"")
        .toUpperCase();

    const alt=
      String(item.altname||"")
        .toUpperCase();

    const ws=
      String(item.wsname||"")
        .toUpperCase();

    const base=
      String(item.base||"")
        .toUpperCase();

    const quote=
      String(item.quote||"")
        .toUpperCase();

    const text=
      symbol+" "+
      alt+" "+
      ws+" "+
      base+" "+
      quote;

    if(!text.includes(query)){
      continue;
    }

    list.push({

      symbol:key,

      pair:
        item.altname ||
        key,

      display:
        displayPair(item),

      altname:
        item.altname ||
        "",

      wsname:
        item.wsname ||
        "",

      base:
        item.base ||
        "",

      quote:
        item.quote ||
        "",

      _score:
        scorePair(
          {
            symbol:key,
            pair:
              item.altname ||
              key,
            ...item
          },
          q
        )
    });
  }

  list.sort(
    (a,b)=>{

      if(
        b._score!==a._score
      ){

        return b._score-
          a._score;
      }

      return String(
        a.display
      ).localeCompare(
        String(b.display)
      );
    }
  );

  const results=
    list
      .slice(0,50)
      .map(
        x=>({

          symbol:x.symbol,

          pair:x.pair,

          display:x.display

        })
      );

  return json({

    status:"ok",

    source:"kraken",

    query:q,

    count:
      results.length,

    results

  });
}

/* =========================================================
   Market
   ========================================================= */

async function handleMarket(
  url
){

  const pair=
    url.searchParams.get("pair") ||
    "XBTUSD";

  const candles=
    await fetchKraken(
      pair,
      "1H",
      10,
      pair
    );

  const last=
    candles[
      candles.length-1
    ];

  return json({

    status:"ok",

    source:"kraken",

    symbol:
      pair==="XBTUSD"
      ? "BTCUSD"
      : pair,

    pair,

    interval:60,

    timestamp:
      last.time,

    price:
      last.close
  });
}

/* =========================================================
   Indicators
   ========================================================= */

async function handleIndicators(
  url
){

  const pair=
    url.searchParams.get("pair") ||
    "XBTUSD";

  const candles=
    await fetchKraken(
      pair,
      "1H",
      720,
      pair
    );

  const indicators=
    calculateIndicators(
      candles
    );

  return json({

    status:"ok",

    source:"kraken",

    symbol:
      pair==="XBTUSD"
      ? "BTCUSD"
      : pair,

    pair,

    interval:60,

    timestamp:
      candles[
        candles.length-1
      ].time,

    indicators

  });
}

/* =========================================================
   Vote
   ========================================================= */

async function handleVote(
  url
){

  const pair=
    url.searchParams.get("pair") ||
    "XBTUSD";

  const candles=
    await fetchKraken(
      pair,
      "1H",
      720,
      pair
    );

  const indicators=
    calculateIndicators(
      candles
    );

  const result=
    calculateVote(
      indicators
    );

  const risk=
    calculateRisk(
      indicators
    );

  if(indicators.volumeAverage){

    result.reasons.push(

      "成交量约为20周期均量的 "+
      (
        indicators.volumeRatio ||
        0
      ).toFixed(2)+
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

    symbol:
      pair==="XBTUSD"
      ? "BTCUSD"
      : pair,

    pair,

    interval:60,

    price:
      indicators.price,

    score:
      result.score,

    vote:
      result.vote,

    risk,

    trend:
      indicators.trend,

    reasons:
      result.reasons

  });
}

/* =========================================================
   Multi
   ========================================================= */

async function handleMulti(
  url
){

  const pair=
    url.searchParams.get("pair") ||
    "XBTUSD";

  const intervals=[
    "15m",
    "1H",
    "4H",
    "1D"
  ];

  const result=[];

  for(
    const interval
    of intervals
  ){

    const candles=
      await fetchKraken(
        pair,
        interval,
        720,
        pair
      );

    const indicators=
      calculateIndicators(
        candles
      );

    const vote=
      calculateVote(
        indicators
      );

    result.push({

      interval,

      intervalLabel:
        interval,

      price:
        indicators.price,

      score:
        vote.score,

      vote:
        vote.vote,

      trend:
        indicators.trend,

      rsi:
        indicators.rsi14

    });
  }

  return json({

    status:"ok",

    source:"kraken",

    symbol:
      pair==="XBTUSD"
      ? "BTCUSD"
      : pair,

    pair,

    timeframes:
      result

  });
}

/* =========================================================
   Regime
   ========================================================= */

async function handleRegime(
  url
){

  const pair=
    url.searchParams.get("pair") ||
    "XBTUSD";

  const candles=
    await fetchKraken(
      pair,
      "1D",
      720,
      pair
    );

  const ind=
    calculateIndicators(
      candles
    );

  let regime="RANGE";

  if(
    ind.trend===
    "strong_bullish"
  ){

    regime="BULL";

  }else if(
    ind.trend===
    "strong_bearish"
  ){

    regime="BEAR";

  }else if(
    ind.trend===
    "bullish"
  ){

    regime=
      "BULLISH_BIAS";

  }else if(
    ind.trend===
    "bearish"
  ){

    regime=
      "BEARISH_BIAS";
  }

  return json({

    status:"ok",

    source:"kraken",

    symbol:
      pair==="XBTUSD"
      ? "BTCUSD"
      : pair,

    pair,

    regime,

    trend:
      ind.trend,

    price:
      ind.price,

    rsi:
      ind.rsi14

  });
}

/* =========================================================
   Backtest
   ========================================================= */

function runBacktest(
  candles
){

  if(
    candles.length<220
  ){

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

  for(
    let i=200;
    i<candles.length;
    i++
  ){

    const slice=
      candles.slice(
        0,
        i+1
      );

    const ind=
      calculateIndicators(
        slice
      );

    const vote=
      calculateVote(
        ind
      );

    const price=
      candles[i].close;

    if(
      !inPosition &&
      vote.score>=3
    ){

      inPosition=true;

      entry=price;

      continue;
    }

    if(
      inPosition &&
      vote.score<=0
    ){

      const ret=
        (price-entry)-
        Math.abs(
          price-entry
        )*0.001;

      const pct=
        ret/entry;

      equity*=
        1+pct;

      returns.push(
        pct
      );

      if(pct>0){

        wins.push(
          pct
        );

      }else{

        losses.push(
          pct
        );
      }

      peak=
        Math.max(
          peak,
          equity
        );

      const dd=
        (peak-equity)/
        peak;

      maxDD=
        Math.max(
          maxDD,
          dd
        );

      inPosition=false;

      entry=0;
    }
  }

  if(inPosition){

    const price=
      candles[
        candles.length-1
      ].close;

    const ret=
      (price-entry)-
      Math.abs(
        price-entry
      )*0.001;

    const pct=
      ret/entry;

    equity*=
      1+pct;

    returns.push(
      pct
    );

    if(pct>0){

      wins.push(
        pct
      );

    }else{

      losses.push(
        pct
      );
    }

    peak=
      Math.max(
        peak,
        equity
      );

    const dd=
      (peak-equity)/
      peak;

    maxDD=
      Math.max(
        maxDD,
        dd
      );
  }

  const n=
    returns.length;

  const winRate=
    n
    ? wins.length/n
    : 0;

  const avg=
    n
    ? returns.reduce(
        (a,b)=>a+b,
        0
      )/n
    : 0;

  let variance=0;

  if(n>1){

    variance=
      returns.reduce(
        (s,x)=>
          s+
          Math.pow(
            x-avg,
            2
          ),
        0
      )/(n-1);
  }

  const sd=
    Math.sqrt(
      variance
    );

  const sharpe=
    sd
    ? avg/sd*
      Math.sqrt(365)
    : 0;

  const grossProfit=
    wins.reduce(
      (a,b)=>a+b,
      0
    );

  const grossLoss=
    Math.abs(
      losses.reduce(
        (a,b)=>a+b,
        0
      )
    );

  const profitFactor=
    grossLoss
    ? grossProfit/grossLoss
    : 0;

  return {

    trades:n,

    winRate,

    cumulativeReturn:
      equity-1,

    maxDrawdown:
      maxDD,

    sharpe,

    profitFactor,

    longTrades:n,

    shortTrades:0

  };
}

async function handleBacktest(
  url
){

  const pair=
    url.searchParams.get("pair") ||
    "XBTUSD";

  const candles=
    await fetchKraken(
      pair,
      "1H",
      720,
      pair
    );

  const result=
    runBacktest(
      candles
    );

  return json({

    status:"ok",

    source:"kraken",

    symbol:
      pair==="XBTUSD"
      ? "BTCUSD"
      : pair,

    pair,

    interval:"1H",

    method:
      "baseline_rule_backtest",

    fee:0.001,

    ...result

  });
}

/* =========================================================
   Request
   ========================================================= */

async function handleRequest(
  request
){

  const url=
    new URL(
      request.url
    );

  if(
    request.method===
    "OPTIONS"
  ){

    return new Response(
      null,
      {
        status:204,
        headers:
          CORS_HEADERS
      }
    );
  }

  if(
    request.method!=="GET"
  ){

    return json(
      {
        status:"error",
        error:
          "Method Not Allowed"
      },
      405
    );
  }

  const path=
    url.pathname;

  try{

    if(path==="/"){

      return new Response(
        HTML,
        {
          headers:{
            ...CORS_HEADERS,
            "Content-Type":
              "text/html;charset=UTF-8"
          }
        }
      );
    }

    if(
      path===
      "/api/health"
    ){

      return json({

        status:"ok",

        service:
          "QuantVote",

        version:
          "v2-worker",

        source:
          "kraken",

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

    if(
      path===
      "/api/pairs"
    ){

      return await handlePairs(
        url
      );
    }

    if(
      path===
      "/api/market"
    ){

      return await handleMarket(
        url
      );
    }

    if(
      path===
      "/api/indicators"
    ){

      return await handleIndicators(
        url
      );
    }

    if(
      path===
      "/api/vote"
    ){

      return await handleVote(
        url
      );
    }

    if(
      path===
      "/api/multi"
    ){

      return await handleMulti(
        url
      );
    }

    if(
      path===
      "/api/regime"
    ){

      return await handleRegime(
        url
      );
    }

    if(
      path===
      "/api/backtest"
    ){

      return await handleBacktest(
        url
      );
    }

    return json(
      {
        status:"error",
        error:"Not Found"
      },
      404
    );

  }catch(error){

    return json(
      {
        status:"error",
        error:
          error instanceof Error
          ? error.message
          : String(error)
      },
      500
    );
  }
}

export default {

  async fetch(request){

    return handleRequest(
      request
    );
  }

};
