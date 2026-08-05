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

Add Sandcastle to your OpenClaw config:

```json5
// openclaw.json
{
  agents: {
    defaults: {
      sandbox: {
        backend: "bwrap",
        bwrap: {
          binds: [
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

That's it. Non-main agent sessions now run sandboxed.

---

## What You Can Do

### Control File Access

Use **bind rules** to decide exactly what the sandbox can see:

| Syntax | Meaning |
|---|---|
| `/path` | Read-only access (default) |
| `/path:rw` | Read-write access |
| `/path:ro` | Read-only (explicit) |
| `-/path/**` | **Deny** — block this path (always wins) |
| `+~/path` | **Force-allow** — mount paths under home |

Supports standard globs (`*`, `**`, `?`).

### Control Environment Variables

```json5
env: {
  PATH: true,               // pass through from host
  HOME: true,               // pass through
  NODE_ENV: "production",   // set a custom value
  OPENAI_API_KEY: false     // explicitly blocked
}
```

Unlisted variables are stripped automatically. Only `PATH`, `HOME`, `USER`, `LANG`, and `LC_ALL` pass through by default.

### Background Processes

Background processes work normally — they survive after the command exits and can be interacted with in subsequent calls.

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
