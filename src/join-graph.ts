import { SemanticError } from "./errors.js";
import type { ContextContract, ContextJoin } from "./contract.js";

export interface JoinPath { entities: string[]; joins: ContextJoin[]; fanoutRisk: "none" | "low" | "high"; }

export function findApprovedJoinPath(contract: ContextContract, from: string, to: string): JoinPath {
  if (from === to) return { entities: [from], joins: [], fanoutRisk: "none" };
  const edges = contract.joins.filter((join) => join.approved);
  const queue: Array<{ entity: string; entities: string[]; joins: ContextJoin[]; risk: JoinPath["fanoutRisk"] }> = [{ entity: from, entities: [from], joins: [], risk: "none" }];
  const visited = new Set([from]);
  while (queue.length) {
    const current = queue.shift()!;
    for (const join of edges) {
      const next = join.from === current.entity ? join.to : join.to === current.entity ? join.from : undefined;
      if (!next || visited.has(next)) continue;
      const risk = join.fanoutRisk === "high" || join.relationship === "many_to_many" ? "high" : join.fanoutRisk === "low" || join.relationship === "one_to_many" ? "low" : current.risk;
      const path = { entities: [...current.entities, next], joins: [...current.joins, join], fanoutRisk: risk } satisfies JoinPath;
      if (next === to) return path;
      visited.add(next);
      queue.push({ entity: next, entities: path.entities, joins: path.joins, risk });
    }
  }
  throw new SemanticError(`No approved join path exists between "${from}" and "${to}".`);
}

export function assertSafeJoinPath(path: JoinPath): void {
  if (path.fanoutRisk === "high") throw new SemanticError(`Join path contains a high fanout relationship: ${path.joins.map((join) => join.id).join(", ")}.`);
}
