import { describe, expect, it } from "vitest";
import { filterEnv } from "./env-filter.js";

const HOST_ENV = { PATH: "/usr/bin", HOME: "/home/user", SECRET: "s3cr3t", LANG: "en_US.UTF-8" };

describe("filterEnv", () => {
  it("passes through listed vars, strips unlisted (deny-by-default)", () => {
    const { env } = filterEnv({ PATH: true, HOME: true }, HOST_ENV);
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/user" });
    expect(env.SECRET).toBeUndefined();
  });

  it("false explicitly strips", () => {
    const { env } = filterEnv({ PATH: true, SECRET: false }, HOST_ENV);
    expect(env.SECRET).toBeUndefined();
  });

  it("string entries set literal values", () => {
    const { env } = filterEnv({ NODE_ENV: "production" }, HOST_ENV);
    expect(env.NODE_ENV).toBe("production");
  });

  it("skips true entries missing from host env", () => {
    const { env } = filterEnv({ MISSING_VAR: true }, HOST_ENV);
    expect(env.MISSING_VAR).toBeUndefined();
  });

  it("produces ordered --setenv entries after clearenv semantics", () => {
    const { setenvEntries } = filterEnv({ PATH: true, NODE_ENV: "prod" }, HOST_ENV);
    expect(setenvEntries).toEqual(["--setenv", "PATH", "/usr/bin", "--setenv", "NODE_ENV", "prod"]);
  });

  it("empty schema → empty env", () => {
    const { env, setenvEntries } = filterEnv({}, HOST_ENV);
    expect(env).toEqual({});
    expect(setenvEntries).toEqual([]);
  });
});
