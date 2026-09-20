import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import type { StartedNeo4jContainer } from "@testcontainers/neo4j";
import type { Driver } from "neo4j-driver";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeNeo4jDriver, createNeo4jDriver } from "../src/bootstrap.js";
import { clearDb } from "./setup/graph-fixture.js";
import { startTestNeo4j } from "./setup/neo4j-test-container.js";

// Process/stdio-level e2e: spawns the built `dist/src/index.js` and speaks
// raw JSON-RPC over stdio. Holds what store-level + InMemoryTransport suites
// cannot: fail-fast startup, SIGTERM handling, stdout purity, and the wire
// envelopes `{ data }` / `{ code, message } + isError`.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(REPO_ROOT, "dist", "src", "index.js");
const TEST_DATABASE = "neo4j";

// Per Q4: suite timeout comes from vitest.config (120s); per-launch budgets below.
const REQUEST_TIMEOUT_MS = 15_000;
const STARTUP_GRACE_MS = 30_000;
const SIGTERM_GRACE_MS = 10_000;

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: number | string;
  result?: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    tools?: Array<{ name: string }>;
  };
};

type Launched = {
  child: ChildProcess;
  req: (method: string, params?: Record<string, unknown>) => Promise<NonNullable<JsonRpcResponse["result"]>>;
  notify: (method: string) => void;
  getStderr: () => string;
  getNonJsonStdout: () => string[];
};

function launch(env: NodeJS.ProcessEnv): Launched {
  const child = spawn("node", [DIST], { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");

  let buf = "";
  const pending = new Map<number, (msg: JsonRpcResponse) => void>();
  let stderr = "";
  const nonJsonStdout: string[] = [];

  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout?.on("data", (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (msg.id !== undefined && typeof msg.id === "number" && pending.has(msg.id)) {
          pending.get(msg.id)?.(msg);
        }
      } catch {
        nonJsonStdout.push(line);
      }
    }
  });

  let nextId = 1;
  const req = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<NonNullable<JsonRpcResponse["result"]>>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        pending.delete(id);
        if (!msg.result) {
          reject(new Error(`MCP ${method} returned no result: ${JSON.stringify(msg).slice(0, 200)}`));
          return;
        }
        resolve(msg.result);
      });
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  const notify = (method: string): void => {
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  };

  return {
    child,
    req,
    notify,
    getStderr: () => stderr,
    getNonJsonStdout: () => nonJsonStdout,
  };
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<number | string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? "null-exit");
    });
  });
}

function killChild(child: ChildProcess): void {
  child.stdin?.end();
}

function parseBody(result: NonNullable<JsonRpcResponse["result"]>): unknown {
  expect(result.content).toHaveLength(1);
  expect(result.content?.[0]?.type).toBe("text");
  return JSON.parse(result.content?.[0]?.text ?? "null");
}

