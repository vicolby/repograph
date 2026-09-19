import { describe, expect, it } from "vitest";
import { loadNeo4jConfigFromEnv } from "../src/bootstrap.js";

describe("loadNeo4jConfigFromEnv", () => {
  it("applies defaults when only the password is provided", () => {
    const config = loadNeo4jConfigFromEnv({ NEO4J_PASSWORD: "secret" });

    expect(config).toEqual({
      uri: "bolt://localhost:7687",
      user: "neo4j",
      password: "secret",
      database: "neo4j",
    });
  });

  it("uses explicit overrides when provided", () => {
    const config = loadNeo4jConfigFromEnv({
      NEO4J_URI: "bolt://neo4j.internal:7687",
      NEO4J_USER: "custom-user",
      NEO4J_PASSWORD: "secret",
      NEO4J_DATABASE: "repograph",
    });

    expect(config).toEqual({
      uri: "bolt://neo4j.internal:7687",
      user: "custom-user",
      password: "secret",
      database: "repograph",
    });
  });

  it("throws when the password is missing", () => {
    expect(() => loadNeo4jConfigFromEnv({})).toThrow();
  });
});
