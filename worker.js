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

function classifyKrakenError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/unknown asset pair|invalid pair|EQuery:.*asset pair/i.test(message)) {
    return { code: "INVALID_PAIR", httpStatus: 400, message: "交易对无效或 Kraken 不支持该交易对" };
  }
  if (/rate limit|too many requests|EAPI:Rate limit exceeded|HTTP 429/i.test(message)) {
    return { code: "RATE_LIMITED", httpStatus: 429, message: "Kraken 请求频率受限，请稍后重试" };
  }
  if (/没有返回K线数据|no candle data|returned no candle/i.test(message)) {
    return { code: "NO_CANDLE_DATA", httpStatus: 503, message: "Kraken 暂无可用 K 线数据" };
  }
  return { code: "UPSTREAM_ERROR", httpStatus: 502, message: "Kraken 行情请求失败，请稍后重试" };
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
  if (!TIMEFRAMES.includes(interval)) throw new Error("Unsupported interval: " + interval);
  const minutes = {
    "5m": 5,
    "15m": 15,
    "1H": 60,
    "4H": 240,
    "1D": 1440,
    "1W": 10080
  }[interval];
  if (!minutes) throw new Error("Unsupported Kraken interval: " + interval);
  return minutes;
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
    if (
      !r ||
      ![r.time, r.open, r.high, r.low, r.close, r.vwap, r.volume, r.count].every(Number.isFinite) ||
      r.volume < 0 ||
      r.open <= 0 ||
      r.high <= 0 ||
      r.low <= 0 ||
      r.close <= 0 ||
      r.high < r.low ||
      r.high < r.open ||
      r.high < r.close ||
      r.low > r.open ||
      r.low > r.close
    ) continue;

    const bucket = Math.floor(r.time / 28800) * 28800;
    let candles = buckets.get(bucket);

    if (!candles) {
      candles = new Map();
      buckets.set(bucket, candles);
    }

    // A timestamp may only contribute once to an 8H candle
    if (!candles.has(r.time)) candles.set(r.time, r);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])

    .filter(([bucket]) => (bucket + 28800) * 1000 <= Date.now())
    .flatMap(([bucket, candles]) => {
      const first = candles.get(bucket);
      const second = candles.get(bucket + 14400);

      // An 8H candle is valid only when both expected 4H candles exist.
      if (!first || !second) return [];

      const volume = first.volume + second.volume;
      return [{
        time: bucket,
        open: first.open,
        high: Math.max(first.high, second.high),
        low: Math.min(first.low, second.low),
        close: second.close,
        vwap: volume
          ? (first.vwap * first.volume + second.vwap * second.volume) / volume
          : second.close,
        volume,
        count: first.count + second.count
      }];
    });
}

function aggregate1W(rows) {
  const buckets = new Map();

  for (const r of rows) {
    if (!r || !Number.isFinite(r.time)) continue;

    const date = new Date(r.time * 1000);
    const day = date.getUTCDay();
    const mondayOffset = day === 0 ? 6 : day - 1;
    const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - mondayOffset));
    const bucket = Math.floor(monday.getTime() / 1000);
    let candles = buckets.get(bucket);

    if (!candles) {
      candles = new Map();
      buckets.set(bucket, candles);
    }

    // A daily candle timestamp may only contribute once to a weekly candle.
    if (!candles.has(r.time)) candles.set(r.time, r);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([bucket, candles]) =>
      (bucket + 604800) * 1000 <= Date.now() &&
      Array.from({ length: 7 }, (_, day) => candles.has(bucket + day * 86400)).every(Boolean)
    )
    .map(([bucket, candles]) => {
      const ordered = [...candles.values()].sort((a, b) => a.time - b.time);
      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      let high = -Infinity;
      let low = Infinity;
      let volume = 0;
      let count = 0;
      let vwapValue = 0;

      for (const r of ordered) {
        high = Math.max(high, r.high);
        low = Math.min(low, r.low);
        volume += r.volume;
        count += r.count;
        vwapValue += r.vwap * r.volume;
      }

      return {
        time: bucket,
        open: first.open,
        high,
        low,
        close: last.close,
        vwap: volume ? vwapValue / volume : last.close,
        volume,
        count
      };
    });
}

async function fetchKraken(symbol, interval, limit = 720) {
  const pair = normalizeSymbol(symbol);

  if (interval === "8H") {
    const source = await fetchKraken(pair, "4H", Math.max(limit * 2 + 4, 720));
    return aggregate8H(source).slice(-limit);
  }

  if (interval === "1W") {
    const source = await fetchKraken(pair, "1D", Math.max(limit * 7 + 7, 720));
    return aggregate1W(source).slice(-limit);
  }

  const krakenInterval = intervalToKraken(interval);
  const cacheKey = pair + "|" + krakenInterval;

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

  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
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
  const macdSeries = [];

  for (let i = 1; i < values.length; i++) {
    fast = values[i] * fastK + fast * (1 - fastK);
    slow = values[i] * slowK + slow * (1 - slowK);

    if (i >= slowPeriod - 1) {
      macdSeries.push(fast - slow);
    }
  }

  if (macdSeries.length < signalPeriod) {
    return { macd: null, signal: null, histogram: null };
  }

  let signal = macdSeries.slice(0, signalPeriod).reduce((a, b) => a + b, 0) / signalPeriod;
  let line = macdSeries[signalPeriod - 1];

  for (let i = signalPeriod; i < macdSeries.length; i++) {
    line = macdSeries[i];
    signal = line * signalK + signal * (1 - signalK);
  }

  return {
    macd: line,
    signal,
    histogram: line - signal
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

  if (tr.length < period) return null;

  // Wilder RMA：第一个 ATR 使用前 period 个 TR 的平均值，
  // 后续 ATR 使用 Wilder 递推平滑。
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < tr.length; i++) {
    atr = ((atr * (period - 1)) + tr[i]) / period;
  }

  return atr;
}

