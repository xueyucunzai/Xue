
const API=(window.QV_API ?? "").replace(/\/$/,"");
const names={RSI:"RSI",MACD:"MACD",EMA:"EMA",KDJ:"KDJ",BOLL:"布林带"};
function weightPct(v){return `${Number(v).toFixed(1)}%`}
function signal(v){return v>0?"🟢 看涨":v<0?"🔴 看跌":"🟡 中性"}
function render(d){
 document.querySelector("#status").textContent=d.error?"● 数据异常":"● 实时刷新";
 document.querySelector("#price").textContent=d.price?`$${Number(d.price).toLocaleString()}`:"--";
 const fs=d.frames||{}, keys=["15m","1H","4H","1D"];
 const cards=document.querySelector("#cards");
 cards.innerHTML=keys.map(k=>{
   const x=fs[k]; if(!x)return "";
   const rows=Object.entries(x.votes).map(([n,v])=>`<div class="row"><span>${names[n]||n}</span><b>${signal(v)}</b><small>${weightPct((x.weights[n]||0)*100)} 权重</small></div>`).join("");
   return `<article class="card"><div class="ctop"><h2>${k}</h2><strong>${x.score}%</strong></div>
   <div class="bar"><i style="width:${x.score}%"></i></div>${rows}</article>`;
 }).join("");
 let weighted=0,total=0;
 keys.forEach(k=>{if(fs[k]){const w=k==="15m"?.1:.3; weighted+=fs[k].score*w; total+=w;}});
 const ov=total?weighted/total:50;
 document.querySelector("#overall").textContent=`${ov.toFixed(1)}% · ${ov>55?"🟢 偏多":ov<45?"🔴 偏空":"🟡 中性"}`;
 document.querySelector("#overallbar i").style.width=`${ov}%`;
 document.querySelector("#weights").innerHTML=Object.keys(names).map(n=>`<tr><td>${names[n]}</td>${keys.map(k=>`<td>${fs[k]?weightPct(fs[k].weights[n]*100):"--"}</td>`).join("")}</tr>`).join("");
}
async function refresh(){try{const r=await fetch(`${API}/api/market`);render(await r.json())}catch(e){document.querySelector("#status").textContent="● 后端未连接"}}
refresh();setInterval(refresh,2000);

async function runBacktest(){
 const interval=document.querySelector("#btInt").value;
 const days=document.querySelector("#btDays").value;
 const box=document.querySelector("#bt");
 box.innerHTML="<div>回测中…</div>";
 try{
   const r=await fetch(`${API}/api/backtest?interval=${interval}&days=${days}&fee_bps=10&slippage_bps=5`);
   const x=await r.json();
   if(x.error){box.innerHTML=`<div>错误：${x.error}</div>`;return}
   const items=[
    ["累计收益",`${x.total_return}%`],
    ["最大回撤",`-${x.max_drawdown}%`],
    ["Sharpe",x.sharpe],
    ["胜率",`${x.win_rate}%`],
    ["交易次数",x.trades]
   ];
   box.innerHTML=items.map(a=>`<div><span>${a[0]}</span><b>${a[1]}</b></div>`).join("");
 }catch(e){box.innerHTML="<div>无法连接后端</div>"}
}
document.querySelector("#runBt").addEventListener("click",runBacktest);

async function runCompare(){
 const i=document.querySelector("#mcInt").value,d=document.querySelector("#mcDays").value;
 const tb=document.querySelector("#mc"); tb.innerHTML="<tr><td colspan=6>模型计算中…</td></tr>";
 try{
  const r=await fetch(`${API}/api/model_compare?interval=${i}&days=${d}`),x=await r.json();
  if(x.error){tb.innerHTML=`<tr><td colspan=6>${x.error}</td></tr>`;return}
  tb.innerHTML=x.results.map(a=>`<tr><td>${a.strategy}</td><td>${a.total_return}%</td><td>-${a.max_drawdown}%</td><td>${a.sharpe}</td><td>${a.win_rate}%</td><td>${a.trades}</td></tr>`).join("");
 }catch(e){tb.innerHTML="<tr><td colspan=6>无法连接后端</td></tr>"}
}
document.querySelector("#runMc").addEventListener("click",runCompare);

