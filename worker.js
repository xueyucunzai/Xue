export default {
  async fetch(request) {
    const url = new URL(request.url);

    // =========================================================
    // 首页
    // =========================================================
    if (url.pathname === "/") {
      return json({
        status: "ok",
        service: "quantvote",
        version: "cloudflare-v4"
      });
    }

    // =========================================================
    // 健康检查
    // =========================================================
    if (url.pathname === "/api/health") {
      return json({
        status: "ok",
        service: "quantvote",
        version: "cloudflare-v4",
        data_source: "kraken-public-api"
      });
    }

    // =========================================================
    // 原始市场数据
    // =========================================================
    if (url.pathname === "/api/market") {
      return await handleMarket(url);
    }

    // =========================================================
    // 技术指标
    // =========================================================
    if (url.pathname === "/api/indicators") {
      return await handleIndicators(url);
    }

    // =========================================================
    // 404
    // =========================================================
    return json(
      {
        status: "error",
        error: "Not Found"
      },
      404
    );
  }
};


// =========================================================
// /api/market
// =========================================================

async function handleMarket(url) {
  const symbol =
    (url.searchParams.get("symbol") || "BTCUSD").toUpperCase();

  const interval =
    url.searchParams.get("interval") || "60";

  const limit = clamp(
    Number(url.searchParams.get("limit") || 100),
    1,
    720
  );

  const pair = normalizeKrakenPair(symbol);

  const krakenUrl =
    "https://api.kraken.com/0/public/OHLC" +
    "?pair=" +
    encodeURIComponent(pair) +
    "&interval=" +
    encodeURIComponent(interval);

  try {
    const response = await fetch(krakenUrl, {
      headers: {
        "User-Agent": "QuantVote-Cloudflare"
      }
    });

    const text = await response.text();

    if (!response.ok) {
      return json(
        {
          status: "error",
          source: "kraken",
          http_status: response.status,
          detail: text
        },
        response.status
      );
    }

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      return json(
        {
          status: "error",
          source: "kraken",
          error: "Invalid JSON response",
          detail: text
        },
        502
      );
    }

    if (data.error && data.error.length > 0) {
      return json(
        {
          status: "error",
          source: "kraken",
          error: data.error
        },
        502
      );
    }

    const result = data.result || {};

    const pairKey = Object.keys(result).find(
      key => key !== "last"
    );

    const candles = pairKey
      ? result[pairKey]
      : [];

    const selected = candles.slice(-limit);

    const normalized = selected.map(normalizeCandle);

    return json({
      status: "ok",
      source: "kraken",
      symbol,
      pair,
      interval: Number(interval),
      count: normalized.length,
      candles: normalized
    });

  } catch (error) {
    return json(
      {
        status: "error",
        source: "kraken",
        error: String(error)
      },
      502
    );
  }
}


// =========================================================
// /api/indicators
//
// 默认：
// BTCUSD
// 1小时
// EMA20 / EMA50 / EMA200
//
// 为了计算 EMA200，自动请求足够的历史K线。
// =========================================================

