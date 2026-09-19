import type { Driver } from "neo4j-driver";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRepographServer } from "../src/mcp/server.js";
import type { RepoStore } from "../src/repos/store.js";
import {
  clearDb,
  seedRepos,
  startGraph,
  stopGraph,
  TEST_DATABASE,
  type TestGraph,
} from "./setup/graph-fixture.js";

describe("get_related_repos (real Neo4j)", () => {
  let graph: TestGraph;
  let driver: Driver;
  let store: RepoStore;

  beforeAll(async () => {
    graph = await startGraph();
    driver = graph.driver;
    store = graph.store;
  });

  afterAll(async () => {
    await stopGraph(graph);
  });

  beforeEach(async () => {
    await clearDb(driver, TEST_DATABASE);
    await seedRepos(store, [
      { repo: "group/service-a", type: "service" },
      { repo: "group/service-b", type: "service" },
      { repo: "group/service-c", type: "service" },
      { repo: "group/service-d", type: "service" },
      { repo: "infra/terraform-x", type: "terraform-module" },
    ]);
    await store.addRelation({
      from: "group/service-a",
      to: "group/service-b",
      type: "depends_on",
      evidence: ["a calls b"],
    });
    // Incoming edge into the start node.
    await store.addRelation({
      from: "group/service-c",
      to: "group/service-a",
      type: "depends_on",
      evidence: ["c calls a"],
    });
    // Depth-2 neighbor, reachable only via service-b.
    await store.addRelation({
      from: "group/service-b",
      to: "group/service-d",
      type: "depends_on",
      evidence: ["b calls d"],
    });
    // Same start node, different relation type.
    await store.addRelation({
      from: "group/service-a",
      to: "infra/terraform-x",
      type: "uses_infra",
      evidence: ["a uses terraform-x"],
    });
  });

  it("defaults to direct (depth-1) neighbors in both directions", async () => {
    const nodes = await store.getRelatedRepos({ repo: "group/service-a" });

    expect(nodes.map((n) => n.path).sort()).toEqual([
      "group/service-b",
      "group/service-c",
      "infra/terraform-x",
    ]);
  });

  it("treats an explicit depth of 1 the same as the default", async () => {
    const byDefault = await store.getRelatedRepos({ repo: "group/service-a" });
    const explicit = await store.getRelatedRepos({ repo: "group/service-a", depth: 1 });

    expect(explicit.map((n) => n.path).sort()).toEqual(byDefault.map((n) => n.path).sort());
  });

  it("widens the traversal with depth", async () => {
    const nodes = await store.getRelatedRepos({ repo: "group/service-a", depth: 2 });

    expect(nodes.map((n) => n.path).sort()).toEqual([
      "group/service-b",
      "group/service-c",
      "group/service-d",
      "infra/terraform-x",
    ]);
  });

  it("narrows back to direct neighbors when depth is 1 after a wider query", async () => {
    const wide = await store.getRelatedRepos({ repo: "group/service-a", depth: 3 });
    expect(wide.map((n) => n.path)).toContain("group/service-d");

    const narrow = await store.getRelatedRepos({ repo: "group/service-a", depth: 1 });
    expect(narrow.map((n) => n.path)).not.toContain("group/service-d");
  });

  it("filters to a single relation type", async () => {
    const dependsOn = await store.getRelatedRepos({
      repo: "group/service-a",
      type: "depends_on",
    });

    expect(dependsOn.map((n) => n.path).sort()).toEqual(["group/service-b", "group/service-c"]);
  });

  it("combines type filter with depth: every hop must match the type", async () => {
    const dependsOnDeep = await store.getRelatedRepos({
      repo: "group/service-a",
      depth: 2,
      type: "depends_on",
    });
    expect(dependsOnDeep.map((n) => n.path).sort()).toEqual([
      "group/service-b",
      "group/service-c",
      "group/service-d",
    ]);

    // terraform-x is the only uses_infra neighbor and has no further
    // uses_infra edges, so depth does not add anything.
    const infraDeep = await store.getRelatedRepos({
      repo: "group/service-a",
      depth: 2,
      type: "uses_infra",
    });
    expect(infraDeep.map((n) => n.path)).toEqual(["infra/terraform-x"]);
  });

  it("accepts SSH URL, HTTPS URL, and plain path for repo", async () => {
    const byPath = await store.getRelatedRepos({ repo: "group/service-a" });
    const bySsh = await store.getRelatedRepos({ repo: "git@gitlab.com:group/service-a.git" });
    const byHttps = await store.getRelatedRepos({
      repo: "https://gitlab.com/group/service-a.git",
    });

    const expected = byPath.map((n) => n.path).sort();
    expect(bySsh.map((n) => n.path).sort()).toEqual(expected);
    expect(byHttps.map((n) => n.path).sort()).toEqual(expected);
  });

  it("never includes the start repo itself, even when a cycle leads back to it", async () => {
    await store.addRelation({
      from: "group/service-d",
      to: "group/service-a",
      type: "depends_on",
      evidence: ["d calls a back"],
    });

    const nodes = await store.getRelatedRepos({ repo: "group/service-a", depth: 3 });

    expect(nodes.map((n) => n.path)).not.toContain("group/service-a");
  });

  it("throws when the repo does not exist", async () => {
    await expect(store.getRelatedRepos({ repo: "group/ghost" })).rejects.toThrow(/not found/i);
  });

  it("rejects out-of-range depth and blank type", async () => {
    await expect(store.getRelatedRepos({ repo: "group/service-a", depth: 0 })).rejects.toThrow(
      /depth/i,
    );
    await expect(store.getRelatedRepos({ repo: "group/service-a", depth: 11 })).rejects.toThrow(
      /depth/i,
    );
    await expect(
      store.getRelatedRepos({ repo: "group/service-a", type: "   " }),
    ).rejects.toThrow(/type/i);
  });

  it("is registered as an MCP tool on the server", async () => {
    const server = createRepographServer({ driver, database: TEST_DATABASE });
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(Object.keys(tools)).toContain("get_related_repos");
  });
});
