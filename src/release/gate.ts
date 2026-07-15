import { readFile } from "node:fs/promises";
import { SemanticError } from "../errors.js";
import { evaluateBenchmark, loadBenchmark, type BenchmarkObservation, type BenchmarkResult } from "../benchmark.js";
import { ReleaseManager, type ValidationReport } from "./manager.js";

export interface ReleaseGateOptions {
  release: string;
  snapshotDir: string;
  previousRelease?: string;
  allowShrink?: boolean;
  contractFile?: string;
  benchmarkCasesFile?: string;
  benchmarkObservationsFile?: string;
}

export interface ReleaseGateReport {
  ok: boolean;
  release: string;
  snapshot: ValidationReport;
  benchmark?: BenchmarkResult;
  problems: string[];
}

export async function runReleaseGate(opts: ReleaseGateOptions): Promise<ReleaseGateReport> {
  const manager = new ReleaseManager(opts.snapshotDir);
  const snapshot = await manager.validate(opts.release, {
    previousRelease: opts.previousRelease,
    allowShrink: opts.allowShrink,
    contractFile: opts.contractFile,
  });
  const problems = [...snapshot.problems];
  let benchmark: BenchmarkResult | undefined;
  if (opts.benchmarkCasesFile || opts.benchmarkObservationsFile) {
    if (!opts.benchmarkCasesFile || !opts.benchmarkObservationsFile) {
      throw new SemanticError("Release gate benchmark requires both --benchmark and --observations.");
    }
    const cases = await loadBenchmark(opts.benchmarkCasesFile);
    const raw = JSON.parse(await readFile(opts.benchmarkObservationsFile, "utf8")) as unknown;
    if (!Array.isArray(raw)) throw new SemanticError("Benchmark observations must be a JSON array.");
    benchmark = evaluateBenchmark(cases, raw as BenchmarkObservation[]);
    for (const failure of benchmark.failures) {
      problems.push(`benchmark ${failure.id}: ${failure.reasons.join("; ")}`);
    }
  }
  return {
    ok: snapshot.ok && (benchmark?.ok ?? true),
    release: opts.release,
    snapshot,
    ...(benchmark ? { benchmark } : {}),
    problems,
  };
}
