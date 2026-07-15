// Measure real token/latency savings on the live staging snapshot.
// Token estimate uses the common ~4 chars/token heuristic for JSON/English.
// This is an APPROXIMATION (no exact tokenizer), flagged as such in output.
import { ContextService } from "../dist/context-service.js";
import { MetabaseClient } from "../dist/metabase/client.js";
import { loadConfig } from "../dist/config.js";
import { performance } from "node:perf_hooks";

const CHARS_PER_TOKEN = 4;
const tok = (s) => Math.round(s.length / CHARS_PER_TOKEN);
const cfg = loadConfig();
const client = new MetabaseClient({ baseUrl: cfg.metabaseUrl, apiKey: cfg.metabaseApiKey, timeoutMs: cfg.queryTimeoutMs });

// --- BASELINE: what an agent pulls today to "discover the schema" ---
// A single /api/database/:id/metadata dump is the typical first move.
const t0 = performance.now();
const rawApp = await client.getDatabaseMetadata(2);
const rawSample = await client.getDatabaseMetadata(1);
const t1 = performance.now();
const rawAppStr = JSON.stringify(rawApp);
const rawBothStr = JSON.stringify([rawApp, rawSample]);

// --- CONTEXT LAYER: targeted responses ---
const s = new ContextService({ snapshotDir: "./snapshots", queryRowLimit: 1000, queryTimeoutMs: 20000, metabaseClient: client });
await s.open();

// Warm + time a search (average of N runs).
const N = 20;
s.search("claim"); // warm
let searchMs = 0;
for (let i = 0; i < N; i++) { const a = performance.now(); s.search("claim policy user"); searchMs += performance.now() - a; }
searchMs /= N;

const a0 = performance.now();
const entity = s.getEntity("public.claims");
const a1 = performance.now();

const searchResp = s.search("claim policy user");
const entityStr = JSON.stringify(entity);
const searchStr = JSON.stringify(searchResp);

s.close();

const rawAppTok = tok(rawAppStr);
const rawBothTok = tok(rawBothStr);
const entityTok = tok(entityStr);
const searchTok = tok(searchStr);

function pct(from, to) { return (((from - to) / from) * 100).toFixed(1); }

console.log(JSON.stringify({
  note: "token counts are APPROXIMATE (chars/4 heuristic); latency is measured wall-clock",
  baseline_schema_discovery: {
    app_db_metadata_chars: rawAppStr.length,
    app_db_metadata_tokens_approx: rawAppTok,
    both_dbs_metadata_chars: rawBothStr.length,
    both_dbs_metadata_tokens_approx: rawBothTok,
    fetch_latency_ms: Math.round(t1 - t0),
  },
  context_layer_responses: {
    get_entity_claims_chars: entityStr.length,
    get_entity_claims_tokens_approx: entityTok,
    get_entity_latency_ms: +(a1 - a0).toFixed(2),
    search_chars: searchStr.length,
    search_tokens_approx: searchTok,
    search_latency_ms_avg_of_20: +searchMs.toFixed(2),
  },
  savings: {
    tokens_entity_vs_app_metadata_pct: pct(rawAppTok, entityTok),
    tokens_entity_vs_both_metadata_pct: pct(rawBothTok, entityTok),
    tokens_search_vs_app_metadata_pct: pct(rawAppTok, searchTok),
    latency_search_vs_metadata_fetch: `${Math.round(t1 - t0)}ms -> ${searchMs.toFixed(1)}ms`,
  },
}, null, 2));
