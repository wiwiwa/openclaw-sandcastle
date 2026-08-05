/**
 * Canonical bwrap invocation builder (Architecture.md §6).
 *
 * Order matters:
 *   1. namespace unshares + --die-with-parent
 *   2. default OS mounts (§4.5), /lib64 only when present on host
 *   3. user binds (allow), already deny-filtered by the bind-rule engine
 *   4. --clearenv THEN --setenv entries (deny-by-default env, §4.3)
 *   5. --chdir workspace, then the command
 *
 * NOTE (dev pushback): §6 of Architecture.md lists `--setenv` before
 * `--clearenv`. bwrap applies options in order, so `--clearenv` placed after
 * `--setenv` would wipe the allowlisted vars. Correct order is clearenv first.
 */

import type { MountFact } from "./bind-rules.js";

export interface BwrapInvocation {
  bwrapBin: string;
  argv: string[];
  /** Env for the spawned bwrap process itself (host side). */
  env: Record<string, string>;
}

export interface BwrapInvocationParams {
  bwrapBin: string;
  mounts: MountFact[];
  /** Ordered --setenv entries, e.g. ["--setenv","PATH","/usr/bin",...]. */
  setenvEntries: string[];
  /** Final env map (host-side spawn env; sandbox env comes from setenv). */
  env: Record<string, string>;
  chdir: string;
  command: string[];
}

export function buildBwrapArgv(params: BwrapInvocationParams): string[] {
  const argv: string[] = [
    params.bwrapBin,
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    "--unshare-user",
    "--die-with-parent",
  ];

  for (const m of params.mounts) {
    switch (m.kind) {
      case "ro-bind":
        argv.push("--ro-bind", m.host!, m.guest);
        break;
      case "bind":
        argv.push("--bind", m.host!, m.guest);
        break;
      case "dev":
        argv.push("--dev", m.guest);
        break;
      case "proc":
        argv.push("--proc", m.guest);
        break;
      case "tmpfs":
        argv.push("--tmpfs", m.guest);
        break;
    }
  }

  argv.push("--clearenv");
  argv.push(...params.setenvEntries);
  argv.push("--chdir", params.chdir);
  argv.push("--", ...params.command);

  return argv;
}
