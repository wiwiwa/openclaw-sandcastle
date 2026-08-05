/**
 * Bind-rule engine (Architecture.md §5, ADR-003, §4.1, §4.5).
 *
 * Resolves merged bind rules into an ordered list of bwrap mount facts:
 *   - default OS mounts (fixed, not removable)          §4.5
 *   - user binds (allow), with deny-wins filtering      ADR-003
 *   - deny overlays (empty tmpfs over denied dirs)      defense-in-depth
 *
 * Hard config errors throw: deny overlapping a default mount, or mounting
 * a restricted path (~/ itself, /home, /) without the `+` prefix.
 */

import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import type { ParsedBind, WorkspaceAccess } from "./config.js";
import { matchesDenyRule } from "./glob.js";

export type MountKind = "ro-bind" | "bind" | "dev" | "proc" | "tmpfs";

export interface MountFact {
  kind: MountKind;
  /** Host path (absent for dev/proc/tmpfs). */
  host?: string;
  /** Guest (sandbox) path. */
  guest: string;
}

export interface BindResolution {
  mounts: MountFact[];
  /** Guest paths shadowed by an empty tmpfs (deny overlays). */
  denied: string[];
}

/** Default OS mounts, fixed and not removable (§4.5). */
export const DEFAULT_OS_MOUNTS: MountFact[] = [
  { kind: "ro-bind", host: "/usr", guest: "/usr" },
  { kind: "ro-bind", host: "/lib", guest: "/lib" },
  { kind: "ro-bind", host: "/bin", guest: "/bin" },
  { kind: "ro-bind", host: "/sbin", guest: "/sbin" },
  { kind: "dev", guest: "/dev" },
  { kind: "proc", guest: "/proc" },
  { kind: "tmpfs", guest: "/tmp" },
];

export const DEFAULT_OS_MOUNT_GUESTS = new Set([
  "/usr",
  "/lib",
  "/lib64",
  "/bin",
  "/sbin",
  "/dev",
  "/proc",
  "/tmp",
]);

/** Expand a leading `~` or `~/` to the home directory. */
export function expandHome(pattern: string, home: string = os.homedir()): string {
  if (pattern === "~") return home;
  if (pattern.startsWith("~/")) return path.join(home, pattern.slice(2));
  return pattern;
}

/** Restricted paths that require the `+` force-allow prefix (§4.1). */
export function isRestrictedPath(p: string, home: string): boolean {
  return p === "/" || p === "/home" || p === home || p === path.dirname(home);
}

/**
 * Resolve merged binds + workspace access into mount facts.
 *
 * @param binds       merged ParsedBind[] (global + per-agent)
 * @param workspaceDir host workspace path (mounted per workspaceAccess)
 * @param workspaceAccess none | ro | rw
 * @param opts        { home, lib64Exists, existsFn } injectable for tests
 */
export function resolveBinds(
  binds: ParsedBind[],
  workspaceDir: string,
  workspaceAccess: WorkspaceAccess,
  opts: { home?: string; lib64Exists?: boolean } = {},
): BindResolution {
  const home = opts.home ?? os.homedir();
  const lib64Exists = opts.lib64Exists ?? (() => {
    try {
      return existsSync("/lib64");
    } catch {
      return false;
    }
  })();

  const mounts: MountFact[] = [...DEFAULT_OS_MOUNTS];
  if (lib64Exists) {
    mounts.push({ kind: "ro-bind", host: "/lib64", guest: "/lib64" });
  }

  const allowRules: ParsedBind[] = [];
  const denyRules: ParsedBind[] = [];

  for (const rule of binds) {
    if (rule.prefix === "-") denyRules.push(rule);
    else allowRules.push(rule);
  }

  // Deny overlapping a default mount is a hard config error (§6 note).
  for (const rule of denyRules) {
    const p = expandHome(rule.pattern, home);
    if (DEFAULT_OS_MOUNT_GUESTS.has(p)) {
      throw new Error(`sandcastle: deny rule "-${rule.pattern}" overlaps a default OS mount (${p})`);
    }
  }

  // Allow rules → mounts, deny-wins filtering.
  const userMounts: MountFact[] = [];
  for (const rule of allowRules) {
    if (rule.pattern.includes("*") || rule.pattern.includes("?")) {
      throw new Error(
        `sandcastle: allow bind "${rule.pattern}" uses a glob pattern; ` +
          `allow binds must be concrete paths in v1 (globs are supported for deny rules)`,
      );
    }
    const host = expandHome(rule.pattern, home);
    if (!path.isAbsolute(host)) {
      throw new Error(`sandcastle: bind path "${rule.pattern}" must be absolute`);
    }
    if (isRestrictedPath(host, home) && rule.prefix !== "+") {
      throw new Error(
        `sandcastle: "${rule.pattern}" is a restricted path (home or parent); ` +
          `prefix with "+" to force-allow (Architecture.md §4.1)`,
      );
    }
    // Deny wins: skip if this path (or an ancestor) is denied.
    if (denyRules.some((d) => matchesDenyRule(expandHome(d.pattern, home), host))) {
      continue;
    }
    userMounts.push({ kind: rule.mode === "rw" ? "bind" : "ro-bind", host, guest: host });
  }

  // Workspace mount (host path == guest path, no translation).
  if (workspaceAccess !== "none" && workspaceDir) {
    const kind = workspaceAccess === "rw" ? "bind" : "ro-bind";
    if (!userMounts.some((m) => m.guest === workspaceDir)) {
      userMounts.push({ kind, host: workspaceDir, guest: workspaceDir });
    }
  }

  mounts.push(...userMounts);

  // Deny overlays: concrete-dir deny rules falling under a mounted guest path
  // get an empty tmpfs shadow so their contents are unreadable inside exec.
  const mountedGuests = new Set(mounts.map((m) => m.guest));
  const denied: string[] = [];
  for (const rule of denyRules) {
    let p = expandHome(rule.pattern, home);
    // A trailing `/**` denies the base dir itself (e.g. `-~/.ssh/**` shadows
    // `~/.ssh` with an empty tmpfs overlay).
    if (p.endsWith("/**")) p = p.slice(0, -3);
    if (p.includes("*") || p.includes("?")) continue; // glob denies enforced at fs-bridge level
    const underMounted = [...mountedGuests].some(
      (g) => g !== "/" && (p === g || p.startsWith(g.endsWith("/") ? g : g + "/")),
    );
    if (underMounted && !DEFAULT_OS_MOUNT_GUESTS.has(p)) {
      mounts.push({ kind: "tmpfs", guest: p });
      denied.push(p);
    }
  }

  return { mounts, denied };
}

/** Whether a host path is denied by the given deny rules (fs-bridge uses this). */
export function isPathDenied(denyRules: ParsedBind[], hostPath: string, home: string = os.homedir()): boolean {
  return denyRules.some((d) => matchesDenyRule(expandHome(d.pattern, home), hostPath));
}
