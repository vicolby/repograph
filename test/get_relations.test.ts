import { expect, it } from "vitest";
import { mapToolError } from "../src/mcp/server.js";
import { defineGraphSuite } from "./setup/graph-fixture.js";

defineGraphSuite(
  "get_relations (real Neo4j)",
  {
    seedRepos: [
      { repo: "group/service-a", type: "service" },
      { repo: "group/service-b", type: "service" },
      { repo: "group/service-c", type: "service" },
    ],
  },
  ({ store }) => {

    async function seedEdges() {
      await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["a calls b"],
        from_paths: ["src/a.ts"],
        to_paths: ["lib/b.ts"],
      });
      await store().addRelation({
        from: "group/service-c",
        to: "group/service-a",
        type: "uses_infra",
        evidence: ["c deploys a"],
        from_paths: ["charts/a/*"],
        to_paths: ["deploy/a.yaml"],
      });
    }

    it("returns edges with from_paths/to_paths in one call, both directions by default", async () => {
      await seedEdges();

      const edges = await store().getRelations({ repo: "group/service-a" });

      expect(edges).toHaveLength(2);
      const byType = new Map(edges.map((e) => [e.type, e]));
      expect(byType.get("depends_on")).toMatchObject({
        from: "group/service-a",
        to: "group/service-b",
        from_paths: ["src/a.ts"],
        to_paths: ["lib/b.ts"],
      });
      expect(byType.get("uses_infra")).toMatchObject({
        from: "group/service-c",
        to: "group/service-a",
        from_paths: ["charts/a/*"],
        to_paths: ["deploy/a.yaml"],
      });
    });

    it("filters by direction: out returns only outgoing, in only incoming", async () => {
      await seedEdges();

      const out = await store().getRelations({ repo: "group/service-a", direction: "out" });
      expect(out.map((e) => e.type)).toEqual(["depends_on"]);

      const incoming = await store().getRelations({ repo: "group/service-a", direction: "in" });
      expect(incoming.map((e) => e.type)).toEqual(["uses_infra"]);

      const both = await store().getRelations({ repo: "group/service-a", direction: "both" });
      expect(both).toHaveLength(2);
    });

    it("restricts to a single relation type when provided", async () => {
      await seedEdges();

      const edges = await store().getRelations({ repo: "group/service-a", type: "depends_on" });

      expect(edges.map((e) => e.type)).toEqual(["depends_on"]);
    });

    it("hides superseded edges by default, includes them with hints when opted in", async () => {
      await seedEdges();
      await store().supersedeRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
      });

      await expect(
        store().getRelations({ repo: "group/service-a" }).then((edges) => edges.map((e) => e.type)),
      ).resolves.toEqual(["uses_infra"]);

      const withHistory = await store().getRelations({
        repo: "group/service-a",
        include_superseded: true,
      });
      expect(withHistory.map((e) => e.type).sort()).toEqual(["depends_on", "uses_infra"]);
      // Hints survive the retract on the read path.
      expect(withHistory.find((e) => e.type === "depends_on")).toMatchObject({
        from_paths: ["src/a.ts"],
        to_paths: ["lib/b.ts"],
      });
      expect(typeof withHistory.find((e) => e.type === "depends_on")?.superseded_at).toBe("string");
    });

    it("reads pre-feature edges as empty hint lists", async () => {
      await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["old edge"],
      });

      const edges = await store().getRelations({ repo: "group/service-a" });

      expect(edges).toHaveLength(1);
      expect(edges[0]?.from_paths).toEqual([]);
      expect(edges[0]?.to_paths).toEqual([]);
    });

    it("accepts SSH/HTTPS URLs as well as plain paths", async () => {
      await seedEdges();

      const byPath = await store().getRelations({ repo: "group/service-a" });
      const bySsh = await store().getRelations({ repo: "git@gitlab.com:group/service-a.git" });
      const byHttps = await store().getRelations({
        repo: "https://gitlab.com/group/service-a.git",
      });

      expect(bySsh).toEqual(byPath);
      expect(byHttps).toEqual(byPath);
    });

    it("throws NOT_FOUND-shaped errors for unknown repos", async () => {
      await expect(store().getRelations({ repo: "group/ghost" })).rejects.toThrow(/not found/i);
      expect(mapToolError(await store().getRelations({ repo: "group/ghost" }).catch((e) => e))).toMatchObject({
        code: "NOT_FOUND",
      });
    });

    it("rejects invalid direction, blank type, and non-boolean flag as INVALID_INPUT", async () => {
      await expect(
        store().getRelations({ repo: "group/service-a", direction: "sideways" as never }),
      ).rejects.toThrow(/must be/i);
      await expect(
        store().getRelations({ repo: "group/service-a", type: "   " }),
      ).rejects.toThrow(/type/i);
      await expect(
        store().getRelations({ repo: "group/service-a", include_superseded: "yes" as never }),
      ).rejects.toThrow(/must be/i);

      const err = await store()
        .getRelations({ repo: "group/service-a", direction: "sideways" as never })
        .catch((e) => e);
      expect(mapToolError(err)).toMatchObject({ code: "INVALID_INPUT" });
    });

    it("leaves get_related_repos response shape unchanged (repo nodes only)", async () => {
      await seedEdges();

      const nodes = await store().getRelatedRepos({ repo: "group/service-a" });

      expect(nodes.map((n) => n.path).sort()).toEqual(["group/service-b", "group/service-c"]);
      for (const node of nodes) {
        expect(Object.keys(node).sort()).toEqual(["description", "path", "type", "url"]);
      }
    });

  },
);
