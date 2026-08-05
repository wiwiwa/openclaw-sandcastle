import { describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { createSandcastleFsBridge, SandcastleFsError } from "./fs-bridge.js";
import { parseBindRule } from "./config.js";

const HOME = os.homedir();
const WS = path.join(HOME, "ws");
const denyRules = ["-~/.ssh/**", "-**/.env"].map(parseBindRule);

function bridge(overrides: { workspaceAccess?: "none" | "ro" | "rw"; deniedPaths?: string[] } = {}) {
  return createSandcastleFsBridge({
    workspaceDir: WS,
    workspaceAccess: overrides.workspaceAccess ?? "rw",
    denyRules,
    deniedPaths: overrides.deniedPaths ?? [],
  });
}

// Mock fs module so no real IO happens (mock-based test per team preference)
vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn().mockResolvedValue(Buffer.from("data")),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ isDirectory: () => false, isFile: () => true, size: 4, mtimeMs: 1 }),
  },
}));

describe("createSandcastleFsBridge", () => {
  it("readFile on denied path throws ENOENT (file not exist), never EACCES", async () => {
    const b = bridge();
    await expect(b.readFile({ filePath: path.join(HOME, ".ssh/id_rsa") })).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(b.readFile({ filePath: path.join(WS, "proj/.env") })).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("readFile on allowed path resolves", async () => {
    const b = bridge();
    const buf = await b.readFile({ filePath: path.join(WS, "src.ts") });
    expect(buf.toString()).toBe("data");
  });

  it("workspaceAccess none → workspace paths ENOENT", async () => {
    const b = bridge({ workspaceAccess: "none" });
    await expect(b.readFile({ filePath: `${WS}/x.ts` })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("workspaceAccess ro → writes EACCES", async () => {
    const b = bridge({ workspaceAccess: "ro" });
    await expect(b.writeFile({ filePath: `${WS}/x.ts`, data: "x" })).rejects.toMatchObject({ code: "EACCES" });
    await expect(b.mkdirp({ filePath: `${WS}/dir` })).rejects.toMatchObject({ code: "EACCES" });
  });

  it("stat on denied path returns null (absent)", async () => {
    const b = bridge();
    expect(await b.stat({ filePath: path.join(HOME, ".ssh") })).toBeNull();
  });

  it("deniedPaths overlays are enforced", async () => {
    const b = bridge({ deniedPaths: ["/opt/secret"] });
    await expect(b.readFile({ filePath: "/opt/secret/keys" })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolvePath maps 1:1 host/container (no translation)", () => {
    const b = bridge();
    const r = b.resolvePath({ filePath: "src.ts" });
    expect(r.hostPath).toBe(`${WS}/src.ts`);
    expect(r.containerPath).toBe(`${WS}/src.ts`);
  });

  it("denied paths never leak existence via error code", async () => {
    const b = bridge();
    const err = await b.readFile({ filePath: path.join(HOME, ".ssh/config") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandcastleFsError);
    expect((err as SandcastleFsError).code).toBe("ENOENT");
    expect((err as Error).message).toContain("file not exist");
  });
});
