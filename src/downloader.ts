/**
 * Auto-downloader (README "Auto-Download", Architecture.md §5).
 *
 * Resolves the bwrap binary:
 *   1. `bwrap` on PATH (host-provided)
 *   2. cached static binary at ~/.cache/openclaw/bwrap/bwrap
 *   3. otherwise: download bubblewrap-static from Alpine latest-stable apk
 *      repository, extract the static binary, cache it.
 *
 * The download path is mock-friendly: the HTTP fetch and the tar extraction
 * are injected via options so tests can stub them.
 */

import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { mkdir, chmod, access, writeFile, readFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface DownloaderOptions {
  homeDir?: string;
  /** Arch key used in the Alpine repo path, e.g. "x86_64". */
  arch?: string;
  /** Base URL of the Alpine mirror. */
  alpineBase?: string;
  /** HTTP GET returning text (APKINDEX) or binary (apk). Injectable. */
  fetch?: (url: string) => Promise<{ text: string; buffer?: never } | { text?: never; buffer: Buffer }>;
  /** Extract one file from a tgz buffer. Injectable (default: system tar). */
  extractTar?: (tgz: Buffer, member: string) => Promise<Buffer>;
}

function archKey(arch: string = process.arch): string {
  switch (arch) {
    case "x64":
      return "x86_64";
    case "arm64":
      return "aarch64";
    case "arm":
      return "armv7";
    default:
      return arch;
  }
}

const APKINDEX_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Find a usable bwrap binary. Returns the resolved path.
 * Throws with a clear error if none can be found/installed.
 */
export async function resolveBwrapBinary(opts: DownloaderOptions & { pathVar?: string } = {}): Promise<string> {
  const home = opts.homeDir ?? os.homedir();
  const cached = path.join(home, ".cache", "openclaw", "bwrap", "bwrap");

  const onPath = await findOnPath("bwrap", opts.pathVar);
  if (onPath) return onPath;

  if (await isExecutable(cached)) return cached;

  await downloadBwrapStatic({ ...opts, homeDir: home });
  if (await isExecutable(cached)) return cached;

  throw new Error(
    "sandcastle: could not locate or auto-download bwrap. " +
      "Install bubblewrap (e.g. `apt install bubblewrap`) or check network access.",
  );
}

async function findOnPath(bin: string, pathVar: string = process.env.PATH ?? ""): Promise<string | null> {
  for (const dir of pathVar.split(":")) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface BwrapDownloadResult {
  cachePath: string;
  version: string;
  fromCache: boolean;
}

/**
 * Download bubblewrap-static from Alpine latest-stable and cache the binary.
 *
 * 1. GET APKINDEX.tar.gz from the repo dir, parse for bubblewrap-static version
 * 2. GET bubblewrap-static-<version>.apk
 * 3. Extract usr/bin/bwrap (statically linked) and cache it
 */
export async function downloadBwrapStatic(opts: DownloaderOptions = {}): Promise<BwrapDownloadResult> {
  const home = opts.homeDir ?? os.homedir();
  const cacheDir = path.join(home, ".cache", "openclaw", "bwrap");
  const cachePath = path.join(cacheDir, "bwrap");
  const arch = archKey(opts.arch);
  const base = opts.alpineBase ?? "https://dl-cdn.alpinelinux.org/alpine/latest-stable";
  const repoDir = `${base}/main/${arch}`;

  await mkdir(cacheDir, { recursive: true });

  const fetch = opts.fetch ?? defaultFetch;
  const extract = opts.extractTar ?? defaultExtractTar;

  // 1. APKINDEX → version
  const version = await resolveBubblewrapVersion(repoDir, fetch, extract);

  // 2. download the apk
  const apkUrl = `${repoDir}/bubblewrap-static-${version}.apk`;
  const apkRes = await fetch(apkUrl);
  const apkBuffer = apkRes.buffer ?? Buffer.from(apkRes.text, "binary");

  // 3. extract the static binary (apk = gzipped tar; member usr/bin/bwrap)
  const binBuffer = await extract(apkBuffer, "usr/bin/bwrap");
  await writeFile(cachePath, binBuffer);
  await chmod(cachePath, 0o755);

  return { cachePath, version, fromCache: false };
}

/** Parse APKINDEX for the latest bubblewrap-static version. */
export async function resolveBubblewrapVersion(
  repoDir: string,
  fetch: DownloaderOptions["fetch"] = defaultFetch,
  extractTar: DownloaderOptions["extractTar"] = defaultExtractTar,
): Promise<string> {
  const res = await fetch(`${repoDir}/APKINDEX.tar.gz`);
  const indexBuffer = res.buffer ?? Buffer.from(res.text, "binary");
  const indexText = (await extractTar(indexBuffer, "APKINDEX")).toString("utf8");

  const blocks = indexText.split(/\n\n+/);
  for (const block of blocks) {
    const pkg = block.match(/^P:(.+)$/m)?.[1]?.trim();
    const ver = block.match(/^V:(.+)$/m)?.[1]?.trim();
    if (pkg === "bubblewrap-static" && ver) return ver;
  }
  throw new Error("sandcastle: bubblewrap-static not found in Alpine APKINDEX");
}

async function defaultFetch(url: string): Promise<{ buffer: Buffer }> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`sandcastle: HTTP ${res.status} fetching ${url}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer };
}

/** Extract a single member from a gzipped tar using the system `tar`. */
async function defaultExtractTar(tgz: Buffer, member: string): Promise<Buffer> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "sandcastle-"));
  const tgzPath = path.join(tmpDir, "archive.tgz");
  await writeFile(tgzPath, tgz);
  try {
    const { stdout } = await execFileP("tar", ["-xzf", tgzPath, "-C", tmpDir, member]);
    // tar without -O writes the file; read it back
    const outPath = path.join(tmpDir, member);
    return await readFile(outPath);
  } finally {
    await execFileP("rm", ["-rf", tmpDir]).catch(() => {});
  }
}
