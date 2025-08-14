export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, url);
    }

    // Serve static assets from the configured assets directory
    return env.ASSETS.fetch(request);
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-store'
  };
}

async function handleApi(request, url) {
  const path = url.pathname.replace(/^\/api\//, '');
  let target;
  // Map known paths
  if (path === 'bootstrap-static' || path === 'bootstrap-static/') {
    target = 'https://fantasy.premierleague.com/api/bootstrap-static/';
  } else if (/^league\/(\d+)\/details\/?$/.test(path)) {
    const id = path.match(/^league\/(\d+)\/details\/?$/)[1];
    target = `https://draft.premierleague.com/api/league/${id}/details`;
  } else if (/^draft\/(\d+)\/choices\/?$/.test(path)) {
    const id = path.match(/^draft\/(\d+)\/choices\/?$/)[1];
    target = `https://draft.premierleague.com/api/draft/${id}/choices`;
  } else {
    return new Response('Not found', { status: 404, headers: corsHeaders() });
  }

  const upstream = await fetch(target, {
    method: 'GET',
    headers: { 'accept': 'application/json' },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  const resp = new Response(upstream.body, upstream);
  for (const [k, v] of Object.entries(corsHeaders())) {
    resp.headers.set(k, v);
  }
  return resp;
}


