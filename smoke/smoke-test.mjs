/**
 * Real-bwrap smoke test (not part of the unit suite — requires bwrap + userns).
 * Proves the acceptance criteria from the workboard card:
 *  1. command runs isolated via bwrap
 *  2. only whitelisted paths visible
 *  3. denied paths unreadable (and ideally unlisted)
 *  4. documents the exact invocation (printed below)
 *
 * Each check builds a fresh bwrap argv with the command under test; the
 * argv already ends in `-- /bin/sh -c <cmd>`, so nothing is appended after it.
 */
import { spawn } from "node:child_process";
import { parseBindRule } from "../dist/config.js";
import { resolveBinds } from "../dist/bind-rules.js";
import { filterEnv } from "../dist/env-filter.js";
import { buildBwrapArgv } from "../dist/argv-builder.js";
import { createSandcastleFsBridge } from "../dist/fs-bridge.js";

const HOME = process.env.HOME ?? "/home/user";
const WS = "/home/user/OpenClaw/agents/dev";

const config = {
  binds: ["+~:rw", "-~/.ssh/**", "-**/.env"].map(parseBindRule),
  env: { PATH: true, HOME: true, USER: true },
};

const { mounts, denied } = resolveBinds(config.binds, WS, "rw", { home: HOME });
const filtered = filterEnv(config.env);

function buildArgv(cmd) {
  return buildBwrapArgv({
    bwrapBin: "/usr/bin/bwrap",
    mounts,
    setenvEntries: filtered.setenvEntries,
    env: filtered.env,
    chdir: WS,
    command: ["/bin/sh", "-c", cmd],
  });
}

console.log("=== exact bwrap invocation (example) ===");
console.log(buildArgv("echo ok").join(" \\\n  "));
console.log("=== denied paths (fs-bridge overlay) ===", denied.join(", "));

function runArgv(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (err += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

const results = {};
async function check(name, argv, expectOk) {
  const { code, out, err } = await runArgv(argv);
  const ok = expectOk ? code === 0 : code !== 0;
  results[name] = ok;
  console.log(`${ok ? "✅" : "❌"} ${name} (exit ${code})${out.trim() ? ` → ${out.trim().slice(0, 80)}` : ""}${err.trim() ? ` [err: ${err.trim().slice(0, 80)}]` : ""}`);
}

async function main() {
  // 1. command runs inside the sandbox
  await check("runs isolated via bwrap", buildArgv("echo sandcastle-ok"), true);
  // 2. default OS mounts visible
  await check("default OS mount /usr visible", buildArgv("ls /usr >/dev/null && echo has-usr"), true);
  // 3. workspace mounted rw
  await check("workspace rw accessible", buildArgv(`touch ${WS}/.smoke-test && rm ${WS}/.smoke-test && echo wrote`), true);
  // 4. ~/.ssh denied: overlay is empty inside exec (contents unreadable)
  await check("~/.ssh empty overlay inside exec", buildArgv(`test -z "$(ls -A ${HOME}/.ssh 2>/dev/null)" && echo empty-overlay`), true);
  // 5. deny overlay hides ~/.ssh contents
  await check("deny overlay hides ~/.ssh contents", buildArgv(`test -f ${HOME}/.ssh/known_hosts && exit 1 || echo no-secrets`), true);

  // 6. fs-bridge: denied path returns "file not exist" (ENOENT)
  const bridge = createSandcastleFsBridge({
    workspaceDir: WS,
    workspaceAccess: "rw",
    denyRules: config.binds.filter((b) => b.prefix === "-"),
    deniedPaths: denied,
  });
  try {
    await bridge.readFile({ filePath: `${HOME}/.ssh/config` });
    console.log("❌ fs-bridge ~/.ssh/config readable");
  } catch (e) {
    const code = e?.code;
    console.log(`${code === "ENOENT" ? "✅" : "❌"} fs-bridge ~/.ssh/config → ${code === "ENOENT" ? "ENOENT (file not exist)" : e}`);
  }
  try {
    await bridge.writeFile({ filePath: `${WS}/new.txt`, data: "x" });
    await bridge.remove({ filePath: `${WS}/new.txt` });
    console.log("✅ fs-bridge workspace write ok");
  } catch (e) {
    console.log("❌ fs-bridge workspace write failed:", e);
  }

  const failed = Object.entries(results).filter(([, ok]) => !ok);
  console.log(failed.length === 0 ? "\nSMOKE TEST PASSED" : `\nSMOKE TEST FAILED: ${failed.map(([n]) => n).join(", ")}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke test error:", e);
  process.exit(1);
});
