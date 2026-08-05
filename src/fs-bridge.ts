/**
 * File-tool enforcement bridge (Architecture.md §4.4).
 *
 * Non-exec file tools are NOT wrapped in bwrap — they run in the Gateway
 * process. This bridge enforces the same deny/access policy at the path
 * level:
 *   - denied paths      → "file not exist" (ENOENT), never "permission denied"
 *   - workspaceAccess none → workspace paths → ENOENT
 *   - workspaceAccess ro   → writes → EACCES ("permission denied")
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
}

export function createSandcastleFsBridge(opts: SandcastleFsBridgeOptions): SandboxFsBridge {
  const { workspaceDir, workspaceAccess, denyRules, deniedPaths = [] } = opts;

  function resolveAbsolute(filePath: string, cwd?: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    return path.resolve(cwd ?? workspaceDir, filePath);
  }

  /** Policy gate: throw ENOENT for denied paths (anti-information-leak). */
  function assertAllowed(p: { filePath: string; cwd?: string }): string {
    const abs = resolveAbsolute(p.filePath, p.cwd);
    if (isPathDenied(denyRules, abs)) {
      throw new SandcastleFsError("ENOENT", `file not exist: ${abs}`);
    }
    if (deniedPaths.some((d) => abs === d || abs.startsWith(d.endsWith("/") ? d : d + "/"))) {
      throw new SandcastleFsError("ENOENT", `file not exist: ${abs}`);
    }
    if (workspaceAccess === "none" && (abs === workspaceDir || abs.startsWith(workspaceDir + path.sep))) {
      throw new SandcastleFsError("ENOENT", `file not exist: ${abs}`);
    }
    return abs;
  }

  /** Write gate: ro workspace → EACCES. */
  function assertWritable(abs: string): void {
    if (workspaceAccess !== "rw") {
      const inWorkspace = abs === workspaceDir || abs.startsWith(workspaceDir + path.sep);
      if (inWorkspace) {
        throw new SandcastleFsError("EACCES", `permission denied: ${abs}`);
      }
    }
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
        return null; // denied paths stat as absent
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
