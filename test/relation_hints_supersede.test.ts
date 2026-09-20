import { expect, it } from "vitest";
import {
  countEdges,
  defineGraphSuite,
  TEST_DATABASE,
} from "./setup/graph-fixture.js";

defineGraphSuite(
  "relation hints supersede/revive (real Neo4j)",
  {
    seedRepos: [
      { repo: "group/service-a", type: "service" },
      { repo: "group/service-b", type: "service" },
    ],
  },
  ({ driver, store }) => {

    it("supersede sets markers without modifying from_paths/to_paths", async () => {
      await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["a calls b"],
        from_paths: ["src/a.ts", "src/handlers/**"],
        to_paths: ["lib/b.ts"],
      });

      const edge = await store().supersedeRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        superseded_by: "infra.md rewired a -> c",
      });

      expect(edge.from_paths).toEqual(["src/a.ts", "src/handlers/**"]);
      expect(edge.to_paths).toEqual(["lib/b.ts"]);
      expect(typeof edge.superseded_at).toBe("string");
      expect(edge.superseded_by).toBe("infra.md rewired a -> c");
      // Evidence trail survives alongside hints.
      expect(edge.evidence).toEqual(["a calls b"]);
      await expect(countEdges(driver(), TEST_DATABASE)).resolves.toBe(1);
    });

    it("repeat supersede preserves hints", async () => {
      await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["e"],
        from_paths: ["a.ts"],
        to_paths: ["b.ts"],
      });
      await store().supersedeRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
      });
      const second = await store().supersedeRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        superseded_by: "second pass",
      });

      expect(second.from_paths).toEqual(["a.ts"]);
      expect(second.to_paths).toEqual(["b.ts"]);
      expect(second.superseded_by).toBe("second pass");
      await expect(countEdges(driver(), TEST_DATABASE)).resolves.toBe(1);
    });

    it("superseded edge with hints is hidden by default and visible with include_superseded", async () => {
      await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["e"],
        from_paths: ["a.ts"],
        to_paths: ["b.ts"],
      });
      const superseded = await store().supersedeRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
      });

      // The superseded edge itself still carries its hints...
      expect(superseded.from_paths).toEqual(["a.ts"]);
      expect(superseded.to_paths).toEqual(["b.ts"]);
      // ...while traversal hides it by default...
      await expect(store().getRelatedRepos({ repo: "group/service-a" })).resolves.toEqual([]);
      // ...and shows the neighbor again with history opted in.
      const withHistory = await store().getRelatedRepos({
        repo: "group/service-a",
        include_superseded: true,
      });
      expect(withHistory.map((n) => n.path)).toEqual(["group/service-b"]);
    });

    it("revive with omitted sides preserves hints and clears markers", async () => {
      await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["first"],
        from_paths: ["a.ts"],
        to_paths: ["b.ts"],
      });
      await store().supersedeRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        superseded_by: "stale",
      });

      const revived = await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["second"],
      });

      expect(revived.superseded_at).toBeNull();
      expect(revived.superseded_by).toBeNull();
      expect(revived.from_paths).toEqual(["a.ts"]);
      expect(revived.to_paths).toEqual(["b.ts"]);
      expect(revived.evidence).toEqual(["first", "second"]);
      await expect(countEdges(driver(), TEST_DATABASE)).resolves.toBe(1);
      await expect(
        store().getRelatedRepos({ repo: "group/service-a" }).then((n) => n.map((r) => r.path)),
      ).resolves.toEqual(["group/service-b"]);
    });

    it("revive appends with dedup when new hints are passed", async () => {
      await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["first"],
        from_paths: ["b.ts", "a.ts"],
        to_paths: ["x.ts"],
      });
      await store().supersedeRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
      });

      const revived = await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["second"],
        from_paths: ["a.ts", "c.ts"],
      });

      expect(revived.superseded_at).toBeNull();
      expect(revived.from_paths).toEqual(["b.ts", "a.ts", "c.ts"]);
      expect(revived.to_paths).toEqual(["x.ts"]);
      await expect(countEdges(driver(), TEST_DATABASE)).resolves.toBe(1);
    });

    it("revive with explicit [] clears only that side", async () => {
      await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["first"],
        from_paths: ["a.ts"],
        to_paths: ["b.ts"],
      });
      await store().supersedeRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
      });

      const revived = await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["second"],
        from_paths: [],
      });

      expect(revived.from_paths).toEqual([]);
      expect(revived.to_paths).toEqual(["b.ts"]);
      expect(revived.superseded_at).toBeNull();
      expect(revived.evidence).toEqual(["first", "second"]);
    });

  },
);
