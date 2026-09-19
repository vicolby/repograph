import type { Driver, Record as Neo4jRecord } from "neo4j-driver";
import { ensureRepoConstraints, withSession } from "./db.js";
// Internal to the src/repos/ module (see store.ts): do not import from outside src/repos/.
import { optionalText, requiredText, requiredTextList, resolveRepoPath } from "./input.js";

export type AddRelationInput = {
  /** Source repo: git remote URL (SSH/HTTPS) or normalized path. */
  from: string;
  /** Target repo: git remote URL (SSH/HTTPS) or normalized path. */
  to: string;
  /** Free-text relation type (`depends_on`, `uses_infra`, anything else). Any string is accepted. */
  type: string;
  /** Sources/citations the relation was derived from. Must be non-empty. */
  evidence: string[];
  /** Who/what created the relation. Optional; preserved when omitted on repeat calls. */
  created_by?: string | null | undefined;
};

export type RelationEdge = {
  from: string;
  to: string;
  type: string;
  evidence: string[];
  created_by: string | null;
  created_at: string;
};

function mapRelationEdge(record: Neo4jRecord): RelationEdge {
  return {
    from: record.get("from") as string,
    to: record.get("to") as string,
    type: record.get("type") as string,
    evidence: (record.get("evidence") as string[] | null) ?? [],
    created_by: (record.get("created_by") as string | null) ?? null,
    created_at: record.get("created_at") as string,
  };
}

/**
 * Creates a relation edge between two existing repos, or accumulates onto
 * the existing one (keyed on the `(from, to, type)` triple).
 *
 * - New triple: creates `(from)-[:RELATES {type, evidence, created_by,
 *   created_at}]->(to)`. The Neo4j relationship type is fixed (`RELATES`);
 *   the free-text `type` is stored as a property so agents can introduce
 *   new types without schema/code changes.
 * - Existing triple: appends the new `evidence` to the edge's list and
 *   refreshes `created_at`, never duplicating the edge. `created_by` is
 *   updated only when a new value is passed.
 * - Both endpoints must already exist (via `add_repo`); otherwise throws.
 */
export async function addRelation(
  driver: Driver,
  database: string,
  input: AddRelationInput,
): Promise<RelationEdge> {
  const fromPath = resolveRepoPath(input.from, "add_relation", "from");
  const toPath = resolveRepoPath(input.to, "add_relation", "to");
  const type = requiredText(input.type, "add_relation", "type");
  const evidence = requiredTextList(input.evidence, "add_relation", "evidence");
  const createdBy = optionalText(input.created_by, "add_relation", "created_by");
  const now = new Date().toISOString();

  return withSession(driver, database, async (session) => {
    await ensureRepoConstraints(session);

    const endpoints = await session.run(
      `OPTIONAL MATCH (a:Repo {path: $fromPath})
       OPTIONAL MATCH (b:Repo {path: $toPath})
       RETURN a IS NOT NULL AS fromExists, b IS NOT NULL AS toExists`,
      { fromPath, toPath },
    );
    const row = endpoints.records[0];
    if (row?.get("fromExists") !== true) {
      throw new Error(`add_relation: repo not found: ${JSON.stringify(fromPath)} (call add_repo first)`);
    }
    if (row?.get("toExists") !== true) {
      throw new Error(`add_relation: repo not found: ${JSON.stringify(toPath)} (call add_repo first)`);
    }

    const result = await session.run(
      `MATCH (a:Repo {path: $fromPath}), (b:Repo {path: $toPath})
       MERGE (a)-[r:RELATES {type: $type}]->(b)
       ON CREATE SET r.evidence = $evidence, r.created_by = $createdBy, r.created_at = $now
       ON MATCH SET
         r.evidence = coalesce(r.evidence, []) + $evidence,
         r.created_by = CASE WHEN $createdBy IS NOT NULL THEN $createdBy ELSE r.created_by END,
         r.created_at = $now
       RETURN a.path AS from, b.path AS to, r.type AS type,
         r.evidence AS evidence, r.created_by AS created_by, r.created_at AS created_at`,
      { fromPath, toPath, type, evidence, createdBy, now },
    );
    const record = result.records[0];
    if (!record) {
      throw new Error("add_relation failed: no record returned");
    }
    return mapRelationEdge(record);
  });
}
