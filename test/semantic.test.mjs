import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSemanticQuery, rankSemanticDefinitions, isBareAggregateCall } from "../dist/semantic.js";

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

const filteredDefs = [
  {
    id: "csat.rounded", name: "rounded csat", synonyms: ["csat"], description: "avg rating",
    table: "app.csat", columns: [], definition: "AVG(rating)",
    sqlTemplate: "SELECT ROUND(AVG(rating),2) FROM app.csat",
    // Not a bare aggregate: FILTER cannot legally attach to this.
    measureExpression: "ROUND(AVG(rating), 2)",
    defaultFilter: "claim_status = 'settled' AND rating > 0",
    dimensions: {},
  },
  {
    id: "csat.responses", name: "csat responses", synonyms: ["responses"], description: "count",
    table: "app.csat", columns: [], definition: "COUNT(*)",
    sqlTemplate: "SELECT COUNT(*) FROM app.csat",
    measureExpression: "COUNT(*)",
    defaultFilter: "claim_status = 'settled' AND rating > 0",
    dimensions: {},
  },
  {
    id: "csat.all", name: "all csat", synonyms: ["all"], description: "count all",
    table: "app.csat", columns: [], definition: "COUNT(*)",
    sqlTemplate: "SELECT COUNT(*) FROM app.csat",
    measureExpression: "COUNT(*)",
    dimensions: {},
  },
];

test("isBareAggregateCall distinguishes wrapped aggregates", () => {
  assert.equal(isBareAggregateCall("AVG(rating)"), true);
  assert.equal(isBareAggregateCall("COUNT(*)"), true);
  assert.equal(isBareAggregateCall("  sum(amt_cents)  "), true);
  assert.equal(isBareAggregateCall("ROUND(AVG(rating), 2)"), false);
  assert.equal(isBareAggregateCall("SUM(amt_cents) / 100.0"), false);
  assert.equal(isBareAggregateCall("rating"), false);
});

test("a non-aggregate measureExpression moves its filter into WHERE, not FILTER", () => {
  const sql = compileSemanticQuery({ measures: ["csat.rounded"] }, filteredDefs);
  assert.ok(!sql.includes("FILTER"), `FILTER is invalid here: ${sql}`);
  assert.match(sql, /WHERE \(claim_status = 'settled' AND rating > 0\)/);
  assert.match(sql, /ROUND\(AVG\(rating\), 2\) AS "csat_rounded"/);
});

test("a bare aggregate still uses per-measure FILTER", () => {
  const sql = compileSemanticQuery({ measures: ["csat.responses"] }, filteredDefs);
  assert.match(sql, /COUNT\(\*\) FILTER \(WHERE claim_status = 'settled' AND rating > 0\)/);
});

test("hoisting is refused when measures do not share the filter", () => {
  assert.throws(
    () => compileSemanticQuery({ measures: ["csat.rounded", "csat.all"] }, filteredDefs),
    /do not share the same defaultFilter/,
  );
});
