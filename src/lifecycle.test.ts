import { describe, expect, it } from "vitest";
import { buildDetachedCommand, buildNsenterCommand, PidRegistry } from "./lifecycle.js";

describe("lifecycle", () => {
  it("buildDetachedCommand uses setsid+nohup and echoes the PID", () => {
    const cmd = buildDetachedCommand("node server.js");
    expect(cmd).toContain("setsid");
    expect(cmd).toContain("nohup");
    expect(cmd).toContain("node server.js");
    expect(cmd).toContain("echo $!");
  });

  it("buildNsenterCommand re-enters the tracked PID namespace", () => {
    expect(buildNsenterCommand(1234, "ps aux")).toBe("nsenter --target 1234 --all -- ps aux");
  });

  it("PidRegistry tracks, gets, lists, untracks", () => {
    const reg = new PidRegistry();
    reg.track("bg-1", 42);
    reg.track("bg-2", 43);
    expect(reg.get("bg-1")).toBe(42);
    expect(reg.list()).toHaveLength(2);
    reg.untrack("bg-1");
    expect(reg.get("bg-1")).toBeUndefined();
    expect(reg.list()).toEqual([{ key: "bg-2", pid: 43 }]);
  });
});
