import type { Driver } from "neo4j-driver";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRepographServer } from "../src/mcp/server.js";
import { addRepo } from "../src/repos/addRepo.js";
import { normalizeRepoIdentifier } from "../src/repos/normalize.js";
import {
  clearDb,
  countRepos,
  startGraph,
  stopGraph,
  TEST_DATABASE,
  type TestGraph,
} from "./setup/graph-fixture.js";

describe("normalizeRepoIdentifier", () => {
  it("resolves SSH, HTTPS, and plain path to the same path", () => {
    const ssh = normalizeRepoIdentifier("git@gitlab.com:group/sub/project.git");
    const https = normalizeRepoIdentifier("https://gitlab.com/group/sub/project.git");
    const path = normalizeRepoIdentifier("group/sub/project");

    expect(ssh.path).toBe("group/sub/project");
    expect(https.path).toBe("group/sub/project");
    expect(path.path).toBe("group/sub/project");
    expect(https.canonicalUrl).toBe("https://gitlab.com/group/sub/project");
    expect(ssh.canonicalUrl).toBe("https://gitlab.com/group/sub/project");
  });

  it("rejects empty identifiers", () => {
    expect(() => normalizeRepoIdentifier("   ")).toThrow();
  });
});

describe("add_repo (real Neo4j)", () => {
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
  });

  it("creates a Repo node with path, url, type, description", async () => {
    const node = await addRepo(driver, TEST_DATABASE, {
      repo: "https://gitlab.com/group/project.git",
      type: "service",
      description: "Billing API",
    });

    expect(node.path).toBe("group/project");
    expect(node.url).toBe("https://gitlab.com/group/project");
    expect(node.type).toBe("service");
    expect(node.description).toBe("Billing API");
    await expect(countRepos(driver, TEST_DATABASE)).resolves.toBe(1);
  });

  it("upserts: second call for the same repo updates fields instead of duplicating", async () => {
    await addRepo(driver, TEST_DATABASE, {
      repo: "group/project",
      type: "service",
      description: "v1",
    });
    const updated = await addRepo(driver, TEST_DATABASE, {
      repo: "https://gitlab.com/group/project",
      description: "v2",
    });

    expect(updated.path).toBe("group/project");
    // Only the passed field changes; type is preserved.
    expect(updated.description).toBe("v2");
    expect(updated.type).toBe("service");
    await expect(countRepos(driver, TEST_DATABASE)).resolves.toBe(1);
  });

  it("resolves SSH URL, HTTPS URL, and plain path to the same node", async () => {
    await addRepo(driver, TEST_DATABASE, { repo: "git@gitlab.com:group/sub/project.git", type: "service" });
    await addRepo(driver, TEST_DATABASE, { repo: "https://gitlab.com/group/sub/project.git" });
    const node = await addRepo(driver, TEST_DATABASE, { repo: "group/sub/project" });

    expect(node.path).toBe("group/sub/project");
    await expect(countRepos(driver, TEST_DATABASE)).resolves.toBe(1);
  });

  it("accepts arbitrary type strings without code changes", async () => {
    const node = await addRepo(driver, TEST_DATABASE, {
      repo: "group/novel-thing",
      type: "quantum-widget-frobnicator",
    });

    expect(node.type).toBe("quantum-widget-frobnicator");
  });

  it("is registered as an MCP tool on the server", async () => {
    const server = createRepographServer({ driver, database: TEST_DATABASE });
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(Object.keys(tools)).toContain("add_repo");
  });
});
