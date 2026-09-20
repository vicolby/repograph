import { describe, expect, it } from "vitest";
import { mapToolError } from "../src/mcp/server.js";
import { optionalEvidenceMode } from "../src/repos/input.js";
import { countEdges, defineGraphSuite, TEST_DATABASE } from "./setup/graph-fixture.js";

defineGraphSuite(
  "relation evidence_mode (real Neo4j)",
  {
    seedRepos: [
      { repo: "group/service-a", type: "service" },
      { repo: "group/service-b", type: "service" },
    ],
  },
  ({ driver, store }) => {
    it("defaults to append: repeat calls accumulate evidence", async () => {
      await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["first: handler.ts:12"],
      });
      const second = await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["second: README mention"],
      });

      expect(second.evidence).toEqual(["first: handler.ts:12", "second: README mention"]);
      await expect(countEdges(driver(), TEST_DATABASE)).resolves.toBe(1);
    });

    it("replace overwrites evidence wholesale without duplicating the edge", async () => {
      await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "uses_ci_template",
        evidence: ["real citation"],
      });
      await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "uses_ci_template",
        evidence: ["test run leftover"],
      });
      const fixed = await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "uses_ci_template",
        evidence: ["real citation, typo fixed"],
        evidence_mode: "replace",
      });

      expect(fixed.evidence).toEqual(["real citation, typo fixed"]);
      await expect(countEdges(driver(), TEST_DATABASE)).resolves.toBe(1);
    });

    it("replace supports removing a single entry by rewriting the filtered list", async () => {
      await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["keep me", "stale test entry"],
      });
      const after = await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["keep me"],
        evidence_mode: "replace",
      });

      expect(after.evidence).toEqual(["keep me"]);
    });

    it("replace on a new triple creates the edge with the given evidence", async () => {
      const edge = await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["initial"],
        evidence_mode: "replace",
      });

      expect(edge.evidence).toEqual(["initial"]);
      await expect(countEdges(driver(), TEST_DATABASE)).resolves.toBe(1);
    });

    it("replace refreshes created_at and preserves hints/created_by semantics", async () => {
      const first = await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["first"],
        created_by: "alice",
        from_paths: ["src/a.ts"],
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["replacement"],
        evidence_mode: "replace",
      });

      expect(second.evidence).toEqual(["replacement"]);
      expect(Date.parse(second.created_at) >= Date.parse(first.created_at)).toBe(true);
      // created_by omitted -> preserved; hints omitted -> preserved.
      expect(second.created_by).toBe("alice");
      expect(second.from_paths).toEqual(["src/a.ts"]);
    });

    it("replace revives a superseded edge with the replacement evidence", async () => {
      await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["original"],
      });
      await store().supersedeRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        superseded_by: "retract for test",
      });
      const revived = await store().addRelation({
        from: "group/service-a",
        to: "group/service-b",
        type: "depends_on",
        evidence: ["corrected"],
        evidence_mode: "replace",
      });

      expect(revived.evidence).toEqual(["corrected"]);
      expect(revived.superseded_at).toBeNull();
      expect(revived.superseded_by).toBeNull();
    });

    it("still requires non-empty evidence in replace mode", async () => {
      await expect(
        store().addRelation({
          from: "group/service-a",
          to: "group/service-b",
          type: "depends_on",
          evidence: [],
          evidence_mode: "replace",
        }),
      ).rejects.toThrow(/evidence/i);
    });

    it("rejects an unknown evidence_mode", async () => {
      await expect(
        store().addRelation({
          from: "group/service-a",
          to: "group/service-b",
          type: "depends_on",
          evidence: ["e"],
          // @ts-expect-error intentional: invalid mode must throw at runtime
          evidence_mode: "merge",
        }),
      ).rejects.toThrow(/must be/i);
    });
  },
);

describe("evidence_mode validation error envelope (unit)", () => {
  it.each([["merge"], ["APPEND"], [""], [42], [null]])(
    "maps %s to INVALID_INPUT",
    (value) => {
      let thrown: unknown;
      try {
        optionalEvidenceMode(value, "add_relation", "evidence_mode");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(mapToolError(thrown)).toMatchObject({ code: "INVALID_INPUT" });
    },
  );

  it("defaults to append when omitted", () => {
    expect(optionalEvidenceMode(undefined, "add_relation", "evidence_mode")).toBe("append");
  });
});