function calculateADX(rows, period = 14) {
  if (!rows || rows.length < period * 2 + 1) {
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

  let smoothedTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothedPlusDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothedMinusDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

  const dx = [];
  let lastPlus = null;
  let lastMinus = null;

  function pushDI() {
    const plusDI = smoothedTR > 0 ? 100 * smoothedPlusDM / smoothedTR : 0;
    const minusDI = smoothedTR > 0 ? 100 * smoothedMinusDM / smoothedTR : 0;

    lastPlus = plusDI;
    lastMinus = minusDI;

    const denominator = plusDI + minusDI;
    dx.push(
      denominator > 0
        ? 100 * Math.abs(plusDI - minusDI) / denominator
        : 0
    );
  }

  pushDI();

  for (let i = period; i < tr.length; i++) {
    smoothedTR = smoothedTR - smoothedTR / period + tr[i];
    smoothedPlusDM = smoothedPlusDM - smoothedPlusDM / period + plusDM[i];
    smoothedMinusDM = smoothedMinusDM - smoothedMinusDM / period + minusDM[i];
    pushDI();
  }

  if (dx.length < period) {
    return {
      adx: null,
      plusDI: lastPlus,
      minusDI: lastMinus
    };
  }

  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < dx.length; i++) {
    adx = ((adx * (period - 1)) + dx[i]) / period;
  }

  return {
    adx: adx,    plusDI: lastPlus,
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
  if (!rows || rows.length < 41) return "neutral";

  const recent = calculateOBV(rows.slice(-21));
  const previous = calculateOBV(rows.slice(-41, -20));

  if (recent === null || previous === null) return "neutral";
  if (recent > previous) return "bullish";
  if (recent < previous) return "bearish";
  return "neutral";
}

function calculateIndicators(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error("没有K线数据");
  }

  if (rows.some(row =>
    !row ||
    ![row.time, row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite) ||
    row.volume < 0 ||
    row.open <= 0 ||
    row.high <= 0 ||
    row.low <= 0 ||
    row.close <= 0 ||
    row.high < row.low ||
    row.high < row.open ||
    row.high < row.close ||
    row.low > row.open ||
    row.low > row.close
  )) {
    throw new Error("K线数据包含无效价格或成交量");
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
    indicators.trend === "strong_bullish" || indicators.trend === "bullish"
      ? 1
      : indicators.trend === "strong_bearish" || indicators.trend === "bearish"
        ? -1
        : 0;
  votes.push(vote);
  reasons.push("EMA：趋势" + (vote > 0 ? "偏多" : vote < 0 ? "偏空" : "中性"));

  vote =
    indicators.rsi14 === null
      ? 0
      : indicators.rsi14 <= 25
        ? 1
        : indicators.rsi14 >= 75
          ? -1
          : indicators.rsi14 >= 55
            ? 1
            : indicators.rsi14 >= 45
              ? 0
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
      : indicators.k <= 20 && indicators.k > indicators.d
        ? 1
        : indicators.k >= 80 && indicators.k < indicators.d
          ? -1
          : indicators.k > indicators.d
            ? 1
            : indicators.k < indicators.d
              ? -1
              : 0;
  votes.push(vote);
  reasons.push("KDJ：" + (vote > 0 ? "K高于D" : vote < 0 ? "K低于D" : "中性"));

  vote =
    indicators.bollUpper === null ||
    indicators.bollLower === null ||
    indicators.bollMiddle === null ||
    indicators.price === null
      ? 0
      : indicators.price >= indicators.bollUpper
        ? -1
        : indicators.price <= indicators.bollLower
          ? 1
          : indicators.price > indicators.bollMiddle
            ? 1
            : indicators.price < indicators.bollMiddle
              ? -1
              : 0;
  votes.push(vote);
  reasons.push("Bollinger：" + (vote > 0 ? "偏多" : vote < 0 ? "偏空" : "中性"));

  vote =
    indicators.volumeRatio === null || indicators.macdHistogram === null
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
  // ATR 缺失时继续使用其他风险指标，不提前返回 UNKNOWN。
  const hasRiskData = [indicators.atrPercent, indicators.bollWidth, indicators.adx, indicators.rsi14].some(v => v !== null && v !== undefined && Number.isFinite(Number(v)));
  if (!hasRiskData) return "UNKNOWN";

  const highVolatility = indicators.atrPercent >= 4;
  const wideBollinger = indicators.bollWidth !== null && indicators.bollWidth >= 12;
  const mediumVolatility = indicators.atrPercent >= 2;
  const weakTrend = indicators.adx !== null && indicators.adx < 15;
  const extremeRSI = indicators.rsi14 !== null &&
    (indicators.rsi14 <= 20 || indicators.rsi14 >= 80);

  if (highVolatility || wideBollinger) return "HIGH";
  if (mediumVolatility || weakTrend || extremeRSI) return "MEDIUM";
  return "LOW";
}

function calculateAlignment(items) {
  const valid = items
    .filter(x => x && Number.isFinite(x.score))
    .map(x => ({
      ...x,
      score: Math.max(-7, Math.min(7, x.score))
    }));
  if (!valid.length) {
    return {
      label: "NO_DATA",
      bullish: 0,
      bearish: 0,
      neutral: 0,
      netScore: 0,
      consistency: 0,
      directionConsistency: 0
    };
  }

  const bullish = valid.filter(x => x.score >= 3).length;
  const bearish = valid.filter(x => x.score <= -3).length;
  const neutral = valid.length - bullish - bearish;
  const netScore = valid.reduce((sum, x) => sum + x.score, 0);
  const consistency = Math.round(
    Math.abs(netScore) / (valid.length * 7) * 100
  );
  const directionalCount = bullish + bearish;
  const dominantDirection = Math.max(bullish, bearish);
  const directionConsistency =
    directionalCount > 0
      ? Math.round(dominantDirection / directionalCount * 100)
      : 0;

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
    consistency,
    directionConsistency
  };
}

