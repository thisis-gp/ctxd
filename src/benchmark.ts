import { readFile } from "node:fs/promises";
import { SemanticError } from "./errors.js";

export interface BenchmarkCase {
  id: string;
  question: string;
  expectedMeasures: string[];
  expectedDimensions?: string[];
  requiredEntities?: string[];
  forbiddenEntities?: string[];
  maxCalls?: number;
  maxLatencyMs?: number;
}

export interface BenchmarkObservation {
  id: string;
  agent?: string;
  measures?: string[];
  dimensions?: string[];
  entities?: string[];
  calls?: number;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  answerCorrect?: boolean;
}

export interface BenchmarkResult {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  failures: Array<{ id: string; reasons: string[] }>;
}

export interface BenchmarkComparison {
  ok: boolean;
  direct: BenchmarkRunSummary;
  context: BenchmarkRunSummary;
  improvements: {
    tokenReductionPct?: number;
    latencyReductionPct?: number;
    callReductionPct?: number;
    accuracyDeltaPct: number;
  };
}

export interface BenchmarkRunSummary {
  cases: number;
  correct: number;
  accuracyPct: number;
  totalCalls: number;
  totalLatencyMs: number;
  totalTokens: number;
  avgCalls: number;
  avgLatencyMs: number;
  avgTokens: number;
}

export async function loadBenchmark(file: string): Promise<BenchmarkCase[]> {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(value)) throw new SemanticError("Benchmark file must contain an array.");
    return value.map((item, index) => parseCase(item, index));
  } catch (err) {
    if (err instanceof SemanticError) throw err;
    throw new SemanticError(`Could not read benchmark at ${file}: ${(err as Error).message}`);
  }
}

function parseCase(value: unknown, index: number): BenchmarkCase {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SemanticError(`Benchmark case ${index} must be an object.`);
  const v = value as Record<string, unknown>;
  const text = (key: string): string => {
    if (typeof v[key] !== "string" || !(v[key] as string).trim()) throw new SemanticError(`Benchmark case ${index}.${key} is required.`);
    return (v[key] as string).trim();
  };
  const strings = (key: string): string[] | undefined => {
    if (v[key] === undefined) return undefined;
    if (!Array.isArray(v[key]) || v[key].some((item) => typeof item !== "string")) throw new SemanticError(`Benchmark case ${index}.${key} must be an array of strings.`);
    return v[key] as string[];
  };
  return { id: text("id"), question: text("question"), expectedMeasures: strings("expectedMeasures") ?? [], ...(strings("expectedDimensions") ? { expectedDimensions: strings("expectedDimensions") } : {}), ...(strings("requiredEntities") ? { requiredEntities: strings("requiredEntities") } : {}), ...(strings("forbiddenEntities") ? { forbiddenEntities: strings("forbiddenEntities") } : {}), ...(v.maxCalls === undefined ? {} : { maxCalls: Number(v.maxCalls) }), ...(v.maxLatencyMs === undefined ? {} : { maxLatencyMs: Number(v.maxLatencyMs) }) };
}

export function evaluateBenchmark(cases: BenchmarkCase[], observations: BenchmarkObservation[]): BenchmarkResult {
  const byId = new Map(observations.map((item) => [item.id, item]));
  const failures: BenchmarkResult["failures"] = [];
  for (const item of cases) {
    const observation = byId.get(item.id);
    const reasons: string[] = [];
    if (!observation) reasons.push("missing observation");
    if (observation) {
      if (observation.answerCorrect === false) reasons.push("answer marked incorrect");
      if (!sameValues(item.expectedMeasures, observation.measures)) reasons.push("measure contract mismatch");
      if (item.expectedDimensions && !sameValues(item.expectedDimensions, observation.dimensions)) reasons.push("dimension contract mismatch");
      for (const entity of item.requiredEntities ?? []) if (!(observation.entities ?? []).includes(entity)) reasons.push(`missing required entity ${entity}`);
      for (const entity of item.forbiddenEntities ?? []) if ((observation.entities ?? []).includes(entity)) reasons.push(`forbidden entity selected ${entity}`);
      if (item.maxCalls !== undefined && (observation.calls ?? Number.POSITIVE_INFINITY) > item.maxCalls) reasons.push(`tool calls exceeded ${item.maxCalls}`);
      if (item.maxLatencyMs !== undefined && (observation.latencyMs ?? Number.POSITIVE_INFINITY) > item.maxLatencyMs) reasons.push(`latency exceeded ${item.maxLatencyMs}ms`);
    }
    if (reasons.length) failures.push({ id: item.id, reasons });
  }
  return { ok: failures.length === 0, total: cases.length, passed: cases.length - failures.length, failed: failures.length, failures };
}

export function compareBenchmarkRuns(
  cases: BenchmarkCase[],
  direct: BenchmarkObservation[],
  context: BenchmarkObservation[],
): BenchmarkComparison {
  const directSummary = summarizeRun(cases, direct);
  const contextSummary = summarizeRun(cases, context);
  return {
    ok: contextSummary.accuracyPct >= directSummary.accuracyPct,
    direct: directSummary,
    context: contextSummary,
    improvements: {
      tokenReductionPct: reduction(directSummary.totalTokens, contextSummary.totalTokens),
      latencyReductionPct: reduction(directSummary.totalLatencyMs, contextSummary.totalLatencyMs),
      callReductionPct: reduction(directSummary.totalCalls, contextSummary.totalCalls),
      accuracyDeltaPct: round(contextSummary.accuracyPct - directSummary.accuracyPct),
    },
  };
}

function summarizeRun(cases: BenchmarkCase[], observations: BenchmarkObservation[]): BenchmarkRunSummary {
  const byId = new Map(observations.map((item) => [item.id, item]));
  let correct = 0;
  let totalCalls = 0;
  let totalLatencyMs = 0;
  let totalTokens = 0;
  for (const item of cases) {
    const observation = byId.get(item.id);
    if (!observation) continue;
    if (observation.answerCorrect !== false) correct += 1;
    totalCalls += observation.calls ?? 0;
    totalLatencyMs += observation.latencyMs ?? 0;
    totalTokens += observation.totalTokens ?? (observation.inputTokens ?? 0) + (observation.outputTokens ?? 0);
  }
  const count = cases.length || 1;
  return {
    cases: cases.length,
    correct,
    accuracyPct: round((correct / count) * 100),
    totalCalls,
    totalLatencyMs,
    totalTokens,
    avgCalls: round(totalCalls / count),
    avgLatencyMs: round(totalLatencyMs / count),
    avgTokens: round(totalTokens / count),
  };
}

function reduction(baseline: number, next: number): number | undefined {
  if (baseline <= 0) return undefined;
  return round(((baseline - next) / baseline) * 100);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function sameValues(expected: string[], actual: string[] | undefined): boolean {
  const right = new Set(actual ?? []);
  return expected.every((item) => right.has(item));
}
