import { describe, expect, it } from "vitest";
import { globToRegExp, matchesGlob, matchesDenyRule } from "./glob.js";

describe("globToRegExp", () => {
  it("matches literal paths", () => {
    expect(matchesGlob("/home/user/projects", "/home/user/projects")).toBe(true);
    expect(matchesGlob("/home/user/projects", "/home/user/projects2")).toBe(false);
  });

  it("* matches a non-hidden segment but not /", () => {
    expect(matchesGlob("/home/*/projects", "/home/user/projects")).toBe(true);
    expect(matchesGlob("/home/*/projects", "/home/user/deep/projects")).toBe(false);
    expect(matchesGlob("/home/*", "/home/.env")).toBe(false); // hidden segment
    expect(matchesGlob("/home/*", "/home/file.txt")).toBe(true);
  });

  it("** matches recursively including hidden", () => {
    expect(matchesGlob("**/.env", "/home/user/proj/.env")).toBe(true);
    expect(matchesGlob("**/.env", ".env")).toBe(true);
    expect(matchesGlob("/home/user/.ssh/**", "/home/user/.ssh/id_rsa")).toBe(true);
    expect(matchesGlob("/home/user/.ssh/**", "/home/user/.ssh")).toBe(false); // dir itself: deny-rule semantics
  });

  it("? matches a single character", () => {
    expect(matchesGlob("/tmp/file?.log", "/tmp/file1.log")).toBe(true);
    expect(matchesGlob("/tmp/file?.log", "/tmp/file12.log")).toBe(false);
  });
});

describe("matchesDenyRule", () => {
  it("deny of a directory denies its contents", () => {
    expect(matchesDenyRule("/home/user/.ssh", "/home/user/.ssh/id_ed25519")).toBe(true);
    expect(matchesDenyRule("/home/user/.ssh", "/home/user/.ssh")).toBe(true);
    expect(matchesDenyRule("/home/user/.ssh", "/home/user/.ssh2")).toBe(false);
  });

  it("glob deny matches everywhere", () => {
    expect(matchesDenyRule("**/.env", "/a/b/c/.env")).toBe(true);
    expect(matchesDenyRule("**/.env", "/a/b/c/.env.local")).toBe(false);
  });
});
