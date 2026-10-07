export default {
  async fetch(request) {
    const url = new URL(request.url);

    // =========================
    // 首页
    // =========================
    if (url.pathname === "/") {
      return json({
        status: "ok",
        service: "quantvote",
        version: "cloudflare-kraken-v1"
      });
    }

    // =========================
    // 健康检查
    // =========================
    if (url.pathname === "/api/health") {
      return json({
        status: "ok",
        service: "quantvote",
        version: "cloudflare-kraken-v1",
        data_source: "kraken-public-api"
      });
    }

    // =========================
    // 市场数据
    // =========================
    if (url.pathname === "/api/market") {
      const symbol =
        (url.searchParams.get("symbol") || "BTCUSD").toUpperCase();

      const interval =
        url.searchParams.get("interval") || "60";

      const limit = Math.min(
        Math.max(
          Number(url.searchParams.get("limit") || 100),
          1
        ),
        720
      );

      // Kraken:
      // BTCUSD -> XBTUSD
      const pair =
        symbol === "BTCUSD"
          ? "XBTUSD"
          : symbol;

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

        // Kraken API 自己报告错误
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

        // 只保留请求数量
        const selected = candles.slice(-limit);

        return json({
          status: "ok",
          source: "kraken",
          symbol: symbol,
          pair: pair,
          interval: Number(interval),
          count: selected.length,
          candles: selected
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

    // =========================
    // 404
    // =========================
    return json(
      {
        status: "error",
        error: "Not Found"
      },
      404
    );
  }
};


// =========================
// JSON 工具
// =========================
function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    }
  );
}