async function runEnsemble(){
 const i=document.querySelector("#enInt").value,d=document.querySelector("#enDays").value;
 document.querySelector("#enResult .big").textContent="计算中…";
 try{
  const r=await fetch(`${API}/api/ensemble?interval=${i}&days=${d}`),x=await r.json();
  if(x.error){document.querySelector("#enResult .big").textContent=x.error;return}
  document.querySelector("#enResult .big").textContent=`${x.action} · ${x.ensemble_score}%`;
  document.querySelector("#enMeta").textContent=`动态权重基于最近 ${d} 天的滚动历史表现；这不是未来收益保证。`;
  const labels={indicator:"指标投票",xgb:"XGBoost",arima:"ARIMA"};
  document.querySelector("#enTable").innerHTML=["indicator","xgb","arima"].map(k=>{
   const pr=x.predictions[k]; const sig=pr>0?"🟢 看涨":pr<0?"🔴 看跌":"🟡 中性";
   return `<tr><td>${labels[k]}</td><td>${x.accuracy[k]}%</td><td>${sig}</td><td>${(x.weights[k]*100).toFixed(1)}%</td></tr>`
  }).join("");
 }catch(e){document.querySelector("#enResult .big").textContent="无法连接后端"}
}
document.querySelector("#runEn").addEventListener("click",runEnsemble);

async function runLab(){
 const i=document.querySelector("#labInt").value,d=document.querySelector("#labDays").value;
 document.querySelector("#labSummary").innerHTML="<div>实验计算中…</div>";
 try{
  const r=await fetch(`${API}/api/research_lab?interval=${i}&days=${d}`),x=await r.json();
  if(x.error){document.querySelector("#labSummary").innerHTML=`<div>${x.error}</div>`;return}
  const a=[
   ["训练样本",x.split.train],["验证样本",x.split.validation],["测试样本",x.split.test],
   ["最佳阈值",x.selected_threshold],["测试收益",x.test.return+"%"],["Buy & Hold",x.buy_hold_test.return+"%"]
  ];
  document.querySelector("#labSummary").innerHTML=a.map(v=>`<div><span>${v[0]}</span><b>${v[1]}</b></div>`).join("");
  document.querySelector("#costs").innerHTML=x.cost_sensitivity.map(v=>`<tr><td>${v.fee_bps} + ${v.slippage_bps} bps</td><td>${v.return}%</td><td>-${v.max_drawdown}%</td><td>${v.trades}</td></tr>`).join("");
 }catch(e){document.querySelector("#labSummary").innerHTML="<div>无法连接后端</div>"}
}
document.querySelector("#runLab").addEventListener("click",runLab);

async function runOptimizer(){
 const i=document.querySelector("#opInt").value,d=document.querySelector("#opDays").value;
 document.querySelector("#opScore .big").textContent="优化中…";
 try{
  const r=await fetch(`${API}/api/optimizer?interval=${i}&days=${d}`),x=await r.json();
  if(x.error){document.querySelector("#opScore .big").textContent=x.error;return}
  document.querySelector("#opScore .big").textContent=`稳健性评分 ${x.robustness_score}/100`;
  document.querySelector("#opScore .sub").textContent=`最佳阈值 ${x.chosen.threshold} · 测试收益 ${x.test.return}% · Buy & Hold ${x.buy_hold.return}%`;
  document.querySelector("#opTable").innerHTML=x.top_candidates.map(a=>`<tr><td>${a.threshold}</td><td>${a.train}%</td><td>${a.valid}%</td><td>-${a.valid_dd}%</td><td>${a.selection_score}</td></tr>`).join("");
  document.querySelector("#opTest").textContent=`成本压力测试：${x.cost_sensitivity.filter(v=>v.return>0).length}/${x.cost_sensitivity.length} 个成本场景仍保持正收益。`;
 }catch(e){document.querySelector("#opScore .big").textContent="无法连接后端"}
}
document.querySelector("#runOp").addEventListener("click",runOptimizer);


