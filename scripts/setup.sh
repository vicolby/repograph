#!/usr/bin/env bash
#
# One-command local setup for repograph:
#
#   ./scripts/setup.sh
#   # or: npm run setup
#
# Idempotent: safe to re-run. It never overwrites an existing .env.
#
# What it does:
#   1. Checks prerequisites (Node.js >= 20, Docker + Compose).
#   2. Installs dependencies (npm ci).
#   3. Creates .env from .env.example on first run (never overwrites).
#   4. Starts Neo4j via docker compose and waits until it is healthy.
#   5. Builds the MCP server (dist/).
#   6. Smoke-tests the exact stdio spawn both agents use
#      (node dist/src/index.js) against the local Neo4j.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { echo "setup: ERROR: $*" >&2; exit 1; }
info() { echo "setup: $*"; }

# 1. Prerequisites -----------------------------------------------------------
command -v node >/dev/null || fail "node not found — install Node.js >= 20 (https://nodejs.org)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "node $(node --version) is too old — need >= 20."
command -v npm >/dev/null || fail "npm not found — it ships with Node.js."
command -v docker >/dev/null || fail "docker not found — install Docker (https://docs.docker.com/get-docker)."
docker info >/dev/null 2>&1 || fail "cannot reach the Docker daemon. Is Docker running? If you just joined the 'docker' group, log out and back in (or run: newgrp docker)."
docker compose version >/dev/null 2>&1 || fail "'docker compose' plugin not found — update Docker to a version with Compose v2."
info "prerequisites OK (node $(node --version), $(docker compose version --short))"

# 2. Dependencies -------------------------------------------------------------
info "installing dependencies..."
npm ci --no-audit --no-fund

# 3. Env file (first run only) -------------------------------------------------
if [ -f .env ]; then
  info ".env already exists — leaving it untouched."
else
  cp .env.example .env
  info "created .env from .env.example (default local-only credentials)."
fi
# shellcheck disable=SC1091
set -a; source .env; set +a
: "${NEO4J_PASSWORD:?NEO4J_PASSWORD must be set in .env}"

# 4. Neo4j --------------------------------------------------------------------
info "starting Neo4j (docker compose up -d)..."
docker compose up -d neo4j
info "waiting for Neo4j to become healthy (up to ~2 min)..."
for _ in $(seq 1 24); do
  STATUS="$(docker inspect -f '{{.State.Health.Status}}' repograph-neo4j 2>/dev/null || echo starting)"
  if [ "$STATUS" = "healthy" ]; then
    info "Neo4j is healthy."
    break
  fi
  sleep 5
done
[ "$STATUS" = "healthy" ] || fail "Neo4j did not become healthy. Inspect with: docker compose logs neo4j"

# 5. Build ---------------------------------------------------------------------
info "building the MCP server..."
npm run build --silent

# 6. Smoke test: spawn exactly what opencode.json / .mcp.json spawn -----------
info "smoke-testing stdio spawn (tools/list)..."
SMOKE="$(NEO4J_URI="${NEO4J_URI:-bolt://localhost:7687}" \
  NEO4J_USER="${NEO4J_USER:-neo4j}" \
  NEO4J_PASSWORD="$NEO4J_PASSWORD" \
  NEO4J_DATABASE="${NEO4J_DATABASE:-neo4j}" \
  timeout 25 node -e "
const { spawn } = require('node:child_process');
const child = spawn('node', ['dist/src/index.js'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id === 1) { console.log(JSON.stringify(msg.result.tools.map((t) => t.name))); child.kill(); process.exit(0); }
    } catch {}
  }
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n');
setTimeout(() => { console.error('smoke test timed out'); child.kill(); process.exit(1); }, 20000).unref();
")"
info "tools exposed: $SMOKE"
echo "$SMOKE" | grep -q "add_repo" || fail "smoke test failed — expected add_repo in: $SMOKE"

echo ""
echo "Done. Next steps:"
echo "  - OpenCode: run 'opencode mcp list' from this directory — repograph should be connected."
echo "  - Claude Code: approve .mcp.json once when prompted, then check '/mcp'."
echo "  - Neo4j browser: http://localhost:7474"
echo "  - Data persists in the 'neo4j-data' Docker volume (survives restarts; 'down -v' wipes it)."
