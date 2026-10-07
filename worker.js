const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS
    }
  });
}

function error(message, status = 400, extra = {}) {
  return json({
    status: "error",
    error: message,
    ...extra
  }, status);
}

function corsOptions() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS
  });
}

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function ema(values, period) {
  if (!values.length) return null;

  const p = Math.min(period, values.length);
  const seed = average(values.slice(0, p));

  let result = seed;
  const multiplier = 2 / (period + 1);

  for (let i = p; i < values.length; i++) {
    result = (values[i] - result) * multiplier + result;
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];

    if (diff >= 0) {
      gains += diff;
    } else {
      losses += Math.abs(diff);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = Math.max(diff, 0);
    const loss = Math.max(-diff, 0);

    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  if (values.length < slow + signalPeriod) {
    return {
      macd: null,
      signal: null,
      histogram: null
    };
  }

  const fastEma = [];
  const slowEma = [];

  let ef = average(values.slice(0, fast));
  let es = average(values.slice(0, slow));

  fastEma.push(ef);
  slowEma.push(es);

  const mf = 2 / (fast + 1);
  const ms = 2 / (slow + 1);

  for (let i = fast; i < values.length; i++) {
    ef = (values[i] - ef) * mf + ef;
    fastEma.push(ef);
  }

  for (let i = slow; i < values.length; i++) {
    es = (values[i] - es) * ms + es;
    slowEma.push(es);
  }

  const offset = slow - fast;
  const macdSeries = [];

  for (let i = 0; i < slowEma.length; i++) {
    const fastIndex = i + offset;

    if (fastIndex < fastEma.length) {
      macdSeries.push(fastEma[fastIndex] - slowEma[i]);
    }
  }

  if (macdSeries.length < signalPeriod) {
    return {
      macd: null,
      signal: null,
      histogram: null
    };
  }

  const signal = ema(macdSeries, signalPeriod);
  const current = macdSeries[macdSeries.length - 1];

  return {
    macd: current,
    signal,
    histogram: current - signal
  };
}

function bollinger(values, period = 20, multiplier = 2) {
  if (values.length < period) {
    return {
      middle: null,
      upper: null,
      lower: null,
      width: null
    };
  }

  const slice = values.slice(-period);
  const middle = average(slice);

  const variance = average(
    slice.map(v => Math.pow(v - middle, 2))
  );

  const std = Math.sqrt(variance);

  const upper = middle + multiplier * std;
  const lower = middle - multiplier * std;

  const width = middle !== 0
    ? ((upper - lower) / middle) * 100
    : null;

  return {
    middle,
    upper,
    lower,
    width
  };
}

function kdj(candles, period = 9) {
  if (candles.length < period) {
    return {
      k: null,
      d: null,
      j: null
    };
  }

  let k = 50;
  let d = 50;

  for (let i = period - 1; i < candles.length; i++) {
    const window = candles.slice(i - period + 1, i + 1);

    const highs = window.map(x => x.high);
    const lows = window.map(x => x.low);

    const high = Math.max(...highs);
    const low = Math.min(...lows);
    const close = candles[i].close;

    const range = high - low;

    const rsv = range === 0
      ? 50
      : ((close - low) / range) * 100;

    k = (2 * k + rsv) / 3;
    d = (2 * d + k) / 3;
  }

  const j = 3 * k - 2 * d;

  return {
    k,
    d,
    j
  };
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    trs.push(tr);
  }

  return average(trs.slice(-period));
}