function pct(v) {
  return (Number(v) * 100).toFixed(2) + "%";
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return {ctx, w: rect.width, h: rect.height};
}

function drawSeries(canvas, points, trades) {
  const {ctx, w, h} = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!points.length) return;

  const pad = {l: 52, r: 18, t: 18, b: 30};
  const xs = points.map((_, i) => i);
  const prices = points.map(p => p.price);
  const eq = points.map(p => p.equity);
  const bh = points.map(p => p.buy_hold);

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const erMin = Math.min(...eq, ...bh);
  const erMax = Math.max(...eq, ...bh);
  const x = i => pad.l + i * (w-pad.l-pad.r) / Math.max(1, points.length-1);
  const yPrice = v => pad.t + (max-v) * (h-pad.t-pad.b) / Math.max(1e-12, max-min);
  const yEq = v => pad.t + (erMax-v) * (h-pad.t-pad.b) / Math.max(1e-12, erMax-erMin);

  ctx.font = "12px sans-serif";
  ctx.strokeStyle = "rgba(128,128,128,.22)";
  ctx.fillStyle = "rgba(128,128,128,.75)";
  for (let k=0;k<5;k++) {
    const yy = pad.t + k*(h-pad.t-pad.b)/4;
    ctx.beginPath(); ctx.moveTo(pad.l,yy); ctx.lineTo(w-pad.r,yy); ctx.stroke();
  }

  function line(vals, fn, width) {
    ctx.lineWidth = width;
    ctx.beginPath();
    vals.forEach((v,i) => {
      const xx=x(i), yy=fn(v);
      if(i===0) ctx.moveTo(xx,yy); else ctx.lineTo(xx,yy);
    });
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(80,150,220,.95)";
  line(prices, yPrice, 1.8);
  ctx.strokeStyle = "rgba(80,200,130,.95)";
  line(eq, yEq, 2.2);
  ctx.strokeStyle = "rgba(220,170,70,.95)";
  line(bh, yEq, 1.8);

  // Trade markers.
  trades.forEach(t => {
    let nearest = 0;
    let best = Infinity;
    points.forEach((p,i) => {
      const d = Math.abs(p.time - t.time);
      if(d < best) {best=d; nearest=i;}
    });
    const xx=x(nearest), yy=yPrice(t.price);
    ctx.beginPath();
    if(t.position === 1) {
      ctx.moveTo(xx, yy-8); ctx.lineTo(xx-5, yy+4); ctx.lineTo(xx+5, yy+4);
    } else {
      ctx.moveTo(xx, yy+8); ctx.lineTo(xx-5, yy-4); ctx.lineTo(xx+5, yy-4);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(230,230,230,.95)";
    ctx.fill();
  });

  ctx.fillStyle = "rgba(128,128,128,.8)";
  ctx.fillText("价格", 8, 16);
  ctx.fillText("策略/基准", 8, h-8);
}

function drawDrawdown(canvas, points) {
  const {ctx, w, h} = setupCanvas(canvas);
  ctx.clearRect(0,0,w,h);
  if(!points.length) return;
  const pad={l:52,r:18,t:14,b:24};
  const maxDD=Math.max(0.001,...points.map(p=>p.drawdown));
  const x=i=>pad.l+i*(w-pad.l-pad.r)/Math.max(1,points.length-1);
  const y=v=>pad.t+v*(h-pad.t-pad.b)/maxDD;

  ctx.strokeStyle="rgba(128,128,128,.22)";
  ctx.beginPath(); ctx.moveTo(pad.l,pad.t); ctx.lineTo(w-pad.r,pad.t); ctx.stroke();

  ctx.beginPath();
  points.forEach((p,i)=>{
    const xx=x(i), yy=y(p.drawdown);
    if(i===0) ctx.moveTo(xx,yy); else ctx.lineTo(xx,yy);
  });
  ctx.lineTo(x(points.length-1),h-pad.b);
  ctx.lineTo(x(0),h-pad.b);
  ctx.closePath();
  ctx.fillStyle="rgba(210,90,90,.20)";
  ctx.fill();

  ctx.strokeStyle="rgba(210,90,90,.95)";
  ctx.lineWidth=1.8;
  ctx.beginPath();
  points.forEach((p,i)=>{
    const xx=x(i), yy=y(p.drawdown);
    if(i===0) ctx.moveTo(xx,yy); else ctx.lineTo(xx,yy);
  });
  ctx.stroke();

  ctx.fillStyle="rgba(128,128,128,.8)";
  ctx.font="12px sans-serif";
  ctx.fillText("回撤", 8, 16);
}

async function loadBacktestChart() {
  const interval = document.getElementById("chartInterval").value;
  const days = document.getElementById("chartDays").value;
  const status = document.getElementById("chartStatus");
  status.textContent = "正在计算回测…";
  try {
    const r = await fetch(`${API}/api/backtest_chart?interval=${interval}&days=${days}&threshold=0.05`);
    const d = await r.json();
    const st = d.stats || {};
    document.getElementById("chartReturn").textContent = pct(st.return || 0);
    document.getElementById("chartBH").textContent = pct(st.buy_hold || 0);
    document.getElementById("chartDD").textContent = pct(st.max_drawdown || 0);
    document.getElementById("chartSharpe").textContent = Number(st.sharpe || 0).toFixed(2);
    document.getElementById("chartTrades").textContent = st.trades ?? 0;
    document.getElementById("chartWinRate").textContent = pct(st.win_rate || 0);

    drawSeries(document.getElementById("equityCanvas"), d.points || [], d.trades || []);
    drawDrawdown(document.getElementById("drawdownCanvas"), d.points || []);
    status.textContent = `已加载 ${interval} / ${days}天；买卖点基于历史指标信号。`;
  } catch (e) {
    status.textContent = "回测加载失败：" + e.message;
  }
}

window.addEventListener("resize", () => {
  const btn = document.getElementById("loadChartBtn");
  if (btn && window.__chartData) {
    drawSeries(document.getElementById("equityCanvas"), window.__chartData.points, window.__chartData.trades);
    drawDrawdown(document.getElementById("drawdownCanvas"), window.__chartData.points);
  }
});

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("loadChartBtn");
  if (btn) {
    btn.addEventListener("click", loadBacktestChart);
    loadBacktestChart();
  }
});


