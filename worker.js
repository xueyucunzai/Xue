export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return new Response('QuantVote API proxy', { status: 404 });
    }

    const origin = 'https://xue-8e742.containers.snapdeploy.app';

    const target = origin + url.pathname + url.search;

    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.set('X-Forwarded-By', 'quantvote-cloudflare');

    try {
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        body:
          request.method === 'GET' || request.method === 'HEAD'
            ? undefined
            : request.body,
      });

      const out = new Response(upstream.body, upstream);
      out.headers.set('X-QuantVote-Proxy', 'cloudflare-worker');

      return out;
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: 'QuantVote upstream connection failed',
          detail: String(error),
        }),
        {
          status: 502,
          headers: {
            'content-type': 'application/json',
          },
        }
      );
    }
  },
};
