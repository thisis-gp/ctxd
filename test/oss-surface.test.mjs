import test from "node:test";
import assert from "node:assert/strict";
import { compareBenchmarkRuns, draftContractFromModel, loadModelFromAdapter } from "../dist/index.js";

test("dbt adapter imports a normalized model", async () => {
  const model = await loadModelFromAdapter("dbt", "examples/dbt-manifest-mini.json");
  assert.equal(model.entities.filter((item) => item.kind === "table").length, 1);
  assert.equal(model.entities.filter((item) => item.kind === "column").length, 4);
  assert.equal(model.entities.find((item) => item.kind === "table")?.qualifiedName, "public.orders");
});

test("draftContractFromModel creates entities, dimensions, and count measures", async () => {
  const model = await loadModelFromAdapter("dbt", "examples/dbt-manifest-mini.json");
  const result = draftContractFromModel(model, { project: "demo", maxEntities: 10 });
  assert.equal(result.contract.entities[0]?.id, "public_orders");
  assert.equal(result.contract.measures[0]?.id, "public_orders.count");
  assert.ok(result.contract.dimensions.some((item) => item.id === "public_orders.status"));
});

test("compareBenchmarkRuns reports token and latency improvements", () => {
  const cases = [{ id: "one", question: "q", expectedMeasures: ["m"] }];
  const direct = [{ id: "one", measures: ["m"], calls: 4, latencyMs: 1000, totalTokens: 10000, answerCorrect: true }];
  const context = [{ id: "one", measures: ["m"], calls: 2, latencyMs: 400, totalTokens: 2500, answerCorrect: true }];
  const result = compareBenchmarkRuns(cases, direct, context);
  assert.equal(result.ok, true);
  assert.equal(result.improvements.tokenReductionPct, 75);
  assert.equal(result.improvements.latencyReductionPct, 60);
  assert.equal(result.improvements.callReductionPct, 50);
});
