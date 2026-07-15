import type { Relationship } from "./model.js";
import type { SemanticMatch } from "./semantic.js";

export interface RankableTable {
  name: string;
  qualifiedName: string;
  description?: string;
}

export interface RankableColumn {
  name: string;
  qualifiedName: string;
  table?: string;
  type?: string;
  semanticType?: string;
}

export interface RankedCandidate<T> {
  item: T;
  score: number;
  reasons: string[];
}

export interface HybridRankInput {
  question: string;
  intent?: "metric_only" | "metric_by_dimension" | "lookup" | "join_exploration" | "definition";
  tables: RankableTable[];
  columns: RankableColumn[];
  semanticMatches: SemanticMatch[];
  relationships?: Relationship[];
}

export interface HybridRankResult {
  tables: RankedCandidate<RankableTable>[];
  columns: RankedCandidate<RankableColumn>[];
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "by",
  "did",
  "do",
  "does",
  "for",
  "from",
  "how",
  "in",
  "is",
  "many",
  "of",
  "on",
  "per",
  "receive",
  "received",
  "the",
  "to",
  "we",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
]);

const SYNONYMS: Record<string, string[]> = {
  csat: ["customer", "satisfaction", "survey", "rating", "feedback"],
  org: ["organization", "organisation", "company", "client", "employer"],
  organization: ["org", "company", "client", "employer"],
  employee: ["user", "member", "subscriber", "beneficiary"],
  employees: ["users", "members", "subscribers", "beneficiaries"],
  ticket: ["tickets", "case", "issue"],
  tickets: ["ticket", "cases", "issues"],
  order: ["orders", "purchase"],
  orders: ["order", "purchases"],
  customer: ["customers", "account", "client"],
  customers: ["customer", "accounts", "clients"],
};

const TABLE_QUALIFIERS = [
  {
    label: "history",
    question: /\b(history|historical|old|previous|archive|audit)\b/i,
    table: /(^|[_.])(history|hist|archive|audit)([_.]|$)/i,
  },
  {
    label: "staging",
    question: /\b(staged|staging|upload|uploaded|imported|raw)\b/i,
    table: /(^|[_.])(staged|staging)([_.]|$)/i,
  },
];

export function rankHybridCandidates(input: HybridRankInput): HybridRankResult {
  const queryTokens = expandTokens(tokenize(input.question));
  const semanticTables = new Set(input.semanticMatches.map((match) => norm(match.definition.table)));
  const semanticColumns = new Set(input.semanticMatches.flatMap((match) => match.definition.columns.map(norm)));
  const anchor = input.semanticMatches[0]?.definition.table;
  const joinDistances = anchor && input.relationships ? computeJoinDistances(anchor, input.relationships) : new Map<string, number>();

  const tables = input.tables
    .map((table, index) => rankTable(table, index, queryTokens, semanticTables, joinDistances, input.question, input.intent))
    .sort(compareRanked);
  const columns = input.columns
    .map((column, index) => rankColumn(column, index, queryTokens, semanticColumns, semanticTables))
    .sort(compareRanked);

  return { tables, columns };
}

function rankTable(
  table: RankableTable,
  lexicalIndex: number,
  queryTokens: Set<string>,
  semanticTables: Set<string>,
  joinDistances: Map<string, number>,
  question: string,
  intent: HybridRankInput["intent"],
): RankedCandidate<RankableTable> {
  let score = Math.max(1, 22 - lexicalIndex * 2);
  const reasons = [`lexical candidate rank ${lexicalIndex + 1}`];
  const tableName = norm(table.qualifiedName);
  const bare = norm(table.name);
  const activeQualifiers = TABLE_QUALIFIERS.filter((qualifier) => qualifier.question.test(question));
  const metricIntent = intent === "metric_only" || intent === "metric_by_dimension";
  const joinIntent = intent === "join_exploration";
  if (semanticTables.has(tableName)) {
    score += metricIntent ? 80 : 20;
    reasons.push("owns matched semantic metric");
    if (activeQualifiers.some((qualifier) => !qualifier.table.test(table.qualifiedName))) {
      score -= 55;
      reasons.push("penalized broad semantic table for explicit table qualifier");
    }
  }
  for (const qualifier of activeQualifiers) {
    if (qualifier.table.test(table.qualifiedName)) {
      score += 90;
      reasons.push(`explicit ${qualifier.label} table intent`);
    }
  }
  const exactName = bare.replace(/_/g, " ");
  if (hasPhrase(question, exactName) || queryTokens.has(bare)) {
    score += 28;
    reasons.push("exact table name match");
  }
  const tableNameTokens = tokenize(table.name);
  if ([...tableNameTokens].some((token) => tokenVariants(token).some((variant) => queryTokens.has(variant)))) {
    score += intent === "lookup" ? 34 : 14;
    reasons.push("table name token variant match");
  }
  const overlap = tokenOverlap(queryTokens, tokenize(`${table.name} ${table.qualifiedName} ${table.description ?? ""}`));
  if (overlap > 0) {
    score += overlap * 5;
    reasons.push(`${overlap} table token match${overlap === 1 ? "" : "es"}`);
  }
  const distance = joinDistances.get(tableName);
  if (distance !== undefined && !semanticTables.has(tableName)) {
    if (distance === 1) {
      score += joinIntent ? 18 : metricIntent ? 12 : 3;
      reasons.push("one-hop join from semantic metric table");
    } else if (distance === 2) {
      score += joinIntent ? 8 : metricIntent ? 5 : 1;
      reasons.push("two-hop join from semantic metric table");
    } else {
      score -= 8;
      reasons.push(`penalized ${distance}-hop join from semantic metric table`);
    }
  }
  if (/(^|[_.])(history|hist|staged|archive|audit)([_.]|$)/i.test(table.qualifiedName)) {
    if (/\b(history|historical|staged|archive|audit)\b/i.test(question)) {
      score += 26;
      reasons.push("explicit history/staging intent");
    } else {
      score -= 18;
      reasons.push("penalized history/staging table");
    }
  }
  return { item: table, score, reasons };
}

