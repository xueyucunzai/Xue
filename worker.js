const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
};

const VERSION = "QuantVote V3";
const TIMEFRAMES = ["5m", "15m", "1H", "4H", "8H", "1D", "1W"];
const SHORT_TIMEFRAMES = ["5m", "15m"];
const MEDIUM_TIMEFRAMES = ["1H", "4H", "8H"];
const LONG_TIMEFRAMES = ["1D", "1W"];

const OHLC_CACHE = new Map();
const OHLC_INFLIGHT = new Map();
const ANALYSIS_CACHE = new Map();
let PAIRS_CACHE = null;
let PAIRS_CACHE_TIME = 0;
let PAIRS_INFLIGHT = null;
let krakenQueue = Promise.resolve();
let lastKrakenRequestAt = 0;

const OHLC_CACHE_TTL = 20000;
const ANALYSIS_CACHE_TTL = 15000;
const PAIRS_CACHE_TTL = 60000;
const KRAKEN_REQUEST_GAP = 350;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json;charset=UTF-8"
    }
  });
}

function errorResponse(error, status = 500) {
  return json({
    status: "error",
    error: error instanceof Error ? error.message : String(error)
  }, status);
}

function normalizeSymbol(value) {
  let s = String(value || "XBTUSD").toUpperCase().replace(/[\s/_-]/g, "");
  if (s === "BTCUSD") s = "XBTUSD";
  if (s === "BTCUSDT") s = "XBTUSDT";
  return s;
}

function displaySymbol(pair) {
  return normalizeSymbol(pair) === "XBTUSD" ? "BTCUSD" : normalizeSymbol(pair);
}

function intervalToKraken(interval) {
  return {
    "5m": 5,
    "15m": 15,
    "1H": 60,
    "4H": 240,
    "1D": 1440,
    "1W": 10080
  }[interval] || 60;
}

function groupFor(interval) {
  if (SHORT_TIMEFRAMES.includes(interval)) return "short";
  if (MEDIUM_TIMEFRAMES.includes(interval)) return "medium";
  return "long";
}

function groupLabel(group) {
  return group === "short" ? "短期" : group === "medium" ? "中期" : "长期";
}

async function queueKrakenRequest(task) {
  const previous = krakenQueue;
  let release;
  krakenQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    const wait = Math.max(0, KRAKEN_REQUEST_GAP - (Date.now() - lastKrakenRequestAt));
    if (wait) await sleep(wait);
    return await task();
  } finally {
    lastKrakenRequestAt = Date.now();
    release();
  }
}

function aggregate8H(rows) {
  const buckets = new Map();
  for (const r of rows) {
    const bucket = Math.floor(r.time / 28800) * 28800;
    let a = buckets.get(bucket);
    if (!a) {
      a = {
        time: bucket,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        vwapValue: r.vwap * r.volume,
        volume: r.volume,
        count: r.count
      };
      buckets.set(bucket, a);
    } else {
      a.high = Math.max(a.high, r.high);
      a.low = Math.min(a.low, r.low);
      a.close = r.close;
      a.vwapValue += r.vwap * r.volume;
      a.volume += r.volume;
      a.count += r.count;
    }
  }
  return [...buckets.values()]
    .sort((a, b) => a.time - b.time)
    .map(r => ({
      time: r.time,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      vwap: r.volume ? r.vwapValue / r.volume : r.close,
      volume: r.volume,
      count: r.count
    }));
}

function aggregate1W(rows) {
  const buckets = new Map();
  for (const r of rows) {
    const date = new Date(r.time * 1000);
    const day = date.getUTCDay();
    const mondayOffset = day === 0 ? 6 : day - 1;
    const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - mondayOffset));
    const bucket = Math.floor(monday.getTime() / 1000);
    let a = buckets.get(bucket);
    if (!a) {
      a = { time: bucket, open: r.open, high: r.high, low: r.low, close: r.close, vwapValue: r.vwap * r.volume, volume: r.volume, count: r.count };
      buckets.set(bucket, a);
    } else {
      a.high = Math.max(a.high, r.high);
      a.low = Math.min(a.low, r.low);
      a.close = r.close;
      a.vwapValue += r.vwap * r.volume;
      a.volume += r.volume;
      a.count += r.count;
    }
  }
  return [...buckets.values()].sort((a,b)=>a.time-b.time).map(r=>({time:r.time,open:r.open,high:r.high,low:r.low,close:r.close,vwap:r.volume?r.vwapValue/r.volume:r.close,volume:r.volume,count:r.count}));
}