let auditData = [];

function fmt(v, digits=2) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : "-";
}

function auditTime(ms) {
  return new Date(Number(ms)).toLocaleString();
}

function voteLabel(v) {
  return v > 0 ? "看涨" : (v < 0 ? "看跌" : "中性");
}

function renderAuditDetail(t) {
  const detail = document.getElementById("auditDetail");
  if (!t) {
    detail.innerHTML = '<div class="muted">点击左侧交易查看详细信号</div>';
    return;
  }

  const rows = Object.entries(t.indicators).map(([k,v]) =>
    `<tr><td>${k}</td><td>${fmt(v, k === "RSI" ? 2 : 4)}</td></tr>`
  ).join("");

  const votes = Object.entries(t.votes).map(([k,v]) =>
    `<span class="vote-chip">${k}: ${voteLabel(v)}</span>`
  ).join("");

  const weights = Object.entries(t.weights).map(([k,v]) =>
    `<span class="weight-chip">${k} ${fmt(v*100,1)}%</span>`
  ).join("");

  detail.innerHTML = `
    <div class="audit-title">
      <strong>${t.action}</strong>
      <span>${auditTime(t.time)}</span>
    </div>
    <div class="audit-summary">
      <div><span>价格</span><b>${fmt(t.price,2)}</b></div>
      <div><span>综合评分</span><b>${fmt(t.score,4)}</b></div>
      <div><span>加权评分</span><b>${fmt(t.weighted_score,4)}</b></div>
      <div><span>下一根K线</span><b>${fmt(t.next_bar_return*100,2)}%</b></div>
    </div>
    <h4>指标原始值</h4>
    <table class="audit-table"><tbody>${rows}</tbody></table>
    <h4>指标投票</h4>
    <div class="chip-row">${votes}</div>
    <h4>当时权重</h4>
    <div class="chip-row">${weights}</div>
    <div class="audit-note">
      成本假设：手续费 ${(0.0004*100).toFixed(2)}% + 滑点 ${(0.0002*100).toFixed(2)}%。
      “下一根K线”仅用于历史复盘，不参与当时信号计算。
    </div>
  `;
}

