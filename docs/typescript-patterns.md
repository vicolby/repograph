# TypeScript patterns

Code examples for §10 of `CODING_STANDARDS.md` (type-system discipline).
Adapted from the `typescript-best-practices` skill
(<https://github.com/cursor/plugins/tree/main/pstack/skills/typescript-best-practices>,
`references/patterns.md`); repo-specific examples use this codebase.

## Branded types

Brand primitives so they can't be mixed up. Validate once at the
boundary; downstream code trusts the type. Match the
`readonly __brand: "X"` shape — don't invent a new convention.

```ts
type RepoPath = string & { readonly __brand: "RepoPath" };

// Boundary: normalizeRepoIdentifier / resolveRepoPath already validate.
// A brand would make from/to mix-ups unrepresentable:
function addRelationEdge(from: RepoPath, to: RepoPath): void {
  /* swapped args no longer compile */
}
```

Brand only where same-typed values travel together — not by reflex
(see `TimeRange` below).

## Discriminated unions

Model variants with a literal discriminant. Every variant shares the
field name and each value is unique, so impossible combos can't be
represented. Pick one discriminant name (`kind`, `type`, `tag`) and
stick to it.

```ts
// Don't. Boolean + optionals lets contradictory states exist.
type DiffState = { loading: boolean; diff?: GitDiff; error?: string };

// Do. Only valid states exist.
type DiffState =
  | { kind: "loading" }
  | { kind: "ready"; diff: GitDiff }
  | { kind: "error"; error: string };
```

## Constructive modeling

Build the type from parts that are all legal instead of restricting a
loose type with runtime checks.

```ts
type NonEmpty<T> = [T, ...T[]];

// Don't: T[] plus a length check every caller must repeat.
function pickWinner(entries: string[]): string {
  if (entries.length === 0) throw new Error("no entries");
  return entries[Math.floor(Math.random() * entries.length)];
}

// Do: an empty value of the type can't exist.
function pickWinner(entries: NonEmpty<string>): string {
  return entries[Math.floor(Math.random() * entries.length)];
}
```

Where a plain `T[]` arrives, narrow once with a guard — the fact then
travels in the type:

```ts
const isNonEmpty = <T>(arr: T[]): arr is NonEmpty<T> => arr.length > 0;
```

Even length, as pairs: `type Pairs<T> = [T, T][];`

A time range, as start plus duration:

```ts
// Don't: a comment holds the invariant.
type TimeRange = { start: Date; end: Date }; // start <= end

// Do: a negative range can't be written; derive end when needed.
type TimeRange = { start: Date; durationMs: number };
```

Keep `durationMs` a plain number. Brand it only if a raw number could
be passed where a duration is expected. Expose the reading you need on
top (`pairs.flat()`, a `rangeEnd()` helper).

## Simplest total type

Don't strengthen everything. Keep `T[]` when every operation on it is
total:

```ts
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0); // [] is 0, fine
```

Strengthen when the loose type forces a lie at a use site. The tells
are `!`, `arr[0] as T`, and a "should never happen" throw:

```ts
// Don't: partiality smuggled past the compiler.
function newestSession(sessions: Session[]): Session {
  return sessions.at(0)!;
}

// Do: strengthen the input; the assertion disappears.
function newestSession(sessions: NonEmpty<Session>): Session {
  return sessions[0];
}
```

Weakening the result to `Session | undefined` is the other total
signature.

## `unknown` over `any`

External data is always `unknown`. Narrow before use. External sources
include RPC payloads, `JSON.parse`, IPC, file contents, environment
variables, database results.

```ts
// Don't.
function handle(input: any) {
  return input.foo.bar;
}

// Do.
function handle(input: unknown) {
  if (typeof input === "object" && input !== null && "foo" in input) {
    // narrowed; compiler verifies access
  }
}
```

In this repo: `main().catch((error: unknown) => …)` and `mapToolError`
already treat throws as `unknown`.

## Schemas before hand-rolled guards

Before writing a property-by-property type guard for external data,
use the repository's runtime schema library and infer the type from
the schema. One schema owns validation; don't maintain a schema, a
duplicate interface, and a guard that can drift apart.

