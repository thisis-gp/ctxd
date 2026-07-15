/**
 * Usage metrics + savings dashboard (Phase 5: token usage / query-reuse metrics).
 *
 * Every context tool call appends one record to audit/metrics.jsonl. The `stats`
 * command aggregates these into a dashboard. We report ACTUALS (calls, tokens
 * served, latency) as ground truth, plus an ESTIMATED saving vs a tunable
 * schema-discovery baseline — the estimate is clearly labelled, never conflated
 * with the measured actuals.
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/** ~4 chars/token heuristic — approximate, matches how we report elsewhere. */
export const approxTokens = (s: string): number => Math.round(s.length / 4);

/** Tools that replace naive schema discovery (used for the savings estimate). */
export const DISCOVERY_TOOLS = new Set([
  "context_search",
  "context_get_entity",
  "context_get_relationships",
  "context_find_saved_questions",
]);

export interface MetricRecord {
  at: string;
  tool: string;
  tokensApprox: number;
  latencyMs: number;
  release?: string;
  outcome?: "ok" | "error";
  errorCode?: string;
}

export function auditDir(snapshotDir: string): string {
  return path.join(snapshotDir, "..", "audit");
}

/** Append a metric record. Best-effort — never throws into the caller's path. */
export async function recordMetric(snapshotDir: string, rec: MetricRecord): Promise<void> {
  try {
    const dir = auditDir(snapshotDir);
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, "metrics.jsonl"), JSON.stringify(rec) + "\n", "utf8");
  } catch {
    /* metrics are non-critical */
  }
}

export async function readMetrics(snapshotDir: string): Promise<MetricRecord[]> {
  const f = path.join(auditDir(snapshotDir), "metrics.jsonl");
  if (!existsSync(f)) return [];
  const raw = await readFile(f, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as MetricRecord);
}

export interface SavingsBaseline {
  /** Tokens a single naive schema-discovery task would consume. */
  tokensPerDiscovery: number;
  /** Wall-clock a single naive schema-discovery task would consume, ms. */
  msPerDiscovery: number;
}

/** Defaults for a conservative schema-discovery baseline (~5k tok / ~1.5s). */
export const DEFAULT_BASELINE: SavingsBaseline = {
  tokensPerDiscovery: 5000,
  msPerDiscovery: 1500,
};

export interface StatsSummary {
  totalCalls: number;
  byTool: Record<string, { calls: number; tokensServed: number; avgLatencyMs: number }>;
  tokensServed: number;
  avgLatencyMs: number;
  discovery: {
    calls: number;
    actualTokens: number;
    actualLatencyMs: number;
    baseline: SavingsBaseline;
    estBaselineTokens: number;
    estTokensSaved: number;
    estTokenReductionPct: number;
    estBaselineMs: number;
    estMsSaved: number;
  };
  note: string;
}

export function summarize(records: MetricRecord[], baseline: SavingsBaseline = DEFAULT_BASELINE): StatsSummary {
  const byTool: StatsSummary["byTool"] = {};
  let tokensServed = 0;
  let latencySum = 0;
  let discCalls = 0;
  let discTokens = 0;
  let discLatency = 0;

  for (const r of records) {
    const b = (byTool[r.tool] ??= { calls: 0, tokensServed: 0, avgLatencyMs: 0 });
    b.calls++;
    b.tokensServed += r.tokensApprox;
    b.avgLatencyMs += r.latencyMs;
    tokensServed += r.tokensApprox;
    latencySum += r.latencyMs;
    if (DISCOVERY_TOOLS.has(r.tool)) {
      discCalls++;
      discTokens += r.tokensApprox;
      discLatency += r.latencyMs;
    }
  }
  for (const b of Object.values(byTool)) b.avgLatencyMs = round(b.avgLatencyMs / b.calls);

  const estBaselineTokens = discCalls * baseline.tokensPerDiscovery;
  const estBaselineMs = discCalls * baseline.msPerDiscovery;
  const estTokensSaved = estBaselineTokens - discTokens;
  return {
    totalCalls: records.length,
    byTool,
    tokensServed,
    avgLatencyMs: records.length ? round(latencySum / records.length) : 0,
    discovery: {
      calls: discCalls,
      actualTokens: discTokens,
      actualLatencyMs: round(discLatency),
      baseline,
      estBaselineTokens,
      estTokensSaved,
      estTokenReductionPct: estBaselineTokens ? round((estTokensSaved / estBaselineTokens) * 100) : 0,
      estBaselineMs,
      estMsSaved: round(estBaselineMs - discLatency),
    },
    note:
      "Actuals (calls, tokensServed, latency) are measured. Savings are ESTIMATES vs a " +
      `${baseline.tokensPerDiscovery}-token / ${baseline.msPerDiscovery}ms per-discovery baseline ` +
      "(override with --baseline-tokens / --baseline-ms). Token counts use a chars/4 approximation.",
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
