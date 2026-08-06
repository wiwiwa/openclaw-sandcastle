import { describe, expect, it } from "vitest";
import { parseBindRule, resolveSandcastleConfig, DEFAULT_ENV } from "./config.js";

describe("parseBindRule", () => {
  it("parses plain read-only bind", () => {
    expect(parseBindRule("/usr/local/bin")).toEqual({ prefix: "", pattern: "/usr/local/bin", mode: "ro" });
  });

  it("parses explicit :rw and :ro", () => {
    expect(parseBindRule("/home/user/projects:rw")).toEqual({
      prefix: "",
      pattern: "/home/user/projects",
      mode: "rw",
    });
    expect(parseBindRule("/opt/tools:ro")).toEqual({
      prefix: "",
      pattern: "/opt/tools",
      mode: "ro",
    });
  });

  it("parses + force-allow and - deny prefixes", () => {
    expect(parseBindRule("+~/OpenClaw")).toEqual({ prefix: "+", pattern: "~/OpenClaw", mode: "ro" });
    expect(parseBindRule("-~/.ssh/**")).toEqual({ prefix: "-", pattern: "~/.ssh/**", mode: "ro" });
  });

  it("rejects empty and missing-pattern rules", () => {
    expect(() => parseBindRule("")).toThrow();
    expect(() => parseBindRule("+:rw")).toThrow();
    expect(() => parseBindRule(":rw")).toThrow();
  });
});

describe("resolveSandcastleConfig", () => {
  const base = { workspaceDir: "/home/user/ws" };

  it("merges global + per-agent mapDir, global first", () => {
    const cfg = resolveSandcastleConfig(
      { mapDir: ["/opt/shared"] },
      { mapDir: ["/home/user/projects:rw"] },
      base,
    );
    expect(cfg.binds.map((b) => b.pattern)).toEqual(["/opt/shared", "/home/user/projects"]);
    expect(cfg.binds[1].mode).toBe("rw");
  });

  it("merges env per-key with per-agent winning", () => {
    const cfg = resolveSandcastleConfig(
      { env: { PATH: true, NODE_ENV: "global" } },
      { env: { NODE_ENV: "per-agent" } },
      base,
    );
    expect(cfg.env).toMatchObject({ PATH: true, NODE_ENV: "per-agent" });
  });

  it("applies default env when nothing configured", () => {
    const cfg = resolveSandcastleConfig({}, undefined, base);
    expect(cfg.env).toEqual(DEFAULT_ENV);
  });

  it("defaults mode/scope/workspaceAccess", () => {
    const cfg = resolveSandcastleConfig({}, undefined, base);
    expect(cfg.mode).toBe("off");
    expect(cfg.scope).toBe("agent");
    expect(cfg.workspaceAccess).toBe("none");
  });

  it("resolves backend to 'sandcastle'", () => {
    const cfg = resolveSandcastleConfig({}, undefined, base);
    expect(cfg.backend).toBe("sandcastle");
  });

  it("rejects scope shared (v1 deferral, Architecture.md §8)", () => {
    expect(() => resolveSandcastleConfig({ scope: "shared" }, undefined, base)).toThrow(/shared/);
  });

  it("per-agent sandbox config wins over global scalars", () => {
    const cfg = resolveSandcastleConfig(
      { mode: "all", workspaceAccess: "ro" },
      undefined,
      { ...base, mode: "non-main", workspaceAccess: "rw" },
    );
    expect(cfg.mode).toBe("non-main");
    expect(cfg.workspaceAccess).toBe("rw");
  });
});