function calculateMultiTimeframeVote(items) {
  const weights = {
    "15m": 0.10,
    "1H": 0.35,
    "4H": 0.25,
    "8H": 0.15,
    "1D": 0.15
  };
  const seen = new Set();
  const valid = items.filter(item => {
    if (
      !item ||
      !Object.prototype.hasOwnProperty.call(weights, item.interval) ||
      !Number.isFinite(item.score) ||
      seen.has(item.interval)
    ) return false;

    seen.add(item.interval);
    return true;
  }).map(item => ({
    interval: item.interval,
    score: Math.max(-7, Math.min(7, item.score))
  }));
  const totalWeight = valid.reduce((sum, item) => sum + weights[item.interval], 0);
  if (!totalWeight) {
    return { score: 0, vote: "NO_DATA", usedTimeframes: [], weights };
  }
  const weightedScore = valid.reduce(
    (sum, item) => sum + (item.score / 7) * weights[item.interval],
    0
  ) / totalWeight * 7;
  const score = Math.round(Math.max(-7, Math.min(7, weightedScore)) * 100) / 100;
  return {
    score,
    vote: score >= 1.5 ? "BULLISH" : score <= -1.5 ? "BEARISH" : "NEUTRAL",
    usedTimeframes: valid.map(item => item.interval),
    weights
  };
}

