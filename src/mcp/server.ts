import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { Driver } from "neo4j-driver";
import { z } from "zod";
import { addRepo } from "../repos/addRepo.js";

export type RepographServerDeps = {
  driver: Driver;
  database: string;
};

/**
 * Builds the repograph MCP server. `add_relation`, `get_related_repos`, and
 * `search_repos` are registered here by later work.
 */
export function createRepographServer(deps: RepographServerDeps): McpServer {
  const server = new McpServer({ name: "repograph", version: "0.1.0" });

  server.registerTool(
    "add_repo",
    {
      description:
        "Create a repository node or update the existing one (upsert keyed on the normalized GitLab full path). " +
        "Accepts a git remote URL (SSH git@host:group/project.git or HTTPS https://host/group/project.git) " +
        "or an already-normalized path (group/subgroup/project).",
      inputSchema: {
        repo: z
          .string()
          .min(1)
          .describe(
            "Repository identifier: git remote URL (SSH or HTTPS) or GitLab full path (group/subgroup/project)",
          ),
        type: z
          .string()
          .optional()
          .describe("Free-text repository type, e.g. service or terraform-module"),
        description: z.string().optional().describe("Optional repository description"),
      },
    },
    async (args: { repo: string; type?: string | undefined; description?: string | undefined }) => {
      const { repo, type, description } = args;
      const node = await addRepo(deps.driver, deps.database, { repo, type, description });
      return { content: [{ type: "text" as const, text: JSON.stringify(node) }] };
    },
  );

  return server;
}

/** Connects the server to stdio and starts serving requests. */
export async function startStdioServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
