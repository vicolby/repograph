import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { Driver } from "neo4j-driver";

export type RepographServerDeps = {
  driver: Driver;
  database: string;
};

/**
 * Builds the repograph MCP server. The tool registry is intentionally empty
 * at this stage (project scaffold) — `add_repo`, `add_relation`,
 * `get_related_repos`, and `search_repos` are registered here by later work.
 */
export function createRepographServer(_deps: RepographServerDeps): McpServer {
  const server = new McpServer({ name: "repograph", version: "0.1.0" });

  return server;
}

/** Connects the server to stdio and starts serving requests. */
export async function startStdioServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
