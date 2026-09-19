import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { Driver } from "neo4j-driver";
import { z } from "zod";
import { createRepoStore } from "../repos/store.js";

export type RepographServerDeps = {
  driver: Driver;
  database: string;
};

/**
 * Builds the repograph MCP server. `get_related_repos` is registered here
 * by later work.
 */
export function createRepographServer(deps: RepographServerDeps): McpServer {
  const server = new McpServer({ name: "repograph", version: "0.1.0" });
  const store = createRepoStore(deps.driver, deps.database);

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
      const node = await store.addRepo({ repo, type, description });
      return { content: [{ type: "text" as const, text: JSON.stringify(node) }] };
    },
  );

  server.registerTool(
    "add_relation",
    {
      description:
        "Record that one repository is connected to another. Creates a directed edge between two " +
        "existing repos, or appends evidence to the existing edge when the same (from, to, type) " +
        "triple is recorded again. from/to accept a git remote URL (SSH or HTTPS) or an " +
        "already-normalized path (group/subgroup/project).",
      inputSchema: {
        from: z
          .string()
          .min(1)
          .describe(
            "Source repository: git remote URL (SSH or HTTPS) or GitLab full path (group/subgroup/project)",
          ),
        to: z
          .string()
          .min(1)
          .describe(
            "Target repository: git remote URL (SSH or HTTPS) or GitLab full path (group/subgroup/project)",
          ),
        type: z
          .string()
          .min(1)
          .describe("Free-text relation type, e.g. depends_on or uses_infra"),
        evidence: z
          .array(z.string().min(1))
          .min(1)
          .describe("Sources/citations the relation was derived from (file/line references, quotes)"),
        created_by: z.string().optional().describe("Who/what recorded the relation"),
      },
    },
    async (args: {
      from: string;
      to: string;
      type: string;
      evidence: string[];
      created_by?: string | undefined;
    }) => {
      const { from, to, type, evidence, created_by } = args;
      const edge = await store.addRelation({
        from,
        to,
        type,
        evidence,
        created_by,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(edge) }] };
    },
  );

  server.registerTool(
    "search_repos",
    {
      description:
        "Find repository nodes by partial (substring, case-insensitive) match on path or description. " +
        "Use when the exact repository identifier is unknown.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Substring to search for in repository path and description"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max nodes to return (default 20, max 100)"),
      },
    },
    async (args: { query: string; limit?: number | undefined }) => {
      const { query, limit } = args;
      const nodes = await store.searchRepos({ query, limit });
      return { content: [{ type: "text" as const, text: JSON.stringify(nodes) }] };
    },
  );

  return server;
}

/** Connects the server to stdio and starts serving requests. */
export async function startStdioServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
