import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSemanticQuery, rankSemanticDefinitions } from "../dist/semantic.js";

const definitions = [
  {
    id: "orders.count", name: "Order count", synonyms: ["orders"], description: "Count orders",
    table: "public.orders", columns: [], definition: "COUNT(*)", sqlTemplate: "SELECT COUNT(*) FROM public.orders",
    measureExpression: "COUNT(*)",
    dimensions: { status: { name: "Status", expression: "status", synonyms: ["state"] } },
  },
];

test("compiles a semantic measure with a dimension and structured filter", () => {
  const sql = compileSemanticQuery({
    measures: ["orders.count"],
    dimensions: ["status"],
    filters: [{ field: "status", operator: "=", value: "paid" }],
    limit: 25,
  }, definitions);
  assert.match(sql, /SELECT status AS "status", COUNT\(\*\) AS "orders_count"/);
  assert.match(sql, /WHERE status = 'paid'/);
  assert.match(sql, /GROUP BY status/);
  assert.match(sql, /LIMIT 25/);
});

test("rejects unknown fields and cross-table measures", () => {
  assert.throws(
    () => compileSemanticQuery({ measures: ["orders.count"], filters: [{ field: "missing", operator: "=", value: 1 }] }, definitions),
    /Unknown semantic filter field/,
  );
  assert.throws(
    () => compileSemanticQuery({ measures: ["orders.count", "other.count"] }, [...definitions, { ...definitions[0], id: "other.count", table: "public.other" }]),
    /reviewed join graph/,
  );
});

test("semantic ranker matches reviewed phrases inside longer questions", () => {
  const matches = rankSemanticDefinitions("How many tickets are there?", [
    {
      id: "tickets.count",
      name: "ticket count",
      synonyms: ["tickets", "how many tickets"],
      description: "Count tickets",
      table: "public.tickets",
      columns: [],
      definition: "COUNT(*)",
      sqlTemplate: "SELECT COUNT(*) FROM public.tickets;",
      measureExpression: "COUNT(*)",
    },
  ]);

  assert.equal(matches[0]?.definition.id, "tickets.count");
  assert.ok((matches[0]?.score ?? 0) >= 5);
});
