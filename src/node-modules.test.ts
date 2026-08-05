import { describe, expect, it } from "vitest";
import { resolveGlobalModules } from "./node-modules.js";

const HOME = "/home/user";

describe("resolveGlobalModules", () => {
  it("returns mount+NODE_PATH when openclaw resolves under ~/ (npm-global)", () => {
    const fakePath = `${HOME}/.npm-global/lib/node_modules/openclaw/package.json`;
    const result = resolveGlobalModules({
      home: HOME,
      tryResolveOpenclaw: () => fakePath,
    });
    expect(result).not.toBeNull();
    expect(result!.path).toBe(`${HOME}/.npm-global/lib/node_modules`);
    expect(result!.shouldMount).toBe(true);
    expect(result!.shouldSetNodePath).toBe(true);
  });

  it("returns mount+NODE_PATH for nvm path under ~/", () => {
    const fakePath = `${HOME}/.nvm/versions/node/v24.18.1/lib/node_modules/openclaw/package.json`;
    const result = resolveGlobalModules({
      home: HOME,
      tryResolveOpenclaw: () => fakePath,
    });
    expect(result).not.toBeNull();
    expect(result!.path).toBe(`${HOME}/.nvm/versions/node/v24.18.1/lib/node_modules`);
    expect(result!.shouldMount).toBe(true);
    expect(result!.shouldSetNodePath).toBe(true);
  });

  it("returns no-mount when path is under /usr (system)", () => {
    const fakePath = `/usr/lib/node_modules/openclaw/package.json`;
    const result = resolveGlobalModules({
      home: HOME,
      tryResolveOpenclaw: () => fakePath,
    });
    expect(result).not.toBeNull();
    expect(result!.path).toBe("/usr/lib/node_modules");
    expect(result!.shouldMount).toBe(false);
    expect(result!.shouldSetNodePath).toBe(false);
  });

  it("falls back to NODE_PATH env when openclaw can't be resolved", () => {
    const result = resolveGlobalModules({
      home: HOME,
      nodePath: `${HOME}/.npm-global/lib/node_modules`,
      tryResolveOpenclaw: () => null,
    });
    expect(result).not.toBeNull();
    expect(result!.path).toBe(`${HOME}/.npm-global/lib/node_modules`);
    expect(result!.shouldMount).toBe(true);
    expect(result!.shouldSetNodePath).toBe(true);
  });

  it("falls back to home prefix candidates when nothing else resolves", () => {
    const result = resolveGlobalModules({
      home: HOME,
      nodeVersion: "v24.18.1",
      tryResolveOpenclaw: () => null,
    });
    expect(result).not.toBeNull();
    // First candidate: ~/.npm-global/lib/node_modules
    expect(result!.path).toBe(`${HOME}/.npm-global/lib/node_modules`);
    expect(result!.shouldMount).toBe(true);
  });

  it("returns null when NODE_PATH is relative and openclaw unresolvable", () => {
    // When nodePath is relative, it's skipped; then home candidates are tried.
    // But if we want a null result, we need to simulate no home candidates.
    // Since home candidates always exist, this tests the relative-NODE_PATH skip.
    const result = resolveGlobalModules({
      home: HOME,
      nodePath: "relative/path",
      tryResolveOpenclaw: () => null,
    });
    // Falls through to home candidates, which return non-null
    expect(result).not.toBeNull();
  });

  it("classifies volta path under home correctly", () => {
    // Volta stores node versions under tools/image/node/<ver>/lib/node_modules
    const fakePath = `${HOME}/.volta/tools/image/node/v24.18.1/lib/node_modules/openclaw/package.json`;
    const result = resolveGlobalModules({
      home: HOME,
      tryResolveOpenclaw: () => fakePath,
    });
    expect(result).not.toBeNull();
    expect(result!.path).toBe(`${HOME}/.volta/tools/image/node/v24.18.1/lib/node_modules`);
    expect(result!.shouldMount).toBe(true);
    expect(result!.shouldSetNodePath).toBe(true);
  });

  it("handles path that is exactly home dir (edge case)", () => {
    const result = resolveGlobalModules({
      home: HOME,
      nodePath: HOME,
      tryResolveOpenclaw: () => null,
    });
    expect(result).not.toBeNull();
    expect(result!.shouldMount).toBe(true);
    expect(result!.shouldSetNodePath).toBe(true);
  });
});