async function handleIndicators(url) {
  const symbol =
    (url.searchParams.get("symbol") || "BTCUSD").toUpperCase();

  const interval =
    url.searchParams.get("interval") || "60";

  const limit = clamp(
    Number(url.searchParams.get("limit") || 100),
    1,
    500
  );

  const pair = normalizeKrakenPair(symbol);

  // EMA200 需要至少 200 根数据。
  // 多取一些历史数据，让 EMA 更稳定。
  const fetchLimit = Math.min(
    Math.max(limit, 250),
    720
  );

  const krakenUrl =
    "https://api.kraken.com/0/public/OHLC" +
    "?pair=" +
    encodeURIComponent(pair) +
    "&interval=" +
    encodeURIComponent(interval);

  try {
    const response = await fetch(krakenUrl, {
      headers: {
        "User-Agent": "QuantVote-Cloudflare"
      }
    });

    const text = await response.text();

    if (!response.ok) {
      return json(
        {
          status: "error",
          source: "kraken",
          http_status: response.status,
          detail: text
        },
        response.status
      );
    }

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      return json(
        {
          status: "error",
          source: "kraken",
          error: "Invalid JSON response",
          detail: text
        },
        502
      );
    }

    if (data.error && data.error.length > 0) {
      return json(
        {
          status: "error",
          source: "kraken",
          error: data.error
        },
        502
      );
    }

    const result = data.result || {};

    const pairKey = Object.keys(result).find(
      key => key !== "last"
    );

    const rawCandles = pairKey
      ? result[pairKey]
      : [];

    const candles = rawCandles
      .map(normalizeCandle)
      .sort((a, b) => a.timestamp - b.timestamp);

    // -------------------------------------------------------
    // 收盘价
    // -------------------------------------------------------

    const closes = candles.map(candle => candle.close);

    // -------------------------------------------------------
    // EMA
    // -------------------------------------------------------

    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const ema200 = calculateEMA(closes, 200);

    // -------------------------------------------------------
    // 最终返回最近 limit 根
    // -------------------------------------------------------

    const startIndex = Math.max(
      0,
      candles.length - limit
    );

    const output = [];

    for (let i = startIndex; i < candles.length; i++) {
      output.push({
        ...candles[i],

        ema20:
          ema20[i] === null
            ? null
            : round(ema20[i], 4),

        ema50:
          ema50[i] === null
            ? null
            : round(ema50[i], 4),

        ema200:
          ema200[i] === null
            ? null
            : round(ema200[i], 4)
      });
    }

    const latest =
      output.length > 0
        ? output[output.length - 1]
        : null;

    return json({
      status: "ok",
      source: "kraken",
      symbol,
      pair,
      interval: Number(interval),

      indicators: [
        "EMA20",
        "EMA50",
        "EMA200"
      ],

      requested_limit: limit,
      fetched_candles: candles.length,
      returned_candles: output.length,

      latest,

      candles: output
    });

  } catch (error) {
    return json(
      {
        status: "error",
        source: "kraken",
        error: String(error)
      },
      502
    );
  }
}


// =========================================================
// Kraken → 标准 OHLCV
//
// Kraken 原始格式：
// [
//   time,
//   open,
//   high,
//   low,
//   close,
//   vwap,
//   volume,
//   count
// ]
// =========================================================

function normalizeCandle(candle) {
  return {
    timestamp: Number(candle[0]),
    time: new Date(
      Number(candle[0]) * 1000
    ).toISOString(),

    open: Number(candle[1]),
    high: Number(candle[2]),
    low: Number(candle[3]),
    close: Number(candle[4]),

    vwap: Number(candle[5]),
    volume: Number(candle[6]),
    trades: Number(candle[7])
  };
}


// =========================================================
// EMA
//
// EMA = Exponential Moving Average
//
// 第一个有效值从 period 开始。
// 这里使用 SMA 作为 EMA 初始值，
// 再按照标准 EMA 平滑公式计算。
// =========================================================

function calculateEMA(values, period) {
  const result = new Array(values.length).fill(null);

  if (values.length < period) {
    return result;
  }

  let sum = 0;

  for (let i = 0; i < period; i++) {
    sum += values[i];
  }

  let ema = sum / period;

  result[period - 1] = ema;

  const multiplier =
    2 / (period + 1);

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    ema =
      (values[i] - ema) *
        multiplier +
      ema;

    result[i] = ema;
  }

  return result;
}


// =========================================================
// BTCUSD → XBTUSD
// =========================================================

function normalizeKrakenPair(symbol) {
  if (symbol === "BTCUSD") {
    return "XBTUSD";
  }

  if (symbol === "BTCUSDT") {
    return "XBTUSDT";
  }

  return symbol;
}


// =========================================================
// 数字范围限制
// =========================================================

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(
    Math.max(value, min),
    max
  );
}


// =========================================================
// 小数处理
// =========================================================

function round(value, decimals) {
  const factor =
    Math.pow(10, decimals);

  return (
    Math.round(value * factor) /
    factor
  );
}


// =========================================================
// JSON Response
// =========================================================

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=utf-8",

        "cache-control":
          "no-store"
      }
    }
  );
}

替换后只测试这个

Commit → 等 Cloudflare 部署。

然后打开：

https://xue.xilongy41-8bd.workers.dev/api/indicators?symbol=BTCUSD&interval=60&limit=10

正常情况下，你应该看到：

status: ok
source: kraken
indicators:
  EMA20
  EMA50
  EMA200
latest:
  ...
candles:
  ...

先不要测试其他接口，也不要继续改代码。

把 "/api/indicators" 的完整结果发给我。我们先确认 EMA 引擎 是否正常，再进入 RSI / MACD。
