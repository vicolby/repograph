# Coding standards

Conventions every change to this repo follows. The codebase is the
reference implementation — when this document and the code disagree,
trust the code and update this document.

## 1. Module boundaries

- `src/repos/store.ts` is the **only** public seam of the `src/repos/`
  module. Outside callers (MCP server, tests, fixtures) import only
  `store.ts` and the domain types it re-exports. Never import
  `db.ts`, `input.ts`, `normalize.ts`, or per-tool files from outside
  `src/repos/`.
- Every internal file in `src/repos/` carries the header comment
  `// Internal to the src/repos/ module (see store.ts): do not import
  // from outside src/repos/.` Keep it on new files.
- Responsibilities are split by file, one reason to change each:
  - `store.ts` — binds driver+database into `RepoStore`, re-exports types.
  - `input.ts` — all input validation (the validation seam, §3).
  - `db.ts` — session lifecycle, constraints, record mapping.
  - `normalize.ts` — repo identifier normalization.
  - one file per tool (`addRepo.ts`, `addRelation.ts`, …) — Cypher only.
- `src/mcp/server.ts` is a thin transport layer: tool registration,
  zod schemas, and the success/error envelope. No domain logic.
- `src/bootstrap.ts` owns startup wiring (env config + shared driver).
  Only `src/index.ts` (production) and the test fixture import it.
  Do not add pass-through modules with a single consumer.

## 2. TypeScript

`tsconfig.json` enforces `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitReturns`,
`noFallthroughCasesInSwitch`, and `verbatimModuleSyntax` (plus
`NodeNext` ESM). Consequences:

- Use `import type` for type-only imports.
- Use `.js` suffixes in relative imports (`./db.js`).
- Declare optional input fields as `x?: T | null | undefined` and pass
  `x ?? null` as Cypher params (Cypher distinguishes `NULL`
  from omitted; see §5).
- Handle `null`/`undefined` from record getters explicitly
  (`?? []`, `?? null`); never cast away nullability.
- Document exported types and functions with TSDoc, including write
  semantics (what omit/`[]`/repeat-call does), not just shapes.

## 3. Validation seam (`src/repos/input.ts`)

All trim / reject / throw rules live here. The zod schemas in
`src/mcp/server.ts` are thin transport types (field names and scalar
shapes only, no min/max/range constraints), so MCP calls and direct
store calls fail identically through this seam.

- Every validator takes `(value, tool, field)`; `tool` is the calling
  tool's name and prefixes every message.
- Message wording is load-bearing. `mapToolError` maps to:
  - `INVALID_INPUT` — message matches `/must be|requires|non-empty|integer|boolean|invalid/i`;
  - `NOT_FOUND` — message matches `/not found/i`;
  - `INTERNAL` — everything else.
  - Therefore validation failures **must** contain `must be`
    (e.g. `` `${tool} field ${JSON.stringify(field)} must be …` ``),
    and missing repos/edges **must** say `not found`. A message
    without these phrases silently becomes `INTERNAL`.
- Reuse the existing helpers (`requiredText`, `optionalText`,
  `requiredTextList`, `resolveRepoPath`, `optionalIntInRange`,
  `optionalBoolean`). A new optional enum means a new
  `Type + optionalX` pair that returns the default when `undefined`
  and throws otherwise (see `RelationDirection` /
  `optionalRelationDirection`, `EvidenceMode` / `optionalEvidenceMode`).
- Pure functions here are unit-testable without a database; cover new
  validators with a unit `describe` asserting the `INVALID_INPUT`
  mapping (see `test/relation_evidence_mode.test.ts`).

## 4. Tool envelopes (`src/mcp/server.ts`)

- Success is `{ data: <store value> }` as a single text block;
  failure is `{ code, message }` with `isError: true`. All tools go
  through `runTool`; never return bare values or throw past it.
- Adding a tool means adding one `registerTool` call in `registerAll`
  with a concrete `z.object` schema (no unions, no casts) and a
  description that states the write semantics. Pass validated args
  straight to the store; coerce nothing in the handler.
- Transport-level schema rejections (wrong scalar shape) are answered
  by the SDK and never reach `mapToolError` — keep zod enums in sync
  with the `input.ts` validators so both layers agree.

## 5. Cypher / Neo4j

- Always run queries inside `withSession` (it closes the session).
  Call `ensureRepoConstraints` on writes; call `ensureReposExist` /
  `ensureRepoExists` so missing nodes throw `not found` before matching.
- `MERGE` on natural keys (`Repo.path`, the `(from, to, type)` triple
  on `RELATES`); never create duplicate nodes/edges. One edge per
  triple — repeat writes accumulate, they never duplicate.
