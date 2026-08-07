/**
 * bwrap backend handle + manager (Architecture.md §5, §6, §7).
 *
 * Implements the OpenClaw `SandboxBackendHandle` contract. Every exec call is
 * wrapped in a fresh ephemeral bwrap invocation (no persistent sandbox).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type {
  CreateSandboxBackendParams,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendExecSpec,
  SandboxBackendFactory,
  SandboxBackendHandle,
  SandboxBackendManager,
} from "openclaw/plugin-sdk/sandbox";
import type { SandcastlePluginConfig, SandcastleAgentConfig } from "./config.js";
import { resolveSandcastleConfig } from "./config.js";
import { resolveBinds, isPathDenied, expandHome, DEFAULT_OS_MOUNTS } from "./bind-rules.js";
import { filterEnv } from "./env-filter.js";
import { buildBwrapArgv } from "./argv-builder.js";
import { resolveBwrapBinary } from "./downloader.js";
import { resolveGlobalModules } from "./node-modules.js";
import { createSandcastleFsBridge } from "./fs-bridge.js";
import { matchesDenyRule } from "./glob.js";
import type { MountFact } from "./bind-rules.js";

/** Fail fast: verify the sandbox can actually be created (userns etc.). */
async function probeSandbox(bwrapBin: string): Promise<void> {
  // Reuse the canonical default OS mounts (§4.5) — includes /lib64 when present.
  const probeMounts: MountFact[] = [...DEFAULT_OS_MOUNTS];
  if (existsSync("/lib64")) {
    probeMounts.push({ kind: "ro-bind", host: "/lib64", guest: "/lib64" });
  }
  const result = await runBwrap(bwrapBin, {
    bwrapBin,
    mounts: probeMounts,
    setenvEntries: [],
    env: {},
    chdir: "/",
    command: ["/bin/true"],
  });
  if (result.code !== 0) {
    throw new Error(
      `sandcastle: bwrap probe failed (exit ${result.code}): ${result.stderr.toString("utf8").trim()} — ` +
        `user namespaces are likely blocked (e.g. AppArmor). Failing fast per Architecture.md §6; ` +
        `never silently degrading to unsandboxed.`,
    );
  }
}

function runBwrap(
  bwrapBin: string,
  invocation: Parameters<typeof buildBwrapArgv>[0] & { env: Record<string, string> },
): Promise<SandboxBackendCommandResult> {
  const argv = buildBwrapArgv(invocation);
  return new Promise<SandboxBackendCommandResult>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...invocation.env },
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        code: code ?? 0,
      });
    });
  });
}

export function createBwrapSandboxBackendFactory(
  getPluginConfig: () => SandcastlePluginConfig,
): SandboxBackendFactory {
  return async (params: CreateSandboxBackendParams): Promise<SandboxBackendHandle> => {
    const pluginConfig = getPluginConfig();
    // Per-agent `sandbox.mapDir` / `sandbox.env` (Architecture.md §8).
    // Read defensively off the resolved sandbox config, merged over global
    // plugin config.
    const agentCfg: SandcastleAgentConfig = {
      mapDir: (params.cfg as unknown as { mapDir?: string[] }).mapDir,
      env: (params.cfg as unknown as { env?: Record<string, boolean | string> }).env,
    };
    const resolved = resolveSandcastleConfig(pluginConfig, agentCfg, {
      mode: params.cfg.mode,
      scope: params.cfg.scope,
      workspaceAccess: params.cfg.workspaceAccess,
      workspaceDir: params.workspaceDir,
    });

    const bwrapBin = await resolveBwrapBinary();
    await probeSandbox(bwrapBin);

    const denyRules = resolved.binds.filter((b) => b.prefix === "-");
    const { mounts: userMounts, denied } = resolveBinds(resolved.binds, resolved.workspaceDir, resolved.workspaceAccess);

    // Auto-mount global node modules under ~/ (docs/UserGuide.md "Auto-Mounted").
    const globalModules = resolveGlobalModules();
    const autoMounts: MountFact[] = [];
    let autoNodePath: string | null = null;
    if (globalModules && globalModules.shouldMount && existsSync(globalModules.path)) {
      // Deny rules can suppress the auto-mount (e.g. "-~/.npm-global/**").
      const suppressed = denyRules.some((d) => {
        return matchesDenyRule(expandHome(d.pattern), globalModules.path);
      });
      if (!suppressed) {
        autoMounts.push({ kind: "ro-bind", host: globalModules.path, guest: globalModules.path });
        if (globalModules.shouldSetNodePath) {
          autoNodePath = globalModules.path;
        }
      }
    }

    const mounts = [...userMounts, ...autoMounts];

    // Inject NODE_PATH into resolved env so it flows through filterEnv → --setenv.
    if (autoNodePath && !resolved.env.NODE_PATH) {
      resolved.env.NODE_PATH = autoNodePath;
    }

    return {
      id: "sandcastle",
      runtimeId: `sandcastle-${params.scopeKey}`,
      runtimeLabel: `Sandcastle (${params.scopeKey})`,
      workdir: params.workspaceDir,
      env: filterEnv(resolved.env).env,

      async buildExecSpec({ command, workdir, env, usePty }): Promise<SandboxBackendExecSpec> {
        const filtered = filterEnv(resolved.env, { ...process.env, ...env });
        const chdir = workdir ?? resolved.workspaceDir ?? "/";
        return {
          argv: buildBwrapArgv({
            bwrapBin,
            mounts,
            setenvEntries: filtered.setenvEntries,
            env: filtered.env,
            chdir,
            command: ["/bin/sh", "-c", command],
          }),
          env: filtered.env,
          stdinMode: usePty ? "pipe-open" : "pipe-closed",
        };
      },

      async runShellCommand(p: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult> {
        const filtered = filterEnv(resolved.env);
        return runBwrap(bwrapBin, {
          bwrapBin,
          mounts,
          setenvEntries: filtered.setenvEntries,
          env: filtered.env,
          chdir: resolved.workspaceDir ?? "/",
          command: p.args?.length ? [p.script, ...p.args] : ["/bin/sh", "-c", p.script],
        });
      },

      createFsBridge: ({ sandbox }) =>
        createSandcastleFsBridge({
          workspaceDir: sandbox.workspaceDir,
          workspaceAccess: resolved.workspaceAccess,
          denyRules,
          deniedPaths: denied,
        }),
    };
  };
}

export const bwrapSandboxBackendManager: SandboxBackendManager = {
  async describeRuntime() {
    return { running: true, configLabelMatch: true };
  },
  async removeRuntime() {
    // Ephemeral: nothing persistent to remove (§4.2).
  },
};

// Re-exported for tests / CLI "explain".
export { isPathDenied };
