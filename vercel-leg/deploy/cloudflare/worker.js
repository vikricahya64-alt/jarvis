//=============================================================================
// J.A.R.V.I.S. — Cloudflare Worker: latency-based routing + circuit breaker
// to Tailscale Funnel nodes. Request-driven, free tier, no credit card.
//=============================================================================

// Parse the routing table from wrangler `vars`.
let FUNNEL_HOSTS = [];
try {
  FUNNEL_HOSTS = JSON.parse(env.FUNNEL_HOSTS_JSON);
} catch (e) {
  FUNNEL_HOSTS = [];
}
const FALLBACK = env.FUNNEL_FALLBACK || "";
const CBURN_LIMIT = parseInt(env.CBURNS || "3", 10);

// Per-host consecutive-failure counters (module-level, volatile per isolate —
// enough for a coarse circuit breaker under normal free usage).
const circuit = new Map();

function mark_fail(host) {
  circuit.set(host, (circuit.get(host) || 0) + 1);
}
function mark_ok(host) {
  circuit.set(host, 0);
}
function is_open(host) {
  return (circuit.get(host) || 0) >= CBURN_LIMIT;
}

// Choose the nearest node for the viewer's region (request.cf fields).
function pickNode(request) {
  const country = (request.cf && request.cf.country) || "";
  const colo = (request.cf && request.cf.colo) || "";
  let candidates = [];
  // exact colo match first
  candidates = FUNNEL_HOSTS.filter(n => (n.colo || []).includes(colo));
  if (!candidates.length) {
    // then country/region
    candidates = FUNNEL_HOSTS.filter(n => n.region === country);
  }
  if (!candidates.length) {
    candidates = FUNNEL_HOSTS;
  }
  // circuit breaker: prefer first non-open host
  for (const n of candidates) {
    if (!is_open(n.host)) return n.host;
  }
  // all candidate nodes open -> fallback (if configured)
  return FALLBACK || (candidates.length ? candidates[0].host : null);
}

export default {
  async fetch(request, env) {
    FUNNEL_HOSTS = [];
    try { FUNNEL_HOSTS = JSON.parse(env.FUNNEL_HOSTS_JSON); } catch (e) {}
    const host = pickNode(request);
    if (!host) {
      return new Response(JSON.stringify({ ok: false, error: "no_node" }),
                          { status: 503, headers: { "content-type": "application/json" } });
    }

    // Build the proxied URL, preserving path + query. Optional: rewrite
    // /healthz to the node's health/probe path.
    const url = new URL(request.url);
    const target = new URL(host);
    target.pathname = url.pathname || target.pathname;
    target.search = url.search;

    const headers = new Headers(request.headers);
    headers.set("x-jarvis-viewer-colo", request.cf?.colo || "");
    headers.set("x-jarvis-viewer-country", request.cf?.country || "");

    try {
      const resp = await fetch(new Request(target.toString(), {
        method: request.method,
        headers,
        body: (["GET", "HEAD"].includes(request.method)) ? undefined : request.body,
        redirect: "manual",
      }));
      mark_ok(host);
      return new Response(resp.body, {
        status: resp.status,
        headers: resp.headers,
      });
    } catch (e) {
      mark_fail(host);
      return new Response(JSON.stringify({ ok: false, error: "node_unreachable",
                                          node: host }),
                          { status: 502, headers: { "content-type": "application/json" } });
    }
  },
};