// A/B harness: "How many claims have CSAT rating > 8?" against LIVE staging.
//
// Measures the real context an agent must INGEST to answer, two ways:
//   Arm B (direct Metabase): discover schema via information_schema, sample the
//     JSONB csat column to find the 'rating' key, then run the final query.
//   Arm A (ctx): one context_search + the final query — the nested csat→rating
//     field is already in the snapshot, so no table list, no column dump, no
//     JSONB sampling round trip.
//
// Tokens are exact cl100k (gpt-tokenizer). Latency is measured wall-clock. The
// model's reasoning tokens are ~constant across arms, so the DIFFERENCE measured
// here is the true token/latency delta the context layer produces.
import { encode } from "gpt-tokenizer";
import { performance } from "node:perf_hooks";
import { ContextService } from "../dist/context-service.js";
import { MetabaseClient } from "../dist/metabase/client.js";
import { loadConfig } from "../dist/config.js";

const APP_DB = 2;
const cfg = loadConfig();
const client = new MetabaseClient({ baseUrl: cfg.metabaseUrl, apiKey: cfg.metabaseApiKey, timeoutMs: cfg.queryTimeoutMs });
const tok = (s) => encode(s).length;

function payload(res) {
  return JSON.stringify({ cols: (res.data?.cols ?? []).map((c) => c.name), rows: res.data?.rows ?? [] });
}
async function raw(sql, rowLimit = 5000) {
  const t = performance.now();
  const res = await client.runNativeQuery(APP_DB, sql, { rowLimit, timeoutMs: 20000 });
  return { ms: performance.now() - t, str: payload(res) };
}

// ---------------- ARM B: direct Metabase, no context layer ----------------
const B = [];
B.push(["list_tables", await raw(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`)]);
B.push(["describe_claims", await raw(
  `SELECT column_name, data_type FROM information_schema.columns
   WHERE table_schema='public' AND table_name='claims' ORDER BY ordinal_position`)]);
// csat is jsonb — agent must sample values to discover the 'rating' key.
B.push(["sample_csat_json", await raw(
  `SELECT csat FROM public.claims WHERE csat IS NOT NULL LIMIT 3`)]);
B.push(["final_answer", await raw(
  `SELECT count(*) AS n FROM public.claims WHERE (csat->>'rating')::numeric > 8`)]);
const bTokens = B.reduce((a, [, s]) => a + tok(s.str), 0);
const bMs = B.reduce((a, [, s]) => a + s.ms, 0);

// ---------------- ARM A: context layer ----------------
const svc = new ContextService({ snapshotDir: "./snapshots", queryRowLimit: 5000, queryTimeoutMs: 20000, metabaseClient: client });
await svc.open();
const A = [];
let t = performance.now();
const search = svc.search("claims csat rating", { scope: "columns", limit: 12 });
A.push(["context_search", { ms: performance.now() - t, str: JSON.stringify(search) }]);
t = performance.now();
const ans = await svc.runReadonlyQuery("SELECT count(*) AS n FROM public.claims WHERE (csat->>'rating')::numeric > 8", APP_DB);
A.push(["run_readonly_query", { ms: performance.now() - t, str: JSON.stringify({ columns: ans.columns, rows: ans.rows }) }]);
svc.close();
const aTokens = A.reduce((a, [, s]) => a + tok(s.str), 0);
const aMs = A.reduce((a, [, s]) => a + s.ms, 0);

const pct = (from, to) => (((from - to) / from) * 100).toFixed(1);
console.log(JSON.stringify({
  question: "How many claims have CSAT rating > 8?",
  answer_rows: JSON.parse(A[1][1].str).rows,
  tokenizer: "cl100k_base (exact)",
  arm_B_direct_metabase: {
    steps: B.map(([n, s]) => ({ step: n, tokens: tok(s.str), latency_ms: +s.ms.toFixed(1) })),
    total_context_tokens: bTokens,
    total_latency_ms: +bMs.toFixed(1),
    round_trips: B.length,
  },
  arm_A_context_layer: {
    steps: A.map(([n, s]) => ({ step: n, tokens: tok(s.str), latency_ms: +s.ms.toFixed(1) })),
    total_context_tokens: aTokens,
    total_latency_ms: +aMs.toFixed(1),
    round_trips: A.length,
  },
  savings: {
    token_reduction_pct: pct(bTokens, aTokens),
    tokens_saved: bTokens - aTokens,
    latency_reduction_pct: pct(bMs, aMs),
    round_trips: `${B.length} -> ${A.length}`,
  },
  note: "Context/tool-payload tokens only (exact). Model reasoning tokens are ~constant across arms, so this is the true delta the context layer adds.",
}, null, 2));
