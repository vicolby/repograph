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

/** Stable success envelope every tool returns: the store value under `data`. */
export type ToolSuccess<T> = { data: T };

/** Machine-readable error codes agents can branch on. */
export type ToolErrorCode = "INVALID_INPUT" | "NOT_FOUND" | "INTERNAL";

/** Stable error envelope every tool returns on failure. */
export type ToolFailure = { code: ToolErrorCode; message: string };

/**
 * Maps a domain error to the stable error envelope. Validation errors from
 * the shared `input.ts` seam and identifier errors (`must be…`, `invalid…`)
 * become INVALID_INPUT; missing repos/edges (`…not found…`) become
 * NOT_FOUND; everything else is INTERNAL. Transport-level schema rejections
 * (wrong scalar shape) never reach this mapping — the SDK answers those.
 */
export function mapToolError(error: unknown): ToolFailure {
  if (!(error instanceof Error)) return { code: "INTERNAL", message: "Internal error" };
  const message = error.message;
  if (/not found/i.test(message)) return { code: "NOT_FOUND", message };
  if (/must be|requires|non-empty|integer|boolean|invalid/i.test(message)) {
    return { code: "INVALID_INPUT", message };
  }
  return { code: "INTERNAL", message };
}

/** Wraps a store value in the success envelope. */
function toTextResult(value: unknown): CallToolResult {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ data: value } satisfies ToolSuccess<unknown>) },
    ],
  };
}

/** Wraps a thrown error in the error envelope and marks the result failed. */
function toTextError(error: unknown): CallToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(mapToolError(error)) }],
    isError: true,
  };
}

/**
 * Runs one store call behind the envelope seam: success becomes `{ data }`,
 * a throw becomes `{ code, message }` with `isError`.
 */
async function runTool<T>(work: () => Promise<T>): Promise<CallToolResult> {
  try {
    return toTextResult(await work());
  } catch (error) {
    return toTextError(error);
  }
}

/**
 * Registers all five tools on `server`. The single place tools meet the SDK;
 * adding a tool is adding a `registerTool` call here. Every schema is a
 * concrete `z.object`, so `args` in each handler is inferred precisely —
 * no union, no type erasure, no casts.
 */
export function registerAll(server: McpServer, store: RepoStore): void {
  server.registerTool(
    "add_repo",
    {
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
    },
    (args) =>
      runTool(() =>
        store.addRepo({ repo: args.repo, type: args.type, description: args.description }),
      ),
  );

  server.registerTool(
    "add_relation",
    {
      description:
        "Record that one repository is connected to another. Creates a directed edge between two " +
        "existing repos, or appends evidence to the existing edge when the same (from, to, type) " +
        "triple is recorded again. Optional from_paths/to_paths carry per-side file-scope hints " +
        "(repo-root-relative paths, globs allowed): omitted preserves, [] clears, otherwise " +
        "appended with dedup. from/to accept a git remote URL (SSH or HTTPS) or an " +
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
        from_paths: z
          .array(z.string())
          .optional()
          .describe(
            "Optional file-scope hints for the from repo (repo-root-relative paths, * / ** / ? globs allowed). " +
              "Omitted preserves the stored side; explicit [] clears it; otherwise appended with dedup.",
          ),
        to_paths: z
          .array(z.string())
          .optional()
          .describe(
            "Optional file-scope hints for the to repo. Same write semantics as from_paths.",
          ),
      }),
    },
    (args) =>
      runTool(() =>
        store.addRelation({
          from: args.from,
          to: args.to,
          type: args.type,
          evidence: args.evidence,
          created_by: args.created_by,
          from_paths: args.from_paths,
          to_paths: args.to_paths,
        }),
      ),
  );

  server.registerTool(
    "supersede_relation",
    {
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
    },
    (args) =>
      runTool(() =>
        store.supersedeRelation({
          from: args.from,
          to: args.to,
          type: args.type,
          superseded_by: args.superseded_by,
        }),
      ),
  );

  server.registerTool(
    "get_related_repos",
    {
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
    },
    (args) =>
      runTool(() =>
        store.getRelatedRepos({
          repo: args.repo,
          depth: args.depth,
          type: args.type,
          include_superseded: args.include_superseded,
        }),
      ),
  );

  server.registerTool(
    "search_repos",
    {
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
    },
    (args) => runTool(() => store.searchRepos({ query: args.query, limit: args.limit })),
  );
}

/**
 * Builds the repograph MCP server with every tool registered via
 * `registerAll`.
 */
export function createRepographServer(deps: RepographServerDeps): McpServer {
  const server = new McpServer({ name: "repograph", version: "0.1.0" });
  registerAll(server, createRepoStore(deps.driver, deps.database));

  return server;
}

/** Connects the server to stdio and starts serving requests. */
export async function startStdioServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