function calculateIndicators(candles) {
  const closes = candles.map(x => x.close);
  const volumes = candles.map(x => x.volume);

  const price = closes[closes.length - 1];

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);

  const rsi14 = rsi(closes, 14);
  const macdData = macd(closes, 12, 26, 9);
  const kdjData = kdj(candles, 9);
  const boll = bollinger(closes, 20, 2);
  const atr14 = atr(candles, 14);

  const volumeAverage = volumes.length >= 20
    ? average(volumes.slice(-20))
    : average(volumes);

  const currentVolume = volumes[volumes.length - 1];

  const volumeRatio = volumeAverage
    ? currentVolume / volumeAverage
    : null;

  const atrPercent = atr14 && price
    ? (atr14 / price) * 100
    : null;

  let trend = "mixed";

  if (
    ema20 !== null &&
    ema50 !== null &&
    ema200 !== null
  ) {
    if (
      price > ema20 &&
      ema20 > ema50 &&
      ema50 > ema200
    ) {
      trend = "strong_bullish";
    } else if (
      price < ema20 &&
      ema20 < ema50 &&
      ema50 < ema200
    ) {
      trend = "strong_bearish";
    } else if (
      price > ema50 &&
      ema20 > ema50
    ) {
      trend = "bullish";
    } else if (
      price < ema50 &&
      ema20 < ema50
    ) {
      trend = "bearish";
    }
  }

  return {
    price,

    ema20,
    ema50,
    ema200,

    rsi14,

    macd: macdData.macd,
    macdSignal: macdData.signal,
    macdHistogram: macdData.histogram,

    k: kdjData.k,
    d: kdjData.d,
    j: kdjData.j,

    bollMiddle: boll.middle,
    bollUpper: boll.upper,
    bollLower: boll.lower,
    bollWidth: boll.width,

    atr14,
    atrPercent,

    volume: currentVolume,
    volumeAverage,
    volumeRatio,

    trend
  };
}

function quantVote(indicators) {
  let score = 0;
  const reasons = [];

  const {
    price,
    ema20,
    ema50,
    ema200,
    rsi14,
    macd: macdValue,
    macdSignal,
    macdHistogram,
    k,
    d,
    bollUpper,
    bollLower,
    volumeRatio
  } = indicators;

  // 趋势：最高 +3 / -3
  if (
    price !== null &&
    ema20 !== null &&
    ema50 !== null &&
    ema200 !== null
  ) {
    if (
      price > ema20 &&
      ema20 > ema50 &&
      ema50 > ema200
    ) {
      score += 3;
      reasons.push("价格位于 EMA20/50/200 上方，均线多头排列");
    } else if (
      price < ema20 &&
      ema20 < ema50 &&
      ema50 < ema200
    ) {
      score -= 3;
      reasons.push("价格位于 EMA20/50/200 下方，均线空头排列");
    } else if (
      price > ema50 &&
      ema20 > ema50
    ) {
      score += 2;
      reasons.push("价格和短期均线仍高于 EMA50");
    } else if (
      price < ema50 &&
      ema20 < ema50
    ) {
      score -= 2;
      reasons.push("价格和短期均线仍低于 EMA50");
    } else {
      reasons.push("均线结构混合");
    }
  }

  // RSI
  if (rsi14 !== null) {
    if (rsi14 < 30) {
      score += 1;
      reasons.push(`RSI14=${rsi14.toFixed(1)}，进入超卖区域`);
    } else if (rsi14 > 70) {
      score -= 1;
      reasons.push(`RSI14=${rsi14.toFixed(1)}，进入超买区域`);
    } else if (rsi14 >= 50) {
      score += 1;
      reasons.push(`RSI14=${rsi14.toFixed(1)}，动能偏强`);
    } else {
      score -= 1;
      reasons.push(`RSI14=${rsi14.toFixed(1)}，动能偏弱`);
    }
  }

  // MACD
  if (
    macdValue !== null &&
    macdSignal !== null &&
    macdHistogram !== null
  ) {
    if (macdValue > macdSignal && macdHistogram > 0) {
      score += 1;
      reasons.push("MACD 位于信号线上方，动能偏多");
    } else if (macdValue < macdSignal && macdHistogram < 0) {
      score -= 1;
      reasons.push("MACD 位于信号线下方，动能偏空");
    } else {
      reasons.push("MACD 动能处于混合状态");
    }
  }

  // KDJ
  if (k !== null && d !== null) {
    if (k > d) {
      score += 1;
      reasons.push("KDJ K 线上穿 D 线，短线动能偏多");
    } else if (k < d) {
      score -= 1;
      reasons.push("KDJ K 线低于 D 线，短线动能偏空");
    }
  }

  // 布林带
  if (
    price !== null &&
    bollUpper !== null &&
    bollLower !== null
  ) {
    if (price > bollUpper) {
      score -= 1;
      reasons.push("价格高于布林上轨，短线偏热");
    } else if (price < bollLower) {
      score += 1;
      reasons.push("价格低于布林下轨，短线出现超跌");
    }
  }

  // 成交量
  if (volumeRatio !== null) {
    if (volumeRatio >= 1.5) {
      reasons.push(`成交量约为20周期均量的 ${volumeRatio.toFixed(2)} 倍，市场活动明显放大`);
    } else if (volumeRatio <= 0.6) {
      reasons.push(`成交量约为20周期均量的 ${volumeRatio.toFixed(2)} 倍，市场活动偏低`);
    }
  }

  score = clamp(score, -7, 7);

  let vote = "neutral";

  if (score >= 2) {
    vote = "bullish";
  } else if (score <= -2) {
    vote = "bearish";
  }

  return {
    score,
    maxScore: 7,
    minScore: -7,
    vote,
    reasons
  };
}

