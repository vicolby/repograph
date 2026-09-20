import type { Driver } from "neo4j-driver";
import type { RelationEdge } from "./addRelation.js";
import { ensureRepoExists, mapRelationEdge, withSession } from "./db.js";
import {
  optionalBoolean,
  optionalRelationDirection,
  optionalText,
  resolveRepoIdentifier,
  type RelationDirection,
} from "./input.js";
// Internal to the src/repos/ module (see store.ts): do not import from outside src/repos/.

export type GetRelationsInput = {
  /**
   * Repository identifier: a git remote URL (SSH `git@host:group/project.git`
   * or HTTPS `https://host/group/project.git`) or an already-normalized
   * GitLab full path (`group/subgroup/project`).
   */
  repo: string;
  /**
   * Which incident edges to return: `out` (repo is the source), `in` (repo
   * is the target), or `both` (either side). Defaults to `both`.
   */
  direction?: RelationDirection | undefined;
  /** When provided, only returns edges whose free-text `type` equals this value. */
  type?: string | null | undefined;
  /**
   * When true, returns superseded (soft-deleted) edges as well.
   * Defaults to false: retracted relations stay in the graph as history
   * but are hidden from reads.
   */
  include_superseded?: boolean | undefined;
};

/**
 * Returns the `RELATES` edges incident to `repo`, with their per-side
 * file-scope hints (`from_paths`/`to_paths`), in a single call.
 *
 * - `direction` selects outgoing (`out`), incoming (`in`), or all (`both`,
 *   the default) incident edges. `from`/`to` on each returned edge always
 *   follow the stored edge orientation, regardless of direction.
 * - `type` restricts to edges of that free-text relation type.
 * - Superseded edges (retracted via `supersede_relation`) are skipped
 *   unless `include_superseded` is true.
 * - Edges stored before path hints existed read back as `[]` on both
 *   sides (see `mapRelationEdge`).
 * - Results are ordered by `(from, to, type)`.
 * - Throws NOT_FOUND when the repo does not exist: the message names
 *   `search_repos` and, for a bare short name, the candidate full paths.
 *   A bare short name (no group) auto-resolves when exactly one tracked
 *   repo ends with it.
 * - Unlike `get_related_repos` (repo nodes only), this returns edges.
 */
export async function getRelations(
  driver: Driver,
  database: string,
  input: GetRelationsInput,
): Promise<RelationEdge[]> {
  const repoRef = resolveRepoIdentifier(input.repo, "get_relations", "repo");
  const direction = optionalRelationDirection(input.direction, "get_relations", "direction");
  const typeFilter = optionalText(input.type, "get_relations", "type");
  const includeSuperseded = optionalBoolean(
    input.include_superseded,
    "get_relations",
    "include_superseded",
    false,
  );

  return withSession(driver, database, async (session) => {
    const repoPath = await ensureRepoExists(session, repoRef, "get_relations");

    // Anchor on the stored edge orientation: `a` is always the source, so
    // `from`/`to` stay edge-oriented for every direction.
    const orientation =
      direction === "out"
        ? "a.path = $repoPath"
        : direction === "in"
          ? "b.path = $repoPath"
          : "(a.path = $repoPath OR b.path = $repoPath)";
    const predicates: string[] = [orientation];
    if (!includeSuperseded) {
      predicates.push("r.superseded_at IS NULL");
    }
    if (typeFilter !== null) {
      predicates.push("r.type = $typeFilter");
    }
    const result = await session.run(
      `MATCH (a:Repo)-[r:RELATES]->(b:Repo)
       WHERE ${predicates.join(" AND ")}
       RETURN a.path AS from, b.path AS to, r.type AS type,
         r.evidence AS evidence, r.created_by AS created_by, r.created_at AS created_at,
         r.superseded_at AS superseded_at, r.superseded_by AS superseded_by,
         r.from_paths AS from_paths, r.to_paths AS to_paths
       ORDER BY from ASC, to ASC, type ASC`,
      typeFilter === null ? { repoPath } : { repoPath, typeFilter },
    );
    return result.records.map((record) => mapRelationEdge(record));
  });
}
