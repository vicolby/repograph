import type { StartedNeo4jContainer } from "@testcontainers/neo4j";
import type { Driver } from "neo4j-driver";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRepographServer } from "../src/mcp/server.js";
import { closeNeo4jDriver, createNeo4jDriver } from "../src/neo4j/driver.js";
import { addRepo } from "../src/repos/addRepo.js";
import { addRelation } from "../src/repos/addRelation.js";
import { startTestNeo4j } from "./setup/neo4j-test-container.js";

const DATABASE = "neo4j";

async function countEdges(driver: Driver): Promise<number> {
  const session = driver.session({ database: DATABASE });
  try {
    const result = await session.run("MATCH ()-[r:RELATES]->() RETURN count(r) AS count");
    return (result.records[0]?.get("count") as { toNumber: () => number }).toNumber();
  } finally {
    await session.close();
  }
}

describe("add_relation (real Neo4j)", () => {
  let container: StartedNeo4jContainer;
  let driver: Driver;

  beforeAll(async () => {
    container = await startTestNeo4j();
    driver = createNeo4jDriver({
      uri: container.getBoltUri(),
      user: container.getUsername(),
      password: container.getPassword(),
      database: DATABASE,
    });
  });

  afterAll(async () => {
    if (driver) await closeNeo4jDriver(driver);
    if (container) await container.stop();
  });

  beforeEach(async () => {
    const session = driver.session({ database: DATABASE });
    try {
      await session.run("MATCH (n) DETACH DELETE n");
    } finally {
      await session.close();
    }
    await addRepo(driver, DATABASE, { repo: "group/service-a", type: "service" });
    await addRepo(driver, DATABASE, { repo: "group/service-b", type: "service" });
  });

  it("creates an edge with type, evidence, created_by, created_at", async () => {
    const edge = await addRelation(driver, DATABASE, {
      from: "group/service-a",
      to: "group/service-b",
      type: "depends_on",
      evidence: ["service-a/handler.ts:12 calls POST /orders"],
      created_by: "test-agent",
    });

    expect(edge.from).toBe("group/service-a");
    expect(edge.to).toBe("group/service-b");
    expect(edge.type).toBe("depends_on");
    expect(edge.evidence).toEqual(["service-a/handler.ts:12 calls POST /orders"]);
    expect(edge.created_by).toBe("test-agent");
    expect(typeof edge.created_at).toBe("string");
    expect(Number.isNaN(Date.parse(edge.created_at))).toBe(false);
    await expect(countEdges(driver)).resolves.toBe(1);
  });

  it("accepts arbitrary type strings, not a fixed enum", async () => {
    const edge = await addRelation(driver, DATABASE, {
      from: "group/service-a",
      to: "group/service-b",
      type: "quantum-entangled-with",
      evidence: ["made-up link for test"],
    });

    expect(edge.type).toBe("quantum-entangled-with");
  });

  it("repeating the same (from, to, type) appends evidence and refreshes created_at without duplicating", async () => {
    const first = await addRelation(driver, DATABASE, {
      from: "group/service-a",
      to: "group/service-b",
      type: "depends_on",
      evidence: ["first: handler.ts:12"],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await addRelation(driver, DATABASE, {
      from: "group/service-a",
      to: "group/service-b",
      type: "depends_on",
      evidence: ["second: README mention"],
    });

    expect(second.evidence).toEqual(["first: handler.ts:12", "second: README mention"]);
    expect(Date.parse(second.created_at) >= Date.parse(first.created_at)).toBe(true);
    await expect(countEdges(driver)).resolves.toBe(1);
  });

  it("accepts SSH URL, HTTPS URL, and plain path for from/to", async () => {
    const edge = await addRelation(driver, DATABASE, {
      from: "git@gitlab.com:group/service-a.git",
      to: "https://gitlab.com/group/service-b.git",
      type: "depends_on",
      evidence: ["url forms resolve to the same nodes"],
    });

    expect(edge.from).toBe("group/service-a");
    expect(edge.to).toBe("group/service-b");
    await expect(countEdges(driver)).resolves.toBe(1);
  });

  it("keeps separate edges for different types on the same pair", async () => {
    await addRelation(driver, DATABASE, {
      from: "group/service-a",
      to: "group/service-b",
      type: "depends_on",
      evidence: ["calls API"],
    });
    await addRelation(driver, DATABASE, {
      from: "group/service-a",
      to: "group/service-b",
      type: "uses_infra",
      evidence: ["uses shared terraform module"],
    });

    await expect(countEdges(driver)).resolves.toBe(2);
  });

  it("throws when either endpoint repo does not exist", async () => {
    await expect(
      addRelation(driver, DATABASE, {
        from: "group/ghost",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["nope"],
      }),
    ).rejects.toThrow(/not found/i);
    await expect(
      addRelation(driver, DATABASE, {
        from: "group/service-a",
        to: "group/ghost",
        type: "depends_on",
        evidence: ["nope"],
      }),
    ).rejects.toThrow(/not found/i);
    await expect(countEdges(driver)).resolves.toBe(0);
  });

  it("requires non-empty evidence", async () => {
    await expect(
      addRelation(driver, DATABASE, {
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: [],
      }),
    ).rejects.toThrow(/evidence/i);
  });

  it("is registered as an MCP tool on the server", async () => {
    const server = createRepographServer({ driver, database: DATABASE });
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(Object.keys(tools)).toContain("add_relation");
  });
});
