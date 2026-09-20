import type { Driver, Record as Neo4jRecord, Session } from "neo4j-driver";
import neo4j from "neo4j-driver";
import type { RepoNode } from "./addRepo.js";
import type { RelationEdge } from "./addRelation.js";
import type { NormalizedRepo } from "./normalize.js";

// Internal to the src/repos/ module: session lifecycle, schema setup, and
// record mapping live here so tool operations stay focused on their Cypher.
// Not part of the module's interface — do not import from outside src/repos/.

/** Opens a session, runs `work`, and always closes the session. */
export async function withSession<T>(
  driver: Driver,
  database: string,
  work: (session: Session) => Promise<T>,
): Promise<T> {
  const session = driver.session({ database });
  try {
    return await work(session);
  } finally {
    await session.close();
  }
}

/** A repo reference the ensure helpers can resolve: full record or plain path. */
export type RepoRef =
  | string
  | Pick<NormalizedRepo, "path" | "wasUrl" | "isShortName">;

/** How many suffix candidates to fetch: 10 to display plus one to detect overflow. */
const SUFFIX_FETCH_LIMIT = 11;
/** How many candidates to list inline before collapsing to "and more". */
const SUFFIX_DISPLAY_LIMIT = 10;

function toRepoRefParts(ref: RepoRef): Pick<NormalizedRepo, "path" | "wasUrl" | "isShortName"> {
  if (typeof ref === "string") {
    return { path: ref, wasUrl: false, isShortName: !ref.includes("/") };
  }
  return ref;
}

/** Last path segment, used as the `search_repos` hint for full-path misses. */
function hintQueryFor(path: string): string {
  const slash = path.lastIndexOf("/");
  const last = slash >= 0 ? path.slice(slash + 1) : path;
  return last.length > 0 ? last : path;
}

function hintMissError(tool: string, endpoint: string, requested: string): Error {
  const hint = hintQueryFor(requested);
  return new Error(
    `${tool}: ${endpoint}repo not found: ${JSON.stringify(requested)}. ` +
      `Try search_repos(${JSON.stringify(hint)}) to find the full group/subgroup/project path, ` +
      `or call add_repo with the full path.`,
  );
}

/** Case-insensitive suffix candidates for a bare short name, ordered by path. */
async function findSuffixCandidates(session: Session, shortName: string): Promise<string[]> {
  const result = await session.run(
    `MATCH (r:Repo)
     WHERE toLower(r.path) ENDS WITH toLower($suffix)
     RETURN r.path AS path
     ORDER BY r.path ASC
     LIMIT $limit`,
    { suffix: `/${shortName}`, limit: neo4j.int(SUFFIX_FETCH_LIMIT) },
  );
  const paths: string[] = [];
  for (const record of result.records) {
    const path = record.get("path") as unknown;
    if (typeof path === "string") paths.push(path);
  }
  return paths;
}

/**
 * Resolves one repo reference to its stored `path`, suffix-matching a bare
 * short name (plain input without `/`) when the exact path misses.
 *
 * - Exact hit: returns the stored path.
 * - Short-name miss with exactly one `path ENDS WITH '/' + short` match
 *   (case-insensitive): returns the match and logs the substitution to
 *   stderr (stdout stays pure MCP).
 * - Short-name miss with zero matches: throws NOT_FOUND naming
 *   `search_repos` instead of suggesting `add_repo` blindly.
 * - Short-name miss with several matches: throws NOT_FOUND listing the
 *   first 10 candidates so the caller can retry with the full path.
 * - Any other miss (full path or URL input): throws NOT_FOUND with a
 *   `search_repos` hint; URL inputs never auto-resolve.
 */
