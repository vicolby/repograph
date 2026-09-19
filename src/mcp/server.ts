import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { Driver } from "neo4j-driver";
import { z } from "zod";
import { createRepoStore, type RepoStore } from "../repos/store.js";

export type RepographServerDeps = {
  driver: Driver;
  database: string;
};

/**
 * One row of the tool registry: everything `registerTool` needs plus the
 * store call behind the seam. Rows stay precisely typed (schema and args
 * are inferred per row); the registration loop below is the only place
 * that erases the per-row type.
 */
type ToolDef<Schema extends z.ZodType, Result> = {
  name: string;
  description: string;
  inputSchema: Schema;
  invoke: (store: RepoStore, args: z.infer<Schema>) => Promise<Result>;
};

/** Identity helper that preserves each row's schema/args types in the table. */
function defineTool<Schema extends z.ZodType, Result>(
  def: ToolDef<Schema, Result>,
): ToolDef<Schema, Result> {
  return def;
}

/** The single response envelope every tool returns through. */
function toTextResult(value: unknown): CallToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

const toolDefs = [
  defineTool({
    name: "add_repo",
    description:
      "Create a repository node or update the existing one (upsert keyed on the normalized GitLab full path). " +
      "Accepts a git remote URL (SSH git@host:group/project.git or HTTPS https://host/group/project.git) " +
      "or an already-normalized path (group/subgroup/project).",
    inputSchema: z.object({
      repo: z
        .string()
        .describe(
          "Repository identifier: git remote URL (SSH or HTTPS) or GitLab full path (group/subgroup/project)",
        ),
      type: z
        .string()
        .nullable()
        .optional()
        .describe("Free-text repository type, e.g. service or terraform-module"),
      description: z.string().nullable().optional().describe("Optional repository description"),
    }),
    invoke: (store, args) =>
      store.addRepo({ repo: args.repo, type: args.type, description: args.description }),
  }),
  defineTool({
    name: "add_relation",
    description:
      "Record that one repository is connected to another. Creates a directed edge between two " +
      "existing repos, or appends evidence to the existing edge when the same (from, to, type) " +
      "triple is recorded again. from/to accept a git remote URL (SSH or HTTPS) or an " +
      "already-normalized path (group/subgroup/project).",
    inputSchema: z.object({
      from: z
        .string()
        .describe(
          "Source repository: git remote URL (SSH or HTTPS) or GitLab full path (group/subgroup/project)",
        ),
      to: z
        .string()
        .describe(
          "Target repository: git remote URL (SSH or HTTPS) or GitLab full path (group/subgroup/project)",
        ),
      type: z.string().describe("Free-text relation type, e.g. depends_on or uses_infra"),
      evidence: z
        .array(z.string())
        .describe("Sources/citations the relation was derived from (file/line references, quotes)"),
      created_by: z.string().nullable().optional().describe("Who/what recorded the relation"),
    }),
    invoke: (store, args) =>
      store.addRelation({
        from: args.from,
        to: args.to,
        type: args.type,
        evidence: args.evidence,
        created_by: args.created_by,
      }),
  }),
  defineTool({
    name: "supersede_relation",
    description:
      "Retract a repository relation without losing its history. Marks the directed edge for the " +
      "(from, to, type) triple as superseded (sets superseded_at/superseded_by) instead of deleting " +
      "it, so the evidence trail survives. Superseded edges are hidden from get_related_repos by " +
      "default. Re-recording the same triple via add_relation revives the edge. from/to accept a " +
      "git remote URL (SSH or HTTPS) or an already-normalized path (group/subgroup/project).",
    inputSchema: z.object({
      from: z
        .string()
        .describe(
          "Source repository: git remote URL (SSH or HTTPS) or GitLab full path (group/subgroup/project)",
        ),
      to: z
        .string()
        .describe(
          "Target repository: git remote URL (SSH or HTTPS) or GitLab full path (group/subgroup/project)",
        ),
      type: z.string().describe("Free-text relation type, must match the edge exactly"),
      superseded_by: z
        .string()
        .nullable()
        .optional()
        .describe("Who/what superseded the relation, e.g. a citation like 'infra.md rewired a -> c'"),
    }),
    invoke: (store, args) =>
      store.supersedeRelation({
        from: args.from,
        to: args.to,
        type: args.type,
        superseded_by: args.superseded_by,
      }),
  }),
  defineTool({
    name: "get_related_repos",
    description:
      "List repositories connected to the given one, traversing RELATES edges in both directions " +
      "(outgoing and incoming). Defaults to direct (depth-1) neighbors; depth widens the traversal " +
      "and type restricts it to edges of that free-text relation type. repo accepts a git remote " +
      "URL (SSH or HTTPS) or an already-normalized path (group/subgroup/project).",
    inputSchema: z.object({
      repo: z
        .string()
        .describe(
          "Repository identifier: git remote URL (SSH or HTTPS) or GitLab full path (group/subgroup/project)",
        ),
      depth: z
        .number()
        .optional()
        .describe("Traversal depth in hops (default 1, max 10)"),
      type: z
        .string()
        .nullable()
        .optional()
        .describe("Only traverse edges whose relation type equals this value"),
      include_superseded: z
        .boolean()
        .optional()
        .describe(
          "When true, traverse superseded (retracted) edges as well; default false hides history",
        ),
    }),
    invoke: (store, args) =>
      store.getRelatedRepos({
        repo: args.repo,
        depth: args.depth,
        type: args.type,
        include_superseded: args.include_superseded,
      }),
  }),
  defineTool({
    name: "search_repos",
    description:
      "Find repository nodes by partial (substring, case-insensitive) match on path or description. " +
      "Use when the exact repository identifier is unknown.",
    inputSchema: z.object({
      query: z.string().describe("Substring to search for in repository path and description"),
      limit: z
        .number()
        .optional()
        .describe("Max nodes to return (default 20, max 100)"),
    }),
    invoke: (store, args) => store.searchRepos({ query: args.query, limit: args.limit }),
  }),
];

/** Union of every row's args; the registration loop callback's parameter type. */
type AnyToolArgs = z.infer<(typeof toolDefs[number])["inputSchema"]>;

/**
 * Builds the repograph MCP server. Tools are declared as rows in `toolDefs`
 * and registered by the loop below; adding a tool is adding a row.
 */
export function createRepographServer(deps: RepographServerDeps): McpServer {
  const server = new McpServer({ name: "repograph", version: "0.1.0" });
  const store = createRepoStore(deps.driver, deps.database);

  for (const def of toolDefs) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.inputSchema },
      // The loop ranges over a union of row types, so TypeScript cannot
      // correlate `def.inputSchema` with `def.invoke` here. The rows
      // themselves stay precisely typed via `defineTool`; `never` is
      // assignable to every row's args, keeping the erasure in this one spot.
      async (args: AnyToolArgs) => toTextResult(await def.invoke(store, args as never)),
    );
  }

  return server;
}

/** Connects the server to stdio and starts serving requests. */
export async function startStdioServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
