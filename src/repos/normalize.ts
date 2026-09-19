export type NormalizedRepo = {
  /** Normalized GitLab full path, e.g. `group/subgroup/project`. Unique key of the Repo node. */
  path: string;
  /** Canonical HTTPS URL, e.g. `https://gitlab.com/group/subgroup/project`. */
  canonicalUrl: string;
  /** True when the input was a git remote URL (SSH or HTTPS), false for a plain path. */
  wasUrl: boolean;
  /** Lowercased hostname the URL was derived from (or the default host for plain paths). */
  host: string;
};

const DEFAULT_HOST = "gitlab.com";

/** Strips a single trailing `.git` suffix (case-insensitive). */
function stripGitSuffix(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -".git".length) : value;
}

function cleanPath(rawPath: string): string {
  const withoutGit = stripGitSuffix(rawPath.trim());
  const segments = withoutGit
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  return segments.map((segment) => decodeURIComponent(segment)).join("/");
}

function isValidPath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false;
  if (/[\s\\?#@]/.test(path)) return false;
  return /^[A-Za-z0-9_.\-/]+$/.test(path);
}

/**
 * Normalizes a repository identifier to the node's unique key.
 *
 * Accepts:
 * - scp-like SSH URLs: `git@gitlab.com:group/sub/project.git`
 * - URL forms: `https://gitlab.com/group/sub/project(.git)`, `ssh://...`, `git://...`, `http://...`
 * - plain GitLab full paths: `group/sub/project`
 *
 * SSH and HTTPS forms for the same repo resolve to the same `path`.
 */
export function normalizeRepoIdentifier(input: string, defaultHost: string = DEFAULT_HOST): NormalizedRepo {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("repo identifier must be a non-empty string");
  }

  // scp-like SSH syntax: [user@]host:path — must be checked before the
  // plain-path fallback (it contains a colon, which paths never do).
  const scpMatch = /^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/.exec(trimmed);
  if (scpMatch?.[1] && scpMatch[2] !== undefined && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    const host = scpMatch[1].toLowerCase();
    const path = cleanPath(scpMatch[2].replace(/^\/+/, ""));
    if (!isValidPath(path)) {
      throw new Error(`invalid repository identifier: ${JSON.stringify(input)}`);
    }
    return { path, canonicalUrl: `https://${host}/${path}`, wasUrl: true, host };
  }

  // URL forms: https://, http://, ssh://, git:// (also handles SSH URLs
  // given in ssh:// form, and strips credentials/ports/fragments).
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`invalid repository identifier: ${JSON.stringify(input)}`);
    }
    const host = parsed.hostname.toLowerCase();
    if (host.length === 0) {
      throw new Error(`invalid repository identifier: ${JSON.stringify(input)}`);
    }
    const path = cleanPath(parsed.pathname);
    if (!isValidPath(path)) {
      throw new Error(`invalid repository identifier: ${JSON.stringify(input)}`);
    }
    return { path, canonicalUrl: `https://${host}/${path}`, wasUrl: true, host };
  }

  // Plain GitLab full path.
  const path = cleanPath(trimmed);
  if (trimmed.includes(":") || !isValidPath(path)) {
    throw new Error(`invalid repository identifier: ${JSON.stringify(input)}`);
  }
  const host = defaultHost.toLowerCase();
  return { path, canonicalUrl: `https://${host}/${path}`, wasUrl: false, host };
}