async function fetchKraken(symbol, interval, limit = 720) {
  const pair = normalizeSymbol(symbol);

  if (interval === "8H") {
    const source = await fetchKraken(pair, "4H", Math.max(limit * 2 + 4, 720));
    return aggregate8H(source).slice(-limit);
  }

  const krakenInterval = intervalToKraken(interval);
  const cacheKey = pair + "|" + krakenInterval;

  if (interval === "1W") {
    const daily = await fetchKraken(pair, "1D", Math.max(limit * 7 + 7, 720));
    return aggregate1W(daily).slice(-limit);
  }
  const now = Date.now();
  const cached = OHLC_CACHE.get(cacheKey);

  if (cached && now - cached.time < OHLC_CACHE_TTL) {
    return cached.rows.slice(-limit);
  }  if (OHLC_INFLIGHT.has(cacheKey)) {
    return (await OHLC_INFLIGHT.get(cacheKey)).slice(-limit);
  }

  const promise = queueKrakenRequest(async () => {
    const url =
      "https://api.kraken.com/0/public/OHLC?pair=" +
      encodeURIComponent(pair) +
      "&interval=" +
      krakenInterval;

    const response = await fetch(url, {
      headers: { "User-Agent": "QuantVote-V3" }
    });

    if (!response.ok) {
      throw new Error("Kraken HTTP " + response.status);
    }

    const data = await response.json();

    if (data.error && data.error.length) {
      throw new Error(data.error.join(", "));
    }

    const result = data.result || {};
    const key = Object.keys(result).find(k => k !== "last");

    if (!key || !Array.isArray(result[key])) {
      throw new Error("Kraken 没有返回K线数据");
    }

    const rows = result[key].map(r => ({
      time: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      vwap: Number(r[5]),
      volume: Number(r[6]),
      count: Number(r[7])
    }));

    OHLC_CACHE.set(cacheKey, {
      time: Date.now(),
      rows
    });

    return rows;
  });

  OHLC_INFLIGHT.set(cacheKey, promise);

  try {
    return (await promise).slice(-limit);
  } finally {
    OHLC_INFLIGHT.delete(cacheKey);
  }
}

async function fetchPairs() {
  const now = Date.now();

  if (PAIRS_CACHE && now - PAIRS_CACHE_TIME < PAIRS_CACHE_TTL) {
    return PAIRS_CACHE;
  }

  if (PAIRS_INFLIGHT) return PAIRS_INFLIGHT;

  PAIRS_INFLIGHT = queueKrakenRequest(async () => {
    const response = await fetch(
      "https://api.kraken.com/0/public/AssetPairs",
      { headers: { "User-Agent": "QuantVote-V3" } }
    );

    if (!response.ok) {
      throw new Error("Kraken AssetPairs HTTP " + response.status);
    }

    const data = await response.json();

    if (data.error && data.error.length) {
      throw new Error(data.error.join(", "));
    }

    PAIRS_CACHE = data.result || {};
    PAIRS_CACHE_TIME = Date.now();
    return PAIRS_CACHE;
  });

  try {
    return await PAIRS_INFLIGHT;
  } finally {
    PAIRS_INFLIGHT = null;
  }
}

function sma(values, period) {
  if (!values || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

function ema(values, period) {
  if (!values || !values.length) return null;
  const n = Math.min(period, values.length);
  let value = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const k = 2 / (period + 1);
  for (let i = n; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
  }
  return value;
}

function standardDeviation(values, period) {
  const mean = sma(values, period);
  if (mean === null) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) {
    sum += (values[i] - mean) ** 2;
  }
  return Math.sqrt(sum / period);
}

function calculateRSI(values, period = 14) {
  if (!values || values.length <= period) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }

  let averageGain = gain / period;
  let averageLoss = loss / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const currentGain = Math.max(change, 0);
    const currentLoss = Math.max(-change, 0);

    averageGain = (averageGain * (period - 1) + currentGain) / period;
    averageLoss = (averageLoss * (period - 1) + currentLoss) / period;
  }

  if (averageLoss === 0) return 100;
  const rs = averageGain / averageLoss;
  return 100 - 100 / (1 + rs);
}

