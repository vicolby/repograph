import type { Driver } from "neo4j-driver";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRepographServer } from "../src/mcp/server.js";
import { addRelation } from "../src/repos/addRelation.js";
import {
  clearDb,
  countEdges,
  seedRepos,
  startGraph,
  stopGraph,
  TEST_DATABASE,
  type TestGraph,
} from "./setup/graph-fixture.js";

describe("add_relation (real Neo4j)", () => {
  let graph: TestGraph;
  let driver: Driver;

  beforeAll(async () => {
    graph = await startGraph();
    driver = graph.driver;
  });

  afterAll(async () => {
    await stopGraph(graph);
  });

  beforeEach(async () => {
    await clearDb(driver, TEST_DATABASE);
    await seedRepos(driver, TEST_DATABASE, [
      { repo: "group/service-a", type: "service" },
      { repo: "group/service-b", type: "service" },
    ]);
  });

  it("creates an edge with type, evidence, created_by, created_at", async () => {
    const edge = await addRelation(driver, TEST_DATABASE, {
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
    await expect(countEdges(driver, TEST_DATABASE)).resolves.toBe(1);
  });

  it("accepts arbitrary type strings, not a fixed enum", async () => {
    const edge = await addRelation(driver, TEST_DATABASE, {
      from: "group/service-a",
      to: "group/service-b",
      type: "quantum-entangled-with",
      evidence: ["made-up link for test"],
    });

    expect(edge.type).toBe("quantum-entangled-with");
  });

  it("repeating the same (from, to, type) appends evidence and refreshes created_at without duplicating", async () => {
    const first = await addRelation(driver, TEST_DATABASE, {
      from: "group/service-a",
      to: "group/service-b",
      type: "depends_on",
      evidence: ["first: handler.ts:12"],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await addRelation(driver, TEST_DATABASE, {
      from: "group/service-a",
      to: "group/service-b",
      type: "depends_on",
      evidence: ["second: README mention"],
    });

    expect(second.evidence).toEqual(["first: handler.ts:12", "second: README mention"]);
    expect(Date.parse(second.created_at) >= Date.parse(first.created_at)).toBe(true);
    await expect(countEdges(driver, TEST_DATABASE)).resolves.toBe(1);
  });

  it("accepts SSH URL, HTTPS URL, and plain path for from/to", async () => {
    const edge = await addRelation(driver, TEST_DATABASE, {
      from: "git@gitlab.com:group/service-a.git",
      to: "https://gitlab.com/group/service-b.git",
      type: "depends_on",
      evidence: ["url forms resolve to the same nodes"],
    });

    expect(edge.from).toBe("group/service-a");
    expect(edge.to).toBe("group/service-b");
    await expect(countEdges(driver, TEST_DATABASE)).resolves.toBe(1);
  });

  it("keeps separate edges for different types on the same pair", async () => {
    await addRelation(driver, TEST_DATABASE, {
      from: "group/service-a",
      to: "group/service-b",
      type: "depends_on",
      evidence: ["calls API"],
    });
    await addRelation(driver, TEST_DATABASE, {
      from: "group/service-a",
      to: "group/service-b",
      type: "uses_infra",
      evidence: ["uses shared terraform module"],
    });

    await expect(countEdges(driver, TEST_DATABASE)).resolves.toBe(2);
  });

  it("throws when either endpoint repo does not exist", async () => {
    await expect(
      addRelation(driver, TEST_DATABASE, {
        from: "group/ghost",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["nope"],
      }),
    ).rejects.toThrow(/not found/i);
    await expect(
      addRelation(driver, TEST_DATABASE, {
        from: "group/service-a",
        to: "group/ghost",
        type: "depends_on",
        evidence: ["nope"],
      }),
    ).rejects.toThrow(/not found/i);
    await expect(countEdges(driver, TEST_DATABASE)).resolves.toBe(0);
  });

  it("requires non-empty evidence", async () => {
    await expect(
      addRelation(driver, TEST_DATABASE, {
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: [],
      }),
    ).rejects.toThrow(/evidence/i);
  });

  it("is registered as an MCP tool on the server", async () => {
    const server = createRepographServer({ driver, database: TEST_DATABASE });
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(Object.keys(tools)).toContain("add_relation");
  });
});
