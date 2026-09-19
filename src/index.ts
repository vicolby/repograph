import { loadNeo4jConfigFromEnv } from "./bootstrap.js";
import { closeNeo4jDriver, createNeo4jDriver, verifyNeo4jConnectivity } from "./bootstrap.js";
import { createRepographServer, startStdioServer } from "./mcp/server.js";

async function main(): Promise<void> {
  const config = loadNeo4jConfigFromEnv();
  const driver = createNeo4jDriver(config);

  // Fail fast on a bad connection rather than waiting for the first tool call.
  await verifyNeo4jConnectivity(driver, config.database);

  const server = createRepographServer({ driver, database: config.database });

  const shutdown = (): void => {
    void closeNeo4jDriver(driver).finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // stdout is reserved for the MCP protocol; log startup diagnostics to stderr.
  await startStdioServer(server);
}

main().catch((error: unknown) => {
  console.error("repograph-mcp failed to start:", error);
  process.exit(1);
});
