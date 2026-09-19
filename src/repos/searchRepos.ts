import type { Driver } from "neo4j-driver";
import neo4j from "neo4j-driver";
import type { RepoNode } from "./addRepo.js";
import { mapRepoNode, withSession } from "./db.js";
import { optionalIntInRange, requiredText } from "./input.js";

export type SearchReposInput = {
  /** Substring to match against repo `path` and `description` (case-insensitive). */
  query: string;
  /** Max nodes to return. Defaults to 20, clamped to 1..100. */
  limit?: number | undefined;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Finds Repo nodes by partial (substring) match on `path` or `description`.
 *
 * Matching is case-insensitive (`toLower(...) CONTAINS toLower($query)`), so
 * agents find a node without knowing its exact identifier. Results are
 * ordered by `path` for stable output.
 */
export async function searchRepos(
  driver: Driver,
  database: string,
  input: SearchReposInput,
): Promise<RepoNode[]> {
  const query = requiredText(input.query, "search_repos", "query");
  const limit = optionalIntInRange(input.limit, "search_repos", "limit", 1, MAX_LIMIT, DEFAULT_LIMIT);

  return withSession(driver, database, async (session) => {
    const result = await session.run(
      `MATCH (r:Repo)
       WHERE toLower(r.path) CONTAINS toLower($query)
          OR (r.description IS NOT NULL AND toLower(r.description) CONTAINS toLower($query))
       RETURN r.path AS path, r.url AS url, r.type AS type, r.description AS description
       ORDER BY r.path ASC
       LIMIT $limit`,
      { query, limit: neo4j.int(limit) },
    );
    return result.records.map((record) => mapRepoNode(record));
  });
}
