# openclaw-sandcastle — User Guide

This guide covers configuration, map rules, environment variables, troubleshooting, and operational details.

## Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [Map Rules](#map-rules)
- [Environment Variables](#environment-variables)
- [Workspace Access](#workspace-access)
- [Background Processes](#background-processes)
- [File Tool Enforcement](#file-tool-enforcement)
- [Auto-Download](#auto-download)
- [Troubleshooting](#troubleshooting)
- [Security Model](#security-model)

## Installation

Sandcastle is an OpenClaw plugin published on [ClawHub](https://clawhub):

```bash
openclaw plugins install clawhub:openclaw-sandcastle
```

Or add it directly to your `openclaw.json` plugins config.

### Prerequisites

- **Linux** with bwrap available (or auto-download will fetch it)
- Kernel support for user namespaces (most modern kernels ≥ 3.8)
- If AppArmor is enabled, it must allow unprivileged user namespaces

**No manual bwrap installation required** — Sandcastle auto-downloads `bubblewrap-static` from Alpine's latest-stable apk repo if `bwrap` is not in `PATH`.

## Configuration

Enable Sandcastle by setting `backend: "sandcastle"` in your sandbox config. **Config is split across two namespaces:** OpenClaw core keys live under `agents.defaults.sandbox`; Sandcastle's own keys (`mapDir`, `env`) live under `plugins.entries."openclaw-sandcastle".config`.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        backend: "sandcastle",     // core key: select the backend
        mode: "non-main",          // core key: "off" | "non-main" | "all"
        scope: "session",          // core key: "agent" | "session"
        workspaceAccess: "rw"      // core key: "none" | "ro" | "rw"
      }
    }
  },
  plugins: {
    entries: {
      "openclaw-sandcastle": {
        enabled: true,
        config: {
          mapDir: [
            // see Map Rules section
          ],
          env: {
            // see Environment Variables section
          }
        }
      }
    }
  }
}
```

> **Why the split?** OpenClaw core validates `agents.defaults.sandbox` against a **strict** schema (only `mode`, `backend`, `workspaceAccess`, `sessionToolsVisibility`, `scope`, `workspaceRoot`, `docker`, `ssh`, `browser`, `prune`). Putting `mapDir`/`env` there triggers `unknown configuration key` and the values are ignored. Sandcastle's own config namespace is validated against the plugin's published `configSchema`, so `mapDir`/`env` belong there.

> **Note:** `backend: "bwrap"` is accepted as a deprecated alias for `"sandcastle"` and will be removed in 1.0.

### Per-Agent Overrides

Core sandbox keys (`mode`, `scope`, `workspaceAccess`, `backend`) can be overridden per agent:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        backend: "sandcastle",
        mode: "all"
      }
    },
    list: [
      {
        id: "dev",
        sandbox: {
          mode: "non-main",
          workspaceAccess: "rw"
        }
      }
    ]
  }
}
```

**`mapDir` and `env` are global-only in v1.** They cannot be overridden per agent: OpenClaw core does not pass plugin-specific keys through the per-agent `sandbox` block, so a per-agent `sandbox.mapDir` would be rejected as an unknown key and silently ignored. Per-agent `mapDir`/`env` overrides are a **v1 non-goal** (requires a core/plugin-SDK per-agent config channel — tracked in Architecture.md §8/§10).

### Settings Reference

| Setting | Key | Values | Default |
|---|---|---|---|
| Backend | `agents.defaults.sandbox.backend` | `sandcastle` (`bwrap` deprecated) | `sandcastle` |
| Mode | `agents.defaults.sandbox.mode` | `off`, `non-main`, `all` | `off` |
| Scope | `agents.defaults.sandbox.scope` | `agent`, `session` (`shared` deferred) | `agent` |
| Workspace access | `agents.defaults.sandbox.workspaceAccess` | `none`, `ro`, `rw` | `none` |
| Map rules | `plugins.entries."openclaw-sandcastle".config.mapDir` | array of glob patterns | `[]` |
| Env | `plugins.entries."openclaw-sandcastle".config.env` | object | `{PATH, HOME, USER, LANG, LC_ALL: true}` |

> `scope: "shared"` is **deferred** in v1 (persistent namespace conflicts with the ephemeral-per-exec lifecycle).

## Map Rules

`mapDir` entries control which host paths are visible inside the sandbox. They are configured under `plugins.entries."openclaw-sandcastle".config.mapDir` (global-only in v1 — no per-agent overrides, see [Per-Agent Overrides](#per-agent-overrides)).

### Path Resolution

All paths in `mapDir` (including deny and force-allow rules) are resolved at **config load time** using these rules:

1. **Relative paths are rejected.** A path like `./secrets` or `../etc` causes a config load error. Use absolute paths (`/home/user/secrets`) or `~`-prefixed paths (`~/secrets`).
2. **`~` is expanded** to the user's home directory. `~/.env.*` becomes `/home/user/.env.*` before glob matching. This is the only shorthand accepted.
3. **Symlinks are resolved** to their real target (`realpath`) before binding. If `/home/user/projects` is a symlink to `/data/projects`, the sandbox binds `/data/projects`. This ensures deny rules match the real path, not a symlink alias that could bypass them.

### Glob Expansion Timing

Glob patterns (`*`, `**`, `?`) are expanded **once, at config load time**. This is a permanent design constraint, not a limitation — reliably re-evaluating filesystem globs at runtime is infeasible.

**Implication:** files created mid-session that would match a glob pattern are **not** automatically mapped or denied. For example, if you have a deny rule `-~/.env.*` and someone creates `~/.env.local` while the gateway is running, that file is not covered until the gateway restarts and globs are re-expanded.

To pick up filesystem changes, **restart the gateway**.

### Syntax

```
[prefix]<glob-pattern>[:mode]
```

| Component | Values | Description |
|---|---|---|
| prefix | (none), `+`, `-` | `+` = force-allow restricted path, `-` = deny |
| glob | absolute or `~`-prefixed path with `*`, `**`, `?` | Pattern to match |
| mode | `ro` (default), `rw` | Mount mode |

### Examples

```json5
mapDir: [
  "/usr/local/bin",              // mount read-only
  "/home/user/projects:rw",     // mount read-write
  "+~/OpenClaw",                 // force-allow (normally restricted)
  "-**/.env",                    // deny — blocks .env everywhere
  "-**/.env.*",                  // deny — blocks .env.production etc.
  "-~/.ssh/**",                  // deny — blocks SSH keys
  "-~/.aws/**",                  // deny — blocks AWS credentials
  // "./secrets",                // ❌ REJECTED — relative path
  // "~/secrets",               // ✅ valid — ~ expanded to absolute
]
```

### How Deny Works

- Deny rules (`-` prefix) **always win** over allow rules.
- If a path matches both an allow and a deny, it is denied.
- Deny rules apply after merge — a deny in global config blocks a path even if per-agent config allows it.

### Home Directory Protection

`~/` (the home directory itself) and its parent directories (`/home`, `/`) **cannot be mounted** without the `+` prefix:

```json5
mapDir: [
  "~/:rw",          // ❌ REJECTED — home dir requires + prefix
  "/home:rw",       // ❌ REJECTED — parent of home requires + prefix
  "+~/:rw",         // ✅ force-allowed — user explicitly accepts the risk
  "~/projects:rw",  // ✅ fine — specific subdir, not ~/ itself
]
```

This prevents accidental broad mounts that would expose `~/.ssh`, `~/.aws`, `~/.gnupg`, and other secret directories.

### Default Mounts (Automatic)

These are always mounted and cannot be removed or overridden:

| Path | Mode | Source |
|---|---|---|
| `/usr` | read-only | bwrap `--ro-bind` |
| `/lib` | read-only | bwrap `--ro-bind` |
| `/lib64` | read-only | bwrap `--ro-bind` (if exists) |
| `/bin` | read-only | bwrap `--ro-bind` |
| `/sbin` | read-only | bwrap `--ro-bind` |
| `/dev` | devtmpfs | bwrap `--dev /dev` |
| `/proc` | procfs | bwrap `--proc /proc` |
| `/tmp` | tmpfs | bwrap `--tmpfs /tmp` |

### Auto-Mounted: Global Node Modules

When the global npm/node modules directory resolves to a path **under the user's home directory**, Sandcastle automatically mounts it **read-only**. This ensures that globally installed CLIs (`openclaw`, `npx`, etc.) are available inside the sandbox without manual configuration.

**How it works:**

- At sandbox startup, Sandcastle resolves the global node modules path using Node.js APIs (no `npm root -g` shell-out)
- If the resolved path is under `~/` (e.g. `~/.npm-global/lib/node_modules`, `~/.nvm/versions/node/.../lib/node_modules`, `~/.volta/...`) → auto-mounted read-only
- Sandcastle also sets `NODE_PATH` to the resolved path inside the sandbox, so Node.js can resolve global modules at runtime
- If the path is already covered by a system mount (e.g. `/usr/lib/node_modules`) → no action needed, `NODE_PATH` not set (already in Node's default resolution)
- If the path cannot be resolved (npm not installed, no prefix configured) → silently skipped, `NODE_PATH` not set

**Override:**

Users can explicitly control this with `mapDir` entries:

```json5
mapDir: [
  "-~/.npm-global/**",    // deny — block the auto-mount
  "~/.npm-global:rw",     // or upgrade to read-write
]
```

Deny rules (`-`) always win over the auto-mount.

**Why this is safe:** Global node modules contain installed packages and CLIs — no credentials, no secrets, no user data. It's functionally equivalent to `/usr/lib/node_modules`, just located under the home directory for non-root setups.

## Environment Variables

Control which environment variables reach the sandbox, configured under `plugins.entries."openclaw-sandcastle".config.env` (global-only in v1):

```json5
env: {
  PATH: true,               // pass through host value
  HOME: true,               // pass through host value
  USER: true,               // pass through host value
  LANG: true,               // pass through host value
  LC_ALL: true,             // pass through host value
  NODE_ENV: "production",   // set custom literal value
  DATABASE_URL: false,      // explicitly strip
  CI: true                  // pass through
}
```

| Value | Behavior |
|---|---|
| `true` | Pass through the host's value for this variable |
| `false` | Explicitly strip (same as unlisted, but documents intent) |
| `"string"` | Set this literal value inside the sandbox |

**Any variable not listed is stripped.** This is deny-by-default — secrets like `OPENAI_API_KEY`, `AWS_SECRET_ACCESS_KEY`, etc. never enter the sandbox unless you explicitly allow them.

### Default Env

If `env` is omitted entirely, these defaults apply:

```json5
{
  PATH: true,
  HOME: true,
  USER: true,
  LANG: true,
  LC_ALL: true
}
```

## Workspace Access

Controls whether the agent workspace is mounted:

| Value | Behavior | What agent sees |
|---|---|---|
| `none` | No workspace mount | Paths → "file not exist" (ENOENT) |
| `ro` | Read-only mount via `--ro-bind` | Reads work; writes → permission denied (EACCES) |
| `rw` | Read-write mount via `--bind` | Full read/write access |

The workspace path inside the sandbox is **identical to the host path**. If your workspace is `/home/user/OpenClaw/agents/pm`, that's exactly what the agent sees inside bwrap. No path translation.

### `none` means none

There is no scratch directory, no temp workspace, no fallback. If you set `workspaceAccess: "none"`, the agent cannot write files anywhere. Use this only for agents that should be purely read-only or have no file access needs.

## Background Processes

Since each `exec` call runs in an ephemeral bwrap namespace, background processes need special handling:

1. **Process survives** — use `nohup`, `setsid`, or `disown` so the child detaches from the bwrap parent
2. **Follow-up access** — Sandcastle tracks the background PID and uses `nsenter --target <pid> --all -- <command>` to enter the original namespace for subsequent tool calls

> **Implementation status:** helper functions exist (`buildDetachedCommand`, `buildNsenterCommand`, `PidRegistry` in `lifecycle.ts`) but are **not yet wired** into the backend exec path. Background process support is in progress for v1.

### Limitations

- If the host reboots, tracked PIDs are lost (no persistence)
- `nsenter` requires the same Linux capabilities that bwrap used to create the namespace

## File Tool Enforcement

`read`, `write`, `edit`, and `apply_patch` are **not** wrapped in bwrap. They run in the Gateway process. Instead, Sandcastle enforces path policy:

1. Before executing a file tool, the Gateway checks the target path against the map rules (allow/deny globs)
2. If denied → returns **"file not exist"** (not "permission denied")
3. This prevents information leakage — the agent can't tell whether a file exists at a denied path

This is the **hybrid model**: policy enforcement for file tools, real namespace isolation for `exec`.

## Auto-Download

When Sandcastle needs bwrap and it's not in `PATH`:

1. Fetches `bubblewrap-static` from [Alpine Linux](https://alpinelinux.org/) latest-stable apk repository
2. Stores the binary at `~/.cache/openclaw/bwrap/bubblewrap-static`
3. Verifies TLS delivery (signature verification planned for future)
4. On subsequent runs, uses the cached binary

If bwrap cannot create namespaces (e.g. AppArmor blocking, missing capabilities):

- Sandcastle emits a clear error message explaining the problem
- Sandcastle **fails fast** — it never silently degrades to unsandboxed execution (Architecture.md §6)
- Run `openclaw doctor` for diagnostics

## Troubleshooting

### `unknown configuration key: agents.defaults.sandbox.mapDir` (or `sandbox.env`)

You put Sandcastle-specific keys inside the core `sandbox` block. OpenClaw core validates that block against a **strict** schema and rejects `mapDir`/`env` as unknown keys.

**Fix:** move `mapDir`/`env` to the plugin's own config namespace:

```json5
plugins: {
  entries: {
    "openclaw-sandcastle": {
      enabled: true,
      config: {
        mapDir: [...],
        env: { ... }
      }
    }
  }
}
```

Only core keys (`backend`, `mode`, `scope`, `workspaceAccess`, …) belong under `agents.defaults.sandbox`.

### `bwrap: setting up uid map: Permission denied`

AppArmor is blocking unprivileged user namespaces. Options:

- Grant the OpenClaw process the required namespaces via AppArmor profile
- Set `kernel.apparmor_restrict_unprivileged_userns=0` (host-wide, has security tradeoffs)
- Run `openclaw doctor` for specific guidance

### `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`

Related to network namespace restrictions. Since Sandcastle v1 doesn't use `--unshare-net`, this error shouldn't appear. If it does, report it as a bug.

### Agent can't find commands / tools

The sandbox only has the default OS mounts plus your configured binds. If the agent needs Node.js, Python, or other runtimes:

- Ensure the runtime is installed on the host under a path that's in the default mounts (e.g. `/usr/bin/node`)
- Or add the runtime's directory to `mapDir`

### File operations return "file not exist" unexpectedly

Check your deny rules. A glob pattern may be broader than intended. Use `openclaw sandbox explain` to see the effective mount set and deny rules.

### Background process not found

The PID may have been cleaned up or the namespace lost. Ensure the host is stable and the process was started with `nohup`/`setsid`.

## Security Model

### What Sandcastle Protects Against

- **Secret file disclosure to LLMs** — the primary threat. Secret paths (`~/.ssh`, `.env`, credentials) are not mounted, so they don't exist in the agent's world.
- **Accidental file reads** — even if an agent tries `read("~/.aws/credentials")`, the path policy layer returns "file not exist."

### What Sandcastle Does NOT Protect Against

- **Network access** — sandboxed agents have full host network access in v1
- **Process visibility** — `/proc` shows only sandbox-internal processes (private PID namespace via `--unshare-pid`), but procfs itself is writable in v1
- **Resource exhaustion** — no CPU/memory limits (bwrap doesn't enforce cgroups by default)
- **Kernel exploits** — bwrap is not a security boundary against kernel vulnerabilities

### Not a Security Boundary

Sandcastle materially reduces the risk of accidental secret disclosure. It is **not** a defense against a determined adversary with code execution. For hostile workloads, use the Docker sandbox backend with full container isolation.

## CLI Reference

| Command | Sandcastle Behavior |
|---|---|
| `openclaw sandbox list` | Nothing to list (ephemeral) |
| `openclaw sandbox explain` | Shows effective config, mounts, map rules, deny rules, env vars |
| `openclaw sandbox recreate` | No-op (each call is already fresh) |
| `openclaw doctor` | Checks bwrap availability, capabilities, and auto-download status |
