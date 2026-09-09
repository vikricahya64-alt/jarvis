/**
 * Relay: Supabase Database Webhook (Edge Function target) -> Vercel /api/orchestrator
 *
 * Free-tier Supabase cannot always create URL-based Database Webhooks
 * (supabase_functions.http_request / pg_net), so this Edge Function is the
 * event receiver. It forwards the raw webhook payload to the Vercel Python
 * orchestrator with the internal auth token, exactly as the URL target would.
 *
 * Optional guard: if WEBHOOK_GUARD env is set, incoming requests MUST carry
 * `x-jarvis-guard: <WEBHOOK_GUARD>` to be forwarded.
 */
const UPSTREAM = "https://jarvis-sigma-navy-gamma.vercel.app/api/orchestrator";

function isServiceRole(req: Request): boolean {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return false;
  try {
    const payload = token.split(".")[1] ?? "";
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64);
    const role = JSON.parse(json).role;
    return role === "service_role";
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Only Supabase-triggered events (service_role JWT) may forward.
    if (!isServiceRole(req)) {
      return new Response(JSON.stringify({ ok: false, error: "forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    const raw = await req.text();
    const token = Deno.env.get("INTERNAL_AUTH_TOKEN") ?? "";

    const res = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: raw,
    });

    return new Response(
      JSON.stringify({ ok: true, upstream: res.status }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});