```ts
import { z } from "zod";

const UserSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(["admin", "member"]),
});

type User = z.infer<typeof UserSchema>;

function parseUser(input: unknown): User {
  return UserSchema.parse(input);
}
```

Use `safeParse` when failure is an expected branch. Repo note: for
tool inputs the owned "schema" is `input.ts` (§3 of the standards) —
don't duplicate it in zod. Zod owns env config and transport shapes.

## No `as` casts

Every `as` is a potential runtime crash. Cast only after the type
system has verified the claim — an earned cast at a validated
boundary:

```ts
// db.ts: the Neo4j driver returns `any`; the mapper is the parse.
// This is the repo's one tolerated cast site.
evidence: (record.get("evidence") as string[] | null) ?? [],
```

```ts
// server.ts: `as const` narrows a literal — not a lie, always fine.
{ type: "text" as const, text: JSON.stringify(…) },
```

When refactoring an `as` out of existing code, identify why
TypeScript can't infer:

- missing discriminant → discriminated union;
- overly wide source (e.g. `Record<string, unknown>`) → narrow it;
- untyped boundary → parse function or schema;
- genuinely inexpressible → branded type or `satisfies`.

## Narrowing hierarchy

Best to last-resort:

1. Discriminated union switch / if — compiler narrows automatically.
2. `in` operator — `"key" in obj` narrows to variants with that key.
3. `typeof` / `instanceof` — primitives and class instances.
4. User-defined type guard — when the above aren't enough.
5. `as` cast — only after validation.

```ts
function area(s: Shape): number {
  if ("radius" in s) return Math.PI * s.radius ** 2; // narrowed to circle
  return s.width * s.height; // narrowed to rect
}
```

## Type guards

A guard must actually verify the claim. A lying guard is worse than
`as` because the bug hides behind a safe-sounding name. Name them
`isX` or `hasX`; prefer discriminant narrowing when possible.

```ts
function isCircle(s: Shape): s is Shape & { kind: "circle" } {
  return s.kind === "circle";
}
```

## Exhaustiveness

In default arms, assign the discriminant to a `never`-typed local so
the compiler errors when a new variant is added. Return-style in
value-returning switches, void-style in statement switches.

```ts
function area(s: Shape): number {
  switch (s.kind) {
    case "circle":
      return Math.PI * s.radius ** 2;
    case "rect":
      return s.width * s.height;
    default: {
      const _exhaustive: never = s;
      return _exhaustive;
    }
  }
}
```

## `satisfies` over `as`

`satisfies` validates without widening literal types. Already the repo
norm for the success envelope:

```ts
// server.ts
{ type: "text" as const, text: JSON.stringify({ data: value } satisfies ToolSuccess<unknown>) },
// config.theme is "dark" (literal), not string:
const config = { theme: "dark", cols: 3 } satisfies Config;
```

## Boundary validation

Validate once where data crosses in; trust types inside; don't
re-validate deep in call chains. Here the boundaries are `input.ts`
(parsing into domain values) and `normalize.ts` (identifiers).

## Schema-derived types

Reach for `Pick` / `Omit` / `Parameters` / `ReturnType` / `Awaited` /
`typeof` before declaring a new interface:

```ts
// Don't: redeclare what the store already types.
type AddRelationFn = (input: AddRelationInput) => Promise<RelationEdge>;

// Do: derive it.
type AddRelationFn = RepoStore["addRelation"];
```

## Object args

Order-independent and self-documenting. All tool inputs already are
objects; new functions with 2+ params take an object. Skip on hot
paths (per-frame render, tokenizers, parsers, tight loops).

```ts
// Don't. Swap two args, still compiles.
openFile(uri, { startLineNumber: 10, startColumn: 1 });

// Do.
openFile({ uri, selection: { startLineNumber: 10, startColumn: 1 } });
```

## Real tests

Don't mock what you can run — §7 of the standards: real Neo4j via
testcontainers, real stdio build in e2e. Mock only what can't run
locally.

## Structured telemetry

Stdout is reserved for the MCP protocol (e2e asserts zero non-JSON
stdout lines), so diagnostics go to stderr. No `console.log` in
shipped code:

```ts
// src/index.ts — the template for failure diagnostics.
main().catch((error: unknown) => {
  console.error("repograph-mcp failed to start:", error);
  process.exit(1);
});
```
