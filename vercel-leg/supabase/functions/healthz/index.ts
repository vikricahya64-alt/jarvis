// J.A.R.V.I.S. — Supabase Edge Function: /healthz liveness probe
// Free tier rule: MUST complete within 10s. This is trivially fast.
// Serves as the "ephemeral worker" liveness that Cloudflare / monitors check.
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_KEY") || Deno.env.get("SUPABASE_KEY");
  return new Response(
    JSON.stringify({ ok: !!supabaseUrl && !!key, service: "jarvis-ef-healthz",
                    ts: Date.now() }),
    { headers: { ...corsHeaders, "content-type": "application/json" } },
  );
});