function renderAuditList() {
  const box = document.getElementById("auditList");
  if (!auditData.length) {
    box.innerHTML = '<div class="muted">这个区间没有产生信号切换。</div>';
    return;
  }
  box.innerHTML = auditData.map((t,i) => `
    <button class="audit-item" data-i="${i}">
      <span class="audit-action">${t.action}</span>
      <span>${auditTime(t.time)}</span>
      <span>${fmt(t.price,2)}</span>
      <span>评分 ${fmt(t.score,3)}</span>
    </button>
  `).join("");
  box.querySelectorAll(".audit-item").forEach(btn => {
    btn.addEventListener("click", () => {
      box.querySelectorAll(".audit-item").forEach(x => x.classList.remove("active"));
      btn.classList.add("active");
      renderAuditDetail(auditData[Number(btn.dataset.i)]);
    });
  });
}

async function loadTradeAudit() {
  const interval = document.getElementById("chartInterval")?.value || "1h";
  const days = document.getElementById("chartDays")?.value || "90";
  try {
    const r = await fetch(`${API}/api/trade_audit?interval=${interval}&days=${days}&threshold=0.05`);
    const d = await r.json();
    auditData = d.trades || [];
    renderAuditList();
    renderAuditDetail(auditData[0]);
  } catch (e) {
    document.getElementById("auditList").innerHTML =
      `<div class="muted">交易审计加载失败：${e.message}</div>`;
  }
}

const oldLoadChart = loadBacktestChart;
loadBacktestChart = async function() {
  await oldLoadChart();
  await loadTradeAudit();
};


let ensembleAuditData = [];

function scoreClass(v) {
  return Number(v) > 0 ? "score-positive" : (Number(v) < 0 ? "score-negative" : "");
}

function renderEnsembleDetail(t) {
  const box = document.getElementById("ensembleAuditDetail");
  if (!t) {
    box.innerHTML = '<div class="muted">点击左侧交易查看模型决策</div>';
    return;
  }
  const id = t.indicator_detail || {};
  box.innerHTML = `
    <div class="audit-title">
      <strong>${t.action} · ${t.agreement}</strong>
      <span>${auditTime(t.time)}</span>
    </div>
    <div class="model-score-grid">
      <div><span>技术指标</span><b class="${scoreClass(t.indicator_score)}">${fmt(t.indicator_score,3)}</b><small>权重 ${fmt(t.model_weights.indicators*100,0)}%</small></div>
      <div><span>XGBoost</span><b class="${scoreClass(t.xgb_score)}">${fmt(t.xgb_score,3)}</b><small>上涨评分 ${fmt(t.xgb_up_score*100,1)}</small></div>
      <div><span>ARIMA</span><b class="${scoreClass(t.arima_score)}">${fmt(t.arima_score,3)}</b><small>预测收益 ${fmt(t.arima_return_forecast*100,3)}%</small></div>
      <div><span>Ensemble</span><b class="${scoreClass(t.ensemble_score)}">${fmt(t.ensemble_score,3)}</b><small>最终：${t.direction}</small></div>
    </div>
    <h4>指标证据</h4>
    <table class="audit-table"><tbody>
      <tr><td>RSI</td><td>${fmt(id.RSI,2)}</td></tr>
      <tr><td>EMA 差距</td><td>${fmt(id.EMA_gap_pct,3)}%</td></tr>
      <tr><td>MACD 差距</td><td>${fmt(id.MACD_gap,5)}</td></tr>
      <tr><td>K / D</td><td>${fmt(id.K,2)} / ${fmt(id.D,2)}</td></tr>
      <tr><td>布林位置</td><td>${fmt(id.BB_position,3)}</td></tr>
    </tbody></table>
    <div class="audit-summary" style="margin-top:12px">
      <div><span>价格</span><b>${fmt(t.price,2)}</b></div>
      <div><span>下一根K线</span><b>${fmt(t.next_bar_return*100,2)}%</b></div>
    </div>
    <div class="audit-note">
      模型分数用于比较方向与强弱，不代表真实概率；三个模型均只使用当时及更早的数据。
    </div>
  `;
}

