import type { Driver } from "neo4j-driver";
import type { RelationEdge } from "./addRelation.js";
import { ensureRepoConstraints, ensureReposExist, mapRelationEdge, withSession } from "./db.js";
// Internal to the src/repos/ module (see store.ts): do not import from outside src/repos/.
import { optionalText, requiredText, resolveRepoIdentifier } from "./input.js";

export type SupersedeRelationInput = {
  /** Source repo: git remote URL (SSH/HTTPS) or normalized path. */
  from: string;
  /** Target repo: git remote URL (SSH/HTTPS) or normalized path. */
  to: string;
  /** Free-text relation type, must match the edge's `type` property exactly. */
  type: string;
  /**
   * Who/what superseded the relation (e.g. a citation like
   * "infra.md rewired a -> c"). Optional; preserved when omitted on repeat calls.
   */
  superseded_by?: string | null | undefined;
};

/**
 * Soft-deletes a relation edge by marking it superseded instead of removing
 * it, so the evidence trail survives and `get_related_repos` can filter it
 * out by default (with an opt-in flag to see history).
 *
 * - Both endpoints must already exist (via `add_repo`); otherwise throws
 *   NOT_FOUND naming `search_repos` (short names auto-resolve when unambiguous).
 * - The `(from, to, type)` triple must match an existing edge; otherwise
 *   throws — there is nothing to retract.
 * - Repeat calls refresh `superseded_at` and update `superseded_by` only
 *   when a new value is passed, never duplicating the edge.
 * - File-scope hints (`from_paths`/`to_paths`) are never modified here:
 *   supersede preserves them verbatim so an accidental retract does not
 *   lose search scope.
 * - Re-recording the triple via `add_relation` revives the edge (clears the
 *   supersede markers) and appends the new evidence.
 */
export async function supersedeRelation(
  driver: Driver,
  database: string,
  input: SupersedeRelationInput,
): Promise<RelationEdge> {
  const fromRef = resolveRepoIdentifier(input.from, "supersede_relation", "from");
  const toRef = resolveRepoIdentifier(input.to, "supersede_relation", "to");
  const type = requiredText(input.type, "supersede_relation", "type");
  const supersededBy = optionalText(input.superseded_by, "supersede_relation", "superseded_by");
  const now = new Date().toISOString();

  return withSession(driver, database, async (session) => {
    await ensureRepoConstraints(session);
    const { fromPath, toPath } = await ensureReposExist(session, fromRef, toRef, "supersede_relation");

    const result = await session.run(
      `MATCH (a:Repo {path: $fromPath})-[r:RELATES {type: $type}]->(b:Repo {path: $toPath})
       SET r.superseded_at = $now,
         r.superseded_by = CASE WHEN $supersededBy IS NOT NULL THEN $supersededBy ELSE r.superseded_by END
       RETURN a.path AS from, b.path AS to, r.type AS type,
         r.evidence AS evidence, r.created_by AS created_by, r.created_at AS created_at,
         r.superseded_at AS superseded_at, r.superseded_by AS superseded_by,
         r.from_paths AS from_paths, r.to_paths AS to_paths`,
      { fromPath, toPath, type, supersededBy, now },
    );
    const record = result.records[0];
    if (!record) {
      throw new Error(
        `supersede_relation: relation not found: ${JSON.stringify(fromPath)} -> ${JSON.stringify(toPath)} ${JSON.stringify(type)}`,
      );
    }
    return mapRelationEdge(record);
  });
}
