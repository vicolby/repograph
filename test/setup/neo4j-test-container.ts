import { Neo4jContainer, type StartedNeo4jContainer } from "@testcontainers/neo4j";

const TEST_PASSWORD = "test-password";

/**
 * Starts a real, disposable Neo4j Community Edition container for tests.
 * Callers must call `.stop()` on the returned container when done.
 */
export async function startTestNeo4j(): Promise<StartedNeo4jContainer> {
  return new Neo4jContainer("neo4j:5-community").withPassword(TEST_PASSWORD).start();
}