function rankColumn(
  column: RankableColumn,
  lexicalIndex: number,
  queryTokens: Set<string>,
  semanticColumns: Set<string>,
  semanticTables: Set<string>,
): RankedCandidate<RankableColumn> {
  let score = Math.max(1, 18 - lexicalIndex * 2);
  const reasons = [`lexical candidate rank ${lexicalIndex + 1}`];
  if (semanticColumns.has(norm(column.qualifiedName))) {
    score += 60;
    reasons.push("used by matched semantic metric");
  }
  if (column.table && semanticTables.has(norm(column.table))) {
    score += 12;
    reasons.push("belongs to matched semantic table");
  }
  const bare = norm(column.name);
  if (queryTokens.has(bare)) {
    score += 30;
    reasons.push("exact column name match");
  }
  const overlap = tokenOverlap(queryTokens, tokenize(`${column.name} ${column.qualifiedName} ${column.semanticType ?? ""}`));
  if (overlap > 0) {
    score += overlap * 4;
    reasons.push(`${overlap} column token match${overlap === 1 ? "" : "es"}`);
  }
  if (column.semanticType && /email|date|time|fk|foreign|json/i.test(column.semanticType)) {
    score += 3;
    reasons.push(`semantic type ${column.semanticType}`);
  }
  if (/(^|[_.])(history|staged|archive|audit)([_.]|$)/i.test(column.table ?? "")) {
    score -= 10;
    reasons.push("penalized history/staging column");
  }
  return { item: column, score, reasons };
}

function computeJoinDistances(anchor: string, relationships: Relationship[]): Map<string, number> {
  const adj = new Map<string, string[]>();
  const add = (from: string, to: string) => {
    const key = norm(from);
    (adj.get(key) ?? adj.set(key, []).get(key)!).push(norm(to));
  };
  for (const relationship of relationships) {
    add(relationship.fromTable, relationship.toTable);
    add(relationship.toTable, relationship.fromTable);
  }
  const start = norm(anchor);
  const distances = new Map<string, number>([[start, 0]]);
  const queue = [start];
  while (queue.length) {
    const current = queue.shift()!;
    const nextDistance = (distances.get(current) ?? 0) + 1;
    for (const next of adj.get(current) ?? []) {
      if (distances.has(next)) continue;
      distances.set(next, nextDistance);
      queue.push(next);
    }
  }
  return distances;
}

function compareRanked<T extends { qualifiedName: string }>(a: RankedCandidate<T>, b: RankedCandidate<T>): number {
  return b.score - a.score || a.item.qualifiedName.localeCompare(b.item.qualifiedName);
}

function expandTokens(tokens: Set<string>): Set<string> {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    for (const variant of tokenVariants(token)) expanded.add(variant);
    for (const synonym of SYNONYMS[token] ?? []) expanded.add(norm(synonym));
  }
  return expanded;
}

function tokenVariants(token: string): string[] {
  const variants = [token];
  if (token.endsWith("ies") && token.length > 3) variants.push(`${token.slice(0, -3)}y`);
  if (token.endsWith("s") && token.length > 3) variants.push(token.slice(0, -1));
  if (!token.endsWith("s")) variants.push(`${token}s`);
  return variants;
}

function tokenOverlap(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of right) if (left.has(token)) count += 1;
  return count;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token && !STOPWORDS.has(token)),
  );
}

function hasPhrase(value: string, phrase: string): boolean {
  return value.toLowerCase().includes(phrase.toLowerCase());
}

function norm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
