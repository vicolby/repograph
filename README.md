# repograph

MCP server backed by Neo4j that tracks relationships between repositories
(which services call which, which terraform modules they use, etc.), so an
AI agent working in one repo can quickly understand what it's connected to.

This is a personal, local-only tool. It is not published or pushed anywhere.

## What's here (project scaffold)

- `docker-compose.yml` — Neo4j Community Edition, reachable over Bolt.
- `src/config.ts` — reads Neo4j connection settings from environment variables.
- `src/neo4j/driver.ts` — shared Neo4j driver module used by the server (and later, its tools).
- `src/mcp/server.ts` / `src/index.ts` — an MCP server that speaks stdio, with
  four tools: `add_repo`, `add_relation`, `get_related_repos`, and
  `search_repos`.
- `opencode.json` — project-local OpenCode config that spawns the server
  over stdio (`repograph`).
- `.mcp.json` — project-scoped Claude Code config that spawns the same
  stdio server (`repograph`).
- `test/` — a smoke test that exercises the driver module against a real,
  disposable Neo4j instance (via testcontainers), plus a unit test for config parsing.

## Prerequisites

- Node.js >= 20
- Docker (with `docker compose`)

## Setup

One command (checks prerequisites, installs deps, creates `.env` on first
run, starts Neo4j, builds, and smoke-tests the MCP spawn):

```bash
./scripts/setup.sh
# or: npm run setup
```

Safe to re-run — it never overwrites an existing `.env`. Manual steps, if
you prefer them:

```bash
npm install
cp .env.example .env   # then edit NEO4J_PASSWORD if you want something other than the default
```

## Running Neo4j locally

```bash
docker compose up -d
```

This starts Neo4j Community Edition (no APOC/GDS plugins) with:

- Bolt on `localhost:7687`
- Browser UI on `http://localhost:7474`

Stop it with `docker compose down` (add `-v` to also drop the data volume).

## Running the MCP server

```bash
npm run dev
```

This starts the server as a stdio process — the same way an agent (OpenCode,
Claude Code) spawns it as a child process. It reads Neo4j connection settings
from the environment (see `.env.example`).

For the agent-spawned entrypoint, build first so `dist/` is fresh, then run
the compiled server (this is exactly what `opencode.json` and `.mcp.json`
spawn):

```bash
npm run build
npm start
```

## Connecting agents (OpenCode + Claude Code)

Both agents spawn the same local stdio server against the Neo4j instance
from `docker-compose.yml`. No other agent tools are configured.

- **OpenCode** reads `opencode.json` in the project root automatically.
  Verify with `opencode mcp list` — `repograph` should show as connected.
- **Claude Code** reads `.mcp.json` in the project root (project scope).
  Approve it once when prompted, then check `/mcp` or
  `claude mcp get repograph`.

Both configs run `node dist/src/index.js` with the default local Neo4j
credentials from `.env.example` (`bolt://localhost:7687`,
`neo4j` / `changeme-local-only`, database `neo4j`). Rebuild after pulling
(`npm run build`) so the spawned server matches `src/`. To use a different
password, change `NEO4J_PASSWORD` in both files to match
`docker-compose.yml`'s auth.

## Testing

```bash
npm test
```

Tests spin up a real, disposable Neo4j container per test file (via
[testcontainers](https://node.testcontainers.org/)) and tear it down when
done — no mocked driver. The `test` script sets
`TESTCONTAINERS_RYUK_DISABLED=true` because this machine's Docker socket
permissions block testcontainers' Ryuk reaper container from reaching the
daemon; test files stop their own containers explicitly in `afterAll`, so
this only means we rely on that explicit teardown instead of the reaper's
crash-cleanup safety net.

## Environment variables

| Variable         | Default                  | Notes                              |
| ---------------- | ------------------------- | ----------------------------------- |
| `NEO4J_URI`       | `bolt://localhost:7687`   |                                      |
| `NEO4J_USER`      | `neo4j`                   |                                      |
| `NEO4J_PASSWORD`  | *(required)*              | Must match `docker-compose.yml`'s auth. |
| `NEO4J_DATABASE`  | `neo4j`                   |                                      |
