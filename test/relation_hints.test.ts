import { describe, expect, it } from "vitest";
import { mapToolError } from "../src/mcp/server.js";
import { optionalPathHintList } from "../src/repos/input.js";
import { withSession } from "../src/repos/db.js";
import {
  countEdges,
  defineGraphSuite,
  TEST_DATABASE,
} from "./setup/graph-fixture.js";

defineGraphSuite(
  "relation hints (real Neo4j)",
  {
    seedRepos: [
      { repo: "group/service-a", type: "service" },
      { repo: "group/service-b", type: "service" },
    ],
  },
  ({ driver, store }) => {

    it("round-trips both hint sides on the returned edge", async () => {
      const edge = await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["api call"],
        from_paths: ["src/handlers/**", "README.md"],
        to_paths: ["app/controllers/*.rb"],
      });

      expect(edge.from_paths).toEqual(["src/handlers/**", "README.md"]);
      expect(edge.to_paths).toEqual(["app/controllers/*.rb"]);
    });

    it("defaults both hint sides to [] when omitted", async () => {
      const edge = await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["api call"],
      });

      expect(edge.from_paths).toEqual([]);
      expect(edge.to_paths).toEqual([]);
    });

    it("omitting a side preserves it while explicit [] clears only that side", async () => {
      await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["first"],
        from_paths: ["src/a.ts"],
        to_paths: ["lib/b.ts"],
      });

      const preserved = await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["second"],
      });
      expect(preserved.from_paths).toEqual(["src/a.ts"]);
      expect(preserved.to_paths).toEqual(["lib/b.ts"]);

      const cleared = await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["third"],
        from_paths: [],
      });
      expect(cleared.from_paths).toEqual([]);
      expect(cleared.to_paths).toEqual(["lib/b.ts"]);
    });

    it("appends with dedup, preserves order, never duplicates the edge", async () => {
      await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["first"],
        from_paths: ["b.ts", "a.ts"],
      });
      const second = await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["second"],
        from_paths: ["a.ts", "c.ts"],
      });

      expect(second.from_paths).toEqual(["b.ts", "a.ts", "c.ts"]);
      await expect(countEdges(driver(), TEST_DATABASE)).resolves.toBe(1);
    });

    it("dedups within a single call, preserving first-seen order", async () => {
      const edge = await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["e"],
        to_paths: ["x.ts", "x.ts", "y.ts"],
      });
      expect(edge.to_paths).toEqual(["x.ts", "y.ts"]);
    });

    it("accepts globs and trims entries", async () => {
      const edge = await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["e"],
        from_paths: ["  src/**/*.ts  ", "docs/?.md", "Makefile"],
      });
      expect(edge.from_paths).toEqual(["src/**/*.ts", "docs/?.md", "Makefile"]);
    });

    it.each([
      { field: "from_paths", value: ["/abs/path.ts"] },
      { field: "to_paths", value: ["/abs/path.ts"] },
      { field: "from_paths", value: ["../escape.ts"] },
      { field: "from_paths", value: ["a/../../b.ts"] },
      { field: "from_paths", value: [".."] },
      { field: "to_paths", value: ["ok.ts", "   "] },
      { field: "from_paths", value: [""] },
    ])("rejects invalid $field entry $value", async ({ field, value }) => {
      await expect(
        store().addRelation({
          from: "group/service-a",
          to: "group/service-b",
          type: "depends_on",
          evidence: ["e"],
          [field]: value,
        }),
      ).rejects.toThrow(/must be/i);
    });

    it("rejects more than 50 entries per side", async () => {
      const many = Array.from({ length: 51 }, (_, i) => `file-${i}.ts`);
      await expect(
        store().addRelation({
          from: "group/service-a",
          to: "group/service-b",
          type: "depends_on",
          evidence: ["e"],
          from_paths: many,
        }),
      ).rejects.toThrow(/at most 50/i);
    });

    it("rejects entries longer than 500 chars", async () => {
      await expect(
        store().addRelation({
          from: "group/service-a",
          to: "group/service-b",
          type: "depends_on",
          evidence: ["e"],
          to_paths: [`src/${"a".repeat(500)}.ts`],
        }),
      ).rejects.toThrow(/at most 500/i);
    });

    it("reads pre-feature edges without hint properties as empty lists", async () => {
      // Simulate a legacy edge: raw Cypher with no from_paths/to_paths props.
      await withSession(driver(), TEST_DATABASE, async (session) => {
        await session.run(
          `MATCH (a:Repo {path: 'group/service-a'}), (b:Repo {path: 'group/service-b'})
           CREATE (a)-[:RELATES {type: 'depends_on', evidence: ['legacy'], created_at: '2024-01-01T00:00:00.000Z'}]->(b)`,
        );
      });
      const edge = await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["new"],
      });
      expect(edge.from_paths).toEqual([]);
      expect(edge.to_paths).toEqual([]);
      expect(edge.evidence).toEqual(["legacy", "new"]);
    });

    it("keeps evidence append semantics alongside hints", async () => {
      await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["first"],
        from_paths: ["a.ts"],
      });
      const second = await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["second"],
        to_paths: ["b.ts"],
      });
      expect(second.evidence).toEqual(["first", "second"]);
      expect(second.from_paths).toEqual(["a.ts"]);
      expect(second.to_paths).toEqual(["b.ts"]);
    });

  },
);

describe("hint validation error envelope (unit)", () => {
  it.each([
    ["leading slash", ["/abs/path.ts"]],
    ["parent escape", ["../escape.ts"]],
    ["nested parent", ["a/../../b.ts"]],
    ["bare dotdot", [".."]],
    ["blank entry", ["ok.ts", "   "]],
    ["empty entry", [""]],
    ["too many entries", Array.from({ length: 51 }, (_, i) => `file-${i}.ts`)],
    ["too long entry", [`src/${"a".repeat(500)}.ts`]],
    ["non-array", "not-an-array"],
  ])("maps %s to INVALID_INPUT", (_label, value) => {
    let thrown: unknown;
    try {
      optionalPathHintList(value as string[], "add_relation", "from_paths");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(mapToolError(thrown)).toMatchObject({ code: "INVALID_INPUT" });
  });
});
