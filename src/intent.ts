import type { SemanticMatch, SemanticQuery } from "./semantic.js";
import type { RankedCandidate } from "./ranker.js";

export type QueryIntent = "metric_only" | "metric_by_dimension" | "lookup" | "join_exploration" | "definition";
export type PlanConfidence = "high" | "medium" | "low";

export interface IntentResult {
  intent: QueryIntent;
  reasons: string[];
}

export interface ConfidenceInput {
  intent: QueryIntent;
  semanticMatches: SemanticMatch[];
  rankedTables: RankedCandidate<{ qualifiedName: string }>[];
  savedQuestionCount: number;
  requiresClarification: boolean;
  hasSuggestedSemanticQuery?: boolean;
}

export interface ConfidenceResult {
  confidence: PlanConfidence;
  reasons: string[];
}

const GROUP_RE = /\b(by|per|group(?:ed)?\s+by|break(?:\s|-)?down|split by|top|rank)\b/i;
const LOOKUP_RE = /\b(list|show|find|lookup|give me|which|who are|details?|records?)\b/i;
const DEFINITION_RE = /\b(define|definition|meaning|what is|how is|explain|what does\b.*\bmean|means?)\b/i;
const JOIN_RE = /\b(join|connect|relationship|foreign key|linked|between)\b/i;
const METRIC_RE = /\b(count|how many|total|sum|average|avg|median|min|max|rate|percentage|trend|number of)\b/i;

export function classifyQueryIntent(question: string, semanticMatches: SemanticMatch[]): IntentResult {
  const reasons: string[] = [];
  if (DEFINITION_RE.test(question)) {
    reasons.push("definition/explanation phrase detected");
    return { intent: "definition", reasons };
  }
  if (JOIN_RE.test(question)) {
    reasons.push("join/relationship phrase detected");
    return { intent: "join_exploration", reasons };
  }
  if (GROUP_RE.test(question)) {
    reasons.push("grouping or ranking phrase detected");
    return { intent: "metric_by_dimension", reasons };
  }
  const asksForMetric = METRIC_RE.test(question);
  if (LOOKUP_RE.test(question) && !asksForMetric) {
    reasons.push("lookup/list phrase detected");
    return { intent: "lookup", reasons };
  }
  if (asksForMetric || semanticMatches.length > 0) {
    reasons.push(semanticMatches.length > 0 ? "semantic metric match detected" : "metric phrase detected");
    return { intent: "metric_only", reasons };
  }
  if (LOOKUP_RE.test(question)) {
    reasons.push("lookup/list phrase detected");
    return { intent: "lookup", reasons };
  }
  reasons.push("defaulted to lookup intent");
  return { intent: "lookup", reasons };
}

export function scorePlanConfidence(input: ConfidenceInput): ConfidenceResult {
  const topSemantic = input.semanticMatches[0]?.score ?? 0;
  const topTable = input.rankedTables[0]?.score ?? 0;
  const secondTable = input.rankedTables[1]?.score ?? 0;
  const gap = topTable - secondTable;
  const reasons: string[] = [];

  if (input.requiresClarification) {
    reasons.push("planner requires clarification");
    return { confidence: "low", reasons };
  }
  if (topSemantic >= 2 && input.intent === "metric_by_dimension" && gap >= 20) {
    if (input.hasSuggestedSemanticQuery) {
      reasons.push("semantic metric and reviewed dimension matched with clear top table");
      return { confidence: "high", reasons };
    }
    reasons.push("semantic metric match plus clear top table; dimension still needs physical-column validation");
    return { confidence: "medium", reasons };
  }
  if (topSemantic >= 2 && input.intent === "metric_only") {
    reasons.push("strong semantic metric match for metric-only question");
    return { confidence: "high", reasons };
  }
  if (input.savedQuestionCount > 0) {
    reasons.push("matching saved question/model exists");
    return { confidence: "medium", reasons };
  }
  if (topTable > 0 && gap >= 15) {
    reasons.push("clear top ranked table");
    return { confidence: "medium", reasons };
  }
  reasons.push("no strong semantic, saved-question, or ranking gap signal");
  return { confidence: "low", reasons };
}

export function buildSuggestedSemanticQuery(
  question: string,
  intent: QueryIntent,
  semanticMatches: SemanticMatch[],
): SemanticQuery | undefined {
  const top = semanticMatches[0];
  if (!top || top.score < 2) return undefined;
  if (intent !== "metric_only" && intent !== "metric_by_dimension") return undefined;
  const dimensions = intent === "metric_by_dimension"
    ? inferDimensions(question, top.definition.dimensions)
    : [];
  if (intent === "metric_by_dimension" && dimensions.length === 0) return undefined;
  return {
    measures: [top.definition.id],
    ...(dimensions.length ? { dimensions } : {}),
    limit: 1000,
  };
}

function inferDimensions(
  question: string,
  dimensions: SemanticMatch["definition"]["dimensions"],
): string[] {
  if (!dimensions) return [];
  const q = normalize(question);
  const matches: string[] = [];
  for (const [id, dimension] of Object.entries(dimensions)) {
    const phrases = [dimension.name, id, ...dimension.synonyms].map(normalize);
    if (phrases.some((phrase) => phrase && q.includes(phrase))) matches.push(id);
  }
  return matches;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
