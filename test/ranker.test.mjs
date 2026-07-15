import { test } from "node:test";
import assert from "node:assert/strict";
import { rankHybridCandidates } from "../dist/index.js";

test("hybrid ranker prefers semantic metric owner over lexical neighbors", () => {
  const result = rankHybridCandidates({
    question: "How many CSAT responses did we receive?",
    intent: "metric_only",
    semanticMatches: [
      {
        definition: {
          id: "tickets.csat_responses",
          name: "CSAT responses",
          synonyms: ["customer satisfaction responses"],
          description: "Tickets with CSAT response.",
          table: "public.tickets",
          columns: ["public.tickets.csat"],
          definition: "CSAT response on tickets.",
          sqlTemplate: "SELECT COUNT(*) FROM public.tickets;",
        },
        score: 2,
      },
    ],
    tables: [
      { name: "survey_responses", qualifiedName: "public.survey_responses" },
      { name: "tickets", qualifiedName: "public.tickets" },
      { name: "feedback_responses", qualifiedName: "public.feedback_responses" },
    ],
    columns: [
      { name: "response", qualifiedName: "public.survey_responses.response", table: "public.survey_responses" },
      { name: "csat", qualifiedName: "public.tickets.csat", table: "public.tickets", semanticType: "type/SerializedJSON" },
    ],
    relationships: [],
  });

  assert.equal(result.tables[0]?.item.qualifiedName, "public.tickets");
  assert.ok(result.tables[0]?.reasons.includes("owns matched semantic metric"));
  assert.equal(result.columns[0]?.item.qualifiedName, "public.tickets.csat");
  assert.ok(result.columns[0]?.reasons.includes("used by matched semantic metric"));
});

test("hybrid ranker penalizes history tables unless the question asks for history", () => {
  const normal = rankHybridCandidates({
    question: "ticket status",
    semanticMatches: [],
    tables: [
      { name: "ticket_history", qualifiedName: "public.ticket_history" },
      { name: "tickets", qualifiedName: "public.tickets" },
    ],
    columns: [],
  });
  const historical = rankHybridCandidates({
    question: "ticket history status",
    semanticMatches: [],
    tables: [
      { name: "ticket_history", qualifiedName: "public.ticket_history" },
      { name: "tickets", qualifiedName: "public.tickets" },
    ],
    columns: [],
  });

  assert.equal(normal.tables[0]?.item.qualifiedName, "public.tickets");
  assert.equal(historical.tables[0]?.item.qualifiedName, "public.ticket_history");
});

test("hybrid ranker honors explicit table qualifiers over broad semantic owner", () => {
  const semanticMatches = [
    {
      definition: {
        id: "orders.count",
        name: "Order count",
        synonyms: ["orders"],
        description: "Count orders.",
        table: "public.orders",
        columns: [],
        definition: "COUNT(*) on orders.",
        sqlTemplate: "SELECT COUNT(*) FROM public.orders;",
      },
      score: 1,
    },
  ];
  const cases = [
    ["Show staged order upload data", "public.staged_orders"],
    ["Show order history records", "public.order_history"],
  ];

  for (const [question, expected] of cases) {
    const result = rankHybridCandidates({
      question,
      intent: "lookup",
      semanticMatches,
      tables: [
        { name: "orders", qualifiedName: "public.orders" },
        { name: "staged_orders", qualifiedName: "public.staged_orders" },
        { name: "order_history", qualifiedName: "public.order_history" },
      ],
      columns: [],
    });

    assert.equal(result.tables[0]?.item.qualifiedName, expected);
  }
});
