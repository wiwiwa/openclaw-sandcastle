/**
 * Environment filter (Architecture.md §4.3, ADR-005).
 *
 * Deny-by-default: only variables listed in the env schema reach the sandbox.
 *   true   → pass through the host value
 *   false  → explicit strip (same as unlisted)
 *   string → literal override inside the sandbox
 *
 * The authoritative mechanism is `bwrap --clearenv` + allowlisted `--setenv`
 * at the namespace level; this module produces the final env map and the
 * ordered argv entries for it.
 */

import type { EnvEntry } from "./config.js";

export interface FilteredEnv {
  /** Final env map (sandbox view). */
  env: Record<string, string>;
  /** Ordered `--setenv NAME value` argv entries (after --clearenv). */
  setenvEntries: string[];
}

/**
 * Filter host env through the schema. `hostEnv` is injectable for tests
 * (defaults to process.env).
 */
export function filterEnv(
  schema: Record<string, EnvEntry>,
  hostEnv: NodeJS.ProcessEnv = process.env,
): FilteredEnv {
  const env: Record<string, string> = {};
  const setenvEntries: string[] = [];

  for (const [name, entry] of Object.entries(schema)) {
    if (entry === false) continue;
    let value: string | undefined;
    if (entry === true) {
      value = hostEnv[name];
      if (value === undefined) continue;
    } else {
      value = entry;
    }
    env[name] = value;
    setenvEntries.push("--setenv", name, value);
  }

  return { env, setenvEntries };
}