function calculateMACD(values) {
  if (!values || values.length < 35) {
    return {
      macd: null,
      signal: null,
      histogram: null
    };
  }

  const fastPeriod = 12;
  const slowPeriod = 26;
  const signalPeriod = 9;
  const fastK = 2 / (fastPeriod + 1);
  const slowK = 2 / (slowPeriod + 1);
  const signalK = 2 / (signalPeriod + 1);

  let fast = values[0];
  let slow = values[0];
  let signal = null;
  let last = null;

  for (let i = 1; i < values.length; i++) {
    fast = values[i] * fastK + fast * (1 - fastK);
    slow = values[i] * slowK + slow * (1 - slowK);

    if (i >= slowPeriod - 1) {
      const line = fast - slow;
      signal = signal === null ? line : line * signalK + signal * (1 - signalK);
      last = {
        macd: line,
        signal,
        histogram: line - signal
      };
    }
  }

  return last || {
    macd: null,
    signal: null,
    histogram: null
  };
}

function calculateKDJ(rows, period = 9) {
  if (!rows || rows.length < period) {
    return { k: null, d: null, j: null };
  }

  let k = 50;
  let d = 50;

  for (let i = period - 1; i < rows.length; i++) {
    const window = rows.slice(i - period + 1, i + 1);
    const high = Math.max(...window.map(x => x.high));
    const low = Math.min(...window.map(x => x.low));
    const rsv = high === low ? 50 : ((rows[i].close - low) / (high - low)) * 100;

    k = (2 * k + rsv) / 3;
    d = (2 * d + k) / 3;
  }

  return {
    k,
    d,
    j: 3 * k - 2 * d
  };
}

function calculateATR(rows, period = 14) {
  if (!rows || rows.length <= period) return null;

  const tr = [];

  for (let i = 1; i < rows.length; i++) {
    const current = rows[i];
    const previous = rows[i - 1];

    tr.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );
  }

  return sma(tr, period);
}

function calculateADX(rows, period = 14) {
  if (!rows || rows.length < period + 2) {
    return {
      adx: null,
      plusDI: null,
      minusDI: null
    };
  }

  const tr = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < rows.length; i++) {
    const current = rows[i];
    const previous = rows[i - 1];

    tr.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );

    const up = current.high - previous.high;
    const down = previous.low - current.low;

    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }

  const dx = [];
  let lastPlus = null;
  let lastMinus = null;

  for (let i = period - 1; i < tr.length; i++) {
    const trSum = tr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    const plusSum = plusDM.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    const minusSum = minusDM.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);

    const plusDI = trSum ? 100 * plusSum / trSum : 0;
    const minusDI = trSum ? 100 * minusSum / trSum : 0;

    lastPlus = plusDI;
    lastMinus = minusDI;

    dx.push(
      plusDI + minusDI
        ? 100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI)
        : 0
    );
  }

  return {
    adx: sma(dx, period),    plusDI: lastPlus,
    minusDI: lastMinus
  };
}

function calculateOBV(rows) {
  if (!rows || rows.length < 2) return null;

  let value = 0;

  for (let i = 1; i < rows.length; i++) {
    if (rows[i].close > rows[i - 1].close) value += rows[i].volume;
    else if (rows[i].close < rows[i - 1].close) value -= rows[i].volume;
  }

  return value;
}

function calculateOBVTrend(rows) {
  if (!rows || rows.length < 22) return "neutral";

  const recent = calculateOBV(rows.slice(-21));
  const previous = calculateOBV(rows.slice(-41, -20));

  if (recent === null || previous === null) return "neutral";
  if (recent > previous) return "bullish";
  if (recent < previous) return "bearish";
  return "neutral";
}

