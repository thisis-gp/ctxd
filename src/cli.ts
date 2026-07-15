#!/usr/bin/env node
/**
 * ctxd CLI (§13).
 *
 * Commands:
 *   init                       scaffold .env and the snapshot directory
 *   snapshot build             build an immutable snapshot for a release
 *   snapshot validate          run validation gates on a built snapshot
 *   snapshot publish           mark a validated snapshot immutable/ready
 *   snapshot promote           advance the `current` pointer (post health checks)
 *   snapshot rollback          restore the previous `current` pointer
 *   search <query>             query a local snapshot from the terminal
 *   freshness                  print current-snapshot freshness
 *   serve                      start the MCP stdio server
 */

import { Command } from "commander";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadConfig, loadLocalConfig } from "./config.js";
import { ContextService } from "./context-service.js";
import { AgentContextError, SemanticError, SnapshotError } from "./errors.js";
import { logger } from "./logger.js";
import { MetabaseClient } from "./metabase/client.js";
import { ReleaseManager } from "./release/manager.js";
import { buildSnapshot, checkDrift } from "./snapshot/builder.js";
import { readSnapshotModel } from "./snapshot/manifest.js";
import { TokenStore, defaultTokenStorePath } from "./auth/tokens.js";
import { refreshFromMetabase } from "./refresh.js";
import { generateConnectorToken, serveHttpMcp } from "./mcp/http.js";
import { serveMcp } from "./mcp/server.js";
import { readMetrics, summarize, type StatsSummary } from "./metrics.js";
import {
  loadSemanticDefinitions,
  validateSemanticDefinitions,
  zSemanticQuery,
} from "./semantic.js";
import { loadContextContract, validateContextContract } from "./contract.js";
import { compareBenchmarkRuns, evaluateBenchmark, loadBenchmark, type BenchmarkObservation } from "./benchmark.js";
import { ADAPTERS, loadModelFromAdapter, type AdapterKind } from "./adapters/index.js";
import { draftContractFromModel, writeDraftContract } from "./contract-draft.js";
import { runReleaseGate } from "./release/gate.js";

