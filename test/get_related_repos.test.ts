import { expect, it } from "vitest";
import { defineGraphSuite } from "./setup/graph-fixture.js";

defineGraphSuite(
  "get_related_repos (real Neo4j)",
  {
    seedRepos: [
      { repo: "group/service-a", type: "service" },
      { repo: "group/service-b", type: "service" },
      { repo: "group/service-c", type: "service" },
      { repo: "group/service-d", type: "service" },
      { repo: "infra/terraform-x", type: "terraform-module" },
    ],
    seedRelations: [
      { from: "group/service-a", to: "group/service-b", type: "depends_on", evidence: ["a calls b"] },
      { from: "group/service-c", to: "group/service-a", type: "depends_on", evidence: ["c calls a"] },
      { from: "group/service-b", to: "group/service-d", type: "depends_on", evidence: ["b calls d"] },
      {
        from: "group/service-a",
        to: "infra/terraform-x",
        type: "uses_infra",
        evidence: ["a uses terraform-x"],
      },
    ],
  },
  ({ store }) => {

  it("defaults to direct (depth-1) neighbors in both directions", async () => {
    const nodes = await store().getRelatedRepos({ repo: "group/service-a" });

    expect(nodes.map((n) => n.path).sort()).toEqual([
      "group/service-b",
      "group/service-c",
      "infra/terraform-x",
    ]);
  });

  it("treats an explicit depth of 1 the same as the default", async () => {
    const byDefault = await store().getRelatedRepos({ repo: "group/service-a" });
    const explicit = await store().getRelatedRepos({ repo: "group/service-a", depth: 1 });

    expect(explicit.map((n) => n.path).sort()).toEqual(byDefault.map((n) => n.path).sort());
  });

  it("widens the traversal with depth", async () => {
    const nodes = await store().getRelatedRepos({ repo: "group/service-a", depth: 2 });

    expect(nodes.map((n) => n.path).sort()).toEqual([
      "group/service-b",
      "group/service-c",
      "group/service-d",
      "infra/terraform-x",
    ]);
  });

  it("narrows back to direct neighbors when depth is 1 after a wider query", async () => {
    const wide = await store().getRelatedRepos({ repo: "group/service-a", depth: 3 });
    expect(wide.map((n) => n.path)).toContain("group/service-d");

    const narrow = await store().getRelatedRepos({ repo: "group/service-a", depth: 1 });
    expect(narrow.map((n) => n.path)).not.toContain("group/service-d");
  });

  it("filters to a single relation type", async () => {
    const dependsOn = await store().getRelatedRepos({
      repo: "group/service-a",
      type: "depends_on",
    });

    expect(dependsOn.map((n) => n.path).sort()).toEqual(["group/service-b", "group/service-c"]);
  });

  it("combines type filter with depth: every hop must match the type", async () => {
    const dependsOnDeep = await store().getRelatedRepos({
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
    const infraDeep = await store().getRelatedRepos({
      repo: "group/service-a",
      depth: 2,
      type: "uses_infra",
    });
    expect(infraDeep.map((n) => n.path)).toEqual(["infra/terraform-x"]);
  });

  it("accepts SSH URL, HTTPS URL, and plain path for repo", async () => {
    const byPath = await store().getRelatedRepos({ repo: "group/service-a" });
    const bySsh = await store().getRelatedRepos({ repo: "git@gitlab.com:group/service-a.git" });
    const byHttps = await store().getRelatedRepos({
      repo: "https://gitlab.com/group/service-a.git",
    });

    const expected = byPath.map((n) => n.path).sort();
    expect(bySsh.map((n) => n.path).sort()).toEqual(expected);
    expect(byHttps.map((n) => n.path).sort()).toEqual(expected);
  });

  it("never includes the start repo itself, even when a cycle leads back to it", async () => {
    await store().addRelation({
      from: "group/service-d",
      to: "group/service-a",
      type: "depends_on",
      evidence: ["d calls a back"],
    });

    const nodes = await store().getRelatedRepos({ repo: "group/service-a", depth: 3 });

    expect(nodes.map((n) => n.path)).not.toContain("group/service-a");
  });

  it("throws when the repo does not exist", async () => {
    await expect(store().getRelatedRepos({ repo: "group/ghost" })).rejects.toThrow(/not found/i);
  });

  it("rejects out-of-range depth and blank type", async () => {
    await expect(store().getRelatedRepos({ repo: "group/service-a", depth: 0 })).rejects.toThrow(
      /depth/i,
    );
    await expect(store().getRelatedRepos({ repo: "group/service-a", depth: 11 })).rejects.toThrow(
      /depth/i,
    );
    await expect(
      store().getRelatedRepos({ repo: "group/service-a", type: "   " }),
    ).rejects.toThrow(/type/i);
  });

  },
);
