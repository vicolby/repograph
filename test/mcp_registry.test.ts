import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
  createRepographServer,
  mapToolError,
  type ToolFailure,
  type ToolSuccess,
} from "../src/mcp/server.js";
import { defineGraphSuite, TEST_DATABASE } from "./setup/graph-fixture.js";

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
};

type CallToolWireResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

/**
 * Minimal MCP client over an in-memory transport: speaks raw JSON-RPC
 * (`initialize`, `tools/list`, `tools/call`) so the suite exercises the
 * server exactly the way a real agent client does — no server privates.
 */
async function connectTestClient(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await clientTransport.start();

  let nextId = 1;
  const pending = new Map<number | string, (msg: JsonRpcResponse) => void>();
  clientTransport.onmessage = (message) => {
    const msg = message as JsonRpcResponse;
    if (typeof msg.id === "number" || typeof msg.id === "string") {
      pending.get(msg.id)?.(msg);
    }
  };

  async function request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = nextId++;
    const response = new Promise<JsonRpcResponse>((resolve) => {
      pending.set(id, resolve);
    });
    await clientTransport.send({ jsonrpc: "2.0", id, method, params: params ?? {} });
    const msg = await response;
    pending.delete(id);
    if (msg.error) throw new Error(`MCP ${method} failed: ${msg.error.message}`);
    return msg.result as T;
  }

  return {
    initialize: () =>
      request("initialize", {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "registry-test", version: "0.0.0" },
      }),
    notifyInitialized: () => clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" }),
    listToolNames: async () => {
      const result = await request<{ tools: Array<{ name: string }> }>("tools/list");
      return result.tools.map((tool) => tool.name);
    },
    callTool: (name: string, args: Record<string, unknown>) =>
      request<CallToolWireResult>("tools/call", { name, arguments: args }),
    close: async () => {
      await clientTransport.close();
      await server.close();
    },
  };
}

function parseCall(result: CallToolWireResult): { isError: boolean; body: unknown } {
  expect(result.content).toHaveLength(1);
  expect(result.content[0]?.type).toBe("text");
  return { isError: result.isError ?? false, body: JSON.parse(result.content[0]?.text ?? "null") };
}

describe("mapToolError", () => {
  it("maps non-Error throws to INTERNAL without leaking the value", () => {
    expect(mapToolError("boom")).toEqual({ code: "INTERNAL", message: "Internal error" });
  });

  it("passes unknown Error messages through as INTERNAL", () => {
    expect(mapToolError(new Error("connection reset"))).toEqual({
      code: "INTERNAL",
      message: "connection reset",
    });
  });
});

defineGraphSuite(
  "mcp registry (real Neo4j, MCP client)",
  {
    seedRepos: [{ repo: "group/service-a" }, { repo: "group/service-b" }],
  },
  ({ driver }) => {
    async function newClient() {
      const server = createRepographServer({ driver: driver(), database: TEST_DATABASE });
      const client = await connectTestClient(server);
      await client.initialize();
      await client.notifyInitialized();
      return client;
    }

    it("lists all five tools", async () => {
      const client = await newClient();
      try {
        await expect(client.listToolNames()).resolves.toEqual([
          "add_repo",
          "add_relation",
          "supersede_relation",
          "get_related_repos",
          "search_repos",
        ]);
      } finally {
        await client.close();
      }
    });

    it("returns the { data } envelope on success", async () => {
      const client = await newClient();
      try {
        const { isError, body } = parseCall(
          await client.callTool("add_repo", { repo: "group/service-c", type: "service" }),
        );
        expect(isError).toBe(false);
        expect((body as ToolSuccess<{ path: string }>).data.path).toBe("group/service-c");

        const search = parseCall(await client.callTool("search_repos", { query: "service" }));
        expect(search.isError).toBe(false);
        expect((search.body as ToolSuccess<Array<{ path: string }>>).data.length).toBeGreaterThan(0);
      } finally {
        await client.close();
      }
    });

    it("returns INVALID_INPUT when domain validation rejects the call", async () => {
      const client = await newClient();
      try {
        const { isError, body } = parseCall(await client.callTool("add_repo", { repo: "   " }));
        expect(isError).toBe(true);
        expect(body as ToolFailure).toMatchObject({ code: "INVALID_INPUT" });
        expect((body as ToolFailure).message).toMatch(/repo/);

        const relation = parseCall(
          await client.callTool("add_relation", {
            from: "group/service-a",
            to: "group/service-b",
            type: "depends_on",
            evidence: [],
          }),
        );
        expect(relation.isError).toBe(true);
        expect(relation.body as ToolFailure).toMatchObject({ code: "INVALID_INPUT" });
      } finally {
        await client.close();
      }
    });

    it("returns NOT_FOUND for missing repos and edges", async () => {
      const client = await newClient();
      try {
        const { isError, body } = parseCall(
          await client.callTool("get_related_repos", { repo: "group/no-such-repo" }),
        );
        expect(isError).toBe(true);
        expect(body as ToolFailure).toMatchObject({ code: "NOT_FOUND" });

        const edge = parseCall(
          await client.callTool("supersede_relation", {
            from: "group/service-a",
            to: "group/service-b",
            type: "no_such_type",
          }),
        );
        expect(edge.isError).toBe(true);
        expect(edge.body as ToolFailure).toMatchObject({ code: "NOT_FOUND" });
      } finally {
        await client.close();
      }
    });
  },
);