function calculateIndicators(rows) {
  if (!rows || !rows.length) {
    throw new Error("没有K线数据");
  }

  const closes = rows.map(x => x.close);
  const price = closes.at(-1);

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14 = calculateRSI(closes, 14);
  const macd = calculateMACD(closes);
  const kdj = calculateKDJ(rows, 9);
  const atr14 = calculateATR(rows, 14);
  const adx = calculateADX(rows, 14);

  const bollMiddle = sma(closes, 20);
  const deviation = standardDeviation(closes, 20);
  const bollUpper =
    bollMiddle !== null && deviation !== null
      ? bollMiddle + deviation * 2
      : null;
  const bollLower =
    bollMiddle !== null && deviation !== null
      ? bollMiddle - deviation * 2
      : null;

  const volumes = rows.map(x => x.volume);
  const volumeAverage = sma(volumes, 20);
  const volumeRatio =
    volumeAverage && volumeAverage !== 0
      ? rows.at(-1).volume / volumeAverage
      : null;

  let trend = "neutral";

  if (ema20 !== null && ema50 !== null && ema200 !== null) {
    if (price > ema20 && ema20 > ema50 && ema50 > ema200) {
      trend = "strong_bullish";
    } else if (price < ema20 && ema20 < ema50 && ema50 < ema200) {
      trend = "strong_bearish";
    } else if (price > ema50 && ema20 > ema50) {
      trend = "bullish";
    } else if (price < ema50 && ema20 < ema50) {
      trend = "bearish";
    }
  }

  return {
    price,
    ema20,
    ema50,
    ema200,
    rsi14,
    macd: macd.macd,
    macdSignal: macd.signal,
    macdHistogram: macd.histogram,
    k: kdj.k,
    d: kdj.d,
    j: kdj.j,
    bollMiddle,
    bollUpper,
    bollLower,
    bollWidth:
      bollMiddle && bollUpper !== null && bollLower !== null
        ? ((bollUpper - bollLower) / bollMiddle) * 100
        : null,
    atr14,
    atrPercent: atr14 && price ? atr14 / price * 100 : null,
    volume: rows.at(-1).volume,
    volumeAverage,
    volumeRatio,
    adx: adx.adx,
    plusDI: adx.plusDI,
    minusDI: adx.minusDI,
    obv: calculateOBV(rows),
    obvTrend: calculateOBVTrend(rows),
    trend,
    candleCount: rows.length,
    lastTime: rows.at(-1).time
  };
}

function calculateVote(indicators) {
  const votes = [];
  const reasons = [];

  let vote;

  vote =
    indicators.trend.includes("bull")
      ? 1
      : indicators.trend.includes("bear")
        ? -1
        : 0;
  votes.push(vote);
  reasons.push("EMA：趋势" + (vote > 0 ? "偏多" : vote < 0 ? "偏空" : "中性"));

  vote =
    indicators.rsi14 === null
      ? 0
      : indicators.rsi14 < 30
        ? 1
        : indicators.rsi14 > 70
          ? -1
          : indicators.rsi14 >= 50
            ? 1
            : -1;
  votes.push(vote);
  reasons.push("RSI14：" + (vote > 0 ? "偏多" : vote < 0 ? "偏空" : "中性"));

  vote =
    indicators.macdHistogram === null
      ? 0
      : indicators.macdHistogram > 0
        ? 1
        : indicators.macdHistogram < 0
          ? -1
          : 0;  votes.push(vote);
  reasons.push("MACD：" + (vote > 0 ? "多头动能" : vote < 0 ? "空头动能" : "中性"));

  vote =
    indicators.k === null || indicators.d === null
      ? 0
      : indicators.k > indicators.d
        ? 1
        : indicators.k < indicators.d
          ? -1
          : 0;
  votes.push(vote);
  reasons.push("KDJ：" + (vote > 0 ? "K高于D" : vote < 0 ? "K低于D" : "中性"));

  vote =
    indicators.bollUpper === null
      ? 0
      : indicators.price > indicators.bollUpper
        ? -1
        : indicators.price < indicators.bollLower
          ? 1
          : indicators.price >= indicators.bollMiddle
            ? 1
            : -1;
  votes.push(vote);
  reasons.push("Bollinger：" + (vote > 0 ? "偏多" : vote < 0 ? "偏空" : "中性"));

  vote =
    indicators.volumeRatio === null
      ? 0
      : indicators.volumeRatio > 1.2
        ? indicators.macdHistogram > 0
          ? 1
          : indicators.macdHistogram < 0
            ? -1
            : 0
        : 0;
  votes.push(vote);
  reasons.push("Volume：" + (vote > 0 ? "放量偏多" : vote < 0 ? "放量偏空" : "无强确认"));

  vote =
    indicators.obvTrend === "bullish"
      ? 1
      : indicators.obvTrend === "bearish"
        ? -1
        : 0;
  votes.push(vote);
  reasons.push("OBV：" + (vote > 0 ? "资金流偏多" : vote < 0 ? "资金流偏空" : "中性"));

  let score = votes.reduce((a, b) => a + b, 0);
  score = Math.max(-7, Math.min(7, score));

  return {
    score,
    vote: score >= 3 ? "BULLISH" : score <= -3 ? "BEARISH" : "NEUTRAL",
    votes,
    reasons
  };
}

function calculateRisk(indicators) {
  if (indicators.atrPercent === null) return "UNKNOWN";
  if (
    indicators.atrPercent >= 4 ||
    (indicators.adx !== null && indicators.adx < 15)
  ) return "HIGH";
  if (indicators.atrPercent >= 2) return "MEDIUM";
  return "LOW";
}

