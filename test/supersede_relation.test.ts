import { expect, it } from "vitest";
import { createRepographServer } from "../src/mcp/server.js";
import {
  countEdges,
  defineGraphSuite,
  TEST_DATABASE,
} from "./setup/graph-fixture.js";

defineGraphSuite(
  "supersede_relation (real Neo4j)",
  {
    seedRepos: [
      { repo: "group/service-a", type: "service" },
      { repo: "group/service-b", type: "service" },
      { repo: "group/service-c", type: "service" },
    ],
    seedRelations: [
      {
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["a calls b"],
        created_by: "test-agent",
      },
    ],
  },
  ({ driver, store }) => {

  it("marks the edge superseded, preserving evidence, and hides it from default traversal", async () => {
    const edge = await store().supersedeRelation({
      from: "group/service-a",
      to: "group/service-b",
      type: "depends_on",
      superseded_by: "infra.md rewired a -> c",
    });

    expect(edge.from).toBe("group/service-a");
    expect(edge.to).toBe("group/service-b");
    expect(edge.type).toBe("depends_on");
    // Evidence trail survives the retraction.
    expect(edge.evidence).toEqual(["a calls b"]);
    expect(edge.created_by).toBe("test-agent");
    expect(typeof edge.superseded_at).toBe("string");
    expect(Number.isNaN(Date.parse(edge.superseded_at as string))).toBe(false);
    expect(edge.superseded_by).toBe("infra.md rewired a -> c");
    // Soft delete: the edge row still exists.
    await expect(countEdges(driver(), TEST_DATABASE)).resolves.toBe(1);

    // Default traversal skips superseded edges...
    await expect(store().getRelatedRepos({ repo: "group/service-a" })).resolves.toEqual([]);
    // ...unless history is explicitly requested.
    const withHistory = await store().getRelatedRepos({
      repo: "group/service-a",
      include_superseded: true,
    });
    expect(withHistory.map((n) => n.path)).toEqual(["group/service-b"]);
  });

  it("superseding is idempotent and refreshes superseded_at", async () => {
    const first = await store().supersedeRelation({
      from: "group/service-a",
      to: "group/service-b",
      type: "depends_on",
    });
    expect(first.superseded_by).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await store().supersedeRelation({
      from: "group/service-a",
      to: "group/service-b",
      type: "depends_on",
      superseded_by: "second pass",
    });

    expect(Date.parse(second.superseded_at as string) >= Date.parse(first.superseded_at as string)).toBe(
      true,
    );
    expect(second.superseded_by).toBe("second pass");
    await expect(countEdges(driver(), TEST_DATABASE)).resolves.toBe(1);
  });

  it("re-adding the triple via add_relation revives the edge", async () => {
    await store().supersedeRelation({
      from: "group/service-a",
      to: "group/service-b",
      type: "depends_on",
      superseded_by: "stale",
    });
    await expect(store().getRelatedRepos({ repo: "group/service-a" })).resolves.toEqual([]);

    const revived = await store().addRelation({
      from: "group/service-a",
      to: "group/service-b",
      type: "depends_on",
      evidence: ["a calls b again"],
    });

    expect(revived.superseded_at).toBeNull();
    expect(revived.superseded_by).toBeNull();
    expect(revived.evidence).toEqual(["a calls b", "a calls b again"]);
    await expect(
      store().getRelatedRepos({ repo: "group/service-a" }).then((n) => n.map((r) => r.path)),
    ).resolves.toEqual(["group/service-b"]);
  });

  it("excludes multi-hop paths that traverse a superseded edge by default", async () => {
    await store().addRelation({
      from: "group/service-b",
      to: "group/service-c",
      type: "depends_on",
      evidence: ["b calls c"],
    });
    await store().supersedeRelation({
      from: "group/service-a",
      to: "group/service-b",
      type: "depends_on",
    });

    const hidden = await store().getRelatedRepos({ repo: "group/service-a", depth: 2 });
    expect(hidden.map((n) => n.path)).not.toContain("group/service-c");

    const shown = await store().getRelatedRepos({
      repo: "group/service-a",
      depth: 2,
      include_superseded: true,
    });
    expect(shown.map((n) => n.path).sort()).toEqual(["group/service-b", "group/service-c"]);
  });

  it("throws when the relation (or an endpoint repo) does not exist", async () => {
    await expect(
      store().supersedeRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "uses_infra",
        superseded_by: "wrong type",
      }),
    ).rejects.toThrow(/relation not found/i);
    await expect(
      store().supersedeRelation({
        from: "group/ghost",
        to: "group/service-b",
        type: "depends_on",
      }),
    ).rejects.toThrow(/not found/i);
    await expect(
      store().supersedeRelation({
        from: "group/service-a",
        to: "group/ghost",
        type: "depends_on",
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects blank from/to/type and blank superseded_by", async () => {
    await expect(
      store().supersedeRelation({ from: "   ", to: "group/service-b", type: "depends_on" }),
    ).rejects.toThrow(/from/i);
    await expect(
      store().supersedeRelation({ from: "group/service-a", to: "group/service-b", type: "   " }),
    ).rejects.toThrow(/type/i);
    await expect(
      store().supersedeRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        superseded_by: "   ",
      }),
    ).rejects.toThrow(/superseded_by/i);
  });

  it("is registered as an MCP tool on the server", async () => {
    const server = createRepographServer({ driver: driver(), database: TEST_DATABASE });
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(Object.keys(tools)).toContain("supersede_relation");
  });
  },
);
