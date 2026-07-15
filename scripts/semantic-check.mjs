#!/usr/bin/env node
// Validate semantic definitions compile and optionally execute with psql.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { compileSemanticQuery, parseSemanticDefinitions } from "../dist/semantic.js";
import { validateReadOnlySql } from "../dist/sql/validate.js";

const args = new Set(process.argv.slice(2));
const withDb = args.has("--db");
const fileArg = process.argv.find((arg) => arg.startsWith("--file="));
const file = fileArg ? fileArg.slice("--file=".length) : process.env.SEMANTIC_DEFINITIONS_FILE ?? "./semantics/definitions.json";
const psqlCommand = process.env.CTXD_SEMANTIC_CHECK_PSQL ?? "psql";
const definitions = parseSemanticDefinitions(JSON.parse(readFileSync(file, "utf8")));

function runSql(sql) {
  const result = spawnSync(psqlCommand, ["-At", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `${psqlCommand} exited ${result.status}`).trim());
  return result.stdout.trim();
}

function dimensionCombos(definition) {
  return Object.keys(definition.dimensions ?? {}).map((dimension) => ({
    label: `${definition.id} by ${dimension}`,
    query: { measures: [definition.id], dimensions: [dimension], limit: 1000 },
  }));
}

const checks = [];
for (const definition of definitions) {
  checks.push({
    label: definition.id,
    query: { measures: [definition.id], limit: 1000 },
  });
  checks.push(...dimensionCombos(definition));
}

const rows = [];
for (const check of checks) {
  const failures = [];
  let sql = "";
  let rowCount = null;
  try {
    sql = compileSemanticQuery(check.query, definitions);
    const validation = validateReadOnlySql(sql);
    if (!validation.ok) failures.push(validation.reason ?? "SQL validation failed");
    if (withDb) {
      const wrapped = `SELECT COUNT(*) FROM (${sql.replace(/;\s*$/, "")}) AS semantic_check;`;
      const output = runSql(wrapped);
      const value = Number(output.split(/\r?\n/).find(Boolean)?.split("\t").at(-1));
      if (!Number.isFinite(value)) failures.push(`invalid DB row count: ${output}`);
      else rowCount = value;
    }
  } catch (err) {
    failures.push(err.message);
  }
  rows.push({
    label: check.label,
    pass: failures.length === 0,
    failures,
    query: check.query,
    rowCount,
  });
}

const summary = {
  semanticFile: file,
  definitions: definitions.length,
  checks: rows.length,
  passed: rows.filter((row) => row.pass).length,
  failed: rows.filter((row) => !row.pass).length,
  dbExecution: withDb ? "enabled" : "skipped",
};
console.log(JSON.stringify({ summary, rows }, null, 2));
if (rows.some((row) => !row.pass)) process.exit(1);
