import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSuggestedSemanticQuery,
  classifyQueryIntent,
  scorePlanConfidence,
} from "../dist/index.js";

const csatMatch = {
  definition: {
    id: "tickets.csat_responses",
    name: "CSAT responses",
    synonyms: ["customer satisfaction responses"],
    description: "Tickets with CSAT response.",
    table: "public.tickets",
    columns: ["public.tickets.csat"],
    definition: "CSAT response on tickets.",
    sqlTemplate: "SELECT COUNT(*) FROM public.tickets;",
    measureExpression: "COUNT(*)",
    dimensions: {
      org: {
        name: "Organization",
        expression: "orgs.name",
        synonyms: ["org", "organization", "company"],
      },
    },
  },
  score: 2,
};

test("classifyQueryIntent separates metric-only and grouped metric questions", () => {
  assert.equal(classifyQueryIntent("How many CSAT responses did we receive?", [csatMatch]).intent, "metric_only");
  assert.equal(classifyQueryIntent("CSAT responses by organization", [csatMatch]).intent, "metric_by_dimension");
  assert.equal(classifyQueryIntent("How do orders join customers?", []).intent, "join_exploration");
  assert.equal(classifyQueryIntent("What is CSAT?", [csatMatch]).intent, "definition");
  assert.equal(classifyQueryIntent("What does CSAT response mean?", [csatMatch]).intent, "definition");
  assert.equal(classifyQueryIntent("Show staged order records", [csatMatch]).intent, "lookup");
});

test("buildSuggestedSemanticQuery emits declarative semantic query", () => {
  assert.deepEqual(
    buildSuggestedSemanticQuery("How many CSAT responses did we receive?", "metric_only", [csatMatch]),
    { measures: ["tickets.csat_responses"], limit: 1000 },
  );
  assert.deepEqual(
    buildSuggestedSemanticQuery("CSAT responses by organization", "metric_by_dimension", [csatMatch]),
    { measures: ["tickets.csat_responses"], dimensions: ["org"], limit: 1000 },
  );
  assert.equal(
    buildSuggestedSemanticQuery(
      "CSAT responses by ticket status",
      "metric_by_dimension",
      [{ ...csatMatch, definition: { ...csatMatch.definition, dimensions: undefined } }],
    ),
    undefined,
  );
});

test("scorePlanConfidence is high for strong metric-only semantic plans", () => {
  const result = scorePlanConfidence({
    intent: "metric_only",
    semanticMatches: [csatMatch],
    rankedTables: [{ item: { qualifiedName: "public.tickets" }, score: 100, reasons: [] }],
    savedQuestionCount: 0,
    requiresClarification: false,
  });
  assert.equal(result.confidence, "high");
});

test("scorePlanConfidence is high for grouped semantic plans with a reviewed dimension", () => {
  const result = scorePlanConfidence({
    intent: "metric_by_dimension",
    semanticMatches: [csatMatch],
    rankedTables: [
      { item: { qualifiedName: "public.tickets" }, score: 100, reasons: [] },
      { item: { qualifiedName: "public.form_responses" }, score: 10, reasons: [] },
    ],
    savedQuestionCount: 0,
    requiresClarification: false,
    hasSuggestedSemanticQuery: true,
  });

  assert.equal(result.confidence, "high");
});

test("scorePlanConfidence is medium for grouped semantic plans until dimension is reviewed", () => {
  const result = scorePlanConfidence({
    intent: "metric_by_dimension",
    semanticMatches: [csatMatch],
    rankedTables: [
      { item: { qualifiedName: "public.tickets" }, score: 100, reasons: [] },
      { item: { qualifiedName: "public.form_responses" }, score: 10, reasons: [] },
    ],
    savedQuestionCount: 0,
    requiresClarification: false,
    hasSuggestedSemanticQuery: false,
  });

  assert.equal(result.confidence, "medium");
});
