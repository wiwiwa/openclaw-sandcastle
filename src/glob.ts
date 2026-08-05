/**
 * Glob matching for bind rules (README "Bind Rules" / Architecture.md §5).
 *
 * Supported:
 *   *  — matches any non-hidden segment (no "/", does not start with ".")
 *   ** — matches recursively, including hidden segments and "/"
 *   ?  — matches a single character
 *
 * Everything else is matched literally (case-sensitive).
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function convertSegment(seg: string): string {
  let out = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") {
      if (seg[i + 1] === "*") {
        // Inline `**` inside a segment behaves like `*` (a `**` that spans
        // path separators must be its own segment).
        out += "[^/]*";
        i++;
      } else {
        // non-hidden segment: no slash, and must not start with '.'
        out += "(?![.])[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += escapeRegExp(c);
    }
  }
  return out;
}

/**
 * Convert a glob pattern to an anchored RegExp.
 *
 * Segment-aware so a double-star can span separators:
 *   - a double-star as its own segment matches zero or more whole segments
 *   - a leading double-star run matches zero or more leading segments (so
 *     double-star slash-dot-env matches a dot-env file at any depth, incl. root)
 */
export function globToRegExp(pattern: string): RegExp {
  const segments = pattern.split("/");
  const parts: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    if (seg === "**") {
      const isLast = i === segments.length - 1;
      if (isLast) {
        // Trailing `**`: match the remaining path (may be empty).
        parts.push(".*");
      } else {
        // `**` mid-pattern: zero or more whole segments. Mark it so the
        // following separator becomes optional.
        parts.push("__GLOBSTAR__");
      }
      continue;
    }
    parts.push(convertSegment(seg));
  }

  const joined = parts.join("/");
  // `__GLOBSTAR__/` → `(?:.*/)?` : zero or more segments, separator optional.
  const withGlobstar = joined.replace(/__GLOBSTAR__\//g, "(?:.*/)?");
  // A lone leading `**` (e.g. `**/.env`) must also allow the root form,
  // which the `(?:.*/)?` above already handles (zero segments).
  return new RegExp("^" + withGlobstar + "$");
}

/** Direct glob match of a path against a pattern. */
export function matchesGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

/**
 * Match a path against a *deny* rule: matches if the path itself matches the
 * glob, or any ancestor directory matches (denying a directory denies its
 * contents). A trailing `/**` also denies the directory itself.
 */
export function matchesDenyRule(pattern: string, path: string): boolean {
  if (pattern.endsWith("/**")) {
    const dirPattern = pattern.slice(0, -3);
    if (matchesGlob(dirPattern, path)) return true;
  }
  if (matchesGlob(pattern, path)) {
    return true;
  }
  let cur = path;
  for (;;) {
    const idx = cur.lastIndexOf("/");
    if (idx <= 0) break;
    cur = cur.slice(0, idx);
    if (matchesGlob(pattern, cur)) return true;
  }
  return false;
}
