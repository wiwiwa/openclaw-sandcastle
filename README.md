# 🏰 Sandcastle

**Fast, lightweight sandboxing for [OpenClaw](https://openclaw.ai) agents.**

No Docker containers. No VMs. No image builds. Just instant isolation that keeps your secrets safe and your agents contained — in milliseconds, not seconds.

---

## Why Sandcastle?

OpenClaw's Docker sandbox is powerful but heavy. Container startup, image management, and resource overhead are overkill for most workflows — especially quick sub-agent tasks.

Sandcastle gives you the same isolation guarantees at a fraction of the cost:

- ⚡ **~50ms startup** vs 500ms–2s for Docker
- 🔒 **Secrets stay out** — `~/.ssh`, `~/.aws`, `.env` files never enter the sandbox by default
- 🧹 **Ephemeral by design** — each command gets a fresh sandbox; nothing persists after exit
- 🪶 **Zero setup** — no images to build, no daemon to run, auto-installs on first use
- 🐧 **Native environment** — same OS, libs, and tools as your host. No missing binaries, no broken paths, no "works in Docker but not here" surprises

---

## Quick Start

### 1. Install

Sandcastle is published on [ClawHub](https://clawhub). Install it with:

```bash
openclaw plugins install clawhub:openclaw-sandcastle
```

### 2. Configure

Add Sandcastle to your OpenClaw config:

```json5
// openclaw.json
{
  agents: {
    defaults: {
      sandbox: {
        backend: "sandcastle",   // core key: select the sandcastle backend
        mode: "non-main"         // core key: sandbox non-main sessions
      }
    }
  },
  plugins: {
    entries: {
      "openclaw-sandcastle": {
        enabled: true,
        config: {
          mapDir: [
            "/home/user/projects/myapp:rw",  // read-write project access
            "~/OpenClaw",                    // read-only home subdir
            "-**/.env",                      // block .env everywhere
            "-~/.ssh/**"                     // block SSH keys
          ]
        }
      }
    }
  }
}
```

> **Where config lives:** core sandbox keys (`backend`, `mode`, `scope`, `workspaceAccess`) go under `agents.defaults.sandbox`. Sandcastle's own keys (`mapDir`, `env`) go under `plugins.entries."openclaw-sandcastle".config` — the namespace OpenClaw validates against the plugin's schema. Putting `mapDir`/`env` under `agents.defaults.sandbox` triggers `unknown configuration key` and they are ignored.

That's it. Non-main agent sessions now run sandboxed.

---

## What You Can Do

### Control File Access

Use **map rules** to decide exactly what the sandbox can see:

| Syntax | Meaning |
|---|---|
| `/path` | Read-only access (default) |
| `/path:rw` | Read-write access |
| `/path:ro` | Read-only (explicit) |
| `-/path/**` | **Deny** — block this path (always wins) |
| `+~/path` | **Force-allow** — mount paths under home |

Deny rules support standard globs (`*`, `**`, `?`). Allow rules require concrete paths in v1.

> **Path rules:** All paths must be absolute or `~`-prefixed (relative paths are rejected at config load). `~` is expanded to the home directory; symlinks on host paths are resolved to their real target before binding (guest paths keep the configured name). Deny-rule globs are matched at runtime against path lookups.

### Control Environment Variables

```json5
// inside plugins.entries."openclaw-sandcastle".config:
env: {
  PATH: true,               // pass through from host
  HOME: true,               // pass through
  NODE_ENV: "production",   // set a custom value
  OPENAI_API_KEY: false     // explicitly blocked
}
```

Unlisted variables are stripped automatically. Only `PATH`, `HOME`, `USER`, `LANG`, and `LC_ALL` pass through by default.

### Background Processes

Background process support is in progress for v1 — helper functions exist (`nohup`/`setsid` + PID tracking + `nsenter`) but are not yet wired into the exec path. See [Architecture.md §4.2](docs/Architecture.md) for status.

---

## Sandcastle vs Docker

| | Docker | Sandcastle |
|---|---|---|
| Startup latency | 500ms–2s | ~10–50ms |
| Isolation | Full container | Filesystem + mount namespace |
| Network isolation | ✅ | ❌ (planned) |
| Resource overhead | High | Minimal |
| Browser sandbox | ✅ | ❌ |
| Setup | Build image | Auto-download, zero config |

**Good fit for:** sub-agent tasks, quick file operations, CI-adjacent work, any workflow where Docker is overkill.

**Not yet a fit for:** workflows needing network isolation or browser sandboxing.

---

## Platform Support

| Platform | Status |
|---|---|
| Linux | ✅ Available now |
| macOS | 🔜 Planned |

---

## License

Same as OpenClaw.