/** Print a JSON result to stdout for CLI consumers (safe here — not the MCP path). */
function print(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

function nowIso(): string {
  return new Date().toISOString();
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** Render the savings dashboard as a plain-text box to stdout. */
function renderStatsDashboard(s: StatsSummary): void {
  const d = s.discovery;
  const lines: string[] = [];
  lines.push("╔══════════════════════════════════════════════════════════╗");
  lines.push("║                  ctxd — usage & savings                  ║");
  lines.push("╚══════════════════════════════════════════════════════════╝");
  lines.push("");
  lines.push("MEASURED ACTUALS");
  lines.push(`  total context calls : ${fmt(s.totalCalls)}`);
  lines.push(`  tokens served (~)   : ${fmt(s.tokensServed)}`);
  lines.push(`  avg latency         : ${s.avgLatencyMs} ms`);
  lines.push("");
  lines.push("  per tool:");
  for (const [tool, b] of Object.entries(s.byTool)) {
    lines.push(`    ${tool.padEnd(30)} ${String(b.calls).padStart(4)} calls  ${String(fmt(b.tokensServed)).padStart(9)} tok  ${b.avgLatencyMs} ms`);
  }
  lines.push("");
  lines.push("ESTIMATED SAVINGS (discovery-replacing calls only)");
  lines.push(`  discovery calls     : ${fmt(d.calls)}`);
  lines.push(`  tokens: ${fmt(d.actualTokens)} served  vs  ~${fmt(d.estBaselineTokens)} baseline  →  ${d.estTokenReductionPct}% fewer (${fmt(d.estTokensSaved)} saved)`);
  lines.push(`  time  : ${fmt(d.actualLatencyMs)} ms served  vs  ~${fmt(d.estBaselineMs)} ms baseline  →  ${fmt(d.estMsSaved)} ms saved`);
  lines.push("");
  lines.push(`  note: ${s.note}`);
  process.stdout.write(lines.join("\n") + "\n");
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  status: "pass" | "warn" | "fail";
  detail: string;
}

function addCheck(
  checks: DoctorCheck[],
  name: string,
  ok: boolean,
  detail: string,
  status: DoctorCheck["status"] = ok ? "pass" : "fail",
): void {
  checks.push({ name, ok, status, detail });
}

/** Build a ContextService for local read commands, attaching a Metabase client if creds exist. */
function buildLocalService(): ContextService {
  const local = loadLocalConfig();
  let metabaseClient: MetabaseClient | undefined;
  let allowedDatabaseIds: number[] | undefined;
  try {
    const full = loadConfig();
    allowedDatabaseIds = full.databaseIds;
    metabaseClient = new MetabaseClient({
      baseUrl: full.metabaseUrl,
      apiKey: full.metabaseApiKey,
      timeoutMs: full.queryTimeoutMs,
    });
  } catch {
    // No creds — search/freshness still work; query execution will report clearly.
  }
  return new ContextService({
    snapshotDir: local.snapshotDir,
    queryRowLimit: local.queryRowLimit,
    queryTimeoutMs: local.queryTimeoutMs,
    metabaseClient,
    allowedDatabaseIds,
    deployedRelease: process.env.DEPLOYED_RELEASE,
    deployedCommit: process.env.DEPLOYED_COMMIT,
    contextContractFile: local.contextContractFile,
    allowQueryExecution: local.allowQueryExecution,
  });
}

const program = new Command();
program
  .name("ctxd")
  .description("Release-aware MCP context layer over a Metabase-backed database.")
  .version("0.1.0");

program
  .command("init")
  .description("Scaffold .env (from .env.example) and the snapshot directory.")
  .action(async () => {
    const cwd = process.cwd();
    const envPath = path.join(cwd, ".env");
    const examplePath = path.join(cwd, ".env.example");
    if (!existsSync(envPath) && existsSync(examplePath)) {
      await copyFile(examplePath, envPath);
      logger.info("created .env from .env.example — fill in Metabase credentials");
    } else {
      logger.info(".env already exists or .env.example missing; skipping");
    }
    const snapshotDir = process.env.SNAPSHOT_DIR ?? "./snapshots";
    await mkdir(snapshotDir, { recursive: true });
    print({ ok: true, envPath, snapshotDir });
  });

program
  .command("doctor")
  .description("Check local env, Metabase connectivity, current snapshot, and semantic readiness.")
  .action(async () => {
    const checks: DoctorCheck[] = [];
    const envPath = path.join(process.cwd(), ".env");
    addCheck(
      checks,
      "env_file",
      existsSync(envPath),
      existsSync(envPath) ? ".env exists" : ".env missing; run `ctxd init` and fill in credentials",
    );

    let config: ReturnType<typeof loadConfig> | undefined;
    try {
      config = loadConfig();
      addCheck(checks, "config", true, "required configuration is present");
    } catch (err) {
      addCheck(checks, "config", false, (err as Error).message);
    }

    const local = loadLocalConfig();
    if (config) {
      try {
        const client = new MetabaseClient({
          baseUrl: config.metabaseUrl,
          apiKey: config.metabaseApiKey,
          timeoutMs: config.queryTimeoutMs,
        });
        await client.ping();
        addCheck(checks, "metabase", true, "connected to configured Metabase instance");
      } catch (err) {
        addCheck(checks, "metabase", false, `Metabase ping failed: ${(err as Error).message}`);
      }
    } else {
      addCheck(checks, "metabase", false, "skipped because required configuration is invalid");
    }

    const manager = new ReleaseManager((config ?? local).snapshotDir);
    let currentRelease: string | undefined;
    try {
      const current = await manager.getCurrent();
      currentRelease = current?.release;
      addCheck(
        checks,
        "current_snapshot",
        Boolean(currentRelease),
        currentRelease ? `current release is ${currentRelease}` : "no current snapshot; run `ctxd refresh`",
        currentRelease ? "pass" : "warn",
      );
    } catch (err) {
      addCheck(checks, "current_snapshot", false, `could not read current snapshot: ${(err as Error).message}`);
    }

    try {
      const definitions = await loadSemanticDefinitions((config ?? local).semanticDefinitionsFile);
      if (!currentRelease) {
        addCheck(
          checks,
          "semantics",
          true,
          `${definitions.length} definitions parsed; table references will be validated after a snapshot exists`,
          "warn",
        );
      } else {
        const model = await readSnapshotModel((config ?? local).snapshotDir, currentRelease);
        try {
          validateSemanticDefinitions(definitions, model);
          addCheck(checks, "semantics", true, `${definitions.length} definitions match the current snapshot`);
        } catch (err) {
          const strict = (config ?? local).strictSemantics;
          addCheck(
            checks,
            "semantics",
            !strict,
            strict
              ? `semantic definitions fail strict validation: ${(err as Error).message}`
              : `semantic definitions will be skipped during refresh: ${(err as Error).message}`,
            strict ? "fail" : "warn",
          );
        }
      }
    } catch (err) {
      addCheck(checks, "semantics", false, (err as Error).message);
    }

    addCheck(
      checks,
      "admin_token",
      local.adminToken.length >= 16,
      local.adminToken.length >= 16
        ? "CTXD_ADMIN_TOKEN is set"
        : "CTXD_ADMIN_TOKEN missing or too short; run `ctxd token admin-secret`",
      local.adminToken.length >= 16 ? "pass" : "warn",
    );

    addCheck(
      checks,
      "http",
      local.httpPort > 0,
      `HTTP server configured on ${local.httpHost}:${local.httpPort}`,
    );

    const ok = checks.every((check) => check.ok);
    print({ ok, checks });
    if (!ok) process.exitCode = 1;
  });

const snapshot = program.command("snapshot").description("Build and manage context snapshots.");

snapshot
  .command("build")
  .requiredOption("--release <release>", "Release tag or commit id, e.g. v8.19.0-0")
  .option("--git-commit <sha>", "Git commit this snapshot represents")
  .option("--previous <release>", "Previous release to diff against for changes.json")
  .option("--force", "Overwrite an existing snapshot directory")
  .description("Query Metabase and build an immutable context snapshot.")
  .action(async (opts) => {
    const config = loadConfig();
    const result = await buildSnapshot(
      config,
      {
        release: opts.release,
        gitCommit: opts.gitCommit,
        previousRelease: opts.previous,
        force: Boolean(opts.force),
      },
      nowIso(),
    );
    print({ ok: true, manifest: result.manifest });
  });

snapshot
  .command("validate")
  .requiredOption("--release <release>", "Release to validate")
  .option("--previous <release>", "Previous release to compare size against")
  .option("--allow-shrink", "Permit a materially smaller snapshot than the previous")
  .option("--contract <file>", "Validate a vendor-neutral context contract against this release")
  .description("Run validation gates on a built snapshot.")
  .action(async (opts) => {
    const local = loadLocalConfig();
    const manager = new ReleaseManager(local.snapshotDir);
    const report = await manager.validate(opts.release, {
      previousRelease: opts.previous,
      allowShrink: Boolean(opts.allowShrink),
      // Contract validation is explicit because the checked-in example contract
      // is intentionally generic and must not gate an unrelated deployment.
      contractFile: opts.contract,
    });
    print(report);
    if (!report.ok) process.exitCode = 1;
  });

snapshot
  .command("publish")
  .requiredOption("--release <release>", "Release to publish")
  .description("Mark a validated snapshot as published (immutable, ready to promote).")
  .action(async (opts) => {
    const local = loadLocalConfig();
    await new ReleaseManager(local.snapshotDir).publish(opts.release);
    print({ ok: true, release: opts.release, status: "published" });
  });

snapshot
  .command("promote")
  .requiredOption("--release <release>", "Release to promote to current")
  .description("Advance the `current` pointer to this release (run after health checks).")
  .action(async (opts) => {
    const local = loadLocalConfig();
    const pointer = await new ReleaseManager(local.snapshotDir).promote(opts.release);
    print({ ok: true, current: pointer });
  });

snapshot
  .command("rollback")
  .description("Restore the previously-current snapshot pointer.")
  .action(async () => {
    const local = loadLocalConfig();
    const pointer = await new ReleaseManager(local.snapshotDir).rollback();
    print({ ok: true, current: pointer });
  });

program
  .command("refresh")
  .option("--release <id>", "Override auto nightly release id")
  .option("--force", "Rebuild and promote even if fingerprint is unchanged")
  .option("--no-allow-shrink", "Fail if the new snapshot has far fewer tables than previous")
  .option("--prune-keep <n>", "Keep newest N nightly/auto snapshots (default 14)", "14")
  .option("--contract <file>", "Optionally validate a context contract before promote")
  .description(
    "Ingest live Metabase into current (build → validate → publish → promote). Designed for nightly cron — no manual release tags required. Snapshots stay versioned under the hood for rollback.",
  )
  .action(async (opts) => {
    const config = loadConfig();
    const result = await refreshFromMetabase(config, {
      release: opts.release,
      force: Boolean(opts.force),
      allowShrink: opts.allowShrink !== false,
      pruneKeep: Number(opts.pruneKeep),
      contractFile: opts.contract,
    });
    print(result);
    if (result.reason && !result.skipped && !result.current) process.exitCode = 1;
  });

program
  .command("search <query>")
  .option("--scope <scope>", "all | tables | columns | assets", "all")
  .option("--release <release>", "Search a specific release instead of current")
  .option("--limit <n>", "Max results per category", "8")
  .description("Search a local snapshot from the terminal.")
  .action(async (query, opts) => {
    const service = buildLocalService();
    try {
      await service.open(opts.release);
      print(service.search(query, { scope: opts.scope, limit: Number(opts.limit) }));
    } finally {
      service.close();
    }
  });

program
  .command("freshness")
  .description("Print current-snapshot freshness and version-match status.")
  .action(async () => {
    const service = buildLocalService();
    try {
      print(await service.freshness());
    } finally {
      service.close();
    }
  });

program
  .command("query <sql>")
  .option("--database-id <id>", "Target Metabase database id; inferred when the allowlist has one database")
  .description(
    "Execute one read-only SQL query through Metabase (requires CTXD_ALLOW_QUERY=true). Default product mode only drafts/validates SQL for Metabase.",
  )
  .action(async (sql, opts) => {
    const service = buildLocalService();
    try {
      await service.open();
      print(await service.runReadonlyQuery(sql, opts.databaseId ? Number(opts.databaseId) : undefined));
    } finally {
      service.close();
    }
  });

program
  .command("semantic-query <json>")
  .option("--execute", "Execute the compiled query through Metabase")
  .option("--database-id <id>", "Target Metabase database id")
  .description("Compile or execute a declarative semantic query represented as JSON.")
  .action(async (json, opts) => {
    const service = buildLocalService();
    try {
      await service.open();
      const parsed = zSemanticQuery.parse(JSON.parse(json));
      print(opts.execute
        ? await service.runCompiledSemanticQuery(parsed, opts.databaseId ? Number(opts.databaseId) : undefined)
        : service.compileSemanticQuery(parsed));
    } finally {
      service.close();
    }
  });

program
  .command("contract-query <json>")
  .description("Compile a declarative query against the reviewed context contract.")
  .action(async (json) => {
    const service = buildLocalService();
    try {
      await service.open();
      print(service.compileContractQuery(JSON.parse(json)));
    } finally {
      service.close();
    }
  });

program
  .command("plan <question>")
  .option("--release <release>", "Use a specific release instead of current")
  .option("--limit <n>", "Max candidates per category", "8")
  .description("One-shot query planner: candidate tables, columns, and FK join paths for a question.")
  .action(async (question, opts) => {
    const service = buildLocalService();
    try {
      await service.open(opts.release);
      print(service.planQuery(question, Number(opts.limit)));
    } finally {
      service.close();
    }
  });

program
  .command("join-path <from> <to>")
  .option("--release <release>", "Use a specific release instead of current")
  .description("Show the shortest FK join path between two tables.")
  .action(async (from, to, opts) => {
    const service = buildLocalService();
    try {
      await service.open(opts.release);
      print(service.getJoinPath(from, to));
    } finally {
      service.close();
    }
  });

program
  .command("diff")
  .option("--release <release>", "Release to show changes for (defaults to current)")
  .description("Show the schema-change diff (changes.json) for a release.")
  .action(async (opts) => {
    const service = buildLocalService();
    try {
      await service.open(opts.release);
      print(await service.getChanges(opts.release));
    } finally {
      service.close();
    }
  });

program
  .command("drift")
  .option("--release <release>", "Snapshot to compare live Metabase against (defaults to current)")
  .description("Compare live Metabase schema against a snapshot fingerprint; report drift.")
  .action(async (opts) => {
    const config = loadConfig();
    const report = await checkDrift(config, opts.release);
    print(report);
    if (report.drifted) process.exitCode = 2; // non-zero so pipelines can gate on drift
  });

program
  .command("stats")
  .option("--json", "Emit raw JSON instead of the formatted dashboard")
  .option("--baseline-tokens <n>", "Assumed tokens per naive schema-discovery task", "5000")
  .option("--baseline-ms <n>", "Assumed ms per naive schema-discovery task", "1500")
  .description("Show the token/latency savings dashboard from recorded MCP usage.")
  .action(async (opts) => {
    const local = loadLocalConfig();
    const records = await readMetrics(local.snapshotDir);
    const summary = summarize(records, {
      tokensPerDiscovery: Number(opts.baselineTokens),
      msPerDiscovery: Number(opts.baselineMs),
    });
    if (opts.json) {
      print(summary);
      return;
    }
    renderStatsDashboard(summary);
  });

program
  .command("validate-contract [file]")
  .option("--release <release>", "Validate referenced tables against a snapshot release")
  .description("Validate a vendor-neutral context contract and its approved semantic relationships.")
  .action(async (file, opts) => {
    const local = loadLocalConfig();
    const contract = await loadContextContract(file ?? local.contextContractFile);
    let model;
    if (opts.release) {
      const { readSnapshotModel } = await import("./snapshot/manifest.js");
      model = await readSnapshotModel(local.snapshotDir, opts.release);
    }
    const report = validateContextContract(contract, model);
    print(report);
    if (!report.ok) process.exitCode = 1;
  });

const adapters = program.command("adapters").description("Inspect and import metadata from external semantic tools.");
adapters
  .command("list")
  .description("List supported metadata adapters.")
  .action(() => {
    print({ adapters: ADAPTERS });
  });

adapters
  .command("inspect <kind> <file>")
  .description("Parse an adapter input and show the normalized model counts.")
  .action(async (kind, file) => {
    const model = await loadModelFromAdapter(kind as AdapterKind, file);
    print({
      kind,
      counts: {
        entities: model.entities.length,
        tables: model.entities.filter((item) => item.kind === "table").length,
        columns: model.entities.filter((item) => item.kind === "column").length,
        relationships: model.relationships.length,
        assets: model.assets.length,
      },
    });
  });

const contract = program.command("contract").description("Create and validate vendor-neutral context contracts.");
contract
  .command("draft")
  .requiredOption("--project <name>", "Project name for the generated contract")
  .option("--release <release>", "Draft from a built snapshot release")
  .option("--adapter <kind>", "Draft from adapter input: dbt | cube | metricflow")
  .option("--input <file>", "Adapter input file when --adapter is used")
  .option("--schema <schema...>", "Limit draft to one or more schemas")
  .option("--max-entities <n>", "Maximum tables to include", "50")
  .option("--approve-joins", "Mark imported joins as approved")
  .option("--out <file>", "Write contract JSON to a file instead of stdout")
  .description("Generate a reviewed-contract starting point from a snapshot or adapter metadata.")
  .action(async (opts) => {
    const local = loadLocalConfig();
    let model;
    if (opts.adapter) {
      if (!opts.input) throw new SemanticError("--input is required when --adapter is used.");
      model = await loadModelFromAdapter(opts.adapter as AdapterKind, opts.input);
    } else {
      if (!opts.release) throw new SemanticError("contract draft requires --release or --adapter with --input.");
      const { readSnapshotModel } = await import("./snapshot/manifest.js");
      model = await readSnapshotModel(local.snapshotDir, opts.release);
    }
    const result = draftContractFromModel(model, {
      project: opts.project,
      schemas: opts.schema,
      maxEntities: Number(opts.maxEntities),
      includeUnapprovedJoins: Boolean(opts.approveJoins),
    });
    if (opts.out) {
      await writeDraftContract(opts.out, result);
      print({ ok: true, out: opts.out, warnings: result.warnings, counts: { entities: result.contract.entities.length, dimensions: result.contract.dimensions.length, measures: result.contract.measures.length, joins: result.contract.joins.length } });
      return;
    }
    print(result);
  });

const benchmark = program.command("benchmark").description("Validate agent observations against semantic benchmark cases.");
benchmark
  .command("validate <cases> <observations>")
  .description("Compare recorded agent observations with expected semantic contracts.")
  .action(async (casesFile, observationsFile) => {
    const cases = await loadBenchmark(casesFile);
    const raw = JSON.parse(await readFile(observationsFile, "utf8")) as unknown;
    if (!Array.isArray(raw)) throw new SemanticError("Benchmark observations must be a JSON array.");
    const result = evaluateBenchmark(cases, raw as BenchmarkObservation[]);
    print(result);
    if (!result.ok) process.exitCode = 1;
  });

benchmark
  .command("compare <cases> <directObservations> <contextObservations>")
  .description("Compare direct-schema agent runs against context-layer agent runs.")
  .action(async (casesFile, directFile, contextFile) => {
    const cases = await loadBenchmark(casesFile);
    const directRaw = JSON.parse(await readFile(directFile, "utf8")) as unknown;
    const contextRaw = JSON.parse(await readFile(contextFile, "utf8")) as unknown;
    if (!Array.isArray(directRaw) || !Array.isArray(contextRaw)) throw new SemanticError("Benchmark observations must be JSON arrays.");
    const result = compareBenchmarkRuns(cases, directRaw as BenchmarkObservation[], contextRaw as BenchmarkObservation[]);
    print(result);
    if (!result.ok) process.exitCode = 1;
  });

program
  .command("release-gate")
  .requiredOption("--release <release>", "Release to validate")
  .option("--previous <release>", "Previous release to compare size against")
  .option("--allow-shrink", "Permit a materially smaller snapshot than the previous")
  .option("--contract <file>", "Validate a context contract against this release")
  .option("--benchmark <file>", "Benchmark cases file")
  .option("--observations <file>", "Benchmark observations file")
  .description("Run the CI release gate: snapshot validation, optional contract validation, optional benchmark validation.")
  .action(async (opts) => {
    const local = loadLocalConfig();
    const report = await runReleaseGate({
      release: opts.release,
      snapshotDir: local.snapshotDir,
      previousRelease: opts.previous,
      allowShrink: Boolean(opts.allowShrink),
      contractFile: opts.contract,
      benchmarkCasesFile: opts.benchmark,
      benchmarkObservationsFile: opts.observations,
    });
    print(report);
    if (!report.ok) process.exitCode = 1;
  });

program
  .command("serve")
  .option("--release <release>", "Serve a specific release instead of current")
  .option("--http", "Serve remote MCP over HTTP (org plug-and-play). Default is local stdio.")
  .option("--host <host>", "HTTP bind host (default CTXD_HTTP_HOST or 0.0.0.0)")
  .option("--port <port>", "HTTP port (default CTXD_HTTP_PORT or 8787)")
  .description(
    "Start the MCP server. --http serves /mcp (per-user tokens) and /admin (issue tokens with CTXD_ADMIN_TOKEN).",
  )
  .action(async (opts) => {
    const service = buildLocalService();
    try {
      await service.open(opts.release);
    } catch (err) {
      if (opts.http) {
        throw new SnapshotError(
          `${(err as Error).message} Run \`ctxd refresh\` on this host first so there is a current snapshot to serve.`,
        );
      }
      throw err;
    }
    if (opts.http) {
      const local = loadLocalConfig();
      const host = (opts.host as string | undefined) || local.httpHost;
      const port = opts.port ? Number(opts.port) : local.httpPort;
      await serveHttpMcp(service, {
        host,
        port,
        adminToken: local.adminToken,
        dataDir: local.dataDir,
      });
      return;
    }
    await serveMcp(service);
    await new Promise<void>(() => {});
  });

const tokenCmd = program.command("token").description("Manage per-user connector tokens (or use https://HOST/admin).");

tokenCmd
  .command("create")
  .requiredOption("--name <name>", "User or bot display name")
  .description("Create a per-user MCP token (raw secret printed once).")
  .action(async (opts) => {
    const local = loadLocalConfig();
    const store = new TokenStore(defaultTokenStorePath(local.dataDir));
    const issued = await store.create(opts.name);
    print(issued);
    logger.info("Give this token only to that user. It is not stored in plaintext.");
  });

tokenCmd
  .command("list")
  .description("List connector tokens (no secrets).")
  .action(async () => {
    const local = loadLocalConfig();
    const store = new TokenStore(defaultTokenStorePath(local.dataDir));
    print({ tokens: await store.list() });
  });

tokenCmd
  .command("revoke")
  .requiredOption("--id <id>", "Token id from token list")
  .description("Revoke a per-user connector token.")
  .action(async (opts) => {
    const local = loadLocalConfig();
    const store = new TokenStore(defaultTokenStorePath(local.dataDir));
    const ok = await store.revoke(opts.id);
    print({ ok, id: opts.id });
    if (!ok) process.exitCode = 1;
  });

tokenCmd
  .command("admin-secret")
  .description("Generate a CTXD_ADMIN_TOKEN value for the server .env.")
  .action(() => {
    process.stdout.write(`${generateConnectorToken()}\n`);
    logger.info("Put this in CTXD_ADMIN_TOKEN on the server. Use /admin to issue per-user tokens.");
  });

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof AgentContextError) {
    logger.error(`${err.code}: ${err.message}`);
  } else {
    logger.error(`unexpected error: ${(err as Error).message}`);
  }
  process.exitCode = 1;
});
