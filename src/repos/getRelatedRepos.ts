import type { Driver } from "neo4j-driver";
import type { RepoNode } from "./addRepo.js";
import { ensureRepoExists, mapRepoNode, withSession } from "./db.js";
import { optionalBoolean, optionalIntInRange, optionalText, resolveRepoIdentifier } from "./input.js";
// Internal to the src/repos/ module (see store.ts): do not import from outside src/repos/.

export type GetRelatedReposInput = {
  /**
   * Repository identifier: a git remote URL (SSH `git@host:group/project.git`
   * or HTTPS `https://host/group/project.git`) or an already-normalized
   * GitLab full path (`group/subgroup/project`).
   */
  repo: string;
  /** Traversal depth. Defaults to 1, must be an integer in 1..10. */
  depth?: number | undefined;
  /** When provided, only traverses edges whose free-text `type` equals this value. */
  type?: string | null | undefined;
  /**
   * When true, traverses superseded (soft-deleted) edges as well.
   * Defaults to false: retracted relations stay in the graph as history
   * but are hidden from traversal.
   */
  include_superseded?: boolean | undefined;
};

const DEFAULT_DEPTH = 1;
const MIN_DEPTH = 1;
const MAX_DEPTH = 10;

/**
 * Returns the repos reachable from `repo` within `depth` hops, following
 * `RELATES` edges in both directions (outgoing and incoming).
 *
 * - Default call returns direct (depth-1) neighbors in both directions.
 * - `depth` widens the traversal (`*1..depth` hops, undirected).
 * - `type` restricts traversal to edges whose `type` property equals the
 *   given free-text value (every hop must match).
 * - Superseded edges (retracted via `supersede_relation`) are skipped
 *   unless `include_superseded` is true. Multi-hop paths are hidden when
 *   any hop traverses a superseded edge.
 * - Results are deduplicated, ordered by `path`, and never include the
 *   start repo itself (even when a cycle leads back to it).
 * - Throws NOT_FOUND when the start repo does not exist: the message
 *   names `search_repos` and, for a bare short name, the candidate full
 *   paths. A bare short name auto-resolves when unambiguous,
 *   consistent with `add_relation`'s endpoint check.
 */
export async function getRelatedRepos(
  driver: Driver,
  database: string,
  input: GetRelatedReposInput,
): Promise<RepoNode[]> {
  const repoRef = resolveRepoIdentifier(input.repo, "get_related_repos", "repo");
  const depth = optionalIntInRange(
    input.depth,
    "get_related_repos",
    "depth",
    MIN_DEPTH,
    MAX_DEPTH,
    DEFAULT_DEPTH,
  );
  const typeFilter = optionalText(input.type, "get_related_repos", "type");
  const includeSuperseded = optionalBoolean(
    input.include_superseded,
    "get_related_repos",
    "include_superseded",
    false,
  );

  return withSession(driver, database, async (session) => {
    const repoPath = await ensureRepoExists(session, repoRef, "get_related_repos");

    // `depth` is a validated integer, so interpolating it into the
    // variable-length pattern is safe (Cypher has no parameter for it).
    // Superseded edges carry `superseded_at`; old edges created before the
    // soft-delete feature have no such property, and `IS NULL` matches both.
    const predicates: string[] = [];
    if (!includeSuperseded) {
      predicates.push("all(r IN rels WHERE r.superseded_at IS NULL)");
    }
    if (typeFilter !== null) {
      predicates.push("all(r IN rels WHERE r.type = $typeFilter)");
    }
    const whereClause =
      predicates.length > 0
        ? `WHERE neighbor.path <> $repoPath AND ${predicates.join(" AND ")}`
        : "WHERE neighbor.path <> $repoPath";
    const result = await session.run(
      `MATCH (start:Repo {path: $repoPath})
       MATCH (start)-[rels:RELATES*1..${depth}]-(neighbor:Repo)
       ${whereClause}
       RETURN DISTINCT neighbor.path AS path, neighbor.url AS url,
         neighbor.type AS type, neighbor.description AS description
       ORDER BY neighbor.path ASC`,
      typeFilter === null ? { repoPath } : { repoPath, typeFilter },
    );
    return result.records.map((record) => mapRepoNode(record));
  });
}
