import type { StartedNeo4jContainer } from "@testcontainers/neo4j";
import type { Driver } from "neo4j-driver";
import { closeNeo4jDriver, createNeo4jDriver } from "../../src/neo4j/driver.js";
import { addRepo } from "../../src/repos/addRepo.js";
import { startTestNeo4j } from "./neo4j-test-container.js";

// Shared fixture for the real-Neo4j suites: container lifecycle, database
// cleanup, seeding, and counting live here so test files declare only their
// scenario. No default seed — suites opt in via seedRepos because their
// preconditions differ (empty graph vs a pair of nodes).

export const TEST_DATABASE = "neo4j";

export type TestGraph = {
  container: StartedNeo4jContainer;
  driver: Driver;
  database: string;
};

/** Starts a disposable Neo4j container and a driver for it. Stop with `stopGraph`. */
export async function startGraph(): Promise<TestGraph> {
  const container = await startTestNeo4j();
  const driver = createNeo4jDriver({
    uri: container.getBoltUri(),
    user: container.getUsername(),
    password: container.getPassword(),
    database: TEST_DATABASE,
  });
  return { container, driver, database: TEST_DATABASE };
}

/** Closes the driver and stops the container. */
export async function stopGraph(graph: TestGraph): Promise<void> {
  if (graph.driver) await closeNeo4jDriver(graph.driver);
  if (graph.container) await graph.container.stop();
}

/** Removes every node and edge; suites call this in `beforeEach`. */
export async function clearDb(driver: Driver, database: string): Promise<void> {
  const session = driver.session({ database });
  try {
    await session.run("MATCH (n) DETACH DELETE n");
  } finally {
    await session.close();
  }
}

export type SeedRepo = {
  repo: string;
  type?: string | undefined;
  description?: string | undefined;
};

/** Creates Repo nodes via the `addRepo` tool (same seam the suites exercise). */
export async function seedRepos(
  driver: Driver,
  database: string,
  specs: SeedRepo[],
): Promise<void> {
  for (const spec of specs) {
    await addRepo(driver, database, spec);
  }
}

async function count(driver: Driver, database: string, cypher: string): Promise<number> {
  const session = driver.session({ database });
  try {
    const result = await session.run(cypher);
    return (result.records[0]?.get("count") as { toNumber: () => number }).toNumber();
  } finally {
    await session.close();
  }
}

/** Number of `:Repo` nodes in the graph. */
export function countRepos(driver: Driver, database: string): Promise<number> {
  return count(driver, database, "MATCH (r:Repo) RETURN count(r) AS count");
}

/** Number of `:RELATES` edges in the graph. */
export function countEdges(driver: Driver, database: string): Promise<number> {
  return count(driver, database, "MATCH ()-[r:RELATES]->() RETURN count(r) AS count");
}
