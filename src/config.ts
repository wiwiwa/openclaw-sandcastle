/**
 * Sandcastle plugin configuration types + resolution.
 *
 * Follows Architecture.md §4.3, §8. Config lives under the agent sandbox
 * config (`sandbox.bwrap.*` per-agent) merged over global plugin config.
 */

export type SandboxMode = "off" | "non-main" | "all";
export type SandboxScope = "agent" | "session" | "shared";
export type WorkspaceAccess = "none" | "ro" | "rw";
export type BindMode = "ro" | "rw";
export type BindPrefix = "" | "+" | "-";

/** One parsed bind rule: `[prefix]<glob>[:mode]`. */
export interface ParsedBind {
  prefix: BindPrefix;
  pattern: string; // as written (may contain ~ and globs)
  mode: BindMode;
}

/** Env schema entry: true = pass host value, false = strip, string = literal. */
export type EnvEntry = boolean | string;

export interface SandcastleBwrapConfig {
  binds?: string[];
  env?: Record<string, EnvEntry>;
}

/** Plugin-level config (global defaults). */
export interface SandcastlePluginConfig {
  backend?: "bwrap";
  mode?: SandboxMode;
  scope?: SandboxScope;
  workspaceAccess?: WorkspaceAccess;
  bwrap?: SandcastleBwrapConfig;
}

/** Fully resolved sandbox config for one backend session. */
export interface ResolvedSandcastleConfig {
  backend: "bwrap";
  mode: SandboxMode;
  scope: SandboxScope;
  workspaceAccess: WorkspaceAccess;
  workspaceDir: string;
  binds: ParsedBind[]; // merged global + per-agent, in order
  env: Record<string, EnvEntry>; // merged env schema
}

export const DEFAULT_ENV: Record<string, EnvEntry> = {
  PATH: true,
  HOME: true,
  USER: true,
  LANG: true,
  LC_ALL: true,
};

export const DEFAULT_WORKSPACE_ACCESS: WorkspaceAccess = "none";

const SCOPE_WHITELIST: SandboxScope[] = ["agent", "session"];

/**
 * Merge global plugin config + per-agent `sandbox.bwrap` overrides.
 *
 * - binds: concatenated (global first). Deny rules from either apply across both.
 * - env: per-agent wins per key over global.
 * - mode/scope/workspaceAccess: per-agent (from sandbox config) wins.
 *
 * Architecture.md §8: `scope: "shared"` implies a persistent namespace which
 * conflicts with the ephemeral-per-exec lifecycle; v1 ships agent+session only.
 */
export function resolveSandcastleConfig(
  pluginConfig: SandcastlePluginConfig,
  agentBwrap: SandcastleBwrapConfig | undefined,
  sandboxCfg: { mode?: SandboxMode; scope?: SandboxScope; workspaceAccess?: WorkspaceAccess; workspaceDir: string },
): ResolvedSandcastleConfig {
  const global = pluginConfig ?? {};
  const agent = agentBwrap ?? {};

  const binds = [...(global.bwrap?.binds ?? []), ...(agent.binds ?? [])].map(parseBindRule);

  const env: Record<string, EnvEntry> = { ...DEFAULT_ENV, ...(global.bwrap?.env ?? {}) };
  for (const [k, v] of Object.entries(agent.env ?? {})) {
    env[k] = v;
  }

  const scope = sandboxCfg.scope ?? global.scope ?? "agent";
  if (!SCOPE_WHITELIST.includes(scope)) {
    throw new Error(
      `sandcastle: scope "${scope}" is not supported in v1 (ephemeral lifecycle). ` +
        `Use "agent" or "session". Architecture.md §8.`,
    );
  }

  return {
    backend: "bwrap",
    mode: sandboxCfg.mode ?? global.mode ?? "off",
    scope,
    workspaceAccess: sandboxCfg.workspaceAccess ?? global.workspaceAccess ?? DEFAULT_WORKSPACE_ACCESS,
    workspaceDir: sandboxCfg.workspaceDir,
    binds,
    env,
  };
}

/** Parse `[prefix]<pattern>[:mode]`. Mode defaults to ro. */
export function parseBindRule(raw: string): ParsedBind {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`sandcastle: invalid bind rule "${String(raw)}"`);
  }
  let rest = raw.trim();
  let prefix: BindPrefix = "";
  if (rest.startsWith("+") || rest.startsWith("-")) {
    prefix = rest[0] as BindPrefix;
    rest = rest.slice(1);
  }
  let mode: BindMode = "ro";
  const modeMatch = rest.match(/:(ro|rw)$/);
  if (modeMatch) {
    mode = modeMatch[1] as BindMode;
    rest = rest.slice(0, rest.length - modeMatch[0].length);
  }
  if (rest === "") {
    throw new Error(`sandcastle: bind rule "${raw}" has no path pattern`);
  }
  return { prefix, pattern: rest, mode };
}
