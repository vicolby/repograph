import { normalizeRepoIdentifier } from "./normalize.js";

// Internal to the src/repos/ module (see store.ts): do not import from outside src/repos/.

// Shared input-preparation seam for repo-graph tools: raw MCP args go in,
// validated domain values come out. All trim/reject/throw rules live here;
// the MCP zod schemas in `src/mcp/server.ts` are thin transport types only
// (field names and scalar shapes, no min/max/int/range constraints), so both
// MCP calls and direct store calls fail the same way through this seam.
//
// `tool` is the calling tool's name (e.g. "add_relation"). It prefixes every
// error message, so an agent seeing the error knows which call failed.

/** Trims a required string field; throws when missing, non-string, or blank. */
export function requiredText(value: unknown, tool: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${tool} field ${JSON.stringify(field)} must be a non-empty string`);
  }
  return value.trim();
}

/** Trims an optional string field; null/undefined stay null, blank throws. */
export function optionalText(
  value: string | null | undefined,
  tool: string,
  field: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${tool} field ${JSON.stringify(field)} must be a non-empty string when provided`);
  }
  return value.trim();
}

/** Validates a required list of non-empty strings (e.g. relation evidence). */
export function requiredTextList(value: unknown, tool: string, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${tool} field ${JSON.stringify(field)} must be a non-empty array of strings`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(
        `${tool} field ${JSON.stringify(field)} entry at index ${index} must be a non-empty string`,
      );
    }
    return entry.trim();
  });
}

/**
 * Resolves a repository identifier (SSH/HTTPS URL or normalized path) to
 * the node's unique `path` key, same normalization as `add_repo`.
 */
export function resolveRepoPath(raw: unknown, tool: string, field: string): string {
  return normalizeRepoIdentifier(requiredText(raw, tool, field)).path;
}

/** Validates an optional integer field; returns `defaultValue` when omitted. */
export function optionalIntInRange(
  value: number | undefined,
  tool: string,
  field: string,
  min: number,
  max: number,
  defaultValue: number,
): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `${tool} field ${JSON.stringify(field)} must be an integer between ${min} and ${max} when provided`,
    );
  }
  return value;
}

/** Validates an optional boolean field; returns `defaultValue` when omitted. */
export function optionalBoolean(
  value: boolean | undefined,
  tool: string,
  field: string,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") {
    throw new Error(`${tool} field ${JSON.stringify(field)} must be a boolean when provided`);
  }
  return value;
}

/** Edge-read direction for `get_relations`: which side of `repo` to match. */
export type RelationDirection = "out" | "in" | "both";

/**
 * Validates an optional edge-read direction; returns `"both"` when omitted.
 * Anything outside `out`/`in`/`both` (including non-strings) throws.
 */
export function optionalRelationDirection(
  value: unknown,
  tool: string,
  field: string,
): RelationDirection {
  if (value === undefined) return "both";
  if (value !== "out" && value !== "in" && value !== "both") {
    throw new Error(
      `${tool} field ${JSON.stringify(field)} must be one of "out", "in", or "both" when provided`,
    );
  }
  return value;
}

/**
 * Validates an optional per-side file-scope hint list (`from_paths`/`to_paths`).
 *
 * Returns `undefined` when omitted (caller preserves the stored side);
 * otherwise returns the trimmed list (explicit `[]` clears that side).
 * Entries are repo-root-relative POSIX paths with optional `*`/`**`/`?`
 * globs; leading `/` and any `..` segment are rejected. At most 50 entries
 * per call, at most 500 chars per entry. Exact-string duplicates within one
 * call are dropped, preserving first-seen order.
 */
export function optionalPathHintList(
  value: string[] | undefined,
  tool: string,
  field: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${tool} field ${JSON.stringify(field)} must be an array of strings when provided`);
  }
  if (value.length > 50) {
    throw new Error(`${tool} field ${JSON.stringify(field)} must be an array of at most 50 entries`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index];
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(
        `${tool} field ${JSON.stringify(field)} entry at index ${index} must be a non-empty string`,
      );
    }
    const trimmed = entry.trim();
    if (trimmed.length > 500) {
      throw new Error(
        `${tool} field ${JSON.stringify(field)} entry at index ${index} must be at most 500 characters`,
      );
    }
    if (trimmed.startsWith("/")) {
      throw new Error(
        `${tool} field ${JSON.stringify(field)} entry at index ${index} must be a repo-root-relative path (no leading "/")`,
      );
    }
    if (trimmed.split("/").includes("..")) {
      throw new Error(
        `${tool} field ${JSON.stringify(field)} entry at index ${index} must be a repo-root-relative path without ".." segments`,
      );
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}
