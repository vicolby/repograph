import type { Driver, Record as Neo4jRecord, Session } from "neo4j-driver";
import type { RepoNode } from "./addRepo.js";

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