function renderEnsembleList() {
  const box = document.getElementById("ensembleAuditList");
  if (!ensembleAuditData.length) {
    box.innerHTML = '<div class="muted">没有模型信号切换。</div>';
    return;
  }
  box.innerHTML = ensembleAuditData.map((t,i) => `
    <button class="audit-item" data-ei="${i}">
      <span class="audit-action">${t.action} · ${t.agreement}</span>
      <span>${auditTime(t.time)}</span>
      <span>Ensemble ${fmt(t.ensemble_score,3)}</span>
    </button>
  `).join("");
  box.querySelectorAll(".audit-item").forEach(btn => {
    btn.addEventListener("click", () => {
      box.querySelectorAll(".audit-item").forEach(x => x.classList.remove("active"));
      btn.classList.add("active");
      renderEnsembleDetail(ensembleAuditData[Number(btn.dataset.ei)]);
    });
  });
}

async function loadEnsembleAudit() {
  const interval = document.getElementById("chartInterval")?.value || "1h";
  const days = document.getElementById("chartDays")?.value || "90";
  const status = document.getElementById("modelStatus");
  try {
    const r = await fetch(`${API}/api/ensemble_audit?interval=${interval}&days=${days}&threshold=0.05`);
    const d = await r.json();
    ensembleAuditData = d.trades || [];
    const ms = d.model_status || {};
    status.textContent = `XGBoost: ${ms.xgboost ? "可用" : "不可用"} · ARIMA: ${ms.arima ? "可用" : "不可用"} · 权重：指标 40% / XGBoost 35% / ARIMA 25%`;
    renderEnsembleList();
    renderEnsembleDetail(ensembleAuditData[0]);
  } catch(e) {
    status.textContent = "模型审计加载失败：" + e.message;
  }
}

const oldLoadAudit = loadTradeAudit;
loadTradeAudit = async function() {
  await oldLoadAudit();
  await loadEnsembleAudit();
};


async function loadAdaptiveWeights() {
  const btn=document.getElementById("loadAdaptiveBtn");
  btn.disabled=true; btn.textContent="计算中…";
  try {
    const interval=document.getElementById("chartInterval")?.value||"1h";
    const days=document.getElementById("chartDays")?.value||"90";
    const r=await fetch(`${API}/api/adaptive_ensemble?interval=${interval}&days=${days}&threshold=0.05`);
    const d=await r.json();
    const w=d.chosen_weights||{};
    document.getElementById("awInd").textContent=fmt(w.indicators*100,1)+"%";
    document.getElementById("awXgb").textContent=fmt(w.xgboost*100,1)+"%";
    document.getElementById("awArima").textContent=fmt(w.arima*100,1)+"%";
    document.getElementById("awReturn").textContent=pct(d.test?.return||0);
    document.getElementById("awDD").textContent=pct(d.test?.max_drawdown||0);
    document.getElementById("awTrades").textContent=d.test?.trades??0;

    const rows=d.validation_top||[];
    document.getElementById("adaptiveRanking").innerHTML=rows.map((x,i)=>`
      <div class="ranking-row">
        <b>#${i+1}</b>
        指标 ${fmt(x.weights.indicators*100,0)}% /
        XGB ${fmt(x.weights.xgboost*100,0)}% /
        ARIMA ${fmt(x.weights.arima*100,0)}%
        · 目标 ${fmt(x.objective,5)}
        · 胜率 ${pct(x.win_rate)}
      </div>`).join("");
  } catch(e) {
    document.getElementById("adaptiveRanking").textContent="优化失败："+e.message;
  } finally {
    btn.disabled=false; btn.textContent="运行权重优化";
  }
}
document.addEventListener("DOMContentLoaded",()=>{
  const b=document.getElementById("loadAdaptiveBtn");
  if(b) b.addEventListener("click",loadAdaptiveWeights);
});