function calculateHistoricalForecast(candles, horizons, interval) {
  return horizons.filter(horizon => Number.isInteger(horizon) && horizon > 0).map(horizon => {
    const returns = [];
    const start = Math.max(0, candles.length - 400 * horizon - horizon);
    for (let i = start; i + horizon < candles.length; i++) {
      const entry = candles[i].close;
      const future = candles[i + horizon].close;
      if (Number.isFinite(entry) && entry > 0 && Number.isFinite(future) && future > 0) {
        returns.push((future / entry - 1) * 100);
      }
    }
    returns.sort((a, b) => a - b);
    const quantile = p => returns.length ? returns[Math.floor((returns.length - 1) * p)] : null;
    return {
      horizonBars: horizon,
      horizonMinutes: horizon * ({ "5m": 5, "15m": 15, "1H": 60, "4H": 240, "8H": 480, "1D": 1440, "1W": 10080 }[interval] || 60),
      samples: returns.length,
      sampleStatus: returns.length < 20 ? "insufficient_sample" : returns.length < 100 ? "limited_sample" : "baseline_sample_100_plus",
      historicalDirection: returns.length >= 20 ? (returns.filter(x => x > 0).length / returns.length >= 0.55 ? "UP_BIAS" : returns.filter(x => x < 0).length / returns.length >= 0.55 ? "DOWN_BIAS" : "MIXED") : "INSUFFICIENT_DATA",
      historicalUpRate: returns.length >= 20 ? returns.filter(x => x > 0).length / returns.length : null,
      medianReturnPct: returns.length >= 20 ? quantile(0.5) : null,
      lowReturnPct: returns.length >= 20 ? quantile(0.1) : null,
      highReturnPct: returns.length >= 20 ? quantile(0.9) : null,
      basis: "historical_unconditional_baseline"
    };
  });
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
    votes: vote.votes,
    reasons: vote.reasons,
    risk: calculateRisk(indicators),
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
    try {
      result.push(await analyzeTimeframe(pair, interval));
    } catch (error) {
      result.push({
        interval,
        label: interval,
        group: groupFor(interval),
        groupLabel: groupLabel(groupFor(interval)),
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        errorCode: classifyKrakenError(error).code,
        errorHttpStatus: classifyKrakenError(error).httpStatus,
        price: null,
        score: null,
        vote: "ERROR",
        trend: "unavailable",
        rsi: null,
        adx: null,
        plusDI: null,
        minusDI: null,
        atrPercent: null,
        votes: [],
        reasons: [],
        risk: "UNKNOWN",
        indicators: null
      });
    }
  }

  const groups = {};
  for (const group of ["short", "medium", "long"]) {
    groups[group] = calculateAlignment(
      result.filter(x => x.group === group)
    );
  }

  const current =
    result.find(x => x.interval === "1H" && x.status !== "error" && x.indicators) ||
    result.find(x => x.status !== "error" && x.indicators) ||
    result[0] ||
    null;

  const data = {
    symbol: displaySymbol(pair),
    pair,
    timeframes: result,
    alignment: calculateAlignment(result),
    multiTimeframeVote: calculateMultiTimeframeVote(result),
    groups,
    price: current?.price ?? null,
    current
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
".controls{display:flex;gap:8px;margin:18px 0;flex-wrap:wrap}.searchBox{display:flex;gap:8px;flex:1;min-width:260px;position:relative}.controls input{flex:1;min-width:180px;background:#0f1728;border:1px solid var(--line);color:var(--text);padding:11px;border-radius:8px}.controls button{background:#1d2940;color:var(--text);border:1px solid var(--line);padding:11px 16px;border-radius:8px;touch-action:manipulation}.searchResults{position:absolute;z-index:20;left:0;right:0;top:48px;background:#0f1728;border:1px solid var(--line);border-radius:10px;overflow:hidden;box-shadow:0 12px 30px rgba(0,0,0,.35)}.searchItem{display:flex;justify-content:space-between;gap:10px;width:100%;background:#0f1728;color:var(--text);border:0;border-bottom:1px solid var(--line);padding:12px;text-align:left;cursor:pointer}.searchItem:last-child{border-bottom:0}.searchItem:hover{background:#182238}.searchMain{font-weight:700}.searchSub{color:var(--muted);font-size:11px;margin-top:3px}.hidden{display:none}.reason{padding:9px 11px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:10px}.raw{white-space:pre-wrap;word-break:break-word;background:#0a0f1c;border:1px solid var(--line);border-radius:8px;padding:12px;font-size:11px;max-height:360px;overflow:auto}.sectionTitle{font-weight:700;margin-bottom:8px}",
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
"<div class='controls'><div class='searchBox'><input id='symbol' value='BTCUSD' placeholder='搜索 BTC / ETH / SOL ...' autocomplete='off'><button id='searchBtn'>搜索</button><div id='searchResults' class='searchResults hidden'></div></div><button id='refresh'>刷新数据</button></div>",
"<div id='error' class='error'></div>",
"<div id='summary' class='grid'></div>",
"<div class='section card'><div class='sectionTitle'>历史收益基准（非未来概率）</div><div class='small'>展示所选周期下的历史收益分布。历史上涨比例不等于未来上涨概率；样本不足时不展示统计值。</div><label for='forecastInterval'>统计周期</label><select id='forecastInterval'><option value='5m'>5m</option><option value='15m'>15m</option><option value='1H' selected>1H</option><option value='4H'>4H</option><option value='8H'>8H</option><option value='1D'>1D</option><option value='1W'>1W</option></select><div id='forecast'></div></div>",
"<div class='section card'><div class='label'>多周期 QuantVote</div><div class='small'>短期：5m / 15m　中期：1H / 4H / 8H　长期：1D / 1W</div><div id='table'></div></div>",
"<div class='section card'><div class='label'>周期一致性</div><div id='groups'></div></div>",
"<div class='section card'><div class='sectionTitle'>Vote 判断依据</div><div class='controls'><label for='voteReasonInterval'>选择判断周期</label><select id='voteReasonInterval'><option value='15m'>15分钟（15m）</option><option value='1H' selected>1小时（1H）</option><option value='4H'>4小时（4H）</option><option value='8H'>8小时（8H）</option><option value='1D'>1天（1D）</option><option value='1W'>1周（1W）</option></select></div><div id='voteReasons'></div></div>",
"<div class='section card'><div class='sectionTitle'>市场状态</div><div id='regime'></div></div>",
"<div class='section card'><div class='sectionTitle'>基准策略历史回测</div><div class='small'>仅用于评估规则在历史行情中的表现，不会执行真实交易，也不代表未来收益保证。</div><label for='backtestInterval'>回测周期</label><select id='backtestInterval'><option value='5m'>5m</option><option value='15m'>15m</option><option value='1H' selected>1H</option><option value='4H'>4H</option><option value='8H'>8H</option><option value='1D'>1D</option><option value='1W'>1W</option></select><div id='backtest'></div></div>",
"<div class='section card'><div class='sectionTitle'>1H 技术指标</div><div id='indicators' class='grid'></div></div>",
"<div class='section card'><div class='sectionTitle'>原始指标数据</div><pre id='rawData' class='raw'></pre></div>",
"</main>",
"<script>",
"const $=id=>document.getElementById(id);",
"function cls(v){return String(v||'').toLowerCase().includes('bull')?'bull':String(v||'').toLowerCase().includes('bear')?'bear':'neutral'}",
"function n(v,d=2){return v==null||!Number.isFinite(Number(v))?'—':Number(v).toFixed(d)}",
"let forecastPair='XBTUSD';let forecastRequestSeq=0; async function loadForecast(pair,requestId){const forecastRequestId=++forecastRequestSeq;const box=$('forecast');if(!box)return;box.innerHTML='<div class=\"small\">正在读取历史收益基准...</div>';try{const interval=$('forecastInterval').value||'1H';const r=await fetch('/api/predict?pair='+encodeURIComponent(pair)+'&interval='+encodeURIComponent(interval));const d=await r.json();if(requestId!==loadSeq||forecastRequestId!==forecastRequestSeq)return;if(!r.ok||d.status!=='ok')throw new Error(d.error||'历史统计不可用');const rows=Array.isArray(d.predictions)?d.predictions:[];const statusLabel=s=>s==='insufficient_sample'?'样本不足':s==='limited_sample'?'有限样本':'100个以上样本';const directionLabel=s=>s==='UP_BIAS'?'历史偏上行':s==='DOWN_BIAS'?'历史偏下行':s==='MIXED'?'历史方向混合':'数据不足';const horizonLabel=p=>{const m=Number(p.horizonMinutes);const human=m>=10080&&m%10080===0?(m/10080)+'周':m>=1440&&m%1440===0?(m/1440)+'天':m>=60&&m%60===0?(m/60)+'小时':m+'分钟';return n(p.horizonBars,0)+'根K线（'+human+'）';};box.innerHTML='<div class=\"small\">'+esc(d.note||'历史基准，不是未来概率')+'</div><div class=\"small\">D1记录：'+(d.historySaved?'已保存':'未确认保存')+'</div>'+(rows.length?'<table><thead><tr><th>观察区间</th><th>样本数</th><th>样本状态</th><th>历史方向</th><th>历史上涨比例</th><th>历史中位收益</th><th>历史收益P10–P90</th></tr></thead><tbody>'+rows.map(p=>'<tr><td>'+horizonLabel(p)+'</td><td>'+n(p.samples,0)+'</td><td>'+statusLabel(p.sampleStatus)+'</td><td>'+directionLabel(p.historicalDirection)+'</td><td>'+n(p.historicalUpRate==null?null:p.historicalUpRate*100,1)+(p.historicalUpRate==null?'':'%')+'</td><td>'+n(p.medianReturnPct,2)+(p.medianReturnPct==null?'':'%')+'</td><td>'+n(p.lowReturnPct,2)+(p.lowReturnPct==null?'':'%')+' 至 '+n(p.highReturnPct,2)+(p.highReturnPct==null?'':'%')+'</td></tr>').join('')+'</tbody></table>':'<div class=\"small\">当前没有可展示的历史统计。</div>');}catch(e){if(requestId===loadSeq&&forecastRequestId===forecastRequestSeq)box.innerHTML='<div class=\"error\">'+esc(e.message||'历史统计暂不可用')+'</div>';}}",
"function esc(v){return String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\\"/g,'&quot;').replace(/'/g,'&#39;')}",
"function hideSearch(){ $('searchResults').classList.add('hidden'); $('searchResults').innerHTML=''; }",
"function showSearch(items){ const box=$('searchResults'); if(!items.length){box.innerHTML='<div class=\\\"searchItem\\\"><div><div class=\\\"searchMain\\\">没有找到交易对</div><div class=\\\"searchSub\\\">请换一个币种名称或代码</div></div></div>';box.classList.remove('hidden');return;} box.innerHTML=items.map(x=>'<button type=\\\"button\\\" class=\\\"searchItem\\\" data-symbol=\\\"'+esc(x.symbol)+'\\\"><div><div class=\\\"searchMain\\\">'+esc(x.display||x.pair||x.symbol)+'</div><div class=\\\"searchSub\\\">'+esc(x.pair||x.symbol)+'</div></div><div class=\\\"searchSub\\\">选择</div></button>').join(''); box.classList.remove('hidden'); box.querySelectorAll('[data-symbol]').forEach(b=>b.onclick=()=>{ $('symbol').value=b.dataset.symbol; hideSearch(); load(); }); }",
"let searchTimer=null; let searchRequestId=0; let loadSeq=0; async function searchPairs(){ const q=$('symbol').value.trim(); hideSearch(); if(!q){searchRequestId++;return;} const requestId=++searchRequestId; try{ const r=await fetch('/api/pairs?q='+encodeURIComponent(q)); const d=await r.json(); if(requestId!==searchRequestId)return; if(!r.ok||d.status==='error') throw new Error(d.error||'搜索失败'); showSearch(d.results||[]); }catch(e){ if(requestId===searchRequestId)$('error').textContent=e.message||String(e); } }",
"async function load(){",
"  const raw=$('symbol').value.trim()||'BTCUSD';",
"  const requestId=++loadSeq;",
"  $('error').textContent='';$('summary').innerHTML='';$('table').innerHTML='';$('groups').innerHTML='';$('indicators').innerHTML='';$('rawData').textContent='';$('regime').innerHTML='';$('forecast').innerHTML='';$('backtest').textContent='正在计算所选周期的回测...';",
"  try{",
"    const r=await fetch('/api/analysis?symbol='+encodeURIComponent(raw));",
"    const d=await r.json();",
"    if(requestId!==loadSeq)return;",
"    if(!r.ok||d.status==='error')throw new Error(d.error||'请求失败');",
"    const c=d.current;if(!c||!c.indicators)throw new Error('所有周期数据均不可用，请稍后重试');",
"    forecastPair=d.pair;loadForecast(forecastPair,requestId);",
"    const failedCount=Array.isArray(d.timeframes)?d.timeframes.filter(x=>x.status==='error').length:0;if(failedCount>0)$('error').textContent='部分周期数据不可用（'+failedCount+'/'+(Array.isArray(d.timeframes)?d.timeframes.length:7)+'），其余可用周期仍可查看。',",
"    $('summary').innerHTML=" +
"'<div class=\"card\"><div class=\"label\">当前</div><div class=\"value\">'+d.symbol+'</div></div>'+" +
"'<div class=\"card\"><div class=\"label\">标的价格</div><div class=\"value\">'+n(d.price,2)+'</div></div>'+" +
"'<div class=\"card\"><div class=\"label\">'+esc(c.interval)+' QuantVote</div><div class=\"value '+cls(c.vote)+'\">'+c.vote+'</div></div>'+" +
"'<div class=\"card\"><div class=\"label\">'+esc(c.interval)+' Score</div><div class=\"value '+cls(c.vote)+'\">'+c.score+' / 7</div></div>'+" +
"'<div class=card><div class=label>多周期确认 Vote（评分非概率）</div><div class=value>'+(d.multiTimeframeVote&&d.multiTimeframeVote.vote||'NO_DATA')+' · '+n(d.multiTimeframeVote&&d.multiTimeframeVote.score,2)+'</div></div>' +",
"'<div class=\"card\"><div class=\"label\">风险</div><div class=\"value\">'+(c.risk||'UNKNOWN')+'</div></div>';",
"    $('table').innerHTML='<table><thead><tr><th>周期</th><th>分类</th><th>价格</th><th>Score</th><th>Vote</th><th>Trend</th><th>RSI</th><th>ADX</th></tr></thead><tbody>'+d.timeframes.map(x=>x.status==='error'?'<tr><td>'+esc(x.interval)+'</td><td>'+esc(x.groupLabel)+'</td><td>—</td><td>—</td><td class=\"neutral\" title=\"'+esc(x.error||'该周期分析失败')+'\">数据不可用</td><td>—</td><td>—</td><td>—</td></tr>':'<tr><td>'+esc(x.interval)+'</td><td>'+esc(x.groupLabel)+'</td><td>'+n(x.price)+'</td><td class=\"'+cls(x.vote)+'\">'+x.score+'</td><td class=\"'+cls(x.vote)+'\">'+esc(x.vote)+'</td><td>'+esc(x.trend)+'</td><td>'+n(x.rsi,1)+'</td><td>'+n(x.adx,1)+'</td></tr>').join('')+'</tbody></table>';",
"    $('groups').innerHTML=['short','medium','long'].map(g=>{const x=d.groups[g];return '<span class=\"pill\">'+(g==='short'?'短期':g==='medium'?'中期':'长期')+'：'+x.label+' · 净分 '+x.netScore+' · 方向一致 '+x.directionConsistency+'% · 强度 '+x.consistency+'%</span>'}).join('');",
"    const i=c.indicators;",
"    const fields=[['EMA20',i.ema20],['EMA50',i.ema50],['EMA200',i.ema200],['RSI14',i.rsi14],['MACD',i.macd],['MACD Histogram',i.macdHistogram],['KDJ K',i.k],['KDJ D',i.d],['KDJ J',i.j],['Boll Middle',i.bollMiddle],['Boll Upper',i.bollUpper],['Boll Lower',i.bollLower],['ATR14',i.atr14],['ATR %',i.atrPercent],['Volume Ratio',i.volumeRatio],['ADX',i.adx],['+DI',i.plusDI],['-DI',i.minusDI],['OBV',i.obv],['OBV Trend',i.obvTrend]];",
"    $('indicators').innerHTML=fields.map(x=>'<div class=\"card\"><div class=\"label\">'+x[0]+'</div><div class=\"value\">'+(x[0]==='OBV Trend'?String(x[1]||'neutral').toUpperCase():n(x[1],2))+'</div></div>').join(''); const renderVoteReasons=()=>{const interval=$('voteReasonInterval').value;const selected=d.timeframes.find(x=>x.interval===interval);const reasons=selected&&selected.reasons||[];$('voteReasons').innerHTML='<div class=\"small\">当前周期：'+esc(interval)+'</div>'+ (reasons.map((r,idx)=>'<div class=\"reason\"><span>Vote '+(idx+1)+'</span><span>'+esc(r)+'</span></div>').join('')||'<div class=\"small\">该周期暂无判断依据</div>');};$('voteReasonInterval').onchange=renderVoteReasons;renderVoteReasons(); $('regime').innerHTML='<div class=\"grid\"><div class=\"card\"><div class=\"label\">1D 市场状态</div><div class=\"value\" id=\"regimeValue\">加载中</div></div><div class=\"card\"><div class=\"label\">整体多周期</div><div class=\"value\">'+esc(d.alignment.label)+'</div></div></div>'; $('backtest').innerHTML='<div class=\"small\">正在计算基准回测...</div>'; $('rawData').textContent=JSON.stringify(c.indicators,null,2); try{const rr=await fetch('/api/regime?pair='+encodeURIComponent(d.pair));const rd=await rr.json();if(requestId!==loadSeq)return;$('regimeValue').textContent=rd.regime||'—';}catch(_){if(requestId===loadSeq)$('regimeValue').textContent='—';} try{const br=await fetch('/api/backtest?pair='+encodeURIComponent(d.pair)+'&interval='+encodeURIComponent($('backtestInterval').value||'1H'));const bd=await br.json();if(requestId!==loadSeq)return;if(br.ok&&bd.status==='ok'&&bd.backtestStatus==='insufficient_data'){$('backtest').innerHTML='<div class=\"error\">历史数据不足（少于220根K线），暂无法进行有效回测</div>';}else if(br.ok&&bd.status==='ok'&&bd.backtestStatus==='no_trades'){$('backtest').innerHTML='<div class=\"error\">历史数据足够，但当前策略条件未产生交易</div>';}else if(br.ok&&bd.status==='ok'){$('backtest').innerHTML='<div class=\"grid\"><div class=\"card\"><div class=\"label\">Trades</div><div class=\"value\">'+n(bd.trades,0)+'</div></div><div class=\"card\"><div class=\"label\">Win Rate</div><div class=\"value\">'+n(bd.winRate*100,1)+'%</div></div><div class=\"card\"><div class=\"label\">Return</div><div class=\"value\">'+n(bd.cumulativeReturn*100,2)+'%</div></div><div class=\"card\"><div class=\"label\">Max DD</div><div class=\"value\">'+n(bd.maxDrawdown*100,2)+'%</div></div><div class=\"card\"><div class=\"label\">Sharpe</div><div class=\"value\">'+n(bd.sharpe,2)+'</div></div><div class=\"card\"><div class=\"label\">Profit Factor</div><div class=\"value\">'+(bd.profitFactorStatus==='no_losses'?'无亏损（不适用）':bd.profitFactorStatus==='no_trades'?'无交易':bd.profitFactorStatus==='no_profit_or_loss'?'无盈亏':n(bd.profitFactor,2))+'</div></div></div>';}else{$('backtest').innerHTML='<div class=\"error\">'+esc(bd.error||'回测失败')+'</div>';}}catch(_){if(requestId===loadSeq)$('backtest').innerHTML='<div class=\"error\">回测暂时不可用</div>';}",
"  }catch(e){if(requestId===loadSeq){$('error').textContent=e.message||String(e);$('backtest').innerHTML='<div class=\"error\">行情加载失败，回测未执行</div>';}}",
"}",
"$('forecastInterval').onchange=()=>loadForecast(forecastPair,loadSeq);$('backtestInterval').onchange=load;$('refresh').onclick=load;$('searchBtn').onclick=()=>{clearTimeout(searchTimer);searchPairs()};$('symbol').addEventListener('input',()=>{clearTimeout(searchTimer);const q=$('symbol').value.trim();if(q.length<2){searchRequestId++;hideSearch();return;}searchTimer=setTimeout(searchPairs,300)});$('symbol').addEventListener('focus',()=>{if($('symbol').value.trim().length>=2)searchPairs()});$('symbol').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();clearTimeout(searchTimer);searchPairs()}});document.addEventListener('click',e=>{if(!e.target.closest('.searchBox'))hideSearch()});load();",
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

  let all;
  try {
    all = await fetchPairs();
  } catch (error) {
    const classified = classifyKrakenError(error);
    const message = classified.code === "UPSTREAM_ERROR"
      ? "Kraken 交易对列表获取失败，请稍后重试"
      : classified.message;
    return errorResponse(classified.code + ": " + message, classified.httpStatus);
  }

  const results = [];

  for (const [key, item] of Object.entries(all)) {
    const text = [
      key,
      item.altname,
      item.wsname,
      item.base,
      item.quote
    ].join(" ").toUpperCase();

    const base = String(item.base || "").toUpperCase();
    const quote = String(item.quote || "").toUpperCase();
    const pairNames = [key, item.altname, item.wsname]
      .map(value => String(value || "").toUpperCase());

    if (
      !text.includes(q) &&
      !(q === "BTC" && base.includes("XBT")) &&
      !(q === "BTCUSDT" && pairNames.some(value => value.includes("XBTUSDT")))
    ) continue;

    let score = 0;

    if (key.toUpperCase() === q) score += 10000;
    if (String(item.altname || "").toUpperCase() === q) score += 10000;
    if (base === q || (q === "BTC" && base.includes("XBT"))) score += 8000;
    if (base === q && ["USD", "USDT", "USDC", "EUR"].includes(quote)) score += 5000;

    results.push({
      symbol: item.altname || key,
      pair: key,
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
    multiTimeframeVote: data.multiTimeframeVote,
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

function runBacktest(candles, interval = "1H") {
  if (candles.length < 220) {
    return {
      trades: 0,
      winRate: 0,
      cumulativeReturn: 0,
      maxDrawdown: 0,
      sharpe: 0,
      profitFactor: 0,
      profitFactorStatus: "insufficient_data",
      backtestStatus: "insufficient_data"
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

    if (inPosition) {
      const candle = candles[i];
      const markedHighEquity = equity * (candle.high * 0.999) / (entry * 1.001);
      const markedLowEquity = equity * (candle.low * 0.999) / (entry * 1.001);
      peak = Math.max(peak, markedHighEquity);
      maxDrawdown = Math.max(maxDrawdown, (peak - markedLowEquity) / peak);
    }

    if (!inPosition && vote.score >= 3) {
      if (i + 1 >= candles.length) continue;
      inPosition = true;
      entry = candles[i + 1].open;      continue;
    }

    if (inPosition && vote.score <= 0) {
      if (i + 1 >= candles.length) continue;
      const pct = (candles[i + 1].open * 0.999) / (entry * 1.001) - 1;
      const tradePnl = equity * pct;
      equity *= 1 + pct;
      returns.push(pct);

      if (tradePnl > 0) wins.push(tradePnl);
      else losses.push(tradePnl);

      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);

      inPosition = false;
      entry = 0;
    }
  }

  if (inPosition) {
    const price = candles.at(-1).close;
    const pct = (price * 0.999) / (entry * 1.001) - 1;
    const tradePnl = equity * pct;
    equity *= 1 + pct;
    returns.push(pct);

    if (tradePnl > 0) wins.push(tradePnl);
    else losses.push(tradePnl);

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
    sharpe: deviation && n ? avg / deviation * Math.sqrt(n * 365 * 24 * 60 / (candles.length * ({ "5m": 5, "15m": 15, "1H": 60, "4H": 240, "8H": 480, "1D": 1440, "1W": 10080 }[interval] || 60))) : 0,
    profitFactor: grossLoss ? grossProfit / grossLoss : 0,
    profitFactorStatus: grossLoss > 0 ? "calculated" : grossProfit > 0 ? "no_losses" : n > 0 ? "no_profit_or_loss" : "no_trades",
    backtestStatus: n > 0 ? "ok" : "no_trades"
  };
}

async function handlePredict(url, env) {
  const pair = normalizeSymbol(url.searchParams.get("pair") || "XBTUSD");
  const interval = url.searchParams.get("interval") || "1H";
  if (!TIMEFRAMES.includes(interval)) return errorResponse("Unsupported interval: " + interval, 400);

  const rows = await fetchKraken(pair, interval, 720);
  if (!Array.isArray(rows) || !rows.length) return errorResponse("Kraken returned no candle data for prediction", 503);
  if (rows.some(row => !row || ![row.time, row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite) || row.volume < 0 || row.open <= 0 || row.high <= 0 || row.low <= 0 || row.close <= 0 || row.high < row.low || row.high < row.open || row.high < row.close || row.low > row.open || row.low > row.close)) return errorResponse("Kraken returned invalid candle values for prediction", 502);
  const intervalMinutes = { "5m": 5, "15m": 15, "1H": 60, "4H": 240, "8H": 480, "1D": 1440, "1W": 10080 }[interval];
  const closedRows = rows.filter(row => row.time * 1000 + intervalMinutes * 60 * 1000 <= Date.now());
  if (!closedRows.length) return errorResponse("Kraken returned no closed candles for prediction", 503);
  const indicators = calculateIndicators(closedRows);
  const vote = calculateVote(indicators);
  const horizonsByInterval = {
    "5m": [3, 6, 12, 24],
    "15m": [2, 4, 8, 16],
    "1H": [1, 4, 8, 24, 72, 168],
    "4H": [1, 2, 6, 18, 42],
    "8H": [1, 3, 9, 21],
    "1D": [1, 3, 7, 14],
    "1W": [1, 2, 4, 8]
  };

  const predictions = calculateHistoricalForecast(closedRows, horizonsByInterval[interval], interval);
  let historySaved = false;
  let historyError = env && env.MY_BINDING ? null : "D1 binding MY_BINDING is unavailable";
  if (env && env.MY_BINDING) {
    try {
      await env.MY_BINDING.prepare(
        "INSERT INTO prediction_history (pair, interval, forecast_at, reference_price, forecast_json) VALUES (?, ?, ?, ?, ?)"
      ).bind(
        pair,
        interval,
        Math.floor(Date.now() / 1000),
        indicators.price,
        JSON.stringify({
          currentSignal: vote.vote,
          currentScore: vote.score,
          risk: calculateRisk(indicators),
          predictionType: "historical_baseline_not_calibrated_forecast",
          predictions
        })
      ).run();
      historySaved = true;
    } catch (error) {
      historyError = String(error && error.message ? error.message : error);
      // Keep the prediction API available if history persistence fails.
    }
  }

  return json({
    status: "ok",
    source: "kraken",
    symbol: displaySymbol(pair),
    pair,
    interval,
    price: indicators.price,
    currentSignal: vote.vote,
    currentScore: vote.score,
    risk: calculateRisk(indicators),
    historySaved,
    historyError,
    predictionType: "historical_baseline_not_calibrated_forecast",
    predictions,
    note: "Kraken Spot OHLC returns at most 720 recent entries; older candles cannot be retrieved through this endpoint. Historical returns are an unconditional baseline, not calibrated future probabilities, and sequential samples may be dependent. Limited samples are not reliable forecast confidence."
  });
}

async function handleBacktest(url) {
  const pair = normalizeSymbol(url.searchParams.get("pair") || "XBTUSD");
  const interval = url.searchParams.get("interval") || "1H";
  if (!TIMEFRAMES.includes(interval)) return errorResponse("Unsupported interval: " + interval, 400);

  let rows;
  try {
    rows = await fetchKraken(pair, interval, 720);
  } catch (_) {
    return errorResponse("Unable to fetch Kraken candle data for backtest", 502);
  }
  if (!Array.isArray(rows) || !rows.length) {
    return errorResponse("Kraken returned no candle data for backtest", 503);
  }
  if (rows.some(row => !row || ![row.time, row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite) || row.volume < 0 || row.open <= 0 || row.high <= 0 || row.low <= 0 || row.close <= 0 || row.high < row.low || row.high < row.open || row.high < row.close || row.low > row.open || row.low > row.close)) {
    return errorResponse("Kraken returned invalid candle values for backtest", 502);
  }

  const intervalMs = ({ "5m": 5, "15m": 15, "1H": 60, "4H": 240, "8H": 480, "1D": 1440, "1W": 10080 }[interval] || 60) * 60 * 1000;
  rows = rows.filter(row => row.time * 1000 + intervalMs <= Date.now());
  if (!rows.length) {
    return errorResponse("Kraken returned no closed candles for backtest", 503);
  }

  return json({
    status: "ok",
    source: "kraken",
    symbol: displaySymbol(pair),
    pair,
    interval,
    method: "baseline_rule_backtest_v3",
    fee: 0.001,
    ...runBacktest(rows, interval)
  });
}

async function handleAnalysis(url) {
  const pair = normalizeSymbol(url.searchParams.get("symbol") || url.searchParams.get("pair") || "XBTUSD");
  const data = await analyzeAll(pair);

  if (!data.current || !data.current.indicators) {
    const errors = data.timeframes.filter(x => x.status === "error");
    const priority = ["INVALID_PAIR", "RATE_LIMITED", "NO_CANDLE_DATA", "UPSTREAM_ERROR"];
    const selected = priority
      .map(code => errors.find(x => x.errorCode === code))
      .find(Boolean);
    if (selected) {
      return errorResponse(selected.errorCode + ": " + classifyKrakenError(new Error(selected.error)).message, selected.errorHttpStatus);
    }
    return errorResponse("所有周期分析均失败，请稍后重试", 503);
  }

  return json({
    status: "ok",
    version: VERSION,
    source: "kraken",
    ...data
  });
}

async function handleRequest(request, env) {
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
    if (url.pathname === "/api/predict") return handlePredict(url, env);
    if (url.pathname === "/api/backtest") return handleBacktest(url);

    return errorResponse("Not Found", 404);
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};
