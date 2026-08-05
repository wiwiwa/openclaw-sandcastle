# openclaw-sandcastle — Architecture

**Owner:** Morgan (Arki, architect)
**Status:** v1 — aligned to locked PM design spec (Prada). Dev source of truth for Jordan.
**Last updated:** 2026-08-04

This document is the **single source of truth** for how openclaw-sandcastle is structured. If it disagrees with the README or UserGuide, this file wins.

---

## 1. Purpose

Sandcastle is a lightweight, **ephemeral filesystem sandbox** for OpenClaw agents. It wraps every agent `exec` call in a fresh [bubblewrap](https://github.com/containers/bubblewrap) (bwrap) mount-namespace instance so a sub-agent only ever sees the filesystem it is explicitly granted.

The motivating threat model is **credential confidentiality**: API keys, tokens, and credentials must **never reach the LLM's context**. Denial happens at the filesystem boundary — a secret path is not merely hidden from prompts, it is unreadable and unlistable from inside the sandbox.

### Security posture (read this first)

> **Sandcastle provides *filesystem confidentiality*, NOT network isolation.**

A sandboxed agent has **full network access** in v1. Sandcastle must never be described or relied upon as an egress/exfiltration boundary. It protects *what is on disk* from *leaking into model context*; it does not prevent a compromised sandbox from phoning home. Network packet filtering is **explicitly out of scope for current value** (boss-ratified). If egress containment is ever needed, it is a separate capability (`--unshare-net` + selective `/etc/resolv.conf` bind), designed on its own, not bolted onto v1.

---

## 2. System Context

```
                     ┌──────────────────────────────┐
                     │        OpenClaw Gateway      │
                     │                              │
                     │  sandbox backend: "bwrap"    │
                     └──────────────┬───────────────┘
                                    │
                          exec / file-tool call
                                    │
                     ┌──────────────▼───────────────┐
                     │       Sandcastle Plugin      │
                     │                              │
                     │  • config resolution (merge) │
                     │  • bind-rule engine (glob)   │
                     │  • env filtering (deny-DFLT) │
                     │  • bwrap invocation builder  │
                     │  • PID/nsenter lifecycle     │
                     └──────────────┬───────────────┘
                                    │ spawns
                     ┌──────────────▼───────────────┐
                     │       bwrap sandbox (NS)     │
                     │  private PID nspc + mount ns │
                     │  minimal OS fs + user binds  │
                     │  script/command runs here    │
                     └──────────────┬───────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
     ┌────────▼───────┐    ┌────────▼───────┐    ┌────────▼───────┐
     │ default mounts │    │  user binds    │    │  denied paths  │
     │ /usr /lib/bin  │    │  glob/ro/rw    │    │  -**/.env etc. │
     │ (ro) /tmp      │    │  + force-allow │    │  (unreachable) │
     └────────────────┘    └────────────────┘    └────────────────┘
```

On the host, beside the Gateway:

- **File tools** (`read`/`write`/`edit`/`apply_patch`) are enforced **at the Gateway policy layer**, returning `"file not exist"` (not `"permission denied"`) for denied paths — anti-information-leak.
- **Exec** is enforced via the **bwrap mount namespace**.

---

## 3. Architecture Decisions (ADRs)

An ADR is recorded only when a decision has **structural consequence or irreversibility**. Functional/operational details live in §4–§6, not as ADRs.

### ADR-001 — Bubblewrap backend (not Docker)

- **Decision:** Use bwrap mount namespaces, not Docker or a VM.
- **Rationale:** millisecond startup, no image management, no container runtime overhead. Docker is heavy for quick sub-agent tasks.
- **Consequence:** Linux-only for the bwrap backend; macOS covered separately (ADR-004).

### ADR-002 — No network isolation in v1

- **Decision:** Sandboxed agents keep full network access. (Boss-ratified.)
- **Rationale:** v1 value is filesystem confidentiality of secrets, not egress containment; packet filtering adds complexity with no current value.
- **Consequence:** Sandcastle is *not* an exfiltration boundary (§1 posture). Egress containment is a future, separate capability.

### ADR-003 — Bind-rule precedence: deny wins

- **Decision:** `-` (deny) rules **always** win over allow rules; applied last, after global+per-agent merge.
- **Rationale:** Fail-closed. A global deny must block a path even if per-agent config allows it. The single most important correctness rule.
- **Consequence:** Order: defaults → per-agent merge → apply `-` denys. Allow cannot resurrect a denied path.
- **Env equivalent:** the same fail-closed principle applies to env — deny-by-default + empty-by-construction (see §4.3). Unlisted env vars are absent, not merely hidden.

### ADR-004 — macOS support (planned, not v1)

- **Decision:** Target `sandbox-exec` or Endpoint Security (ES) on macOS; no bwrap there. Backend abstracted behind an interface so the macOS backend plugs in later. v1 ships Linux-only.
- **Rationale:** bwrap is Linux-only; keep the seam ready without building it now.

### ADR-005 — `/proc` private namespace, read-only (architect-owned)

- **Decision:** Mount `/proc` via bwrap `--proc` inside a **private PID namespace** (`--unshare-pid`), read-only. `/dev` via `--dev` (devtmpfs).
- **Rationale / how the defense chains:**
  - Private PID-ns means `/proc` shows **only the sandbox's own processes**, not the host's (no host process/PID enumeration).
  - Read-only mount prevents mutation of kernel interfaces.
  - `/proc/self/environ` still reflects the *sandbox's own* env, so **`/proc` alone cannot be the defense** for secrets. The **authoritative defense is env-stripping / empty-by-construction at the gateway boundary** (§4.3, §6: `--clearenv` + allowlisted `--setenv`); private+ro `/proc` is defense-in-depth so that even a read of `/proc/self/environ` finds secrets already absent.
- **Known limitation (explicit):** `/proc/self/environ` cannot be bind-scrubbed (procfs does not allow overriding individual files), and no exec-time strip survives a process re-exporting a secret to a child. The design therefore guarantees **absence** (empty-by-construction), not **blocking**. Hard read-blocking requires an LSM rule (AppArmor/SELinux deny `@{PROC}/[0-9]*/environ`), which is **deferred / out of scope for v1** due to distro-specific deployment fragility — recorded here to revisit if the threat model escalates.
- **Owner:** Morgan (architect). Decision made, not open.

---

## 4. Functional Design (not ADRs)

These are the locked functional specifications from the PM design spec.

### 4.1 Home-parent mount protection
`~/` itself and parent dirs (`/home`, `/`) require the **`+` force-allow** prefix to mount. Subdirs (`~/projects`) mount without `+`. Prevents accidental broad mounts exposing `~/.ssh`, `~/.aws`, `~/.gnupg`.

### 4.2 Ephemeral lifecycle + background processes
- **Ephemeral:** a **fresh bwrap instance per exec call**; no persistent sandbox. Sandbox gone when the command exits; callers own state.
- **Background:** a daemonizing command survives the exec wrapper via `nohup`/`setsid`, with **PID tracking** and **`nsenter`** for follow-up interaction (re-enters the namespace by tracked PID).

### 4.3 Environment: deny-by-default + empty-by-construction
- Schema `{ NAME: true | false | "literal" }`. **Any variable not listed is stripped.**
- `true` = pass host value · `false` = explicit strip · `"string"` = literal override.
- Defaults: `PATH, HOME, USER, LANG, LC_ALL`.
- **Authoritative exec path:** bwrap `--clearenv` + allowlisted `--setenv` (namespace-level) is the single, sufficient mechanism. No additional env wrapper in the default chain.
- **Threat scope (be explicit):** this prevents **accidental self-disclosure** of the sandbox env to the LLM. It is **not enforcement** against a process inside the sandbox re-exporting a secret and running a child (whose `/proc/self/environ` would then contain it). Hard read-blocking is an explicit non-goal (ADR-005, §11).

### 4.4 File-tool enforcement (Gateway policy)
Non-exec file tools are enforced by Gateway path policy returning **`"file not exist"`** for denied paths (semantically identical to an absent path; avoids leaking existence via "permission denied"). Two consistent layers: file tools (Gateway) and exec (bwrap NS).

### 4.5 Default OS mounts (fixed, not removable)
| Path | Mode |
|---|---|
| `/usr`, `/lib`, `/lib64` (if present), `/bin`, `/sbin` | read-only bind |
| `/dev` | devtmpfs (`--dev`) |
| `/proc` | **private PID-ns, read-only** (ADR-005) |
| `/tmp` | tmpfs (`--tmpfs`) |

---

## 5. Runtime Components

| Component | Responsibility | Interfaces |
|---|---|---|
| **Config resolver** | Merges global + per-agent sandbox config | `merged Binds[]`, `merged Env{}`, mode/scope/workspace |
| **Bind-rule engine** | Compiles glob binds → ordered bwrap mount flags; enforces deny-wins + `+` force-allow + home-parent guard | glob → `--ro-bind` / `--bind` / deny |
| **Env filter** | Produces final env map (deny-by-default) | `Env{}` → `--setenv` / stripped set |
| **bwrap invocation builder** | Assembles exact `bwrap` argv (§6) | config → argv[] |
| **Lifecycle / PID tracker** | Wraps exec with nohup/setsid; records PID; supports nsenter follow-up | exec → subprocess, PID registry |
| **Auto-downloader** | Fetches `bubblewrap-static` from Alpine latest-stable to `~/.cache/openclaw/bwrap/` when `bwrap` not on PATH | → bwrap binary path |

The **bwrap backend interface** is the seam ADR-004 will replace with a macOS backend. Keep the invocation builder backend-agnostic: emit "mounts / env / command" facts, let the selected backend turn them into real flags.

---

## 6. The bwrap Invocation (canonical, v1)

Order matters. Jordan implements this shape:

```bash
bwrap \
  --unshare-pid --unshare-uts --unshare-ipc --unshare-user \
  --die-with-parent \
  --ro-bind /usr /usr \
  --ro-bind /lib /lib \
  --ro-bind /bin /bin \
  [ --ro-bind /lib64 /lib64 ]            # only if host has /lib64
  --ro-bind /sbin /sbin \
  --dev /dev \
  --proc /proc                           # private PID-ns, read-only (ADR-005)
  --tmpfs /tmp \
  [ --bind <host> <guest> ]              # each :rw bind
  [ --ro-bind <host> <guest> ]           # each :ro / default bind
  [ --setenv NAME value ]                # per allowlisted env entry
  --chdir <workspace> \
  [ --clearenv ] \                       # enforce deny-by-default start (ns-level)
  -- <command...>
```

Notes:
- **`--unshare-user`** required for unprivileged bwrap; if the host forbids user namespaces (e.g. AppArmor), **fail fast** with a clear error — never silently degrade to unsandboxed.
- Not-a-default OS mounts precede user binds so user binds layer on top.
- **Deny rules produce no argv** — resolved upstream by the bind-rule engine, which also rejects a deny overlapping an inherited default mount (e.g. `-/usr` → config error).
- **`--clearenv`** (when supported) + allowlisted `--setenv` is the single, authoritative env control — sufficient for the stated threat model (accidental self-disclosure). No `env -i` wrapper in the default chain.
- **Fallback (implementation note):** `--clearenv`/`--setenv` behavior is version-dependent. *If* a specific bwrap version proves unreliable at clearing the namespace env, add an `env -i [NAME=value] ... -- <cmd>` wrapper as the final exec step — a contingency, not a default layer. Guarantees absence (nothing secret in `/proc/self/environ`), not blocking (see ADR-005 limitation).
- **`--die-with-parent`** guarantees the namespace dies with the wrapper — no orphaned sandbox.

---

## 7. Data Flow

1. Agent issues `exec` or file-tool call for a sandboxed session (mode/scope gate).
2. Config resolver produces merged binds + env.
3. **Bind-rule engine** resolves allow/deny → ordered mount flags (fail-closed on deny-wins, §4.1).
4. **Env filter** produces final env map (unlisted = stripped, §4.3).
5. **Invocation builder** assembles argv per §6.
6. bwrap launches the sandbox; command runs inside a **private pid+mount namespace**.
7. On exit, namespace torn down (**ephemeral**).
8. Backgrounded: nohup/setsid detachment + PID recorded; follow-up via `nsenter`.

File-tool calls bypass bwrap → **Gateway path policy**, returning `"file not exist"` for denied paths (§4.4).

---

## 8. Config Surface

Full user-facing detail: `docs/UserGuide.md`. Architecturally relevant:

| Setting | Meaning | Default |
|---|---|---|
| `sandbox.backend` | `"bwrap"` (v1) | enabled path |
| `sandbox.mode` | `off` / `non-main` / `all` | `off` |
| `sandbox.scope` | `agent` / `session` / `shared` | `agent` |
| `sandbox.workspaceAccess` | `none` / `ro` / `rw` | `none` |
| `sandbox.bwrap.binds` | glob bind list (merged) | `[]` |
| `sandbox.bwrap.env` | env map (deny-by-default) | `{PATH,HOME,USER,LANG,LC_ALL:true}` |

**`scope` note (architect recommendation):** `shared` implies a *persistent* sandbox namespace, which conflicts with the ephemeral-per-exec lifecycle (§4.2). **Recommend v1 ships `agent` + `session` only; defer `shared`.** Flagged to PM (Prada) for sign-off; until confirmed, implement `agent` + `session`.

---

## 9. Acceptance Mapping (trace to workboard card)

| Card acceptance | Where it lives |
|---|---|
| Sub-agent runs isolated via bwrap | §6 invocation, §7 flow |
| Only whitelisted paths visible | §5 bind engine, ADR-003 |
| Denied paths unreadable **and** unlisted | §4.4 (file tools), §6 (exec: deny → no argv; "file not exist") |
| Document exact bwrap invocation/flags | §6 ✅ |

---

## 10. Risks & Open Items

1. **User-namespace availability** on host — fail fast, never silently degrade (§6).
2. **`/proc/self/environ` env re-exposure** — mitigated by env-stripping (ADR-005); revisit if a runtime still sees secrets there.
3. **macOS backend** (ADR-004) — deferred; interface seam only.
4. **`scope: shared`** — deferred pending PM sign-off (§8).

---

## 11. Non-Goals (explicit)

- **Network isolation / packet filtering** — out of scope (ADR-002, boss-ratified).
- **Full container/VM isolation** — bwrap namespaces only.
- **Windows support** — not addressed.
- **Durable cross-call state** — lifecycle is ephemeral by design.
- **Hard enforcement against in-sandbox env re-injection** (LSM rule denying `/proc/*/environ`) — deferred, known limitation; not a v1 guarantee. v1 provides absence-by-construction, not read-blocking (ADR-005, §4.3).

---

## 12. Related Documents

- `README.md` — overview, quick start, bind syntax.
- `docs/UserGuide.md` — operational/config detail.
- Workboard card `eaa8fef5-…` — original requirement + locked design spec.
