import type { StartedNeo4jContainer } from "@testcontainers/neo4j";
import type { Driver } from "neo4j-driver";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRepographServer } from "../src/mcp/server.js";
import { closeNeo4jDriver, createNeo4jDriver } from "../src/neo4j/driver.js";
import { addRepo } from "../src/repos/addRepo.js";
import { normalizeRepoIdentifier } from "../src/repos/normalize.js";
import { startTestNeo4j } from "./setup/neo4j-test-container.js";

const DATABASE = "neo4j";

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
  let container: StartedNeo4jContainer;
  let driver: Driver;

  beforeAll(async () => {
    container = await startTestNeo4j();
    driver = createNeo4jDriver({
      uri: container.getBoltUri(),
      user: container.getUsername(),
      password: container.getPassword(),
      database: DATABASE,
    });
  });

  afterAll(async () => {
    if (driver) await closeNeo4jDriver(driver);
    if (container) await container.stop();
  });

  beforeEach(async () => {
    const session = driver.session({ database: DATABASE });
    try {
      await session.run("MATCH (n) DETACH DELETE n");
    } finally {
      await session.close();
    }
  });

  async function countRepos(): Promise<number> {
    const session = driver.session({ database: DATABASE });
    try {
      const result = await session.run("MATCH (r:Repo) RETURN count(r) AS count");
      return (result.records[0]?.get("count") as { toNumber: () => number }).toNumber();
    } finally {
      await session.close();
    }
  }

  it("creates a Repo node with path, url, type, description", async () => {
    const node = await addRepo(driver, DATABASE, {
      repo: "https://gitlab.com/group/project.git",
      type: "service",
      description: "Billing API",
    });

    expect(node.path).toBe("group/project");
    expect(node.url).toBe("https://gitlab.com/group/project");
    expect(node.type).toBe("service");
    expect(node.description).toBe("Billing API");
    await expect(countRepos()).resolves.toBe(1);
  });

  it("upserts: second call for the same repo updates fields instead of duplicating", async () => {
    await addRepo(driver, DATABASE, {
      repo: "group/project",
      type: "service",
      description: "v1",
    });
    const updated = await addRepo(driver, DATABASE, {
      repo: "https://gitlab.com/group/project",
      description: "v2",
    });

    expect(updated.path).toBe("group/project");
    // Only the passed field changes; type is preserved.
    expect(updated.description).toBe("v2");
    expect(updated.type).toBe("service");
    await expect(countRepos()).resolves.toBe(1);
  });

  it("resolves SSH URL, HTTPS URL, and plain path to the same node", async () => {
    await addRepo(driver, DATABASE, { repo: "git@gitlab.com:group/sub/project.git", type: "service" });
    await addRepo(driver, DATABASE, { repo: "https://gitlab.com/group/sub/project.git" });
    const node = await addRepo(driver, DATABASE, { repo: "group/sub/project" });

    expect(node.path).toBe("group/sub/project");
    await expect(countRepos()).resolves.toBe(1);
  });

  it("accepts arbitrary type strings without code changes", async () => {
    const node = await addRepo(driver, DATABASE, {
      repo: "group/novel-thing",
      type: "quantum-widget-frobnicator",
    });

    expect(node.type).toBe("quantum-widget-frobnicator");
  });

  it("is registered as an MCP tool on the server", async () => {
    const server = createRepographServer({ driver, database: DATABASE });
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(Object.keys(tools)).toContain("add_repo");
  });
});
