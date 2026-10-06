export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return new Response('QuantVote API proxy', { status: 404 });
    }
    const origin = (env.QUANT_ENGINE_URL || '').replace(/\/$/, '');
    if (!origin) return new Response('QUANT_ENGINE_URL is not configured', { status: 503 });
    const target = origin + url.pathname + url.search;
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.set('X-Forwarded-By', 'quantvote-cloudflare');
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    });
    const out = new Response(upstream.body, upstream);
    out.headers.set('X-QuantVote-Proxy', 'cloudflare-worker');
    return out;
  }
};
