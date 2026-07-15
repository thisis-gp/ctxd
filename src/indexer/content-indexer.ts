/**
 * Metabase content indexer (§7.3).
 *
 * Indexes Metabase-owned analytical assets — questions, models, dashboards — and
 * their query definitions. Answers "does Metabase already contain a trusted or
 * reusable query for this question?".
 *
 * Kept separate from the metadata indexer because a table can exist with no saved
 * question, and a saved question carries analytical *intent* that raw schema
 * metadata cannot express.
 */

import { logger } from "../logger.js";
import type { Asset } from "../model.js";
import type { MetabaseClient } from "../metabase/client.js";
import type { MbCard } from "../metabase/types.js";

export interface ContentIndexResult {
  assets: Asset[];
}

/** Best-effort extraction of referenced tables from raw SQL (§7.3: "when safe"). */
export function extractTableRefsFromSql(sql: string): string[] {
  const refs = new Set<string>();
  // Strip line and block comments so commented-out FROMs don't count.
  const cleaned = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  // Match identifiers after FROM / JOIN. Allow optional schema qualifier and quotes.
  const re = /\b(?:from|join)\s+([`"[]?[\w.]+[`"\]]?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const raw = m[1];
    if (!raw) continue;
    const name = raw.replace(/[`"[\]]/g, "").toLowerCase();
    // Skip subquery aliases / obvious non-tables.
    if (name && !name.startsWith("(") && name !== "select") {
      refs.add(name);
    }
  }
  return [...refs];
}

export class ContentIndexer {
  constructor(private readonly client: MetabaseClient) {}

  /**
   * Index cards and dashboards.
   *
   * @param tableIdToQualified map from Metabase numeric table id to qualified
   *   name, built from the metadata pass, used to resolve structured-query
   *   `source-table` references.
   * @param allowedDatabaseIds if non-empty, only index assets targeting these DBs.
   */
  async index(
    tableIdToQualified: Map<number, string>,
    allowedDatabaseIds: number[],
  ): Promise<ContentIndexResult> {
    const allowed = new Set(allowedDatabaseIds);
    const assets: Asset[] = [];

    const cards = await this.client.listCards();
    for (const card of cards) {
      if (allowed.size && card.database_id != null && !allowed.has(card.database_id)) {
        continue;
      }
      assets.push(this.normalizeCard(card, tableIdToQualified));
    }
    logger.info("indexed cards", { count: assets.length });

    // Dashboards: fetch each for its card list so we can record card->dashboard links.
    const dashboards = await this.client.listDashboards();
    const cardIdToDashboards = new Map<number, string[]>();
    for (const summary of dashboards) {
      let full;
      try {
        full = await this.client.getDashboard(summary.id);
      } catch {
        full = summary; // fall back to summary if detail fetch is not permitted
      }
      const cardRefs = full.dashcards ?? full.ordered_cards ?? [];
      for (const ref of cardRefs) {
        const cid = ref.card_id ?? ref.card?.id;
        if (cid == null) continue;
        const list = cardIdToDashboards.get(cid) ?? [];
        list.push(full.name);
        cardIdToDashboards.set(cid, list);
      }
      assets.push({
        id: `dashboard:${full.id}`,
        kind: "dashboard",
        metabaseId: full.id,
        name: full.name,
        description: full.description ?? undefined,
        collectionName: full.collection?.name,
        tableRefs: [],
        url: `/dashboard/${full.id}`,
      });
    }
    logger.info("indexed dashboards", { count: dashboards.length });

    // Attach dashboard membership back onto the card assets.
    for (const asset of assets) {
      if (asset.kind === "dashboard") continue;
      const dnames = cardIdToDashboards.get(asset.metabaseId);
      if (dnames?.length) asset.dashboardNames = [...new Set(dnames)];
    }

    return { assets };
  }

  private normalizeCard(card: MbCard, tableIdToQualified: Map<number, string>): Asset {
    const isModel = card.type === "model" || card.dataset === true;
    const dq = card.dataset_query;
    const queryType = dq?.type;
    const nativeSql = dq?.native?.query ?? undefined;

    const tableRefs = new Set<string>();
    if (queryType === "native" && nativeSql) {
      for (const ref of extractTableRefsFromSql(nativeSql)) tableRefs.add(ref);
    } else if (queryType === "query") {
      const src = dq?.query?.["source-table"];
      if (typeof src === "number") {
        const q = tableIdToQualified.get(src);
        if (q) tableRefs.add(q);
      }
    }
    if (typeof card.table_id === "number") {
      const q = tableIdToQualified.get(card.table_id);
      if (q) tableRefs.add(q);
    }

    return {
      id: `${isModel ? "model" : "question"}:${card.id}`,
      kind: isModel ? "model" : "question",
      metabaseId: card.id,
      name: card.name,
      description: card.description ?? undefined,
      queryType,
      nativeSql,
      databaseId: card.database_id ?? dq?.database ?? undefined,
      tableRefs: [...tableRefs],
      collectionName: card.collection?.name,
      url: `/${isModel ? "model" : "question"}/${card.id}`,
    };
  }
}
