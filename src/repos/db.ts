import type { Driver, Record as Neo4jRecord, Session } from "neo4j-driver";
import type { RepoNode } from "./addRepo.js";
import type { RelationEdge } from "./addRelation.js";

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

/** Throws unless a Repo node exists for `repoPath`; message matches the old per-tool wording. */
export async function ensureRepoExists(
  session: Session,
  repoPath: string,
  tool: string,
): Promise<void> {
  const result = await session.run(
    `OPTIONAL MATCH (s:Repo {path: $repoPath})
     RETURN s IS NOT NULL AS exists`,
    { repoPath },
  );
  if (result.records[0]?.get("exists") !== true) {
    throw new Error(`${tool}: repo not found: ${JSON.stringify(repoPath)} (call add_repo first)`);
  }
}

/** Throws unless Repo nodes exist for both relation endpoints. */
export async function ensureReposExist(
  session: Session,
  fromPath: string,
  toPath: string,
  tool: string,
): Promise<void> {
  const result = await session.run(
    `OPTIONAL MATCH (a:Repo {path: $fromPath})
     OPTIONAL MATCH (b:Repo {path: $toPath})
     RETURN a IS NOT NULL AS fromExists, b IS NOT NULL AS toExists`,
    { fromPath, toPath },
  );
  const row = result.records[0];
  if (row?.get("fromExists") !== true) {
    throw new Error(`${tool}: repo not found: ${JSON.stringify(fromPath)} (call add_repo first)`);
  }
  if (row?.get("toExists") !== true) {
    throw new Error(`${tool}: repo not found: ${JSON.stringify(toPath)} (call add_repo first)`);
  }
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