function calculateAlignment(items) {
  const valid = items.filter(Boolean);
  if (!valid.length) {
    return {
      label: "NO_DATA",
      bullish: 0,
      bearish: 0,
      neutral: 0,
      netScore: 0,
      consistency: 0
    };
  }

  const bullish = valid.filter(x => x.score >= 3).length;
  const bearish = valid.filter(x => x.score <= -3).length;
  const neutral = valid.length - bullish - bearish;
  const netScore = valid.reduce((sum, x) => sum + x.score, 0);
  const consistency = Math.round(
    Math.abs(netScore) / (valid.length * 7) * 100
  );

  let label = "MIXED";

  if (bullish >= Math.ceil(valid.length * 0.7)) {
    label = "BULLISH_ALIGNMENT";
  } else if (bearish >= Math.ceil(valid.length * 0.7)) {
    label = "BEARISH_ALIGNMENT";
  } else if (consistency >= 55) {
    label = netScore > 0 ? "BULLISH_BIAS" : "BEARISH_BIAS";
  }

  return {
    label,
    bullish,
    bearish,
    neutral,
    netScore,
    consistency
  };
}

async function analyzeTimeframe(pair, interval) {
  const candles = await fetchKraken(pair, interval, 720);
  const indicators = calculateIndicators(candles);
  const vote = calculateVote(indicators);

  return {
    interval,
    label: interval,
    group: groupFor(interval),
    groupLabel: groupLabel(groupFor(interval)),
    price: indicators.price,
    score: vote.score,
    vote: vote.vote,
    trend: indicators.trend,
    rsi: indicators.rsi14,
    adx: indicators.adx,
    plusDI: indicators.plusDI,
    minusDI: indicators.minusDI,
    atrPercent: indicators.atrPercent,
    indicators
  };
}

async function analyzeAll(pair) {
  const cacheKey = "all|" + pair;
  const cached = ANALYSIS_CACHE.get(cacheKey);

  if (cached && Date.now() - cached.time < ANALYSIS_CACHE_TTL) {
    return cached.data;
  }

  const result = [];

  for (const interval of TIMEFRAMES) {
    result.push(await analyzeTimeframe(pair, interval));
  }

  const groups = {};
  for (const group of ["short", "medium", "long"]) {
    groups[group] = calculateAlignment(
      result.filter(x => x.group === group)
    );
  }

  const data = {
    symbol: displaySymbol(pair),
    pair,
    timeframes: result,
    alignment: calculateAlignment(result),
    groups,
    price: result.find(x => x.interval === "1H")?.price || result[0]?.price || null,
    current: result.find(x => x.interval === "1H") || result[0] || null
  };

  ANALYSIS_CACHE.set(cacheKey, {
    time: Date.now(),
    data
  });

  return data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function number(value, digits = 2) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? "—"
    : Number(value).toFixed(digits);
}

function voteClass(vote) {
  const v = String(vote || "").toLowerCase();
  if (v.includes("bull")) return "bull";
  if (v.includes("bear")) return "bear";
  return "neutral";
}

