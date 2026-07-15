import { test } from "node:test";
import assert from "node:assert/strict";
import { compileContractQuery, parseContextContract, validateContextContract } from "../dist/contract.js";
import { findApprovedJoinPath } from "../dist/join-graph.js";

const contract = parseContextContract({
  version: 1,
  project: "orders",
  entities: [
    { id: "orders", table: "public.orders", grain: "one row per order" },
    { id: "customers", table: "public.customers", grain: "one row per customer" },
  ],
  dimensions: [{ id: "customers.name", entity: "customers", expression: "name" }],
  measures: [{ id: "orders.count", entity: "orders", expression: "COUNT(*)" }],
  joins: [{ id: "orders.customer", from: "orders", to: "customers", fromColumn: "customer_id", toColumn: "id", relationship: "many_to_one", approved: true, fanoutRisk: "none" }],
});

test("validates and compiles an approved cross-entity contract query", () => {
  assert.equal(validateContextContract(contract).ok, true);
  const path = findApprovedJoinPath(contract, "orders", "customers");
  assert.equal(path.joins.length, 1);
  const sql = compileContractQuery({ measures: ["orders.count"], dimensions: ["customers.name"], limit: 10 }, contract);
  assert.match(sql, /JOIN public\.customers/);
  assert.match(sql, /GROUP BY/);
});

test("rejects unapproved and high-fanout paths", () => {
  const unapproved = parseContextContract({ ...contract, joins: [{ ...contract.joins[0], approved: false }] });
  assert.throws(() => compileContractQuery({ measures: ["orders.count"], dimensions: ["customers.name"] }, unapproved), /No approved join path/);
  const risky = parseContextContract({ ...contract, joins: [{ ...contract.joins[0], fanoutRisk: "high" }] });
  assert.throws(() => compileContractQuery({ measures: ["orders.count"], dimensions: ["customers.name"] }, risky), /high fanout/);
});

test("enforces policies.allowedSchemas at validate and compile time", () => {
  const scoped = parseContextContract({
    ...contract,
    policies: { allowedSchemas: ["public"] },
  });
  assert.equal(validateContextContract(scoped).ok, true);
  assert.doesNotThrow(() => compileContractQuery({ measures: ["orders.count"], limit: 10 }, scoped));

  const blocked = parseContextContract({
    ...contract,
    entities: [{ ...contract.entities[0], table: "staging.orders" }],
    policies: { allowedSchemas: ["public"] },
  });
  const report = validateContextContract(blocked);
  assert.equal(report.ok, false);
  assert.match(report.problems.join("\n"), /outside allowed schemas/);
  assert.throws(
    () => compileContractQuery({ measures: ["orders.count"], limit: 10 }, blocked),
    /outside allowed schemas/,
  );
});
