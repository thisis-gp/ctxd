// Tests for the compact column/asset projection used by get_entity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactColumns, compactAsset } from "../dist/context-service.js";

const col = (name, dataType, semanticType) => ({
  id: `column:public.t.${name}`, kind: "column", name, qualifiedName: `public.t.${name}`,
  databaseId: 1, databaseName: "db", schema: "public", table: "public.t", dataType, semanticType,
});

test("compactColumns projects to name/type/semanticType", () => {
  const out = compactColumns([col("id", "int8"), col("email", "varchar", "type/Email")]);
  assert.deepEqual(out, [
    { name: "id", type: "int8", semanticType: undefined },
    { name: "email", type: "varchar", semanticType: "type/Email" },
  ]);
});

test("compactColumns collapses nested JSONB leaves under their parent with a count", () => {
  const cols = [
    col("intake_form", "jsonb"),
    col("intake_form → requestedAmount", "text"),
    col("intake_form → customerName", "text"),
    col("id", "int8"),
  ];
  const out = compactColumns(cols);
  const parent = out.find((c) => c.name === "intake_form");
  assert.equal(parent.nestedFields, 2, "parent gets nested count");
  assert.equal(out.length, 2, "leaves collapsed; only parent + id remain");
  assert.ok(!out.some((c) => c.name.includes("→")), "no expanded leaves leak through");
});

test("compactColumns synthesizes a parent if only leaves are present", () => {
  const out = compactColumns([col("meta → a", "text"), col("meta → b", "text")]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "meta");
  assert.equal(out[0].nestedFields, 2);
});

test("compactAsset truncates long native SQL to a preview", () => {
  const longSql = "SELECT " + "x,".repeat(300) + "1";
  const a = compactAsset({ id: "question:1", kind: "question", metabaseId: 1, name: "q", nativeSql: longSql, tableRefs: [] });
  assert.ok(a.nativeSql.length < longSql.length);
  assert.match(a.nativeSql, /truncated/);
});

test("compactAsset leaves short SQL untouched", () => {
  const a = compactAsset({ id: "question:1", kind: "question", metabaseId: 1, name: "q", nativeSql: "SELECT 1", tableRefs: [] });
  assert.equal(a.nativeSql, "SELECT 1");
});