function buildHTML() {
  return [
"<!doctype html>",
"<html lang='zh-CN'>",
"<head>",
"<meta charset='UTF-8'>",
"<meta name='viewport' content='width=device-width,initial-scale=1'>",
"<title>QuantVote V3</title>",
"<style>",
":root{color-scheme:dark;--bg:#0b1020;--panel:#121a2b;--line:#26324a;--text:#e8edf7;--muted:#94a3b8;--green:#42d392;--red:#ff6678;--yellow:#f6c85f;}",
"*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
".wrap{max-width:1200px;margin:auto;padding:20px}.top{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.title{font-size:28px;font-weight:800}.sub{color:var(--muted);font-size:13px}",
".controls{display:flex;gap:8px;margin:18px 0}.controls input{flex:1;min-width:180px;background:#0f1728;border:1px solid var(--line);color:var(--text);padding:11px;border-radius:8px}.controls button{background:#1d2940;color:var(--text);border:1px solid var(--line);padding:11px 16px;border-radius:8px}",
".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}.label{font-size:12px;color:var(--muted)}.value{font-size:25px;font-weight:800;margin-top:5px}",
".bull{color:var(--green)}.bear{color:var(--red)}.neutral{color:var(--yellow)}",
"table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}th,td{text-align:left;padding:10px;border-bottom:1px solid var(--line)}th{color:var(--muted)}",
".section{margin-top:18px}.small{font-size:12px;color:var(--muted)}.error{color:var(--red);margin-top:12px}.pill{display:inline-block;padding:4px 8px;border:1px solid var(--line);border-radius:99px;margin:3px;font-size:12px}",
"@media(max-width:650px){.wrap{padding:12px}.title{font-size:22px}table{font-size:12px}th,td{padding:7px}}",
"</style>",
"</head>",
"<body>",
"<main class='wrap'>",
"<div class='top'><div><div class='title'>QuantVote V3</div><div class='sub'>Technical Research Dashboard · Kraken Public Data</div></div></div>",
"<div class='controls'><input id='symbol' value='BTCUSD' placeholder='BTCUSD / ETHUSD / SOLUSD'><button id='refresh'>刷新数据</button></div>",
"<div id='error' class='error'></div>",
"<div id='summary' class='grid'></div>",
"<div class='section card'><div class='label'>多周期 QuantVote</div><div class='small'>短期：5m / 15m　中期：1H / 4H / 8H　长期：1D / 1W</div><div id='table'></div></div>",
"<div class='section card'><div class='label'>周期一致性</div><div id='groups'></div></div>",
"<div class='section card'><div class='label'>1H 技术指标</div><div id='indicators' class='grid'></div></div>",
"</main>",
"<script>",
"const $=id=>document.getElementById(id);",
"function cls(v){return String(v||'').toLowerCase().includes('bull')?'bull':String(v||'').toLowerCase().includes('bear')?'bear':'neutral'}",
"function n(v,d=2){return v==null||!Number.isFinite(Number(v))?'—':Number(v).toFixed(d)}",
"async function load(){",
"  const raw=$('symbol').value.trim()||'BTCUSD';",
"  $('error').textContent='';",
"  try{",
"    const r=await fetch('/api/analysis?symbol='+encodeURIComponent(raw));",
"    const d=await r.json();",
"    if(!r.ok||d.status==='error')throw new Error(d.error||'请求失败');",
"    const c=d.current;",
"    $('summary').innerHTML=" +
"'<div class=\"card\"><div class=\"label\">当前</div><div class=\"value\">'+d.symbol+'</div></div>'+" +
"'<div class=\"card\"><div class=\"label\">标的价格</div><div class=\"value\">'+n(d.price,2)+'</div></div>'+" +
"'<div class=\"card\"><div class=\"label\">1H QuantVote</div><div class=\"value '+cls(c.vote)+'\">'+c.vote+'</div></div>'+" +
"'<div class=\"card\"><div class=\"label\">1H Score</div><div class=\"value '+cls(c.vote)+'\">'+c.score+' / 7</div></div>'+" +
"'<div class=\"card\"><div class=\"label\">风险</div><div class=\"value\">'+(c.indicators.atrPercent==null?'—':(c.indicators.atrPercent>=4||c.indicators.adx<15?'HIGH':c.indicators.atrPercent>=2?'MEDIUM':'LOW'))+'</div></div>';",
"    $('table').innerHTML='<table><thead><tr><th>周期</th><th>分类</th><th>价格</th><th>Score</th><th>Vote</th><th>Trend</th><th>RSI</th><th>ADX</th></tr></thead><tbody>'+d.timeframes.map(x=>'<tr><td>'+x.interval+'</td><td>'+x.groupLabel+'</td><td>'+n(x.price)+'</td><td class=\"'+cls(x.vote)+'\">'+x.score+'</td><td class=\"'+cls(x.vote)+'\">'+x.vote+'</td><td>'+x.trend+'</td><td>'+n(x.rsi,1)+'</td><td>'+n(x.adx,1)+'</td></tr>').join('')+'</tbody></table>';",
"    $('groups').innerHTML=['short','medium','long'].map(g=>{const x=d.groups[g];return '<span class=\"pill\">'+(g==='short'?'短期':g==='medium'?'中期':'长期')+'：'+x.label+' · '+x.netScore+' · '+x.consistency+'%</span>'}).join('');",
"    const i=c.indicators;",
"    const fields=[['EMA20',i.ema20],['EMA50',i.ema50],['EMA200',i.ema200],['RSI14',i.rsi14],['MACD',i.macd],['MACD Histogram',i.macdHistogram],['KDJ K',i.k],['KDJ D',i.d],['KDJ J',i.j],['Boll Middle',i.bollMiddle],['Boll Upper',i.bollUpper],['Boll Lower',i.bollLower],['ATR14',i.atr14],['ATR %',i.atrPercent],['Volume Ratio',i.volumeRatio],['ADX',i.adx],['+DI',i.plusDI],['-DI',i.minusDI],['OBV',i.obv],['OBV Trend',i.obvTrend]];",
"    $('indicators').innerHTML=fields.map(x=>'<div class=\"card\"><div class=\"label\">'+x[0]+'</div><div class=\"value\">'+(x[0]==='OBV Trend'?String(x[1]||'neutral').toUpperCase():n(x[1],2))+'</div></div>').join('');",
"  }catch(e){$('error').textContent=e.message||String(e)}",
"}",
"$('refresh').onclick=load;$('symbol').addEventListener('keydown',e=>{if(e.key==='Enter')load()});load();",
"</script>",
"</body>",
"</html>"
  ].join("");
}

