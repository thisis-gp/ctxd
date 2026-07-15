// Exact-tokenizer + fair-baseline measurement on live staging.
//
// (a) Uses a real BPE tokenizer (cl100k via gpt-tokenizer) instead of chars/4.
//     cl100k is an industry-standard proxy for Claude's tokenizer — close, not
//     identical, but far more accurate than a char heuristic.
// (b) Simulates the realistic incremental schema-discovery an agent actually does
//     via information_schema, measuring each query's RESULT payload (what the
//     agent ingests) and the round-trip latency, then compares to the context
//     layer answering the same question in one call.
import { encode } from "gpt-tokenizer";
import { ContextService } from "../dist/context-service.js";
import { MetabaseClient } from "../dist/metabase/client.js";
import { loadConfig } from "../dist/config.js";
import { performance } from "node:perf_hooks";

const cfg = loadConfig();
const client = new MetabaseClient({ baseUrl: cfg.metabaseUrl, apiKey: cfg.metabaseApiKey, timeoutMs: cfg.queryTimeoutMs });
const APP_DB = 2;
const tok = (s) => encode(s).length;

// Result payload as the agent would receive it (columns + rows as JSON).
function payload(res) {
  return JSON.stringify({ cols: (res.data?.cols ?? []).map((c) => c.name), rows: res.data?.rows ?? [] });
}
async function run(sql) {
  const t = performance.now();
  const res = await client.runNativeQuery(APP_DB, sql, { rowLimit: 5000, timeoutMs: 20000 });
  const ms = performance.now() - t;
  return { ms, str: payload(res), rows: (res.data?.rows ?? []).length };
}

// ---------- SCENARIO: "How do claims relate to users, benefits, dependents?" ----------
// This is a canonical data question that requires schema discovery first.

// FAIR BASELINE — an agent with raw DB/Metabase access discovers incrementally:
const steps = [];
// Step 1: what tables exist?
steps.push(["list_tables", await run(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`,
)]);
// Step 2: columns for the candidate tables it zeroes in on.
steps.push(["list_columns", await run(
  `SELECT table_name, column_name, data_type FROM information_schema.columns
   WHERE table_schema='public' AND table_name IN ('claims','users','benefits','dependents','claim_files')
   ORDER BY table_name, ordinal_position`,
)]);
// Step 3: foreign-key relationships (the standard catalog join).
steps.push(["list_fks", await run(
  `SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
   FROM information_schema.table_constraints tc
   JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
   JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
   WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public'`,
)]);

const baselineTokens = steps.reduce((a, [, s]) => a + tok(s.str), 0);
const baselineMs = steps.reduce((a, [, s]) => a + s.ms, 0);

// ---------- CONTEXT LAYER — same question, targeted calls ----------
const svc = new ContextService({ snapshotDir: "./snapshots", queryRowLimit: 1000, queryTimeoutMs: 20000, metabaseClient: client });
await svc.open();
const cl0 = performance.now();
const claims = svc.getEntity("public.claims");
const clMs = performance.now() - cl0;
const clStr = JSON.stringify(claims);
const clTokens = tok(clStr);
svc.close();

// ---------- EXACT re-tokenization of the earlier whole-dump baseline ----------
const rawApp = JSON.stringify(await client.getDatabaseMetadata(APP_DB));
const rawAppTokens = tok(rawApp);

const pct = (from, to) => (((from - to) / from) * 100).toFixed(1);

console.log(JSON.stringify({
  tokenizer: "cl100k_base (gpt-tokenizer) — real BPE, industry proxy for Claude",
  whole_dump_baseline: {
    app_db_metadata_tokens_exact: rawAppTokens,
    app_db_metadata_chars: rawApp.length,
  },
  fair_incremental_baseline: {
    per_step: steps.map(([name, s]) => ({ step: name, rows: s.rows, tokens_exact: tok(s.str), latency_ms: +s.ms.toFixed(1) })),
    total_tokens_exact: baselineTokens,
    total_latency_ms: +baselineMs.toFixed(1),
    round_trips: steps.length,
  },
  context_layer: {
    get_entity_claims_tokens_exact: clTokens,
    get_entity_latency_ms: +clMs.toFixed(2),
    round_trips: 1,
  },
  savings: {
    tokens_vs_whole_dump_pct: pct(rawAppTokens, clTokens),
    tokens_vs_fair_incremental_pct: pct(baselineTokens, clTokens),
    latency_vs_fair_incremental: `${baselineMs.toFixed(0)}ms (3 round trips) -> ${clMs.toFixed(1)}ms (1 local call)`,
  },
}, null, 2));
