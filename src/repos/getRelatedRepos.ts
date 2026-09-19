import type { Driver } from "neo4j-driver";
import type { RepoNode } from "./addRepo.js";
import { mapRepoNode, withSession } from "./db.js";
import { optionalIntInRange, optionalText, resolveRepoPath } from "./input.js";
// Internal to the src/repos/ module (see store.ts): do not import from outside src/repos/.

export type GetRelatedReposInput = {
  /**
   * Repository identifier: a git remote URL (SSH `git@host:group/project.git`
   * or HTTPS `https://host/group/project.git`) or an already-normalized
   * GitLab full path (`group/subgroup/project`).
   */
  repo: string;
  /** Traversal depth. Defaults to 1, clamped to 1..10. */
  depth?: number | undefined;
  /** When provided, only traverses edges whose free-text `type` equals this value. */
  type?: string | null | undefined;
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
 * - Results are deduplicated, ordered by `path`, and never include the
 *   start repo itself (even when a cycle leads back to it).
 * - Throws when the start repo does not exist yet (call `add_repo` first),
 *   consistent with `add_relation`'s endpoint check.
 */
export async function getRelatedRepos(
  driver: Driver,
  database: string,
  input: GetRelatedReposInput,
): Promise<RepoNode[]> {
  const repoPath = resolveRepoPath(input.repo, "get_related_repos", "repo");
  const depth = optionalIntInRange(
    input.depth,
    "get_related_repos",
    "depth",
    MIN_DEPTH,
    MAX_DEPTH,
    DEFAULT_DEPTH,
  );
  const typeFilter = optionalText(input.type, "get_related_repos", "type");

  return withSession(driver, database, async (session) => {
    const exists = await session.run(
      `OPTIONAL MATCH (s:Repo {path: $repoPath})
       RETURN s IS NOT NULL AS exists`,
      { repoPath },
    );
    if (exists.records[0]?.get("exists") !== true) {
      throw new Error(
        `get_related_repos: repo not found: ${JSON.stringify(repoPath)} (call add_repo first)`,
      );
    }

    // `depth` is a validated integer, so interpolating it into the
    // variable-length pattern is safe (Cypher has no parameter for it).
    const typePredicate =
      typeFilter === null ? "" : " AND all(r IN rels WHERE r.type = $typeFilter)";
    const result = await session.run(
      `MATCH (start:Repo {path: $repoPath})
       MATCH (start)-[rels:RELATES*1..${depth}]-(neighbor:Repo)
       WHERE neighbor.path <> $repoPath${typePredicate}
       RETURN DISTINCT neighbor.path AS path, neighbor.url AS url,
         neighbor.type AS type, neighbor.description AS description
       ORDER BY neighbor.path ASC`,
      typeFilter === null ? { repoPath } : { repoPath, typeFilter },
    );
    return result.records.map((record) => mapRepoNode(record));
  });
}
