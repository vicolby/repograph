import type { Driver } from "neo4j-driver";
import { ensureRepoConstraints, mapRepoNode, withSession } from "./db.js";
// Internal to the src/repos/ module (see store.ts): do not import from outside src/repos/.
import { optionalText, requiredText } from "./input.js";
import { normalizeRepoIdentifier } from "./normalize.js";

export type AddRepoInput = {
  /**
   * Repository identifier: a git remote URL (SSH `git@host:group/project.git`
   * or HTTPS `https://host/group/project.git`) or an already-normalized
   * GitLab full path (`group/subgroup/project`). Validated and normalized
   * through the shared `input.ts` seam, same as every other tool.
   */
  repo: string;
  /** Free-text repository type (e.g. `service`, `terraform-module`). Any string is accepted. */
  type?: string | null | undefined;
  description?: string | null | undefined;
};

export type RepoNode = {
  path: string;
  url: string;
  type: string | null;
  description: string | null;
};

/**
 * Creates a Repo node or updates the existing one (upsert keyed on the
 * normalized `path`).
 *
 * - New identifier: creates `(:Repo {path, url, type, description})`.
 * - Existing path: updates only the fields that were passed (type/description
 *   when non-null; url only when the identifier was a URL), never duplicates.
 */
export async function addRepo(driver: Driver, database: string, input: AddRepoInput): Promise<RepoNode> {
  const rawIdentifier = requiredText(input.repo, "add_repo", "repo");
  const { path, canonicalUrl, wasUrl } = normalizeRepoIdentifier(rawIdentifier);
  if (!path.includes("/")) {
    throw new Error(
      `add_repo: invalid repository path ${JSON.stringify(path)}: GitLab full path must be ` +
        `"group/project" (at least two segments); got single-segment ${JSON.stringify(path)}. ` +
        `Use the full path or search_repos to find it.`,
    );
  }
  const type = optionalText(input.type, "add_repo", "type");
  const description = optionalText(input.description, "add_repo", "description");

  const params = { path, url: canonicalUrl, type, description, wasUrl };
  return withSession(driver, database, async (session) => {
    await ensureRepoConstraints(session);
    const result = await session.run(
      `MERGE (r:Repo {path: $path})
       ON CREATE SET r.url = $url, r.type = $type, r.description = $description
       ON MATCH SET
         r.url = CASE WHEN $wasUrl THEN $url ELSE r.url END,
         r.type = CASE WHEN $type IS NOT NULL THEN $type ELSE r.type END,
         r.description = CASE WHEN $description IS NOT NULL THEN $description ELSE r.description END
       RETURN r.path AS path, r.url AS url, r.type AS type, r.description AS description`,
      params,
    );
    const record = result.records[0];
    if (!record) {
      throw new Error("add_repo failed: no record returned");
    }
    return mapRepoNode(record);
  });
}
