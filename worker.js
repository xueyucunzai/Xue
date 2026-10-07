export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return json({
        status: "ok",
        service: "quantvote",
        version: "cloudflare-v5"
      });
    }

    if (url.pathname === "/api/health") {
      return json({
        status: "ok",
        service: "quantvote",
        version: "cloudflare-v5",
        data_source: "kraken-public-api"
      });
    }

    if (url.pathname === "/api/market") {
      return await handleMarket(url);
    }

    if (url.pathname === "/api/indicators") {
      return await handleIndicators(url);
    }

    if (url.pathname === "/api/vote") {
      return await handleVote(url);
    }

    return json(
      {
        status: "error",
        error: "Not Found"
      },
      404
    );
  }
};

async function getKrakenCandles(symbol, interval) {
  const pair = normalizeKrakenPair(symbol);

  const krakenUrl =
    "https://api.kraken.com/0/public/OHLC" +
    "?pair=" +
    encodeURIComponent(pair) +
    "&interval=" +
    encodeURIComponent(interval);

  const response = await fetch(krakenUrl, {
    headers: {
      "User-Agent": "QuantVote-Cloudflare"
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      "Kraken HTTP " +
      response.status +
      ": " +
      text
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Kraken returned invalid JSON");
  }

  if (data.error && data.error.length > 0) {
    throw new Error(
      "Kraken API error: " +
      data.error.join(", ")
    );
  }

  const result = data.result || {};

  const pairKey = Object.keys(result).find(
    key => key !== "last"
  );

  if (!pairKey) {
    throw new Error("Kraken returned no candle data");
  }

  return {
    pair: pairKey,
    candles: result[pairKey]
      .map(normalizeCandle)
      .sort(
        (a, b) =>
          a.timestamp - b.timestamp
      )
  };
}

async function handleMarket(url) {
  const symbol =
    (
      url.searchParams.get("symbol") ||
      "BTCUSD"
    ).toUpperCase();

  const interval =
    url.searchParams.get("interval") ||
    "60";

  const limit = clamp(
    Number(
      url.searchParams.get("limit") ||
      100
    ),
    1,
    720
  );

  try {
    const market =
      await getKrakenCandles(
        symbol,
        interval
      );

    const candles =
      market.candles.slice(-limit);

    return json({
      status: "ok",
      source: "kraken",
      symbol,
      pair: normalizeKrakenPair(symbol),
      interval: Number(interval),
      count: candles.length,
      candles
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

async function handleIndicators(url) {
  const symbol =
    (
      url.searchParams.get("symbol") ||
      "BTCUSD"
    ).toUpperCase();

  const interval =
    url.searchParams.get("interval") ||
    "60";

  const limit = clamp(
    Number(
      url.searchParams.get("limit") ||
      100
    ),
    1,
    500
  );

  try {
    const market =
      await getKrakenCandles(
        symbol,
        interval
      );

    const candles = market.candles;

    const closes =
      candles.map(c => c.close);

    const ema20 =
      calculateEMA(closes, 20);

    const ema50 =
      calculateEMA(closes, 50);

    const ema200 =
      calculateEMA(closes, 200);

    const rsi14 =
      calculateRSI(closes, 14);

    const macd =
      calculateMACD(closes);

    const bollinger =
      calculateBollinger(
        candles,
        20,
        2
      );

    const kdj =
      calculateKDJ(
        candles,
        9,
        3,
        3
      );

    const start =
      Math.max(
        0,
        candles.length - limit
      );

    const output = [];

    for (
      let i = start;
      i < candles.length;
      i++
    ) {
      output.push({
        ...candles[i],

        ema20: valueOrNull(
          ema20[i]
        ),

        ema50: valueOrNull(
          ema50[i]
        ),

        ema200: valueOrNull(
          ema200[i]
        ),

        rsi14: valueOrNull(
          rsi14[i]
        ),

        macd: {
          macd: valueOrNull(
            macd.macd[i]
          ),
          signal: valueOrNull(
            macd.signal[i]
          ),
          histogram:
            valueOrNull(
              macd.histogram[i]
            )
        },

        bollinger: {
          middle:
            valueOrNull(
              bollinger.middle[i]
            ),
          upper:
            valueOrNull(
              bollinger.upper[i]
            ),
          lower:
            valueOrNull(
              bollinger.lower[i]
            )
        },

        kdj: {
          k:
            valueOrNull(
              kdj.k[i]
            ),
          d:
            valueOrNull(
              kdj.d[i]
            ),
          j:
            valueOrNull(
              kdj.j[i]
            )
        }
      });
    }

    const latest =
      output.length > 0
        ? output[
            output.length - 1
          ]
        : null;

    return json({
      status: "ok",
      source: "kraken",
      symbol,
      pair: normalizeKrakenPair(
        symbol
      ),
      interval: Number(interval),

      indicators: [
        "EMA20",
        "EMA50",
        "EMA200",
        "RSI14",
        "MACD",
        "BOLL",
        "KDJ"
      ],

      fetched_candles:
        candles.length,

      returned_candles:
        output.length,

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

async function handleVote(url) {
  const symbol =
    (
      url.searchParams.get("symbol") ||
      "BTCUSD"
    ).toUpperCase();

  const interval =
    url.searchParams.get("interval") ||
    "60";

  try {
    const market =
      await getKrakenCandles(
        symbol,
        interval
      );

    const candles =
      market.candles;

    const closes =
      candles.map(c => c.close);

    const ema20 =
      calculateEMA(closes, 20);

    const ema50 =
      calculateEMA(closes, 50);

    const ema200 =
      calculateEMA(closes, 200);

    const rsi =
      calculateRSI(
        closes,
        14
      );

    const macd =
      calculateMACD(closes);

    const latestIndex =
      candles.length - 1;

    if (
      latestIndex < 200 ||
      ema200[latestIndex] === null
    ) {
      return json({
        status: "error",
        error:
          "Not enough candle data for EMA200",
        candles:
          candles.length,
        required: 200
      }, 422);
    }

    const price =
      closes[latestIndex];

    const e20 =
      ema20[latestIndex];

    const e50 =
      ema50[latestIndex];

    const e200 =
      ema200[latestIndex];

    const r =
      rsi[latestIndex];

    const m =
      macd.macd[latestIndex];

    const s =
      macd.signal[latestIndex];

    let score = 0;

    if (price > e20) {
      score += 1;
    } else {
      score -= 1;
    }

    if (e20 > e50) {
      score += 1;
    } else {
      score -= 1;
    }

    if (e50 > e200) {
      score += 1;
    } else {
      score -= 1;
    }

    if (r >= 55) {
      score += 1;
    } else if (r <= 45) {
      score -= 1;
    }

    if (m > s) {
      score += 1;
    } else {
      score -= 1;
    }

    let vote;

    if (score >= 3) {
      vote = "bullish";
    } else if (score <= -3) {
      vote = "bearish";
    } else {
      vote = "neutral";
    }

    let risk = "medium";

    if (
      r >= 70 ||
      r <= 30
    ) {
      risk = "high";
    }

    if (
      Math.abs(score) <= 1
    ) {
      risk = "medium";
    }

    if (
      Math.abs(score) >= 4 &&
      r > 35 &&
      r < 65
    ) {
      risk = "low";
    }

    return json({
      status: "ok",
      source: "kraken",

      symbol,

      pair:
        normalizeKrakenPair(
          symbol
        ),

      interval:
        Number(interval),

      timestamp:
        candles[latestIndex]
          .timestamp,

      price:
        round(price, 4),

      indicators: {
        ema20:
          round(e20, 4),

        ema50:
          round(e50, 4),

        ema200:
          round(e200, 4),

        rsi14:
          round(r, 2),

        macd:
          round(m, 4),

        macdSignal:
          round(s, 4),

        macdHistogram:
          round(
            m - s,
            4
          )
      },

      score,

      vote,

      risk,

      interpretation: {
        trend:
          price > e200
            ? "above_ema200"
            : "below_ema200",

        shortTerm:
          e20 > e50
            ? "bullish"
            : "bearish",

        momentum:
          m > s
            ? "bullish"
            : "bearish"
      },

      methodology: {
        name:
          "QuantVote Technical Core",

        scoring:
          "EMA trend + RSI momentum + MACD momentum",

        maxScore: 5,

        minScore: -5,

        note:
          "This is a rule-based analytical score, not investment advice."
      }
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

function normalizeCandle(candle) {
  return {
    timestamp:
      Number(candle[0]),

    time:
      new Date(
        Number(candle[0]) * 1000
      ).toISOString(),

    open:
      Number(candle[1]),

    high:
      Number(candle[2]),

    low:
      Number(candle[3]),

    close:
      Number(candle[4]),

    vwap:
      Number(candle[5]),

    volume:
      Number(candle[6]),

    trades:
      Number(candle[7])
  };
}

function calculateEMA(
  values,
  period
) {
  const result =
    new Array(
      values.length
    ).fill(null);

  if (
    values.length < period
  ) {
    return result;
  }

  let sum = 0;

  for (
    let i = 0;
    i < period;
    i++
  ) {
    sum += values[i];
  }

  let ema =
    sum / period;

  result[
    period - 1
  ] = ema;

  const multiplier =
    2 /
    (period + 1);

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    ema =
      (
        values[i] - ema
      ) *
        multiplier +
      ema;

    result[i] = ema;
  }

  return result;
}

function calculateRSI(
  values,
  period
) {
  const result =
    new Array(
      values.length
    ).fill(null);

  if (
    values.length <= period
  ) {
    return result;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    const change =
      values[i] -
      values[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses -= change;
    }
  }

  let averageGain =
    gains / period;

  let averageLoss =
    losses / period;

  result[period] =
    calculateRSIValue(
      averageGain,
      averageLoss
    );

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const change =
      values[i] -
      values[i - 1];

    const gain =
      change > 0
        ? change
        : 0;

    const loss =
      change < 0
        ? -change
        : 0;

    averageGain =
      (
        averageGain *
          (period - 1) +
        gain
      ) /
      period;

    averageLoss =
      (
        averageLoss *
          (period - 1) +
        loss
      ) /
      period;

    result[i] =
      calculateRSIValue(
        averageGain,
        averageLoss
      );
  }

  return result;
}

function calculateRSIValue(
  averageGain,
  averageLoss
) {
  if (
    averageLoss === 0
  ) {
    return 100;
  }

  const rs =
    averageGain /
    averageLoss;

  return (
    100 -
    100 /
      (1 + rs)
  );
}

function calculateMACD(
  values
) {
  const ema12 =
    calculateEMA(
      values,
      12
    );

  const ema26 =
    calculateEMA(
      values,
      26
    );

  const macd =
    new Array(
      values.length
    ).fill(null);

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    if (
      ema12[i] !== null &&
      ema26[i] !== null
    ) {
      macd[i] =
        ema12[i] -
        ema26[i];
    }
  }

  const validMacd =
    macd.filter(
      value =>
        value !== null
    );

  const signalValid =
    calculateEMA(
      validMacd,
      9
    );

  const signal =
    new Array(
      values.length
    ).fill(null);

  let validIndex = 0;

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    if (
      macd[i] !== null
    ) {
      signal[i] =
        signalValid[
          validIndex
        ] ?? null;

      validIndex++;
    }
  }

  const histogram =
    new Array(
      values.length
    ).fill(null);

  for (
    let i = 0;
    i < values.length;
    i++
  ) {
    if (
      macd[i] !== null &&
      signal[i] !== null
    ) {
      histogram[i] =
        macd[i] -
        signal[i];
    }
  }

  return {
    macd,
    signal,
    histogram
  };
}

function calculateBollinger(
  candles,
  period,
  multiplier
) {
  const middle =
    new Array(
      candles.length
    ).fill(null);

  const upper =
    new Array(
      candles.length
    ).fill(null);

  const lower =
    new Array(
      candles.length
    ).fill(null);

  for (
    let i = period - 1;
    i < candles.length;
    i++
  ) {
    const values =
      candles
        .slice(
          i - period + 1,
          i + 1
        )
        .map(
          candle =>
            candle.close
        );

    const mean =
      values.reduce(
        (a, b) =>
          a + b,
        0
      ) / period;

    let variance = 0;

    for (
      const value of values
    ) {
      variance +=
        Math.pow(
          value - mean,
          2
        );
    }

    variance /=
      period;

    const standardDeviation =
      Math.sqrt(
        variance
      );

    middle[i] = mean;

    upper[i] =
      mean +
      multiplier *
        standardDeviation;

    lower[i] =
      mean -
      multiplier *
        standardDeviation;
  }

  return {
    middle,
    upper,
    lower
  };
}

function calculateKDJ(
  candles,
  period,
  kPeriod,
  dPeriod
) {
  const rawK =
    new Array(
      candles.length
    ).fill(null);

  const k =
    new Array(
      candles.length
    ).fill(null);

  const d =
    new Array(
      candles.length
    ).fill(null);

  const j =
    new Array(
      candles.length
    ).fill(null);

  let previousK = 50;
  let previousD = 50;

  for (
    let i = period - 1;
    i < candles.length;
    i++
  ) {
    const window =
      candles.slice(
        i - period + 1,
        i + 1
      );

    const highestHigh =
      Math.max(
        ...window.map(
          c => c.high
        )
      );

    const lowestLow =
      Math.min(
        ...window.map(
          c => c.low
        )
      );

    const close =
      candles[i].close;

    let rsv = 50;

    if (
      highestHigh !==
      lowestLow
    ) {
      rsv =
        (
          (close -
            lowestLow) /
          (highestHigh -
            lowestLow)
        ) *
        100;
    }

    rawK[i] = rsv;

    const currentK =
      (
        2 * previousK +
        rsv
      ) / 3;

    const currentD =
      (
        2 * previousD +
        currentK
      ) / 3;

    const currentJ =
      3 * currentK -
      2 * currentD;

    k[i] = currentK;
    d[i] = currentD;
    j[i] = currentJ;

    previousK =
      currentK;

    previousD =
      currentD;
  }

  return {
    k,
    d,
    j
  };
}

function normalizeKrakenPair(
  symbol
) {
  if (
    symbol === "BTCUSD"
  ) {
    return "XBTUSD";
  }

  if (
    symbol === "BTCUSDT"
  ) {
    return "XBTUSDT";
  }

  return symbol;
}

function clamp(
  value,
  min,
  max
) {
  if (
    !Number.isFinite(value)
  ) {
    return min;
  }

  return Math.min(
    Math.max(
      value,
      min
    ),
    max
  );
}

function valueOrNull(
  value
) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value)
  ) {
    return null;
  }

  return round(
    value,
    6
  );
}

function round(
  value,
  decimals
) {
  const factor =
    Math.pow(
      10,
      decimals
    );

  return (
    Math.round(
      value * factor
    ) / factor
  );
}

function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
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