- Standard write patterns (copy them, don't reinvent):
  - omit-preserves: `CASE WHEN $p IS NULL THEN r.p ELSE … END`;
  - explicit-`[]`-clears: `WHEN size($p) = 0 THEN []`;
  - append-with-dedup: `coalesce(r.p, []) + [x IN $p WHERE NOT x IN coalesce(r.p, [])]`;
  - update-only-when-provided: `CASE WHEN $p IS NOT NULL THEN $p ELSE r.p END`.
- `RETURN` the full edge/node shape in one query and map it with the
  single-copy mappers (`mapRelationEdge`, `mapRepoNode`). Legacy edges
  missing newer properties read back as defaults (`[]`), never `null`.
- List reads end with an explicit `ORDER BY` (e.g. `from, to, type`).
- Soft-delete, don't `DELETE`: `supersede_relation` sets
  `superseded_at`/`superseded_by`. Reads filter
  `r.superseded_at IS NULL` unless `include_superseded` is true.
  Re-recording a triple via `add_relation` revives it.

## 6. Domain write semantics

- Repo identity is the normalized GitLab full path (`path`).
  `from`/`to`/`repo` accept SSH URLs, HTTPS URLs, or plain paths and
  resolve through `resolveRepoPath` — the same normalization as
  `add_repo`, so URL forms hit the same node.
- The Neo4j relationship type is fixed (`RELATES`); the free-text
  `type` is a property, so new relation types need no schema or code
  changes. Matching on `type` is exact.
- `evidence` is always a non-empty array of trimmed strings, including
  in `replace` mode. Clearing the last entry is a retract — use
  `supersede_relation`, not an empty write.
- Per-side hints (`from_paths`/`to_paths`) are optional, best-effort
  search scope with no freshness guarantee: omitted preserves the
  side, explicit `[]` clears it, otherwise appended with exact,
  case-sensitive, order-preserving dedup.
- `evidence_mode` on `add_relation`: `append` (default) accumulates,
  `replace` overwrites the array wholesale (fix a typo or drop a
  stale entry by rewriting the filtered list).
- Repeat writes refresh `created_at`. `created_by` / `superseded_by`
  update only when a new value is passed. Supersede never touches
  hints or evidence; revive applies normal write semantics.

## 7. Tests

- No mocked driver, ever. Suites spin up a real, disposable Neo4j
  container per test file via testcontainers and stop it in `afterAll`
  (`TESTCONTAINERS_RYUK_DISABLED=true`; teardown is explicit).
  `vitest.config.ts` allows 120 s for container boot — respect it.
- Declare scenarios with `defineGraphSuite(name, { seedRepos,
  seedRelations }, body)` in `test/setup/graph-fixture.ts`. It owns
  lifecycle, `clearDb` in `beforeEach`, and seeding. Test files contain
  only their scenario; use `countEdges` / `countRepos` to assert
  no-duplication. `TEST_DATABASE` is `neo4j`.
- Three layers, each holding what the others cannot:
  - store-level suites (real Neo4j) — domain semantics;
  - `mcp_registry.test.ts` (InMemoryTransport client) — tool names,
    `{ data }` / `{ code, message }` envelopes, wire passthrough;
  - `e2e-process.test.ts` (spawns built `dist/src/index.js` over
    stdio) — startup, SIGTERM, stdout purity, wire envelopes.
- **Rebuild `dist` (`npm run build`) after any `src/` change before
  running e2e or the full suite** — e2e spawns the built output, not
  `src/`.
- Target real behavior per test (`it("…")` names state the scenario,
  e.g. `"replace overwrites evidence wholesale without duplicating
  the edge"`). Keep DB-touching assertions in graph suites; pure
  validation/envelope mapping may use plain unit `describe` blocks.

### 7.1 End-to-end coverage is mandatory for new features

Store-level and registry tests are not enough. Every user-visible
feature — a new tool, a new parameter or write semantic, a new read
behavior or flag — **must** extend the stdio conversation in
`test/e2e-process.test.ts`
(`it("serves the full conversation over stdio …")`), which drives the
built `dist/src/index.js` over raw JSON-RPC exactly like a real agent
client. Rationale: only this layer catches what the inner suites
cannot — stale `dist`, broken tool registration, envelope mismatches,
startup/stdout/SIGTERM regressions.

- New tool: add its name to the sorted `tools/list` assertion, then
  exercise its happy path via `tools/call` and assert the `{ data }`
  body. Update the parallel list in `test/mcp_registry.test.ts`
  (`"lists all six tools"`) as well.
- New write semantic / parameter (e.g. `from_paths`, `evidence_mode`):
  write through `tools/call` with the new parameter, then read the
  result back through the matching getter tool and assert the stored
  shape — the conversation must prove the round-trip over the wire,
  not just the store return value.
- New read behavior / flag: call it in the conversation and assert
  both the data and the error cases (`INVALID_INPUT`, `NOT_FOUND`)
  via `isError` + parsed body.
- Extend the single conversation test; do not spawn extra processes
  per feature — process launch is the slowest part of the suite. The
  two fail-fast tests (wrong/missing password) stay untouched unless
  startup behavior itself changes.
- The e2e conversation uses its own `group/e2e-*` repos; keep it
  self-contained and order-dependent steps in one flow (write → read
  → supersede → hide → history), mirroring how an agent would use
  the tools in sequence.

## 8. Environment and commands

- Node.js >= 20. Docker is reachable only via the `docker` group:
  `sg docker -c 'npm test'`, `sg docker -c 'docker compose up -d'`.
- Scripts: `npm run build` (tsc), `npm run typecheck` (`tsc --noEmit`),
  `npm test` (sets `TESTCONTAINERS_RYUK_DISABLED=true`, runs vitest
  once). Run typechecking regularly, single test files regularly, and
  the full suite once at the end of a change.

## 9. Branches and commits

- One branch per issue: `feature/<scope>` (e.g.
  `feature/issue-2-evidence-mode`, `feature/gim-40`).
- Merge with `git merge --no-ff` and a message naming what merged
  (`Merge feature/…: …`); `main` is pushed directly, no PRs, unless
  review was explicitly requested first.
- Commit messages lead with the what and why
  (`Add evidence_mode (append/replace) to add_relation` + body
  explaining the recovery path it enables); reference the issue
  (`Fixes #2`) so it closes on merge to `main`.

## 10. Type-system discipline

Adapted from the `typescript-best-practices` skill
(<https://github.com/cursor/plugins/tree/main/pstack/skills/typescript-best-practices>).
Code examples live in `docs/typescript-patterns.md` (adapted from the
skill's `references/patterns.md` with repo-specific cases). These rules apply
when reading or editing any `.ts` file. Where a rule meets an existing
repo convention, the repo convention wins — notes below say how.

| Rule | What it means here |
|------|--------------------|
| Discriminated unions | Model variants with a `kind`/`type` literal discriminant so impossible states can't be represented. No boolean-plus-optionals bags. (`ToolSuccess`/`ToolFailure` stay separate types for the same reason.) |
| Branded types | Brand primitives with `& { readonly __brand: "X" }` where same-typed values travel together and could be swapped (e.g. `from`/`to` paths). Validate once at the boundary (`input.ts`, `normalize.ts`); trust the type inside. Don't brand by reflex. |
| Constructive modeling | Prefer shapes the illegal value can't inhabit (`[T, ...T[]]` for non-empty) over a loose type plus a repeated runtime check. |
| Simplest total type | Keep `T[]` while every operation on it stays total. Strengthen (e.g. to non-empty) only where the loose type forces `!`, a cast, or a "should never happen" throw. |
| `unknown` over `any` | External data is `unknown`: RPC args (the SDK gives them to handlers; `runTool`/`mapToolError` already treat throws as `unknown`), `JSON.parse`, env, driver results. Narrow before use. |
| Schemas before hand-rolled guards | The repo's runtime schema library is zod — but the domain "schema" for tool inputs is deliberately `input.ts` (§3), because error-message wording is a contract. Do not add a zod schema that duplicates `input.ts` validation; the two would drift. Use zod for what it owns: env config (`bootstrap.ts`) and thin transport shapes (`server.ts`). |
| No `as` casts | Every `as` is a runtime crash waiting. The only tolerated casts are earned ones at the validated boundary: the `record.get(…) as …` mappings in `db.ts` (the Neo4j driver returns `any`; the mapper is the parse), and `as const` literal narrowings. Any new `as` elsewhere must be justified in the commit message. |
| Narrowing hierarchy | Discriminant switch > `in` operator > `typeof`/`instanceof` > user-defined guard > `as`. |
| Type guards | Must verify the claim; a lying guard is worse than `as`. Name them `isX`/`hasX`. Prefer discriminant narrowing when possible. |
| Exhaustiveness | Inline `const _exhaustive: never = x;` in default arms so the compiler errors when a new variant is added. |
| `satisfies` over `as` | Validates without widening literals (already used for the `{ data }` envelope in `server.ts`). |
| Boundary validation | Parse where data crosses in, into a named domain type — that is `input.ts` + `normalize.ts`. `Record<string, unknown>` stops at that parse; trust types inside and don't re-validate down the call chain. |
| Schema-derived types | Reach for `Pick`/`Omit`/`Parameters`/`ReturnType`/`Awaited`/`typeof` before declaring a new interface (e.g. derive handler arg types from `RepoStore` instead of redeclaring them). |
| Object args | Pass objects, not positionals — tool inputs already are (`AddRelationInput`, …). New functions with 2+ params take an object. Skip on hot paths (none currently). |
| Real tests | Already §7: no mocked driver, real Neo4j, real stdio build. Mock only what can't run locally. |
| Structured telemetry | No `console.log` in shipped code — stdout is reserved for the MCP protocol (e2e asserts zero non-JSON stdout). Diagnostics go to stderr (`src/index.ts` startup failure is the template). |
