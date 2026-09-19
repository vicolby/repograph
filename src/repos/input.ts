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