function calculateRisk(indicators) {
  const atrPercent = indicators.atrPercent;
  const bollWidth = indicators.bollWidth;

  let riskScore = 0;

  if (atrPercent !== null) {
    if (atrPercent >= 5) {
      riskScore += 2;
    } else if (atrPercent >= 3) {
      riskScore += 1;
    }
  }

  if (bollWidth !== null) {
    if (bollWidth >= 12) {
      riskScore += 2;
    } else if (bollWidth >= 7) {
      riskScore += 1;
    }
  }

  let level = "low";

  if (riskScore >= 3) {
    level = "high";
  } else if (riskScore >= 1) {
    level = "medium";
  }

  return {
    level,
    score: riskScore,
    atrPercent,
    bollWidth,
    methodology: "ATR波动率 + 布林带宽度的简单风险分级"
  };
}

function parseInterval(value) {
  const map = {
    "1": 1,
    "5": 5,
    "15": 15,
    "30": 30,
    "60": 60,
    "1h": 60,
    "240": 240,
    "4h": 240,
    "1440": 1440,
    "1d": 1440
  };

  return map[String(value).toLowerCase()] || 60;
}

function normalizeSymbol(symbol) {
  const s = String(symbol || "BTCUSD").toUpperCase();

  const map = {
    BTCUSDT: "XBTUSD",
    BTCUSD: "XBTUSD",
    XBTUSD: "XBTUSD",
    ETHUSD: "ETHUSD",
    ETHUSDT: "ETHUSD",
    SOLUSD: "SOLUSD",
    SOLUSDT: "SOLUSD"
  };

  return map[s] || s;
}