async function resolveSingleRepo(
  session: Session,
  ref: RepoRef,
  tool: string,
  endpoint: string,
): Promise<string> {
  const { path, wasUrl, isShortName } = toRepoRefParts(ref);
  const exact = await session.run(`OPTIONAL MATCH (s:Repo {path: $repoPath}) RETURN s IS NOT NULL AS exists`, {
    repoPath: path,
  });
  if (exact.records[0]?.get("exists") === true) return path;

  if (!isShortName || wasUrl) throw hintMissError(tool, endpoint, path);

  const candidates = await findSuffixCandidates(session, path);
  if (candidates.length === 0) {
    throw new Error(
      `${tool}: ${endpoint}repo not found: ${JSON.stringify(path)}. ` +
        `No repo ends with ${JSON.stringify(`/${path}`)}; ` +
        `try search_repos(${JSON.stringify(path)}) to find the full group/subgroup/project path, ` +
        `or call add_repo with the full path.`,
    );
  }
  const single = candidates.length === 1 ? candidates[0] : undefined;
  if (single !== undefined) {
    // stderr only: stdout is reserved for the MCP protocol.
    console.error(`${tool}: resolved short name ${JSON.stringify(path)} to ${JSON.stringify(single)}`);
    return single;
  }
  const shown = candidates.slice(0, SUFFIX_DISPLAY_LIMIT).map((c) => JSON.stringify(c));
  const overflow =
    candidates.length > SUFFIX_DISPLAY_LIMIT
      ? ` (and more — use search_repos(${JSON.stringify(path)}) to narrow)`
      : "";
  throw new Error(
    `${tool}: ${endpoint}repo not found: ${JSON.stringify(path)}. ` +
      `Did you mean one of: ${shown.join(", ")}?${overflow} Please retry with the full path.`,
  );
}

/**
 * Throws unless a Repo node exists for `repo`; returns the stored `path`
 * (a bare short name may resolve to its full path — callers must use the
 * return value, not the input). Miss messages suggest `search_repos`.
 */
export async function ensureRepoExists(
  session: Session,
  repo: RepoRef,
  tool: string,
): Promise<string> {
  return resolveSingleRepo(session, repo, tool, "");
}

/** Throws unless Repo nodes exist for both endpoints; returns stored paths. */
export async function ensureReposExist(
  session: Session,
  from: RepoRef,
  to: RepoRef,
  tool: string,
): Promise<{ fromPath: string; toPath: string }> {
  const fromPath = await resolveSingleRepo(session, from, tool, "from ");
  const toPath = await resolveSingleRepo(session, to, tool, "to ");
  return { fromPath, toPath };
}

/** Maps a relation RETURN record to a RelationEdge (single copy for all tools). */
export function mapRelationEdge(record: Neo4jRecord): RelationEdge {
  return {
    from: record.get("from") as string,
    to: record.get("to") as string,
    type: record.get("type") as string,
    evidence: (record.get("evidence") as string[] | null) ?? [],
    created_by: (record.get("created_by") as string | null) ?? null,
    created_at: record.get("created_at") as string,
    superseded_at: (record.get("superseded_at") as string | null) ?? null,
    superseded_by: (record.get("superseded_by") as string | null) ?? null,
    // Edges stored before path hints existed carry no such property (null).
    from_paths: (record.get("from_paths") as string[] | null) ?? [],
    to_paths: (record.get("to_paths") as string[] | null) ?? [],
  };
}

/** Idempotently ensures the uniqueness constraints this module relies on. */
export async function ensureRepoConstraints(session: Session): Promise<void> {
  await session.run("CREATE CONSTRAINT repo_path_unique IF NOT EXISTS FOR (r:Repo) REQUIRE r.path IS UNIQUE");
}

/** Maps a `RETURN r.path AS path, r.url AS url, ...` record to a RepoNode. */
export function mapRepoNode(record: Neo4jRecord): RepoNode {
  return {
    path: record.get("path") as string,
    url: record.get("url") as string,
    type: (record.get("type") as string | null) ?? null,
    description: (record.get("description") as string | null) ?? null,
  };
}