async function loadRegime() {
  const interval=document.getElementById("chartInterval")?.value||"1h";
  const days=document.getElementById("chartDays")?.value||"90";
  try {
    const [r1,r2]=await Promise.all([
      fetch(`${API}/api/regime?interval=${interval}&days=${days}`),
      fetch(`${API}/api/regime_ensemble?interval=${interval}&days=${days}`)
    ]);
    const d=await r1.json(), e=await r2.json();
    const cur=d.current||{};
    document.getElementById("regimeNow").textContent=cur.regime||"-";
    document.getElementById("regimeTrend").textContent=fmt(cur.trend_strength,2);
    document.getElementById("regimeVol").textContent=pct(cur.volatility||0);
    document.getElementById("regimeMom").textContent=pct(cur.momentum_20||0);

    document.getElementById("regimeDistribution").innerHTML=
      Object.entries(d.distribution||{}).map(([k,v])=>
        `<span class="vote-chip">${k}: ${v.bars}根 / ${pct(v.pct)}</span>`).join("");

    document.getElementById("regimeWeights").innerHTML=
      Object.entries(e.regime_weights||{}).map(([k,v])=>
        `<div class="ranking-row"><b>${k}</b> · 指标 ${fmt(v.indicators*100,0)}% · XGB ${fmt(v.xgboost*100,0)}% · ARIMA ${fmt(v.arima*100,0)}%</div>`).join("");

    document.getElementById("regimeReturn").textContent=pct(e.test?.return||0);
    document.getElementById("regimeBH").textContent=pct(e.test?.buy_hold||0);
    document.getElementById("regimeDD").textContent=pct(e.test?.max_drawdown||0);
    document.getElementById("regimeTrades").textContent=e.test?.trades??0;
  } catch(err) {
    document.getElementById("regimeNow").textContent="加载失败";
  }
}

document.addEventListener("DOMContentLoaded",()=>{
  const b=document.getElementById("loadRegimeBtn");
  if(b) { b.addEventListener("click",loadRegime); loadRegime(); }
});


async function runWalkForwardOptimization() {
  const btn=document.getElementById("runWalkForward");
  btn.disabled=true; btn.textContent="优化中…";
  try {
    const interval=document.getElementById("chartInterval")?.value||"1h";
    const days=Math.max(90, Number(document.getElementById("chartDays")?.value||90));
    const r=await fetch(`${API}/api/walkforward_opt?interval=${interval}&days=${days}`);
    const d=await r.json();
    const ch=d.chosen||{};
    const vr=(d.validation_ranking||[]).find(x=>x.name===ch.name)||{};
    document.getElementById("wfChosen").textContent=ch.name||"-";
    document.getElementById("wfValid").textContent=pct(vr.avg_validation_return||0);
    document.getElementById("wfWin").textContent=pct(vr.avg_validation_win_rate||0);
    document.getElementById("wfTest").textContent=pct(d.test?.return||0);
    document.getElementById("wfTestWin").textContent=pct(d.test?.win_rate||0);
    document.getElementById("wfTrades").textContent=d.test?.trades??0;
    document.getElementById("wfRanking").innerHTML=(d.validation_ranking||[]).map((x,i)=>
      `<div class="ranking-row"><b>#${i+1} ${x.name}</b> · 验证收益 ${pct(x.avg_validation_return)} · 胜率 ${pct(x.avg_validation_win_rate)} · 波动范围 ${pct(x.fold_spread)} · 目标 ${fmt(x.objective,5)}</div>`
    ).join("");
  } catch(e) {
    document.getElementById("wfChosen").textContent="失败";
  } finally {
    btn.disabled=false; btn.textContent="运行优化";
  }
}
document.addEventListener("DOMContentLoaded",()=>{
  const b=document.getElementById("runWalkForward");
  if(b) b.addEventListener("click",runWalkForwardOptimization);
});