const HTML = buildHTML();

async function handlePairs(url) {
  const q = (url.searchParams.get("q") || "").trim().toUpperCase();

  if (!q) {
    return json({
      status: "ok",
      source: "kraken",
      query: "",
      count: 0,
      results: []
    });
  }

  const all = await fetchPairs();
  const results = [];

  for (const [key, item] of Object.entries(all)) {
    const text = [
      key,
      item.altname,
      item.wsname,
      item.base,
      item.quote
    ].join(" ").toUpperCase();

    if (!text.includes(q)) continue;

    let score = 0;
    const base = String(item.base || "").toUpperCase();
    const quote = String(item.quote || "").toUpperCase();

    if (key.toUpperCase() === q) score += 10000;
    if (String(item.altname || "").toUpperCase() === q) score += 10000;
    if (base === q) score += 8000;
    if (base === q && ["USD", "USDT", "USDC", "EUR"].includes(quote)) score += 5000;

    results.push({
      symbol: key,
      pair: item.altname || key,
      display: item.wsname || item.altname || key,      score
    });
  }

  results.sort((a, b) => b.score - a.score || a.display.localeCompare(b.display));

  return json({
    status: "ok",
    source: "kraken",
    query: q,
    count: Math.min(50, results.length),
    results: results.slice(0, 50).map(({ score, ...x }) => x)
  });
}

async function handleMarket(url) {
  const pair = normalizeSymbol(url.searchParams.get("pair") || "XBTUSD");
  const rows = await fetchKraken(pair, "1H", 10);
  const last = rows.at(-1);

  return json({
    status: "ok",
    source: "kraken",
    symbol: displaySymbol(pair),
    pair,
    interval: "1H",
    timestamp: last.time,
    price: last.close
  });
}

async function handleIndicators(url) {
  const pair = normalizeSymbol(url.searchParams.get("pair") || "XBTUSD");
  const interval = url.searchParams.get("interval") || "1H";
  const rows = await fetchKraken(pair, interval, 720);

  return json({
    status: "ok",
    source: "kraken",
    symbol: displaySymbol(pair),
    pair,
    interval,
    indicators: calculateIndicators(rows)
  });
}

async function handleVote(url) {
  const pair = normalizeSymbol(url.searchParams.get("pair") || "XBTUSD");
  const interval = url.searchParams.get("interval") || "1H";
  const rows = await fetchKraken(pair, interval, 720);
  const indicators = calculateIndicators(rows);
  const vote = calculateVote(indicators);

  return json({
    status: "ok",
    source: "kraken",
    symbol: displaySymbol(pair),
    pair,
    interval,
    price: indicators.price,
    score: vote.score,
    vote: vote.vote,
    risk: calculateRisk(indicators),
    trend: indicators.trend,
    reasons: vote.reasons,
    indicators
  });
}

async function handleMulti(url) {
  const pair = normalizeSymbol(url.searchParams.get("pair") || "XBTUSD");
  const data = await analyzeAll(pair);

  return json({
    status: "ok",
    source: "kraken",
    symbol: data.symbol,
    pair: data.pair,
    timeframes: data.timeframes.map(x => ({
      interval: x.interval,
      label: x.label,
      group: x.group,
      groupLabel: x.groupLabel,
      price: x.price,
      score: x.score,
      vote: x.vote,
      trend: x.trend,
      rsi: x.rsi,
      adx: x.adx,
      atrPercent: x.atrPercent
    })),
    alignment: data.alignment,
    groups: data.groups
  });
}

