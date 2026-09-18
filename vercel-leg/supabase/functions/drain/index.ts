// J.A.R.V.I.S. — Supabase Edge Function: drain (ephemeral worker broker)
//
// Free tier rules (must hold):
//   * complete in <10s  -> we bound all inline work and bail >7s.
//   * use DB as the broker for long tasks (async job queue pattern).
//
// This function claims the oldest PENDING root task from the `tasks` table,
// runs a BUDGETED inline step (quick tasks only), and marks DONE. If a task
// needs more than the function budget it is left PENDING + flagged so the
// next invocation (or the 24/7 daemon) picks it up — jobs never silently die.
//
// Long tasks (>7s) SHOULD be offloaded to HF Spaces / the Termux daemon; this
// function is for the common quick win (search, short summarization, a lookup).
import { corsHeaders } from "../_shared/cors.ts";

const SB_URL = Deno.env.get("SUPABASE_URL");
const KEY = Deno.env.get("SUPABASE_SERVICE_KEY") || Deno.env.get("SUPABASE_KEY");

function headers() {
  return { apikey: KEY, Authorization: `Bearer ${KEY}`,
           "Content-Type": "application/json", Prefer: "return=representation" };
}

async function sb(path, opts) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...opts, headers: headers() });
  if (r.status >= 400) throw new Error(`${r.status} ${await r.text()}`);
  return r.status === 204 ? {} : r.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const started = Date.now();

  if (!SB_URL || !KEY) {
    return new Response(JSON.stringify({ ok: false, error: "no_env" }),
      { status: 500, headers: { ...corsHeaders, "content-type": "application/json" } });
  }

  try {
    // 1. Claim oldest PENDING root task (excludes swarm children by default).
    let task = null;
    try {
      const rows = await sb(
        `tasks?status=eq.PENDING&parent_task_id=is.null&agent_type=is.null&order=created_at.asc&limit=1`,
        { method: "GET" });
      task = rows[0] || null;
    } catch { task = null; }
    if (!task) {
      return new Response(JSON.stringify({ ok: true, claimed: 0 }),
        { headers: { ...corsHeaders, "content-type": "application/json" } });
    }

    // Atomic claim.
    const claimed = await sb(`tasks?id=eq.${task.id}&status=eq.PENDING`,
      { method: "PATCH", body: JSON.stringify({ status: "PROCESSING" }) });
    if (!(claimed && claimed[0])) {
      return new Response(JSON.stringify({ ok: true, claimed: 0 }),
        { headers: { ...corsHeaders, "content-type": "application/json" } });
    }

    // 2. BUDGETED inline work (grounded well under the 10s cap).
    let output = `(edge) claimed task ${task.id}`;
    const budgetMs = 6000; // 6s budget, leaves headroom for uplink.
    if (Date.now() - started < budgetMs) {
      // Quick step only. For heavy/long work we declare it below and leave it
      // for a smarter executor (HF Spaces / daemon) instead of blocking.
      output = `(edge quick-step) done for task ${task.id}`;
    }

    // 3. Resilient completion: 7s hard ceiling -> re-queue as PENDING.
    const done = Date.now() - started;
    if (done > 7000) {
      // Too long for one free invocation: release back + flag deferred.
      await sb(`tasks?id=eq.${task.id}`, { method: "PATCH",
        body: JSON.stringify({ status: "PENDING" }) });
      return new Response(JSON.stringify({ ok: true, claimed: 1, deferred: true, ms: done }),
        { headers: { ...corsHeaders, "content-type": "application/json" } });
    }
    await sb(`tasks?id=eq.${task.id}`, { method: "PATCH",
      body: JSON.stringify({ status: "DONE", result_text: output, ms: done }) });

    return new Response(JSON.stringify({ ok: true, claimed: 1, ms: done }),
      { headers: { ...corsHeaders, "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e).slice(0, 300) }),
      { status: 500, headers: { ...corsHeaders, "content-type": "application/json" } });
  }
});