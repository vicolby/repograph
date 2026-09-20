import { describe, expect, it } from "vitest";
import { mapToolError } from "../src/mcp/server.js";
import { normalizeRepoIdentifier } from "../src/repos/normalize.js";
import { countRepos, defineGraphSuite } from "./setup/graph-fixture.js";

describe("normalizeRepoIdentifier short-name flag", () => {
  it("marks bare plain names as short, full paths and URLs as not short", () => {
    expect(normalizeRepoIdentifier("ml-feast-feature-store").isShortName).toBe(true);
    expect(normalizeRepoIdentifier("ml-feast-feature-store.git").isShortName).toBe(true);
    expect(normalizeRepoIdentifier("group/project").isShortName).toBe(false);
    expect(normalizeRepoIdentifier("https://gitlab.com/group/project").isShortName).toBe(false);
    expect(normalizeRepoIdentifier("https://gitlab.com/lonely").isShortName).toBe(false);
    expect(normalizeRepoIdentifier("git@gitlab.com:group/project.git").isShortName).toBe(false);
  });
});

defineGraphSuite("short name resolution (real Neo4j)", {}, ({ driver, store }) => {
  const FULL = "fhl-world/ml-risk-management/ml-feast-feature-store";
  const NEIGHBOR = "fhl-world/ml-risk-management/some-service";

  async function seedIssueGraph() {
    await store().addRepo({ repo: FULL });
    await store().addRepo({ repo: NEIGHBOR });
    await store().addRelation({
      from: FULL,
      to: NEIGHBOR,
      type: "depends_on",
      evidence: ["feast powers serving"],
    });
  }

  it("resolves the issue repro: get_relations by bare short name hits the full path", async () => {
    await seedIssueGraph();

    const edges = await store().getRelations({ repo: "ml-feast-feature-store" });

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from: FULL, to: NEIGHBOR });
  });

  it("resolves get_related_repos by bare short name", async () => {
    await seedIssueGraph();

    const nodes = await store().getRelatedRepos({ repo: "ml-feast-feature-store" });

    expect(nodes.map((n) => n.path)).toEqual([NEIGHBOR]);
  });

  it("resolves case-insensitively on the normalized path", async () => {
    await store().addRepo({ repo: "group/My-Repo" });
    await store().addRepo({ repo: "group/other" });
    await store().addRelation({
      from: "group/My-Repo",
      to: "group/other",
      type: "depends_on",
      evidence: ["caps"],
    });

    const edges = await store().getRelations({ repo: "my-repo" });

    expect(edges).toHaveLength(1);
    expect(edges[0]?.from).toBe("group/My-Repo");
  });

  it("zero candidates: NOT_FOUND names search_repos and creates nothing", async () => {
    await seedIssueGraph();

    const err = await store().getRelations({ repo: "no-such-short-xyz" }).catch((e) => e);
    expect(String(err?.message)).toMatch(/not found/i);
    expect(String(err?.message)).toMatch(/search_repos\("no-such-short-xyz"\)/);
    expect(String(err?.message)).not.toMatch(/call add_repo first/);
    expect(mapToolError(err)).toMatchObject({ code: "NOT_FOUND" });
    await expect(countRepos(driver(), "neo4j")).resolves.toBe(2);
  });

  it("ambiguous short name: NOT_FOUND lists every candidate full path", async () => {
    await store().addRepo({ repo: "g1/dup" });
    await store().addRepo({ repo: "g2/dup" });

    const err = await store().getRelations({ repo: "dup" }).catch((e) => e);
    expect(String(err?.message)).toMatch(/not found/i);
    expect(String(err?.message)).toContain("g1/dup");
    expect(String(err?.message)).toContain("g2/dup");
    expect(String(err?.message)).toMatch(/full path/);
    expect(mapToolError(err)).toMatchObject({ code: "NOT_FOUND" });
  });

  it("full-path miss hints search_repos with the last segment", async () => {
    const err = await store().getRelations({ repo: "group/ghost" }).catch((e) => e);
    expect(String(err?.message)).toMatch(/not found/i);
    expect(String(err?.message)).toMatch(/search_repos\("ghost"\)/);
    expect(mapToolError(err)).toMatchObject({ code: "NOT_FOUND" });
  });

  it("URL input with a single segment never auto-resolves", async () => {
    await seedIssueGraph();

    const err = await
      store().getRelations({ repo: "https://gitlab.com/ml-feast-feature-store" }).catch((e) => e);
    expect(String(err?.message)).toMatch(/not found/i);
    expect(mapToolError(err)).toMatchObject({ code: "NOT_FOUND" });
  });

  it("add_relation resolves bare shorts on both ends", async () => {
    await store().addRepo({ repo: FULL });
    await store().addRepo({ repo: NEIGHBOR });

    const edge = await store().addRelation({
      from: "ml-feast-feature-store",
      to: "some-service",
      type: "depends_on",
      evidence: ["short on both ends"],
    });

    expect(edge).toMatchObject({ from: FULL, to: NEIGHBOR });
  });

  it("add_relation names which endpoint missed (from vs to)", async () => {
    await store().addRepo({ repo: FULL });

    const missingTo = await
      store().addRelation({
        from: "ml-feast-feature-store",
        to: "ghost-service",
        type: "depends_on",
        evidence: ["x"],
      }).catch((e) => e);
    expect(String(missingTo?.message)).toMatch(/to repo not found/);
    expect(String(missingTo?.message)).toMatch(/search_repos/);

    const missingFrom = await
      store().addRelation({
        from: "ghost-service",
        to: "ml-feast-feature-store",
        type: "depends_on",
        evidence: ["x"],
      }).catch((e) => e);
    expect(String(missingFrom?.message)).toMatch(/from repo not found/);
    expect(mapToolError(missingFrom)).toMatchObject({ code: "NOT_FOUND" });
  });

  it("supersede_relation resolves bare shorts on both ends", async () => {
    await seedIssueGraph();

    const edge = await store().supersedeRelation({
      from: "ml-feast-feature-store",
      to: "some-service",
      type: "depends_on",
      superseded_by: "short-name retract",
    });

    expect(edge).toMatchObject({ from: FULL, to: NEIGHBOR });
    expect(typeof edge.superseded_at).toBe("string");
  });

  it("add_repo rejects single-segment paths (plain and URL) as INVALID_INPUT", async () => {
    const plain = await store().addRepo({ repo: "lonely-short" }).catch((e) => e);
    expect(String(plain?.message)).toMatch(/must be/);
    expect(mapToolError(plain)).toMatchObject({ code: "INVALID_INPUT" });

    const viaUrl = await store().addRepo({ repo: "https://gitlab.com/lonely" }).catch((e) => e);
    expect(String(viaUrl?.message)).toMatch(/must be/);
    expect(mapToolError(viaUrl)).toMatchObject({ code: "INVALID_INPUT" });

    await expect(countRepos(driver(), "neo4j")).resolves.toBe(0);
  });
});
