import { describe, expect, it } from "vitest";
import { normalizeRepoIdentifier } from "../src/repos/normalize.js";
import {
  countRepos,
  defineGraphSuite,
  TEST_DATABASE,
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

defineGraphSuite("add_repo (real Neo4j)", {}, ({ driver, store }) => {

  it("creates a Repo node with path, url, type, description", async () => {
    const node = await store().addRepo({
      repo: "https://gitlab.com/group/project.git",
      type: "service",
      description: "Billing API",
    });

    expect(node.path).toBe("group/project");
    expect(node.url).toBe("https://gitlab.com/group/project");
    expect(node.type).toBe("service");
    expect(node.description).toBe("Billing API");
    await expect(countRepos(driver(), TEST_DATABASE)).resolves.toBe(1);
  });

  it("upserts: second call for the same repo updates fields instead of duplicating", async () => {
    await store().addRepo({
      repo: "group/project",
      type: "service",
      description: "v1",
    });
    const updated = await store().addRepo({
      repo: "https://gitlab.com/group/project",
      description: "v2",
    });

    expect(updated.path).toBe("group/project");
    // Only the passed field changes; type is preserved.
    expect(updated.description).toBe("v2");
    expect(updated.type).toBe("service");
    await expect(countRepos(driver(), TEST_DATABASE)).resolves.toBe(1);
  });

  it("resolves SSH URL, HTTPS URL, and plain path to the same node", async () => {
    await store().addRepo({ repo: "git@gitlab.com:group/sub/project.git", type: "service" });
    await store().addRepo({ repo: "https://gitlab.com/group/sub/project.git" });
    const node = await store().addRepo({ repo: "group/sub/project" });

    expect(node.path).toBe("group/sub/project");
    await expect(countRepos(driver(), TEST_DATABASE)).resolves.toBe(1);
  });

  it("accepts arbitrary type strings without code changes", async () => {
    const node = await store().addRepo({
      repo: "group/novel-thing",
      type: "quantum-widget-frobnicator",
    });

    expect(node.type).toBe("quantum-widget-frobnicator");
  });

  },
);