async function fetchKraken(symbol, interval, limit = 300) {
  const pair = normalizeSymbol(symbol);

  const url =
    `https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=${interval}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "QuantVote/2.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Kraken HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.error && data.error.length) {
    throw new Error(data.error.join(", "));
  }

  const result = data.result || {};

  const key = Object.keys(result).find(
    k => k !== "last"
  );

  if (!key || !Array.isArray(result[key])) {
    throw new Error("Kraken returned no OHLC data");
  }

  let rows = result[key];

  if (limit > 0) {
    rows = rows.slice(-limit);
  }

  const candles = rows.map(row => ({
    time: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    vwap: Number(row[5]),
    volume: Number(row[6]),
    trades: Number(row[7])
  }));

  return {
    pair,
    candles
  };
}

async function marketEndpoint(url) {
  const symbol = url.searchParams.get("symbol") || "BTCUSD";
  const interval = parseInterval(
    url.searchParams.get("interval") || "60"
  );

  const requestedLimit = Number(
    url.searchParams.get("limit") || "300"
  );

  const limit = clamp(
    Number.isFinite(requestedLimit) ? requestedLimit : 300,
    20,
    720
  );

  const result = await fetchKraken(
    symbol,
    interval,
    limit
  );

  return {
    status: "ok",
    source: "kraken",
    symbol: String(symbol).toUpperCase(),
    pair: result.pair,
    interval,
    count: result.candles.length,
    candles: result.candles.map(c => [
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

async function voteEndpoint(url) {
  const symbol = url.searchParams.get("symbol") || "BTCUSD";
  const interval = parseInterval(
    url.searchParams.get("interval") || "60"
  );

  const result = await fetchKraken(
    symbol,
    interval,
    720
  );

  const candles = result.candles;

  if (candles.length < 50) {
    throw new Error(
      `K线数量不足，目前只有 ${candles.length} 根`
    );
  }

  const indicators = calculateIndicators(candles);
  const vote = quantVote(indicators);
  const risk = calculateRisk(indicators);

  return {
    status: "ok",
    source: "kraken",
    symbol: String(symbol).toUpperCase(),
    pair: result.pair,
    interval,
    timestamp: candles[candles.length - 1].time,
    price: indicators.price,
    indicators,
    score: vote.score,
    maxScore: vote.maxScore,
    minScore: vote.minScore,
    vote: vote.vote,
    risk: risk.level,
    riskDetail: risk,
    reasons: vote.reasons,
    methodology: {
      name: "QuantVote Technical Core V2",
      scoring: "EMA + RSI + MACD + KDJ + Bollinger + Volume",
      note: "这是规则化技术分析研究分数，不是价格预测，也不是投资建议。"
    }
  };
}

async function indicatorsEndpoint(url) {
  const symbol = url.searchParams.get("symbol") || "BTCUSD";
  const interval = parseInterval(
    url.searchParams.get("interval") || "60"
  );

  const result = await fetchKraken(
    symbol,
    interval,
    720
  );

  const indicators = calculateIndicators(
    result.candles
  );

  return {
    status: "ok",
    source: "kraken",
    symbol: String(symbol).toUpperCase(),
    pair: result.pair,
    interval,
    timestamp: result.candles[result.candles.length - 1].time,
    indicators
  };
}

async function multiEndpoint(url) {
  const symbol = url.searchParams.get("symbol") || "BTCUSD";

  const periods = [
    {
      key: "15m",
      interval: 15
    },
    {
      key: "1H",
      interval: 60
    },
    {
      key: "4H",
      interval: 240
    },
    {
      key: "1D",
      interval: 1440
    }
  ];

  const results = [];

  for (const period of periods) {
    try {
      const result = await fetchKraken(
        symbol,
        period.interval,
        720
      );

      const indicators = calculateIndicators(
        result.candles
      );

      const vote = quantVote(indicators);
      const risk = calculateRisk(indicators);

      results.push({
        timeframe: period.key,
        interval: period.interval,
        status: "ok",
        source: "kraken",
        pair: result.pair,
        timestamp:
          result.candles[result.candles.length - 1].time,
        price: indicators.price,
        indicators,
        score: vote.score,
        maxScore: vote.maxScore,
        minScore: vote.minScore,
        vote: vote.vote,
        risk: risk.level,
        riskDetail: risk,
        reasons: vote.reasons
      });
    } catch (e) {
      results.push({
        timeframe: period.key,
        interval: period.interval,
        status: "error",
        error: e.message
      });
    }
  }

  const valid = results.filter(
    x => x.status === "ok"
  );

  const totalScore = valid.length
    ? valid.reduce((sum, x) => sum + x.score, 0)
    : 0;

  const averageScore = valid.length
    ? totalScore / valid.length
    : 0;

  let overallVote = "neutral";

  if (averageScore >= 1.5) {
    overallVote = "bullish";
  } else if (averageScore <= -1.5) {
    overallVote = "bearish";
  }

  return {
    status: "ok",
    source: "kraken",
    symbol: String(symbol).toUpperCase(),
    timeframes: results,
    summary: {
      validTimeframes: valid.length,
      totalTimeframes: results.length,
      averageScore,
      overallVote
    },
    methodology: {
      name: "QuantVote Multi-Timeframe Core V2",
      note: "不同周期独立计算后进行简单汇总，不代表未来价格预测。"
    }
  };
}

async function regimeEndpoint(url) {
  const symbol = url.searchParams.get("symbol") || "BTCUSD";
  const interval = parseInterval(
    url.searchParams.get("interval") || "60"
  );

  const result = await fetchKraken(
    symbol,
    interval,
    720
  );

  const indicators = calculateIndicators(
    result.candles
  );

  let regime = "mixed";

  if (
    indicators.trend === "strong_bullish"
  ) {
    regime = "bull_trend";
  } else if (
    indicators.trend === "bullish"
  ) {
    regime = "bullish";
  } else if (
    indicators.trend === "strong_bearish"
  ) {
    regime = "bear_trend";
  } else if (
    indicators.trend === "bearish"
  ) {
    regime = "bearish";
  }

  return {
    status: "ok",
    source: "kraken",
    symbol: String(symbol).toUpperCase(),
    interval,
    regime,
    trend: indicators.trend,
    volatility: {
      atrPercent: indicators.atrPercent,
      bollWidth: indicators.bollWidth
    }
  };
}

async function backtestEndpoint(url) {
  const symbol = url.searchParams.get("symbol") || "BTCUSD";
  const interval = parseInterval(
    url.searchParams.get("interval") || "60"
  );

  const result = await fetchKraken(
    symbol,
    interval,
    720
  );

  const candles = result.candles;

  if (candles.length < 100) {
    throw new Error("历史K线不足，无法进行基础回测");
  }

  let position = 0;
  let entry = 0;
  let equity = 1;
  let trades = 0;
  let wins = 0;

  const equityCurve = [];

  for (let i = 60; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1);

    const indicators = calculateIndicators(slice);
    const vote = quantVote(indicators);

    const price = candles[i].close;

    if (position === 0) {
      if (vote.score >= 3) {
        position = 1;
        entry = price;
        trades++;
      }
    } else {
      if (vote.score <= 0) {
        const returnPct = (price - entry) / entry;

        equity *= (1 + returnPct);

        if (returnPct > 0) {
          wins++;
        }

        position = 0;
        entry = 0;
      }
    }

    equityCurve.push({
      time: candles[i].time,
      equity
    });
  }

  if (position === 1) {
    const price = candles[candles.length - 1].close;
    const returnPct = (price - entry) / entry;

    equity *= (1 + returnPct);

    if (returnPct > 0) {
      wins++;
    }
  }

  const totalReturn = (equity - 1) * 100;

  const winRate = trades > 0
    ? (wins / trades) * 100
    : 0;

  return {
    status: "ok",
    source: "kraken",
    symbol: String(symbol).toUpperCase(),
    interval,
    candles: candles.length,
    result: {
      initialEquity: 1,
      finalEquity: equity,
      totalReturnPercent: totalReturn,
      trades,
      wins,
      winRatePercent: winRate
    },
    methodology: {
      name: "QuantVote Basic Backtest",
      entry: "score >= 3",
      exit: "score <= 0",
      position: "long only",
      fees: "not included",
      slippage: "not included",
      note: "这是基础历史模拟，不代表未来表现。"
    },
    equityCurve
  };
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return corsOptions();
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/" || path === "") {
        return json({
          status: "ok",
          service: "QuantVote",
          version: "v2-worker",
          source: "kraken",
          endpoints: [
            "/api/health",
            "/api/market",
            "/api/indicators",
            "/api/vote",
            "/api/multi",
            "/api/regime",
            "/api/backtest"
          ]
        });
      }

      if (path === "/api/health") {
        return json({
          status: "ok",
          service: "QuantVote",
          version: "v2-worker",
          data_source: "kraken-public-api",
          engine: "worker-native-technical-core"
        });
      }

      if (path === "/api/market") {
        return json(
          await marketEndpoint(url)
        );
      }

      if (path === "/api/indicators") {
        return json(
          await indicatorsEndpoint(url)
        );
      }

      if (path === "/api/vote") {
        return json(
          await voteEndpoint(url)
        );
      }

      if (path === "/api/multi") {
        return json(
          await multiEndpoint(url)
        );
      }

      if (path === "/api/regime") {
        return json(
          await regimeEndpoint(url)
        );
      }

      if (path === "/api/backtest") {
        return json(
          await backtestEndpoint(url)
        );
      }

      return error(
        "Not Found",
        404,
        {
          path,
          available: [
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
    } catch (e) {
      return error(
        e?.message || "Internal Error",
        500
      );
    }
  }
};
