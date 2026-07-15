// Drive real context calls (as the MCP server would), recording metrics, and
// print the compact-vs-full get_entity comparison — verifying the review fix.
import { encode } from "gpt-tokenizer";
import { performance } from "node:perf_hooks";
import { ContextService } from "../dist/context-service.js";
import { recordMetric, approxTokens } from "../dist/metrics.js";

const dir = "./snapshots";
const svc = new ContextService({ snapshotDir: dir, queryRowLimit: 1000, queryTimeoutMs: 20000 });
await svc.open();

async function call(tool, fn) {
  const t0 = performance.now();
  const out = fn();
  const ms = Math.round((performance.now() - t0) * 100) / 100;
  const text = JSON.stringify(out);
  await recordMetric(dir, { at: new Date().toISOString(), tool, tokensApprox: approxTokens(text), latencyMs: ms, release: svc.activeRelease });
  return text;
}

// Simulate a realistic agent session.
await call("context_search", () => svc.search("claim policy user"));
await call("context_search", () => svc.search("benefit"));
await call("context_get_relationships", () => svc.getRelationships("public.claims"));
await call("context_find_saved_questions", () => svc.findSavedQuestions("org names"));
const compactStr = await call("context_get_entity", () => svc.getEntity("public.claims"));

// Compact vs full comparison (the review fix).
const fullStr = JSON.stringify(svc.getEntity("public.claims", { full: true }));
svc.close();

console.log(JSON.stringify({
  compact_get_entity_tokens_cl100k: encode(compactStr).length,
  full_get_entity_tokens_cl100k: encode(fullStr).length,
  reduction_pct: (((encode(fullStr).length - encode(compactStr).length) / encode(fullStr).length) * 100).toFixed(1),
}, null, 2));
