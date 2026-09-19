import type { Driver } from "neo4j-driver";
import { ensureRepoConstraints, ensureReposExist, mapRelationEdge, withSession } from "./db.js";
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
  /** ISO timestamp of the soft delete; null while the edge is current. */
  superseded_at: string | null;
  /** Who/what superseded the edge; null while the edge is current. */
  superseded_by: string | null;
};

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
 *   updated only when a new value is passed. A previously superseded edge
 *   is revived (its `superseded_at`/`superseded_by` markers are cleared).
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
    await ensureReposExist(session, fromPath, toPath, "add_relation");

    const result = await session.run(
      `MATCH (a:Repo {path: $fromPath}), (b:Repo {path: $toPath})
       MERGE (a)-[r:RELATES {type: $type}]->(b)
       ON CREATE SET r.evidence = $evidence, r.created_by = $createdBy, r.created_at = $now,
         r.superseded_at = NULL, r.superseded_by = NULL
       ON MATCH SET
         r.evidence = coalesce(r.evidence, []) + $evidence,
         r.created_by = CASE WHEN $createdBy IS NOT NULL THEN $createdBy ELSE r.created_by END,
         r.created_at = $now,
         r.superseded_at = NULL,
         r.superseded_by = NULL
       RETURN a.path AS from, b.path AS to, r.type AS type,
         r.evidence AS evidence, r.created_by AS created_by, r.created_at AS created_at,
         r.superseded_at AS superseded_at, r.superseded_by AS superseded_by`,
      { fromPath, toPath, type, evidence, createdBy, now },
    );
    const record = result.records[0];
    if (!record) {
      throw new Error("add_relation failed: no record returned");
    }
    return mapRelationEdge(record);
  });
}