describe("e2e process/stdio (real Neo4j, spawned dist)", () => {
  let container: StartedNeo4jContainer;
  let driver: Driver;

  function baseEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      NEO4J_URI: container.getBoltUri(),
      NEO4J_USER: container.getUsername(),
      NEO4J_PASSWORD: container.getPassword(),
      NEO4J_DATABASE: TEST_DATABASE,
    };
  }

  beforeAll(async () => {
    if (!existsSync(DIST)) {
      throw new Error(`dist/src/index.js missing at ${DIST} — run npm run build first`);
    }
    container = await startTestNeo4j();
    driver = createNeo4jDriver({
      uri: container.getBoltUri(),
      user: container.getUsername(),
      password: container.getPassword(),
      database: TEST_DATABASE,
    });
  });

  afterAll(async () => {
    if (driver) await closeNeo4jDriver(driver);
    if (container) await container.stop();
  });

  beforeEach(async () => {
    await clearDb(driver, TEST_DATABASE);
  });

  it("serves the full conversation over stdio with clean stdout and graceful SIGTERM", async () => {
    const s = launch(baseEnv());
    try {
      const init = await s.req("initialize", {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "e2e-process", version: "0.0.0" },
      });
      expect(init).toBeDefined();
      s.notify("notifications/initialized");

      const list = await s.req("tools/list");
      expect(list.tools?.map((t) => t.name).sort()).toEqual([
        "add_relation",
        "add_repo",
        "get_related_repos",
        "get_relations",
        "search_repos",
        "supersede_relation",
      ]);

      const A = "group/e2e-a";
      const B = "group/e2e-b";

      const addA = await s.req("tools/call", { name: "add_repo", arguments: { repo: A, type: "service" } });
      expect(addA.isError ?? false).toBe(false);
      expect((parseBody(addA) as { data: { path: string } }).data.path).toBe(A);

      const addB = await s.req("tools/call", { name: "add_repo", arguments: { repo: B } });
      expect(addB.isError ?? false).toBe(false);

      const rel = await s.req("tools/call", {
        name: "add_relation",
        arguments: {
          from: A,
          to: B,
          type: "depends_on",
          evidence: ["e2e probe"],
          from_paths: ["src/a.ts"],
          to_paths: ["lib/b.ts"],
        },
      });
      expect(rel.isError ?? false).toBe(false);
      expect(parseBody(rel)).toMatchObject({
        data: { type: "depends_on", from_paths: ["src/a.ts"], to_paths: ["lib/b.ts"] },
      });

      const trav = await s.req("tools/call", { name: "get_related_repos", arguments: { repo: A } });
      expect(trav.isError ?? false).toBe(false);
      expect((parseBody(trav) as { data: Array<{ path: string }> }).data.map((n) => n.path)).toContain(B);

      const edges = await s.req("tools/call", {
        name: "get_relations",
        arguments: { repo: A, direction: "out" },
      });
      expect(edges.isError ?? false).toBe(false);
      expect(parseBody(edges)).toMatchObject({
        data: [{ from: A, to: B, from_paths: ["src/a.ts"], to_paths: ["lib/b.ts"] }],
      });

      const fix = await s.req("tools/call", {
        name: "add_relation",
        arguments: {
          from: A,
          to: B,
          type: "depends_on",
          evidence: ["e2e probe, typo fixed"],
          evidence_mode: "replace",
        },
      });
      expect(fix.isError ?? false).toBe(false);
      expect(parseBody(fix)).toMatchObject({
        data: {
          type: "depends_on",
          evidence: ["e2e probe, typo fixed"],
          from_paths: ["src/a.ts"],
          to_paths: ["lib/b.ts"],
        },
      });

      const search = await s.req("tools/call", { name: "search_repos", arguments: { query: "e2e" } });
      expect(search.isError ?? false).toBe(false);
      expect((parseBody(search) as { data: unknown[] }).data).toHaveLength(2);

      const sup = await s.req("tools/call", {
        name: "supersede_relation",
        arguments: { from: A, to: B, type: "depends_on", superseded_by: "e2e" },
      });
      expect(sup.isError ?? false).toBe(false);
      expect((parseBody(sup) as { data: { superseded_by: string } }).data.superseded_by).toBe("e2e");

      const travAfter = await s.req("tools/call", { name: "get_related_repos", arguments: { repo: A } });
      expect(travAfter.isError ?? false).toBe(false);
      expect((parseBody(travAfter) as { data: unknown[] }).data).toHaveLength(0);

      const edgesAfter = await s.req("tools/call", { name: "get_relations", arguments: { repo: A } });
      expect(edgesAfter.isError ?? false).toBe(false);
      expect((parseBody(edgesAfter) as { data: unknown[] }).data).toHaveLength(0);

      const edgesHistory = await s.req("tools/call", {
        name: "get_relations",
        arguments: { repo: A, include_superseded: true },
      });
      expect(edgesHistory.isError ?? false).toBe(false);
      expect(parseBody(edgesHistory)).toMatchObject({
        data: [{ from: A, to: B, from_paths: ["src/a.ts"], to_paths: ["lib/b.ts"] }],
      });

      const bad = await s.req("tools/call", { name: "add_repo", arguments: { repo: "   " } });
      expect(bad.isError).toBe(true);
      expect(parseBody(bad)).toMatchObject({ code: "INVALID_INPUT" });

      const missing = await s.req("tools/call", {
        name: "get_related_repos",
        arguments: { repo: "group/no-such-e2e" },
      });
      expect(missing.isError).toBe(true);
      expect(parseBody(missing)).toMatchObject({ code: "NOT_FOUND" });

      const shortMiss = await s.req("tools/call", {
        name: "get_relations",
        arguments: { repo: "no-such-short-xyz" },
      });
      expect(shortMiss.isError).toBe(true);
      expect(parseBody(shortMiss)).toMatchObject({ code: "NOT_FOUND" });
      expect(JSON.stringify(parseBody(shortMiss))).toContain("search_repos");

      const shortResolve = await s.req("tools/call", {
        name: "get_relations",
        arguments: { repo: "e2e-a", include_superseded: true },
      });
      expect(shortResolve.isError ?? false).toBe(false);
      expect(parseBody(shortResolve)).toMatchObject({ data: [{ from: A, to: B }] });

      const shortTrav = await s.req("tools/call", {
        name: "get_related_repos",
        arguments: { repo: "e2e-a", include_superseded: true },
      });
      expect(shortTrav.isError ?? false).toBe(false);
      expect((parseBody(shortTrav) as { data: Array<{ path: string }> }).data.map((n) => n.path)).toContain(
        B,
      );

      const shortAdd = await s.req("tools/call", { name: "add_repo", arguments: { repo: "lonely-short" } });
      expect(shortAdd.isError).toBe(true);
      expect(parseBody(shortAdd)).toMatchObject({ code: "INVALID_INPUT" });

      expect(s.getNonJsonStdout()).toEqual([]);

      const exitP = waitExit(s.child, SIGTERM_GRACE_MS);
      s.child.kill("SIGTERM");
      await expect(exitP).resolves.toBe(0);
    } finally {
      killChild(s.child);
      s.child.kill("SIGKILL");
    }
  }, 120_000);

  it("fails fast with a non-zero exit and stderr when the password is wrong", async () => {
    const s = launch({ ...baseEnv(), NEO4J_PASSWORD: "wrong-password" });
    try {
      const exited = await waitExit(s.child, STARTUP_GRACE_MS);
      expect(typeof exited).toBe("number");
      expect(exited).not.toBe(0);
      expect(s.getStderr()).toMatch(/failed to start/i);
    } finally {
      killChild(s.child);
      s.child.kill("SIGKILL");
    }
  }, 60_000);

  it("fails fast with a non-zero exit when the password is missing", async () => {
    const env = { ...baseEnv() };
    delete env.NEO4J_PASSWORD;
    const s = launch(env);
    try {
      const exited = await waitExit(s.child, STARTUP_GRACE_MS);
      expect(typeof exited).toBe("number");
      expect(exited).not.toBe(0);
    } finally {
      killChild(s.child);
      s.child.kill("SIGKILL");
    }
  }, 60_000);
});
