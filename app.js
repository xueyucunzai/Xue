const API = (window.QV_API || "https://xue.xilongy41-8bd.workers.dev").replace(/\/$/, "");

const state = {
  symbol: "BTCUSD",
  data: null,
  loading: false
};

const $ = id => document.getElementById(id);

function fmtNumber(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "--";

  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function fmtPrice(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return "--";

  if (n >= 1000) {
    return "$" + fmtNumber(n, 2);
  }

  return "$" + fmtNumber(n, 4);
}

function fmtPercent(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return "--";

  return n.toFixed(2) + "%";
}

function fmtTime(timestamp) {
  if (!timestamp) return "--";

  const date = new Date(Number(timestamp) * 1000);

  if (Number.isNaN(date.getTime())) return "--";

  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function voteText(vote) {
  if (vote === "bullish") return "🟢 看涨";
  if (vote === "bearish") return "🔴 看跌";
  return "🟡 中性";
}

function riskText(risk) {
  if (risk === "high") return "🔴 高";
  if (risk === "medium") return "🟠 中";
  return "🟢 低";
}

function trendText(trend) {
  const map = {
    strong_bullish: "强多头",
    bullish: "偏多",
    mixed: "混合",
    bearish: "偏空",
    strong_bearish: "强空头"
  };

  return map[trend] || "未知";
}

function safe(value, digits = 2) {
  return Number.isFinite(Number(value))
    ? fmtNumber(value, digits)
    : "--";
}

function setStatus(text, ok = true) {
  const el = $("status");

  if (!el) return;

  el.textContent = text;
  el.dataset.status = ok ? "ok" : "error";
}

async function api(path) {
  const response = await fetch(API + path, {
    method: "GET",
    cache: "no-store"
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `API 返回的不是 JSON：${text.slice(0, 200)}`
    );
  }

  if (!response.ok || data.status === "error") {
    throw new Error(
      data.error || `HTTP ${response.status}`
    );
  }

  return data;
}

function findOrCreate(id, parent) {
  let el = $(id);

  if (el) return el;

  el = document.createElement("div");
  el.id = id;

  if (parent) {
    parent.appendChild(el);
  }

  return el;
}

function card(title, content, className = "") {
  return `
    <section class="qv-card ${className}">
      <div class="qv-card-title">${title}</div>
      <div class="qv-card-content">${content}</div>
    </section>
  `;
}

function renderHero(data) {
  const priceEl = $("price");
  const price2El = $("heroPrice");
  const updateEl = $("updateTime");

  if (priceEl) {
    priceEl.textContent = fmtPrice(data.price);
  }

  if (price2El) {
    price2El.textContent = fmtPrice(data.price);
  }

  if (updateEl) {
    updateEl.textContent =
      "数据时间：" + fmtTime(data.timestamp);
  }
}

function renderMainVote(data) {
  const vote = data.vote;
  const score = data.score;
  const maxScore = data.maxScore || 7;

  const voteEl = $("vote");
  const scoreEl = $("score");
  const riskEl = $("risk");

  if (voteEl) {
    voteEl.textContent = voteText(vote);
  }

  if (scoreEl) {
    scoreEl.textContent =
      `${score} / ${maxScore}`;
  }

  if (riskEl) {
    riskEl.textContent =
      riskText(data.risk);
  }
}

function renderIndicators(data) {
  const i = data.indicators || {};

  const html = `
    <div class="qv-indicator-grid">

      <div class="qv-indicator">
        <span>EMA20</span>
        <strong>${fmtPrice(i.ema20)}</strong>
      </div>

      <div class="qv-indicator">
        <span>EMA50</span>
        <strong>${fmtPrice(i.ema50)}</strong>
      </div>

      <div class="qv-indicator">
        <span>EMA200</span>
        <strong>${fmtPrice(i.ema200)}</strong>
      </div>

      <div class="qv-indicator">
        <span>RSI14</span>
        <strong>${safe(i.rsi14, 2)}</strong>
      </div>

      <div class="qv-indicator">
        <span>MACD</span>
        <strong>${safe(i.macd, 2)}</strong>
      </div>

      <div class="qv-indicator">
        <span>MACD Histogram</span>
        <strong>${safe(i.macdHistogram, 2)}</strong>
      </div>

      <div class="qv-indicator">
        <span>K</span>
        <strong>${safe(i.k, 2)}</strong>
      </div>

      <div class="qv-indicator">
        <span>D</span>
        <strong>${safe(i.d, 2)}</strong>
      </div>

      <div class="qv-indicator">
        <span>J</span>
        <strong>${safe(i.j, 2)}</strong>
      </div>

      <div class="qv-indicator">
        <span>布林上轨</span>
        <strong>${fmtPrice(i.bollUpper)}</strong>
      </div>

      <div class="qv-indicator">
        <span>布林中轨</span>
        <strong>${fmtPrice(i.bollMiddle)}</strong>
      </div>

      <div class="qv-indicator">
        <span>布林下轨</span>
        <strong>${fmtPrice(i.bollLower)}</strong>
      </div>

      <div class="qv-indicator">
        <span>ATR14</span>
        <strong>${fmtPrice(i.atr14)}</strong>
      </div>

      <div class="qv-indicator">
        <span>ATR%</span>
        <strong>${fmtPercent(i.atrPercent)}</strong>
      </div>

      <div class="qv-indicator">
        <span>成交量比</span>
        <strong>${safe(i.volumeRatio, 2)}x</strong>
      </div>

      <div class="qv-indicator">
        <span>市场结构</span>
        <strong>${trendText(i.trend)}</strong>
      </div>

    </div>
  `;

  const container =
    $("indicators") ||
    $("indicatorPanel") ||
    $("indicatorGrid");

  if (container) {
    container.innerHTML = html;
  } else {
    const section = document.createElement("section");

    section.id = "qvIndicatorsAuto";

    section.innerHTML =
      card("技术指标", html);

    document.querySelector("main")?.appendChild(section);
  }
}

function renderReasons(data) {
  const reasons = Array.isArray(data.reasons)
    ? data.reasons
    : [];

  const html = reasons.length
    ? reasons.map(
        reason => `<li>${escapeHtml(reason)}</li>`
      ).join("")
    : "<li>暂无解释</li>";

  const content = `
    <ul class="qv-reasons">
      ${html}
    </ul>
  `;

  const container =
    $("reasons") ||
    $("analysis") ||
    $("interpretation");

  if (container) {
    container.innerHTML = content;
  } else {
    const section = document.createElement("section");

    section.id = "qvReasonsAuto";

    section.innerHTML =
      card("QuantVote 判断依据", content);

    document.querySelector("main")?.appendChild(section);
  }
}

function renderRisk(data) {
  const r = data.riskDetail || {};

  const html = `
    <div class="qv-risk-grid">

      <div>
        <span>风险等级</span>
        <strong>${riskText(data.risk)}</strong>
      </div>

      <div>
        <span>ATR%</span>
        <strong>${fmtPercent(r.atrPercent)}</strong>
      </div>

      <div>
        <span>布林带宽度</span>
        <strong>${fmtPercent(r.bollWidth)}</strong>
      </div>

      <div>
        <span>风险分数</span>
        <strong>${safe(r.score, 0)}</strong>
      </div>

    </div>
  `;

  const container = $("riskPanel");

  if (container) {
    container.innerHTML = html;
  }
}

function renderMultiTimeframe(data) {
  const list = data.timeframes || [];

  const html = list.map(item => {

    if (item.status !== "ok") {
      return `
        <div class="qv-timeframe">
          <div class="qv-timeframe-head">
            <strong>${item.timeframe}</strong>
          </div>
          <div class="qv-error">
            ${escapeHtml(item.error || "数据获取失败")}
          </div>
        </div>
      `;
    }

    const i = item.indicators || {};

    return `
      <div class="qv-timeframe">

        <div class="qv-timeframe-head">
          <strong>${item.timeframe}</strong>
          <span>${voteText(item.vote)}</span>
        </div>

        <div class="qv-timeframe-price">
          ${fmtPrice(item.price)}
        </div>

        <div class="qv-timeframe-score">
          Score：
          <strong>
            ${item.score}
          </strong>
          / ${item.maxScore}
        </div>

        <div class="qv-timeframe-meta">
          <span>
            RSI ${safe(i.rsi14, 1)}
          </span>

          <span>
            EMA20 ${fmtPrice(i.ema20)}
          </span>

          <span>
            风险 ${riskText(item.risk)}
          </span>
        </div>

        <div class="qv-timeframe-trend">
          ${trendText(i.trend)}
        </div>

      </div>
    `;
  }).join("");

  const summary = data.summary || {};

  const summaryHtml = `
    <div class="qv-multi-summary">

      <div>
        <span>多周期平均分</span>
        <strong>
          ${safe(summary.averageScore, 2)}
        </strong>
      </div>

      <div>
        <span>综合判断</span>
        <strong>
          ${voteText(summary.overallVote)}
        </strong>
      </div>

    </div>
  `;

  const content =
    summaryHtml +
    `<div class="qv-timeframe-grid">${html}</div>`;

  const container =
    $("multiTimeframe") ||
    $("timeframes") ||
    $("multi");

  if (container) {
    container.innerHTML = content;
  } else {
    const section = document.createElement("section");

    section.id = "qvMultiAuto";

    section.innerHTML =
      card("多周期综合", content);

    document.querySelector("main")?.appendChild(section);
  }
}

function renderMethodology(data) {
  const m = data.methodology || {};

  const html = `
    <div class="qv-methodology">

      <div>
        <strong>${escapeHtml(m.name || "QuantVote")}</strong>
      </div>

      <div>
        ${escapeHtml(m.scoring || "")}
      </div>

      <div class="qv-note">
        ${escapeHtml(m.note || "")}
      </div>

    </div>
  `;

  const container = $("methodology");

  if (container) {
    container.innerHTML = html;
  }
}

function renderHealth(data) {
  const source =
    $("dataSource") ||
    $("source");

  if (source) {
    source.textContent =
      `数据源：${data.source || "Kraken"}`;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function injectMinimalStyles() {
  if ($("qvRuntimeStyles")) return;

  const style = document.createElement("style");

  style.id = "qvRuntimeStyles";

  style.textContent = `
    .qv-card {
      margin: 16px 0;
      padding: 18px;
      border-radius: 14px;
      border: 1px solid rgba(128,128,128,.25);
      background: rgba(128,128,128,.06);
    }

    .qv-card-title {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 14px;
    }

    .qv-indicator-grid {
      display: grid;
      grid-template-columns:
        repeat(auto-fit, minmax(130px, 1fr));
      gap: 10px;
    }

    .qv-indicator {
      padding: 12px;
      border-radius: 10px;
      background: rgba(128,128,128,.08);
    }

    .qv-indicator span,
    .qv-risk-grid span,
    .qv-multi-summary span {
      display: block;
      font-size: 12px;
      opacity: .7;
      margin-bottom: 5px;
    }

    .qv-indicator strong {
      font-size: 15px;
    }

    .qv-reasons {
      margin: 0;
      padding-left: 20px;
    }

    .qv-reasons li {
      margin: 8px 0;
      line-height: 1.5;
    }

    .qv-risk-grid {
      display: grid;
      grid-template-columns:
        repeat(auto-fit, minmax(130px, 1fr));
      gap: 12px;
    }

    .qv-risk-grid > div,
    .qv-multi-summary > div {
      padding: 12px;
      border-radius: 10px;
      background: rgba(128,128,128,.08);
    }

    .qv-multi-summary {
      display: grid;
      grid-template-columns:
        repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 14px;
    }

    .qv-timeframe-grid {
      display: grid;
      grid-template-columns:
        repeat(auto-fit, minmax(190px, 1fr));
      gap: 12px;
    }

    .qv-timeframe {
      padding: 14px;
      border-radius: 12px;
      border: 1px solid rgba(128,128,128,.22);
      background: rgba(128,128,128,.05);
    }

    .qv-timeframe-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 12px;
    }

    .qv-timeframe-price {
      font-size: 22px;
      font-weight: 700;
      margin-bottom: 8px;
    }

    .qv-timeframe-score {
      margin-bottom: 10px;
    }

    .qv-timeframe-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      font-size: 12px;
      opacity: .75;
    }

    .qv-timeframe-meta span {
      padding: 4px 7px;
      border-radius: 6px;
      background: rgba(128,128,128,.1);
    }

    .qv-timeframe-trend {
      margin-top: 12px;
      font-weight: 600;
    }

    .qv-error {
      color: #c44;
      font-size: 13px;
    }

    .qv-methodology {
      line-height: 1.6;
    }

    .qv-note {
      margin-top: 8px;
      opacity: .65;
      font-size: 12px;
    }
  `;

  document.head.appendChild(style);
}

async function loadMain() {
  if (state.loading) return;

  state.loading = true;

  setStatus("正在连接…");

  try {
    const data = await api(
      `/api/vote?symbol=${encodeURIComponent(state.symbol)}&interval=60`
    );

    state.data = data;

    renderHero(data);
    renderMainVote(data);
    renderIndicators(data);
    renderReasons(data);
    renderRisk(data);
    renderMethodology(data);
    renderHealth(data);

    setStatus("已连接");

  } catch (error) {
    console.error(error);

    setStatus("连接失败", false);

    const message =
      `QuantVote 连接失败：${error.message}`;

    const errorEl =
      $("error") ||
      $("errorMessage");

    if (errorEl) {
      errorEl.textContent = message;
    } else {
      const section =
        document.createElement("section");

      section.className = "qv-card";

      section.innerHTML = `
        <div class="qv-card-title">
          连接错误
        </div>
        <div>
          ${escapeHtml(message)}
        </div>
      `;

      document.querySelector("main")?.appendChild(section);
    }

  } finally {
    state.loading = false;
  }
}

async function loadMulti() {
  try {
    const data = await api(
      `/api/multi?symbol=${encodeURIComponent(state.symbol)}`
    );

    renderMultiTimeframe(data);

  } catch (error) {
    console.error(
      "多周期数据加载失败：",
      error
    );
  }
}

async function loadBacktest() {
  const container =
    $("backtest") ||
    $("backtestPanel");

  if (!container) return;

  container.innerHTML = `
    <div class="qv-card">
      <div class="qv-card-title">
        基础回测
      </div>
      <div>
        正在计算历史模拟……
      </div>
    </div>
  `;

  try {
    const data = await api(
      `/api/backtest?symbol=${encodeURIComponent(state.symbol)}&interval=60`
    );

    const r = data.result || {};

    container.innerHTML = `
      <div class="qv-card">

        <div class="qv-card-title">
          基础回测
        </div>

        <div class="qv-indicator-grid">

          <div class="qv-indicator">
            <span>历史收益</span>
            <strong>
              ${fmtPercent(r.totalReturnPercent)}
            </strong>
          </div>

          <div class="qv-indicator">
            <span>交易次数</span>
            <strong>
              ${safe(r.trades, 0)}
            </strong>
          </div>

          <div class="qv-indicator">
            <span>胜率</span>
            <strong>
              ${fmtPercent(r.winRatePercent)}
            </strong>
          </div>

          <div class="qv-indicator">
            <span>最终权益</span>
            <strong>
              ${safe(r.finalEquity, 4)}
            </strong>
          </div>

        </div>

        <div class="qv-note">
          ${escapeHtml(
            data.methodology?.note ||
            "基础历史模拟，不代表未来表现。"
          )}
        </div>

      </div>
    `;

  } catch (error) {

    container.innerHTML = `
      <div class="qv-card">
        <div class="qv-card-title">
          基础回测
        </div>
        <div class="qv-error">
          ${escapeHtml(error.message)}
        </div>
      </div>
    `;
  }
}

function bindButtons() {
  const refreshButtons = [
    "refresh",
    "refreshBtn",
    "reload",
    "reloadBtn"
  ];

  refreshButtons.forEach(id => {
    const button = $(id);

    if (!button) return;

    button.addEventListener(
      "click",
      async () => {
        await refreshAll();
      }
    );
  });

  const symbolInput =
    $("symbolInput") ||
    $("symbol");

  if (symbolInput) {

    symbolInput.addEventListener(
      "change",
      async () => {

        const value =
          String(symbolInput.value || "")
            .trim()
            .toUpperCase();

        if (value) {
          state.symbol = value;
        }

        await refreshAll();
      }
    );
  }
}

async function refreshAll() {
  await loadMain();
  await loadMulti();
}

function startup() {
  injectMinimalStyles();
  bindButtons();
  refreshAll();

  setInterval(
    refreshAll,
    60 * 1000
  );
}

if (
  document.readyState === "loading"
) {
  document.addEventListener(
    "DOMContentLoaded",
    startup
  );
} else {
  startup();
}
