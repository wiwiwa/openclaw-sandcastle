import { describe, expect, it } from "vitest";
import { parseBindRule } from "./config.js";
import { resolveBinds, isPathDenied, DEFAULT_OS_MOUNTS } from "./bind-rules.js";

const HOME = "/home/user";

function binds(...rules: string[]) {
  return rules.map(parseBindRule);
}

describe("resolveBinds", () => {
  it("includes default OS mounts (with /lib64 when present)", () => {
    const r = resolveBinds(binds(), "/home/user/ws", "none", { home: HOME, lib64Exists: true });
    const guests = r.mounts.map((m) => m.guest);
    for (const d of DEFAULT_OS_MOUNTS) expect(guests).toContain(d.guest);
    expect(guests).toContain("/lib64");
  });

  it("omits /lib64 when not present on host", () => {
    const r = resolveBinds(binds(), "/home/user/ws", "none", { home: HOME, lib64Exists: false });
    expect(r.mounts.map((m) => m.guest)).not.toContain("/lib64");
  });

  it("mounts user binds ro by default, rw when explicit", () => {
    const r = resolveBinds(binds("/opt/shared", "/data:rw"), "/home/user/ws", "none", { home: HOME });
    expect(r.mounts).toContainEqual({ kind: "ro-bind", host: "/opt/shared", guest: "/opt/shared" });
    expect(r.mounts).toContainEqual({ kind: "bind", host: "/data", guest: "/data" });
  });

  it("rejects mounting ~/ or parents without + prefix (§4.1)", () => {
    expect(() => resolveBinds(binds("~:rw"), "/ws", "none", { home: HOME })).toThrow(/restricted/);
    expect(() => resolveBinds(binds("/home:rw"), "/ws", "none", { home: HOME })).toThrow(/restricted/);
    expect(() => resolveBinds(binds("/:rw"), "/ws", "none", { home: HOME })).toThrow(/restricted/);
  });

  it("allows ~/ with + force-allow prefix", () => {
    const r = resolveBinds(binds("+~:rw"), "/ws", "none", { home: HOME });
    expect(r.mounts).toContainEqual({ kind: "bind", host: HOME, guest: HOME });
  });

  it("allows ~ subdirs without +", () => {
    const r = resolveBinds(binds("~/projects:rw"), "/ws", "none", { home: HOME });
    expect(r.mounts).toContainEqual({ kind: "bind", host: "/home/user/projects", guest: "/home/user/projects" });
  });

  it("deny wins over allow (ADR-003)", () => {
    const r = resolveBinds(binds("+~:rw", "-~/.ssh/**"), "/ws", "none", { home: HOME });
    // No real bind of the denied dir: only the empty tmpfs shadow exists.
    expect(r.mounts.some((m) => m.guest === "/home/user/.ssh" && (m.kind === "bind" || m.kind === "ro-bind"))).toBe(false);
    // overlay shadow added for the denied dir
    expect(r.denied).toContain("/home/user/.ssh");
    expect(r.mounts).toContainEqual({ kind: "tmpfs", guest: "/home/user/.ssh" });
  });

  it("rejects deny overlapping a default OS mount (§6)", () => {
    expect(() => resolveBinds(binds("-/usr"), "/ws", "none", { home: HOME })).toThrow(/default OS mount/);
  });

  it("rejects glob in allow binds (v1)", () => {
    expect(() => resolveBinds(binds("/opt/*"), "/ws", "none", { home: HOME })).toThrow(/glob/);
  });

  it("mounts workspace per workspaceAccess with identical host/guest path", () => {
    const r = resolveBinds(binds(), "/home/user/ws", "rw", { home: HOME });
    expect(r.mounts).toContainEqual({ kind: "bind", host: "/home/user/ws", guest: "/home/user/ws" });
    const ro = resolveBinds(binds(), "/home/user/ws", "ro", { home: HOME });
    expect(ro.mounts).toContainEqual({ kind: "ro-bind", host: "/home/user/ws", guest: "/home/user/ws" });
    const none = resolveBinds(binds(), "/home/user/ws", "none", { home: HOME });
    expect(none.mounts.some((m) => m.guest === "/home/user/ws")).toBe(false);
  });
});

describe("isPathDenied", () => {
  it("matches deny rules with ancestor semantics", () => {
    const deny = binds("-~/.ssh/**", "-**/.env");
    expect(isPathDenied(deny, "/home/user/.ssh/id_rsa", HOME)).toBe(true);
    expect(isPathDenied(deny, "/home/user/proj/.env", HOME)).toBe(true);
    expect(isPathDenied(deny, "/home/user/proj/src.ts", HOME)).toBe(false);
  });
});
