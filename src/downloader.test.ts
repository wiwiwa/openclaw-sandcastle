import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  resolveBwrapBinary,
  downloadBwrapStatic,
  resolveBubblewrapVersion,
} from "./downloader.js";

// vi.mock is hoisted above imports, so module-scope references must come
// from vi.hoisted (mock-based test per team preference).
const mocks = vi.hoisted(() => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.from("x")),
  mkdtemp: vi.fn().mockResolvedValue("/tmp/sandcastle-test"),
}));

vi.mock("node:fs/promises", () => mocks);

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockClear();
});

const APKINDEX = `C:Q1abc
P:busybox
V:1.36.1-r5

C:Q2def
P:bubblewrap-static
V:0.11.0-r1

C:Q3ghi
P:ca-certificates
V:20240203-r1
`;

function fakeFetch(url: string) {
  if (url.endsWith("APKINDEX.tar.gz")) {
    return Promise.resolve({ buffer: Buffer.from("index-gzip") });
  }
  if (url.includes("bubblewrap-static")) {
    return Promise.resolve({ buffer: Buffer.from("apk-bytes") });
  }
  return Promise.reject(new Error(`unexpected url ${url}`));
}

function fakeExtract(tgz: Buffer, member: string) {
  if (member === "APKINDEX") {
    return Promise.resolve(Buffer.from(APKINDEX));
  }
  if (member === "usr/bin/bwrap") {
    return Promise.resolve(Buffer.from("ELF-binary"));
  }
  return Promise.reject(new Error(`unexpected member ${member}`));
}

describe("resolveBubblewrapVersion", () => {
  it("parses version from APKINDEX", async () => {
    const v = await resolveBubblewrapVersion("https://mirror/main/x86_64", fakeFetch, fakeExtract);
    expect(v).toBe("0.11.0-r1");
  });
});

describe("downloadBwrapStatic", () => {
  it("downloads, extracts, caches with 0755", async () => {
    const result = await downloadBwrapStatic({
      homeDir: "/home/user",
      arch: "x64",
      alpineBase: "https://mirror",
      fetch: fakeFetch,
      extractTar: fakeExtract,
    });

    expect(result.version).toBe("0.11.0-r1");
    expect(result.cachePath).toBe("/home/user/.cache/openclaw/bwrap/bwrap");
    expect(result.fromCache).toBe(false);
    expect(mocks.chmod).toHaveBeenCalledWith(result.cachePath, 0o755);
    expect(mocks.writeFile).toHaveBeenCalledWith(result.cachePath, Buffer.from("ELF-binary"));
  });
});

describe("resolveBwrapBinary", () => {
  it("returns cached binary when executable", async () => {
    // PATH lookup must fail; only the cache path is executable.
    mocks.access.mockImplementation((p: string) =>
      p === "/home/user/.cache/openclaw/bwrap/bwrap" ? Promise.resolve() : Promise.reject(new Error("ENOENT")),
    );
    const result = await resolveBwrapBinary({
      homeDir: "/home/user",
      pathVar: "/nonexistent", // force cache lookup instead of PATH
    });
    expect(result).toBe("/home/user/.cache/openclaw/bwrap/bwrap");
  });
});