async function handleRegime(url) {
  const pair = normalizeSymbol(url.searchParams.get("pair") || "XBTUSD");
  const daily = await analyzeTimeframe(pair, "1D");

  let regime = "RANGE";

  if (daily.trend === "strong_bullish") regime = "BULL";
  else if (daily.trend === "strong_bearish") regime = "BEAR";
  else if (daily.trend === "bullish") regime = "BULLISH_BIAS";
  else if (daily.trend === "bearish") regime = "BEARISH_BIAS";

  return json({
    status: "ok",
    source: "kraken",
    symbol: displaySymbol(pair),
    pair,
    regime,
    trend: daily.trend,
    price: daily.price,
    rsi: daily.rsi,
    adx: daily.adx
  });
}

function runBacktest(candles) {
  if (candles.length < 220) {
    return {
      trades: 0,
      winRate: 0,
      cumulativeReturn: 0,
      maxDrawdown: 0,
      sharpe: 0,
      profitFactor: 0
    };
  }

  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let inPosition = false;
  let entry = 0;

  const returns = [];
  const wins = [];
  const losses = [];

  for (let i = 200; i < candles.length; i++) {
    const indicators = calculateIndicators(candles.slice(0, i + 1));
    const vote = calculateVote(indicators);
    const price = candles[i].close;

    if (!inPosition && vote.score >= 3) {
      inPosition = true;
      entry = price;      continue;
    }

    if (inPosition && vote.score <= 0) {
      const pct = ((price - entry) / entry) - 0.001;
      equity *= 1 + pct;
      returns.push(pct);

      if (pct > 0) wins.push(pct);
      else losses.push(pct);

      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);

      inPosition = false;
      entry = 0;
    }
  }

  if (inPosition) {
    const price = candles.at(-1).close;
    const pct = ((price - entry) / entry) - 0.001;
    equity *= 1 + pct;
    returns.push(pct);

    if (pct > 0) wins.push(pct);
    else losses.push(pct);

    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }

  const n = returns.length;
  const avg = n ? returns.reduce((a, b) => a + b, 0) / n : 0;
  const variance =
    n > 1
      ? returns.reduce((s, x) => s + (x - avg) ** 2, 0) / (n - 1)
      : 0;
  const deviation = Math.sqrt(variance);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

  return {
    trades: n,
    winRate: n ? wins.length / n : 0,
    cumulativeReturn: equity - 1,
    maxDrawdown,
    sharpe: deviation ? avg / deviation * Math.sqrt(365) : 0,
    profitFactor: grossLoss ? grossProfit / grossLoss : 0
  };
}

async function handleBacktest(url) {
  const pair = normalizeSymbol(url.searchParams.get("pair") || "XBTUSD");
  const interval = url.searchParams.get("interval") || "1H";
  const rows = await fetchKraken(pair, interval, 720);

  return json({
    status: "ok",
    source: "kraken",
    symbol: displaySymbol(pair),
    pair,
    interval,
    method: "baseline_rule_backtest_v3",
    fee: 0.001,
    ...runBacktest(rows)
  });
}

async function handleAnalysis(url) {
  const pair = normalizeSymbol(url.searchParams.get("symbol") || url.searchParams.get("pair") || "XBTUSD");
  const data = await analyzeAll(pair);

  return json({
    status: "ok",
    version: VERSION,
    source: "kraken",
    ...data
  });
}

async function handleRequest(request) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }

  if (request.method !== "GET") {
    return errorResponse("Method Not Allowed", 405);
  }

  try {
    if (url.pathname === "/") {
      return new Response(HTML, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "text/html;charset=UTF-8"
        }
      });
    }

    if (url.pathname === "/api/health") {
      return json({
        status: "ok",
        service: "QuantVote",
        version: VERSION,
        source: "kraken",
        timeframes: TIMEFRAMES,
        groups: {
          short: SHORT_TIMEFRAMES,
          medium: MEDIUM_TIMEFRAMES,
          long: LONG_TIMEFRAMES
        },
        eightHour: "aggregated_from_4H"
      });
    }

    if (url.pathname === "/api/pairs") return handlePairs(url);
    if (url.pathname === "/api/market") return handleMarket(url);
    if (url.pathname === "/api/analysis") return handleAnalysis(url);
    if (url.pathname === "/api/multi") return handleMulti(url);
    if (url.pathname === "/api/indicators") return handleIndicators(url);
    if (url.pathname === "/api/vote") return handleVote(url);
    if (url.pathname === "/api/regime") return handleRegime(url);
    if (url.pathname === "/api/backtest") return handleBacktest(url);

    return errorResponse("Not Found", 404);
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export default {
  async fetch(request) {
    return handleRequest(request);
  }
};
