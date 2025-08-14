export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		// CORS preflight for API routes
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders() });
		}

		if (url.pathname.startsWith('/api/')) {
			return proxyApi(request, url);
		}

		// Serve static assets (Pages provides ASSETS binding automatically)
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

async function proxyApi(request, url) {
	const path = url.pathname.replace(/^\/api\//, '');
	let target;

	if (path === 'bootstrap-static' || path === 'bootstrap-static/') {
		target = 'https://fantasy.premierleague.com/api/bootstrap-static/';
	} else if (/^league\/(\d+)\/details\/?$/.test(path)) {
		const id = path.match(/^league\/(\d+)\/details\/?$/)[1];
		target = `https://draft.premierleague.com/api/league/${id}/details`;
	} else if (/^draft\/(\d+)\/choices\/?$/.test(path)) {
		const id = path.match(/^draft\/(\d+)\/choices\/?$/)[1];
		target = `https://draft.premierleague.com/api/draft/${id}/choices`;
	}

	if (!target) {
		return new Response('Not found', { status: 404, headers: corsHeaders() });
	}

	try {
		const upstream = await fetch(target, {
			method: 'GET',
			headers: { accept: 'application/json' },
			cf: { cacheTtl: 0, cacheEverything: false }
		});
		const resp = new Response(upstream.body, upstream);
		const headers = corsHeaders();
		for (const [k, v] of Object.entries(headers)) resp.headers.set(k, v);
		return resp;
	} catch (err) {
		return new Response('Upstream error', { status: 502, headers: corsHeaders() });
	}
}


