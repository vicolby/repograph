# repograph

MCP server backed by Neo4j that tracks relationships between repositories
(which services call which, which terraform modules they use, etc.), so an
AI agent working in one repo can quickly understand what it's connected to.

This is a personal, local-only tool. It is not published or pushed anywhere.

## What's here (project scaffold)

- `docker-compose.yml` — Neo4j Community Edition, reachable over Bolt.
- `src/config.ts` — reads Neo4j connection settings from environment variables.
- `src/neo4j/driver.ts` — shared Neo4j driver module used by the server (and later, its tools).
- `src/mcp/server.ts` / `src/index.ts` — an MCP server that speaks stdio, with an
  empty tool registry. `add_repo`, `add_relation`, `get_related_repos`, and
  `search_repos` are added by later tickets.
- `test/` — a smoke test that exercises the driver module against a real,
  disposable Neo4j instance (via testcontainers), plus a unit test for config parsing.

## Prerequisites

- Node.js >= 20
- Docker (with `docker compose`)

## Setup

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
