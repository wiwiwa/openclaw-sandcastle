/**
 * File-tool enforcement bridge (Architecture.md §4.4).
 *
 * Non-exec file tools are NOT wrapped in bwrap — they run in the Gateway
 * process. This bridge enforces the same **default-deny** posture as bwrap:
 * only paths that correspond to an actual mount inside the sandbox are
 * accessible. Everything else → ENOENT ("file not exist"), matching what
 * the agent would see from inside the namespace.
 *
 * Enforcement layers:
 *   1. Denied paths (deny rules + tmpfs overlays) → ENOENT
 *   2. Allowed paths (mounted guests + workspace) → accessible
 *   3. Everything else → ENOENT (default-deny)
 *   4. Write gate: workspaceAccess ro → EACCES on workspace writes
 *
 * Paths map 1:1 to the host filesystem (bwrap mount namespaces share the
 * host fs — no docker-cp/remote indirection needed).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type {
  SandboxFsBridge,
  SandboxFsStat,
  SandboxResolvedPath,
} from "openclaw/plugin-sdk/sandbox";
import type { ParsedBind, WorkspaceAccess } from "./config.js";
import { isPathDenied } from "./bind-rules.js";

export class SandcastleFsError extends Error {
  code: string;
  constructor(code: "ENOENT" | "EACCES", message: string) {
    super(message);
    this.code = code;
    this.name = "SandcastleFsError";
  }
}

export interface SandcastleFsBridgeOptions {
  workspaceDir: string;
  workspaceAccess: WorkspaceAccess;
  denyRules: ParsedBind[];
  /** Guest paths shadowed by empty tmpfs overlays. */
  deniedPaths?: string[];
  /**
   * Allowed mount guest paths — the paths that exist inside the bwrap
   * namespace (default OS mounts, user binds, auto-mounts, /tmp, etc.).
   * File tools can only access paths under these roots (default-deny).
   */
  allowedPaths: string[];
}

export function createSandcastleFsBridge(opts: SandcastleFsBridgeOptions): SandboxFsBridge {
  const { workspaceDir, workspaceAccess, denyRules, deniedPaths = [], allowedPaths } = opts;

  function resolveAbsolute(filePath: string, cwd?: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    return path.resolve(cwd ?? workspaceDir, filePath);
  }

  /** Check whether a path is under (or equal to) an allowed mount root. */
  function isUnderAllowed(abs: string): boolean {
    return allowedPaths.some(
      (p) => abs === p || abs.startsWith(p.endsWith("/") ? p : p + "/"),
    );
  }

  /**
   * Policy gate (default-deny):
   *   1. Denied paths → ENOENT (anti-information-leak)
   *   2. Not under any allowed mount → ENOENT (same as inside bwrap)
   */
  function assertAllowed(p: { filePath: string; cwd?: string }): string {
    const abs = resolveAbsolute(p.filePath, p.cwd);
    // 1. Deny rules and tmpfs overlays.
    if (isPathDenied(denyRules, abs)) {
      throw new SandcastleFsError("ENOENT", `file not exist: ${abs}`);
    }
    if (deniedPaths.some((d) => abs === d || abs.startsWith(d.endsWith("/") ? d : d + "/"))) {
      throw new SandcastleFsError("ENOENT", `file not exist: ${abs}`);
    }
    // 2. Default-deny: must be under an allowed mount or the workspace.
    if (!isUnderAllowed(abs)) {
      throw new SandcastleFsError("ENOENT", `file not exist: ${abs}`);
    }
    return abs;
  }

  /** Write gate: only rw workspace is writable. */
  function assertWritable(abs: string): void {
    if (workspaceAccess !== "rw") {
      const inWorkspace = abs === workspaceDir || abs.startsWith(workspaceDir + path.sep);
      if (inWorkspace) {
        throw new SandcastleFsError("EACCES", `permission denied: ${abs}`);
      }
    }
    // Non-workspace paths are never writable through file tools, even if
    // mounted rw inside bwrap (file tools run in Gateway, not the sandbox).
    if (!inWorkspaceCheck(abs)) {
      throw new SandcastleFsError("EACCES", `permission denied: ${abs}`);
    }
  }

  function inWorkspaceCheck(abs: string): boolean {
    return abs === workspaceDir || abs.startsWith(workspaceDir + path.sep);
  }

  return {
    resolvePath(p: { filePath: string; cwd?: string }): SandboxResolvedPath {
      const abs = resolveAbsolute(p.filePath, p.cwd);
      const rel = path.relative(workspaceDir, abs);
      return { hostPath: abs, relativePath: rel, containerPath: abs };
    },

    async readFile(p: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<Buffer> {
      const abs = assertAllowed(p);
      return fs.readFile(abs, { signal: p.signal });
    },

    async writeFile(p: {
      filePath: string;
      cwd?: string;
      data: Buffer | string;
      encoding?: BufferEncoding;
      mkdir?: boolean;
      signal?: AbortSignal;
    }): Promise<void> {
      const abs = assertAllowed(p);
      assertWritable(abs);
      if (p.mkdir) {
        await fs.mkdir(path.dirname(abs), { recursive: true });
      }
      await fs.writeFile(abs, p.data, { encoding: p.encoding, signal: p.signal });
    },

    async mkdirp(p: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<void> {
      const abs = assertAllowed(p);
      assertWritable(abs);
      await fs.mkdir(abs, { recursive: true });
    },

    async remove(p: {
      filePath: string;
      cwd?: string;
      recursive?: boolean;
      force?: boolean;
      signal?: AbortSignal;
    }): Promise<void> {
      const abs = assertAllowed(p);
      assertWritable(abs);
      await fs.rm(abs, { recursive: p.recursive ?? false, force: p.force ?? false });
    },

    async rename(p: { from: string; to: string; cwd?: string; signal?: AbortSignal }): Promise<void> {
      const absFrom = assertAllowed({ filePath: p.from, cwd: p.cwd });
      const absTo = assertAllowed({ filePath: p.to, cwd: p.cwd });
      assertWritable(absTo);
      await fs.rename(absFrom, absTo);
    },

    async stat(p: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<SandboxFsStat | null> {
      let abs: string;
      try {
        abs = assertAllowed(p);
      } catch {
        return null; // denied/non-existent paths stat as absent
      }
      try {
        const s = await fs.stat(abs);
        return {
          type: s.isDirectory() ? "directory" : s.isFile() ? "file" : "other",
          size: s.size,
          mtimeMs: s.mtimeMs,
        };
      } catch {
        return null;
      }
    },
  };
}
