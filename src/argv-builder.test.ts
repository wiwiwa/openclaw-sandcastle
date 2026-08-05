import { describe, expect, it } from "vitest";
import { buildBwrapArgv } from "./argv-builder.js";
import type { MountFact } from "./bind-rules.js";

const MOUNTS: MountFact[] = [
  { kind: "ro-bind", host: "/usr", guest: "/usr" },
  { kind: "bind", host: "/data", guest: "/data" },
  { kind: "dev", guest: "/dev" },
  { kind: "proc", guest: "/proc" },
  { kind: "tmpfs", guest: "/tmp" },
];

describe("buildBwrapArgv", () => {
  it("assembles canonical §6 invocation shape", () => {
    const argv = buildBwrapArgv({
      bwrapBin: "/usr/bin/bwrap",
      mounts: MOUNTS,
      setenvEntries: ["--setenv", "PATH", "/usr/bin"],
      env: { PATH: "/usr/bin" },
      chdir: "/home/user/ws",
      command: ["/bin/sh", "-c", "echo hi"],
    });

    expect(argv[0]).toBe("/usr/bin/bwrap");
    expect(argv).toContain("--unshare-pid");
    expect(argv).toContain("--unshare-uts");
    expect(argv).toContain("--unshare-ipc");
    expect(argv).toContain("--unshare-user");
    expect(argv).toContain("--die-with-parent");
    expect(argv).toContain("--clearenv");
    expect(argv).toContain("--chdir");
    expect(argv).toContain("/home/user/ws");
    expect(argv).toContain("--");
    expect(argv.slice(-4)).toEqual(["--", "/bin/sh", "-c", "echo hi"]);
  });

  it("orders clearenv before setenv (pushback on §6 doc ordering)", () => {
    const argv = buildBwrapArgv({
      bwrapBin: "bwrap",
      mounts: [],
      setenvEntries: ["--setenv", "A", "1"],
      env: { A: "1" },
      chdir: "/",
      command: ["/bin/true"],
    });
    const clearenvIdx = argv.indexOf("--clearenv");
    const setenvIdx = argv.indexOf("--setenv");
    expect(clearenvIdx).toBeGreaterThan(-1);
    expect(setenvIdx).toBeGreaterThan(clearenvIdx);
  });

  it("maps mount kinds to flags in order", () => {
    const argv = buildBwrapArgv({
      bwrapBin: "bwrap",
      mounts: MOUNTS,
      setenvEntries: [],
      env: {},
      chdir: "/",
      command: ["/bin/true"],
    });
    const roIdx = argv.indexOf("--ro-bind");
    const bindIdx = argv.indexOf("--bind");
    const devIdx = argv.indexOf("--dev");
    const procIdx = argv.indexOf("--proc");
    const tmpIdx = argv.indexOf("--tmpfs");
    expect(roIdx).toBeGreaterThan(-1);
    expect(bindIdx).toBeGreaterThan(roIdx);
    expect(devIdx).toBeGreaterThan(bindIdx);
    expect(procIdx).toBeGreaterThan(devIdx);
    expect(tmpIdx).toBeGreaterThan(procIdx);
  });
});