async function runHealthCheck(){
  const b=document.getElementById("runHealthCheck");
  b.disabled=true; b.textContent="体检中…";
  try{
    const interval=document.getElementById("chartInterval")?.value||"1h";
    const days=Math.max(90,Number(document.getElementById("chartDays")?.value||180));
    const r=await fetch(`${API}/api/health_check?interval=${interval}&days=${days}`);
    const d=await r.json();
    const o=d.overall||{};
    document.getElementById("hcScore").textContent=d.stability_score??"-";
    document.getElementById("hcReturn").textContent=pct(o.return||0);
    document.getElementById("hcMdd").textContent=pct(o.max_drawdown||0);
    document.getElementById("hcSharpe").textContent=fmt(o.sharpe_proxy||0,2);
    document.getElementById("hcTrades").textContent=o.trades??0;
    document.getElementById("hcCost").textContent=pct((d.cost_sensitivity||[]).at(-1)?.return||0);
    document.getElementById("hcFlags").innerHTML=(d.diagnostics||[]).map(x=>`<div>• ${x}</div>`).join("");
    document.getElementById("hcPeriods").innerHTML=Object.entries(d.periods||{}).map(([k,x])=>
      `<div>${k}: 收益 ${pct(x.return)} · B&H ${pct(x.buy_hold)} · 回撤 ${pct(x.max_drawdown)} · 交易 ${x.trades}</div>`).join("");
    document.getElementById("hcCosts").innerHTML=(d.cost_sensitivity||[]).map(x=>
      `<div>手续费 ${(x.fee*100).toFixed(2)}%: 收益 ${pct(x.return)} · 回撤 ${pct(x.max_drawdown)}</div>`).join("");
    document.getElementById("hcSensitivity").innerHTML=(d.parameter_sensitivity||[]).map(x=>
      `<span style="display:inline-block;margin:3px 8px 3px 0">阈值 ${x.threshold}: ${pct(x.return)}</span>`).join("");
  }catch(e){document.getElementById("hcScore").textContent="失败";}
  finally{b.disabled=false;b.textContent="开始体检";}
}
document.addEventListener("DOMContentLoaded",()=>{
  const b=document.getElementById("runHealthCheck");
  if(b)b.addEventListener("click",runHealthCheck);
});


async function runAdaptiveV2(){
  const b=document.getElementById("runAdaptiveV2");
  if(!b)return;
  b.disabled=true; b.textContent="计算中…";
  try{
    const r=await fetch(`${API}/api/adaptive_ensemble_v2?days=60&threshold=0.08`);
    const d=await r.json();
    if(d.error){ throw new Error(d.error); }
    document.getElementById("a2Action").textContent=d.action||"-";
    document.getElementById("a2Score").textContent=fmt(d.final_score,4);
    document.getElementById("a2Confidence").textContent=fmt(d.confidence,2)+"%";
    document.getElementById("a2Periods").innerHTML=Object.entries(d.timeframe_weights||{}).map(([k,v])=>
      `<span class="vote-chip">${k}: ${fmt(v*100,1)}%</span>`).join("");
    document.getElementById("a2Models").innerHTML=Object.entries(d.timeframes||{}).map(([k,x])=>{
      if(x.status!=="ok") return `<div class="ranking-row"><b>${k}</b> · ${x.status||"error"}</div>`;
      const w=x.model_weights||{}, p=x.predictions||{};
      return `<div class="ranking-row"><b>${k}</b> · 指标 ${fmt((w.indicator||0)*100,1)}% / XGB ${fmt((w.xgb||0)*100,1)}% / ARIMA ${fmt((w.arima||0)*100,1)}% · 当前 ${p.indicator>0?"L":p.indicator<0?"S":"W"}/${p.xgb>0?"L":p.xgb<0?"S":"W"}/${p.arima>0?"L":p.arima<0?"S":"W"}</div>`;
    }).join("");
  }catch(e){
    document.getElementById("a2Action").textContent="失败";
    document.getElementById("a2Models").textContent=e.message;
  }finally{ b.disabled=false; b.textContent="运行 Adaptive 2.0"; }
}

document.addEventListener("DOMContentLoaded",()=>{
  const b=document.getElementById("runAdaptiveV2");
  if(b)b.addEventListener("click",runAdaptiveV2);
});
