// Read-only SQL validation tests, including the SELECT INTO bypass and LIMIT cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReadOnlySql, enforceLimit, extractSqlReferences } from "../dist/sql/validate.js";

test("accepts plain SELECT and WITH", () => {
  assert.equal(validateReadOnlySql("SELECT * FROM users LIMIT 10").ok, true);
  assert.equal(validateReadOnlySql("WITH t AS (SELECT 1 AS x) SELECT * FROM t").ok, true);
});

test("rejects mutations and DDL", () => {
  for (const sql of ["DELETE FROM users", "UPDATE users SET x=1", "INSERT INTO t VALUES (1)", "DROP TABLE t", "TRUNCATE t", "ALTER TABLE t ADD c int"]) {
    assert.equal(validateReadOnlySql(sql).ok, false, sql);
  }
});

test("rejects stacked statements", () => {
  assert.equal(validateReadOnlySql("SELECT 1; SELECT 2").ok, false);
  assert.equal(validateReadOnlySql("SELECT id FROM users; DROP TABLE users").ok, false);
});

test("allows forbidden words inside string literals and column names", () => {
  assert.equal(validateReadOnlySql("SELECT 'update' AS note FROM public.claims").ok, true);
  assert.equal(validateReadOnlySql("SELECT status FROM public.claims WHERE status = 'locked'").ok, true);
  assert.equal(validateReadOnlySql("SELECT lock FROM public.claims").ok, true);
  assert.equal(validateReadOnlySql("SELECT * FROM public.claims WHERE note LIKE '%replace%'").ok, true);
  assert.equal(validateReadOnlySql("SELECT created_at, updated_at FROM public.claims").ok, true);
});

test("rejects SELECT ... INTO (creates a table)", () => {
  const r = validateReadOnlySql("SELECT id INTO new_table FROM users");
  assert.equal(r.ok, false, "SELECT INTO must be rejected");
});

test("allows a real SELECT that merely contains 'insert' inside a comment", () => {
  assert.equal(validateReadOnlySql("select * from a /* insert */ where b=1").ok, true);
});

test("empty and comment-only inputs are rejected", () => {
  assert.equal(validateReadOnlySql("   ").ok, false);
  assert.equal(validateReadOnlySql("-- just a comment").ok, false);
});

test("enforceLimit appends a limit when missing", () => {
  assert.match(enforceLimit("SELECT * FROM t", 100), /LIMIT 100/);
});

test("enforceLimit clamps an oversized limit down to the cap", () => {
  const out = enforceLimit("SELECT * FROM claims LIMIT 1000000", 1000);
  assert.match(out, /LIMIT 1000\b/);
  assert.doesNotMatch(out, /1000000/);
});

test("enforceLimit leaves a smaller limit untouched", () => {
  assert.equal(enforceLimit("SELECT * FROM t LIMIT 5", 1000).match(/LIMIT (\d+)/)[1], "5");
});

test("extracts physical tables and aliased columns", () => {
  const refs = extractSqlReferences("SELECT c.id, o.name FROM public.claims c JOIN public.orgs o ON c.user_id = o.id");
  assert.deepEqual(refs.tables.sort(), ["public.claims", "public.orgs"]);
  assert.ok(refs.columns.some((c) => c.table === "public.claims" && c.column === "id"));
  assert.ok(refs.columns.some((c) => c.table === "public.orgs" && c.column === "name"));
});
