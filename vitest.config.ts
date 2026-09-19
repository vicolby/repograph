import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Testcontainers pulls/starts a real Neo4j image; give it room to boot.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
