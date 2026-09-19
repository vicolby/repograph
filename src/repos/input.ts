import { normalizeRepoIdentifier } from "./normalize.js";

// Shared input-preparation seam for repo-graph tools: raw MCP args go in,
// validated domain values come out. Tool modules keep their intent (which
// fields, which aliases); every trim/reject/throw rule lives here so the
// MCP error surface stays consistent as tools are added.
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
