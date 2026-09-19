import { expect, it } from "vitest";
import { createRepographServer } from "../src/mcp/server.js";
import { defineGraphSuite, TEST_DATABASE } from "./setup/graph-fixture.js";

defineGraphSuite(
  "search_repos (real Neo4j)",
  {
    seedRepos: [
      { repo: "group/billing-api", type: "service", description: "Billing API for invoices" },
      { repo: "group/billing-worker", type: "service", description: "Background jobs" },
      { repo: "infra/terraform-billing", type: "terraform-module", description: "Billing infra" },
      { repo: "group/search-service", type: "service", description: "Full-text search backend" },
    ],
  },
  ({ driver, store }) => {

  it("finds repos by partial path match, not just exact match", async () => {
    const nodes = await store().searchRepos({ query: "bill" });

    expect(nodes.map((n) => n.path).sort()).toEqual([
      "group/billing-api",
      "group/billing-worker",
      "infra/terraform-billing",
    ]);
  });

  it("matches on description", async () => {
    const nodes = await store().searchRepos({ query: "invoices" });

    expect(nodes.map((n) => n.path)).toEqual(["group/billing-api"]);
  });

  it("matches case-insensitively on path and description", async () => {
    const byPath = await store().searchRepos({ query: "BILLING" });
    expect(byPath.length).toBe(3);

    const byDescription = await store().searchRepos({ query: "FULL-TEXT" });
    expect(byDescription.map((n) => n.path)).toEqual(["group/search-service"]);
  });

  it("returns an empty list when nothing matches", async () => {
    await expect(store().searchRepos({ query: "no-such-repo-xyz" })).resolves.toEqual(
      [],
    );
  });

  it("rejects a blank query", async () => {
    await expect(store().searchRepos({ query: "   " })).rejects.toThrow(/query/i);
  });

  it("is registered as an MCP tool on the server", async () => {
    const server = createRepographServer({ driver: driver(), database: TEST_DATABASE });
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(Object.keys(tools)).toContain("search_repos");
  });
  },
);
