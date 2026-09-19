import type { StartedNeo4jContainer } from "@testcontainers/neo4j";
import type { Driver } from "neo4j-driver";
import { afterAll, beforeAll, beforeEach, describe } from "vitest";
import { withSession } from "../../src/repos/db.js";
import { closeNeo4jDriver, createNeo4jDriver } from "../../src/neo4j/driver.js";
import { createRepoStore, type RepoStore } from "../../src/repos/store.js";
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
  store: RepoStore;
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
  const store = createRepoStore(driver, TEST_DATABASE);
  return { container, driver, database: TEST_DATABASE, store };
}

/** Closes the driver and stops the container. */
export async function stopGraph(graph: TestGraph): Promise<void> {
  if (graph.driver) await closeNeo4jDriver(graph.driver);
  if (graph.container) await graph.container.stop();
}

/** Removes every node and edge; suites call this in `beforeEach`. */
export async function clearDb(driver: Driver, database: string): Promise<void> {
  await withSession(driver, database, async (session) => {
    await session.run("MATCH (n) DETACH DELETE n");
  });
}

export type SeedRepo = {
  repo: string;
  type?: string | undefined;
  description?: string | undefined;
};

/** Creates Repo nodes via the store (same seam the suites exercise). */
export async function seedRepos(store: RepoStore, specs: SeedRepo[]): Promise<void> {
  for (const spec of specs) {
    await store.addRepo(spec);
  }
}

async function count(driver: Driver, database: string, cypher: string): Promise<number> {
  return withSession(driver, database, async (session) => {
    const result = await session.run(cypher);
    return (result.records[0]?.get("count") as { toNumber: () => number }).toNumber();
  });
}

/** Number of `:Repo` nodes in the graph. */
export function countRepos(driver: Driver, database: string): Promise<number> {
  return count(driver, database, "MATCH (r:Repo) RETURN count(r) AS count");
}

/** Number of `:RELATES` edges in the graph. */
export function countEdges(driver: Driver, database: string): Promise<number> {
  return count(driver, database, "MATCH ()-[r:RELATES]->() RETURN count(r) AS count");
}

export type SeedRelation = {
  from: string;
  to: string;
  type: string;
  evidence: string[];
  created_by?: string | undefined;
};

export type GraphSuiteOptions = {
  seedRepos?: SeedRepo[];
  seedRelations?: SeedRelation[];
};

/** Live handles handed to a suite body; getters because the graph starts in `beforeAll`. */
export type GraphSuiteContext = {
  graph: () => TestGraph;
  driver: () => Driver;
  store: () => RepoStore;
};

/**
 * The single seam for real-Neo4j suites: container lifecycle, cleanup, and
 * seeding live here so test files declare only their scenario (name, seed,
 * and `it` blocks). Suites exercise the store interface; they never touch
 * lifecycle directly.
 */
export function defineGraphSuite(
  name: string,
  options: GraphSuiteOptions,
  body: (ctx: GraphSuiteContext) => void,
): void {
  describe(name, () => {
    let graph: TestGraph;

    beforeAll(async () => {
      graph = await startGraph();
    });

    afterAll(async () => {
      await stopGraph(graph);
    });

    beforeEach(async () => {
      await clearDb(graph.driver, TEST_DATABASE);
      if (options.seedRepos) {
        await seedRepos(graph.store, options.seedRepos);
      }
      for (const rel of options.seedRelations ?? []) {
        await graph.store.addRelation({
          from: rel.from,
          to: rel.to,
          type: rel.type,
          evidence: rel.evidence,
          created_by: rel.created_by,
        });
      }
    });

    body({
      graph: () => graph,
      driver: () => graph.driver,
      store: () => graph.store,
    });
  });
}
