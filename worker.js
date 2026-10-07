export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return json({
        status: "ok",
        service: "quantvote",
        version: "cloudflare-v3"
      });
    }

    if (url.pathname === "/api/health") {
      return json({
        status: "ok",
        service: "quantvote",
        version: "cloudflare-v3",
        data_source: "binance-public-api"
      });
    }

    if (url.pathname === "/api/market") {
      const symbol =
        (url.searchParams.get("symbol") || "BTCUSDT").toUpperCase();

      const interval =
        url.searchParams.get("interval") || "1h";

      const limit = Math.min(
        Number(url.searchParams.get("limit") || 100),
        1000
      );

      const target =
        "https://data-api.binance.vision/api/v3/klines" +
        "?symbol=" + encodeURIComponent(symbol) +
        "&interval=" + encodeURIComponent(interval) +
        "&limit=" + limit;

      try {
        const response = await fetch(target, {
          headers: {
            "User-Agent": "QuantVote-Cloudflare"
          }
        });

        const data = await response.text();

        return new Response(data, {
          status: response.status,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store"
          }
        });
      } catch (error) {
        return json(
          {
            status: "error",
            error: String(error)
          },
          502
        );
      }
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


function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
