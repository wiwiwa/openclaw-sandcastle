/**
 * Global Node modules resolution (docs/UserGuide.md "Auto-Mounted: Global Node Modules").
 *
 * Resolves the global node_modules path using Node.js APIs (no `npm root -g`
 * shell-out). If the path is under the user's home directory, Sandcastle
 * auto-mounts it read-only and sets NODE_PATH so Node.js can resolve global
 * modules at runtime inside the sandbox.
 *
 * Cases:
 *   - Path under ~/         → return { path, shouldMount: true,  shouldSetNodePath: true }
 *   - Path under /usr/...   → return { path, shouldMount: false, shouldSetNodePath: false }
 *   - Cannot resolve        → return null
 */

import os from "node:os";
import path from "node:path";

export interface GlobalModulesResult {
  /** Absolute path to the global node_modules directory. */
  path: string;
  /** True when the path lives under the user's home → needs an explicit mount. */
  shouldMount: boolean;
  /** True when NODE_PATH should be injected into the sandbox env. */
  shouldSetNodePath: boolean;
}

/**
 * Resolve the global node_modules directory.
 *
 * Strategy (no shell-out):
 *   1. Check `require.resolve("openclaw/package.json")` as a known globally
 *      installed package and walk up to its containing node_modules.
 *   2. Fall back to common prefix locations:
 *      - NODE_PATH env (if set and absolute)
 *      - ~/.npm-global/lib/node_modules
 *      - ~/.nvm/versions/node/<ver>/lib/node_modules
 *      - ~/.volta/tools/image/packages
 *      - /usr/lib/node_modules, /usr/local/lib/node_modules
 *
 * @param opts injectable for tests
 */
export function resolveGlobalModules(
  opts: {
    home?: string;
    nodePath?: string;
    nodeVersion?: string;
    /** Injectable resolver; defaults to the real require.resolve attempt. */
    tryResolveOpenclaw?: () => string | null;
  } = {},
): GlobalModulesResult | null {
  const home = opts.home ?? os.homedir();
  const nodePath = opts.nodePath ?? process.env.NODE_PATH;

  // 1. Try to resolve a known global package (openclaw itself).
  const tryResolve = opts.tryResolveOpenclaw ?? defaultTryResolveOpenclaw;
  const resolved = tryResolve();
  if (resolved) {
    const nmDir = findContainingNodeModules(resolved);
    if (nmDir) {
      return classify(nmDir, home);
    }
  }

  // 2. NODE_PATH env (if explicitly set, it's user intent).
  if (nodePath && path.isAbsolute(nodePath)) {
    return classify(nodePath, home);
  }

  // 3. Common home-prefix locations.
  const candidates = buildHomeCandidates(home, opts.nodeVersion);
  for (const c of candidates) {
    // We can't check existence without fs (keep this pure for testability);
    // the caller (bwrap-backend) verifies existence before mounting.
    return classify(c, home);
  }

  // 4. System locations — already covered by default OS mounts.
  return null;
}

/**
 * Walk up from a resolved file path to find the containing node_modules dir.
 */
function findContainingNodeModules(filePath: string): string | null {
  const idx = filePath.lastIndexOf("/node_modules/");
  if (idx === -1) return null;
  return filePath.slice(0, idx + "/node_modules".length);
}

/**
 * Classify a resolved path: under ~/ → mount + NODE_PATH; under /usr → neither.
 */
function classify(nmPath: string, home: string): GlobalModulesResult {
  const underHome = nmPath === home || nmPath.startsWith(home + "/");
  if (underHome) {
    return { path: nmPath, shouldMount: true, shouldSetNodePath: true };
  }
  // System paths like /usr/lib/node_modules are already in default mounts.
  return { path: nmPath, shouldMount: false, shouldSetNodePath: false };
}

function buildHomeCandidates(home: string, nodeVersion?: string): string[] {
  const ver = nodeVersion ?? process.version;
  return [
    path.join(home, ".npm-global", "lib", "node_modules"),
    path.join(home, ".nvm", "versions", "node", ver, "lib", "node_modules"),
    // Volta: ~/.volta/tools/image/node/<ver>/lib/node_modules
    path.join(home, ".volta", "tools", "image", "node", ver, "lib", "node_modules"),
    path.join(home, ".pnpm", "global"),
  ];
}

/**
 * Default implementation: try to resolve openclaw/package.json.
 * Wrapped in try/catch since the package may not be resolvable in all contexts.
 */
function defaultTryResolveOpenclaw(): string | null {
  try {
    // Dynamic require to avoid hard dependency at build time.
    return require.resolve("openclaw/package.json");
  } catch {
    return null;
  }
}
