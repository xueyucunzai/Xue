export default {
  async fetch(request) {
    const url = new URL(request.url);

    // 首页
    if (url.pathname === "/") {
      return json({
        status: "ok",
        service: "quantvote",
        version: "cloudflare-v2"
      });
    }

    // 健康检查
    if (url.pathname === "/api/health") {
      return json({
        status: "ok",
        service: "quantvote",
        version: "cloudflare-v2",
        data_source: "coingecko-public-api"
      });
    }

    // BTC 行情测试
    if (url.pathname === "/api/market") {
      try {
        const response = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
          {
            headers: {
              "User-Agent": "QuantVote-Cloudflare"
            }
          }
        );

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
