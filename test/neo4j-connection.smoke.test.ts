import type { StartedNeo4jContainer } from "@testcontainers/neo4j";
import type { Driver } from "neo4j-driver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeNeo4jDriver, createNeo4jDriver, verifyNeo4jConnectivity } from "../src/bootstrap.js";
import { startTestNeo4j } from "./setup/neo4j-test-container.js";

describe("neo4j connection module (real instance)", () => {
  let container: StartedNeo4jContainer;
  let driver: Driver;

  beforeAll(async () => {
    container = await startTestNeo4j();
    driver = createNeo4jDriver({
      uri: container.getBoltUri(),
      user: container.getUsername(),
      password: container.getPassword(),
      database: "neo4j",
    });
    await verifyNeo4jConnectivity(driver, "neo4j");
  });

  afterAll(async () => {
    await closeNeo4jDriver(driver);
    await container.stop();
  });

  it("round-trips a query against the real database", async () => {
    const session = driver.session({ database: "neo4j" });
    try {
      const result = await session.run("RETURN 1 AS value");
      expect(result.records[0]?.get("value").toNumber()).toBe(1);
    } finally {
      await session.close();
    }
  });
});
