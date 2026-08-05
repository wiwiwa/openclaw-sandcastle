import { describe, expect, it, vi, beforeEach } from "vitest";
import { createBwrapSandboxBackendFactory } from "./bwrap-backend.js";
import { parseBindRule } from "./config.js";
import { resolveBinds, DEFAULT_OS_MOUNTS } from "./bind-rules.js";
import { filterEnv } from "./env-filter.js";

// Mock the downloader so the factory never hits the network/filesystem.
vi.mock("./downloader.js", () => ({
  resolveBwrapBinary: vi.fn().mockResolvedValue("/usr/bin/bwrap"),
}));

// Mock spawn so no real bwrap process is launched during unit tests.
const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => {
    const custom = mockSpawn(...args);
    if (custom) return custom;
    // default success child (closes with code 0)
    const stdout = { on: vi.fn() };
    const stderr = { on: vi.fn() };
    const child = {
      stdout,
      stderr,
      on: (ev: string, cb: (code?: number) => void) => {
        if (ev === "close") queueMicrotask(() => cb(0));
        return child;
      },
    };
    return child;
  },
}));

beforeEach(() => {
  mockSpawn.mockClear();
});

const BASE_PARAMS = {
  sessionKey: "session:test",
  scopeKey: "test-scope",
  workspaceDir: "/home/user/ws",
  agentWorkspaceDir: "/home/user/ws",
  cfg: {
    mode: "non-main" as const,
    backend: "bwrap" as const,
    scope: "session" as const,
    workspaceAccess: "rw" as const,
    workspaceRoot: "/home/user/ws",
    docker: { image: "", containerPrefix: "", workdir: "", readOnlyRoot: false, tmpfs: [], network: "none", capDrop: [] },
    ssh: {},
    browser: { bridgeUrl: "" },
    tools: {},
    prune: {},
  },
};

describe("createBwrapSandboxBackendFactory", () => {
  it("resolves plugin + agent config and builds an exec spec with bwrap argv", async () => {
    const factory = createBwrapSandboxBackendFactory(() => ({
      bwrap: { binds: ["/opt/shared", "-**/.env"], env: { PATH: true } },
    }));
    const handle = await factory(BASE_PARAMS);

    expect(handle.id).toBe("bwrap");
    expect(handle.workdir).toBe("/home/user/ws");

    const spec = await handle.buildExecSpec({
      command: "echo hi",
      workdir: "/home/user/ws",
      env: { HOME: "/home/user" },
      usePty: false,
    });

    expect(spec.argv[0]).toBe("/usr/bin/bwrap");
    expect(spec.argv).toContain("--unshare-user");
    expect(spec.argv).toContain("--clearenv");
    expect(spec.argv).toContain("--ro-bind");
    expect(spec.argv).toContain("/opt/shared");
    expect(spec.stdinMode).toBe("pipe-closed");
    // env filtered to allowlisted keys only
    expect(spec.env.PATH).toBeDefined();
    expect(spec.env.SECRET).toBeUndefined();
  });

  it("includes /lib64 mount when host has it", async () => {
    const factory = createBwrapSandboxBackendFactory(() => ({}));
    const handle = await factory(BASE_PARAMS);
    const spec = await handle.buildExecSpec({ command: "true", env: {}, usePty: false });
    // unit-level: bind engine handles lib64; here we verify the engine's output shape
    const r = resolveBinds([], "/home/user/ws", "rw", { lib64Exists: true });
    expect(r.mounts.some((m) => m.guest === "/lib64")).toBe(true);
    expect(DEFAULT_OS_MOUNTS.some((m) => m.guest === "/usr")).toBe(true);
    expect(spec.argv).toBeDefined();
  });

  it("runShellCommand spawns bwrap (probe + run) and returns buffered result", async () => {
    const factory = createBwrapSandboxBackendFactory(() => ({}));
    const handle = await factory(BASE_PARAMS);
    const result = await handle.runShellCommand({ script: "ls" });
    expect(result.code).toBe(0);
    // factory() runs a probe first, then runShellCommand spawns again
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn.mock.calls[1][0]).toBe("/usr/bin/bwrap");
  });

  it("probe failure (userns blocked) fails fast with clear error", async () => {
    mockSpawn.mockImplementationOnce(() => {
      const child = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: (ev: string, cb: (code: number) => void) => {
          if (ev === "close") queueMicrotask(() => cb(1));
          return child;
        },
      };
      return child;
    });
    const factory = createBwrapSandboxBackendFactory(() => ({}));
    await expect(factory(BASE_PARAMS)).rejects.toThrow(/user namespaces/);
  });
});

describe("resolveBinds + filterEnv integration", () => {
  it("deny rules filter binds and env schema strips unlisted", () => {
    const binds = ["+~:rw", "-~/.ssh/**"].map(parseBindRule);
    const r = resolveBinds(binds, "/home/user/ws", "rw", { home: "/home/user" });
    expect(r.mounts.some((m) => m.guest === "/home/user/.ssh" && (m.kind === "bind" || m.kind === "ro-bind"))).toBe(false);
    expect(r.denied).toContain("/home/user/.ssh");

    const { env } = filterEnv({ PATH: true }, { PATH: "/bin", TOKEN: "x" });
    expect(env).toEqual({ PATH: "/bin" });
  });
});
