/**
 * Lifecycle helpers (Architecture.md §4.2).
 *
 * Sandboxes are ephemeral: a fresh bwrap instance per exec call. Background
 * processes that must outlive the exec wrapper detach via nohup/setsid, with
 * PID tracking so follow-up interaction can re-enter the namespace via
 * nsenter.
 *
 * These helpers are pure command constructors — OpenClaw's process layer
 * drives the actual spawn; keeping them as pure functions makes them
 * mock-testable.
 */

/** Wrap a command so it detaches from the exec wrapper's process group. */
export function buildDetachedCommand(command: string): string {
  return `setsid nohup ${command} >/dev/null 2>&1 & echo $!`;
}

/** Re-enter a tracked background PID's namespaces to run a follow-up command. */
export function buildNsenterCommand(pid: number, command: string): string {
  return `nsenter --target ${pid} --all -- ${command}`;
}

/** Simple in-process PID registry for background sandbox processes. */
export class PidRegistry {
  private pids = new Map<string, number>();

  track(key: string, pid: number): void {
    this.pids.set(key, pid);
  }

  get(key: string): number | undefined {
    return this.pids.get(key);
  }

  untrack(key: string): void {
    this.pids.delete(key);
  }

  list(): Array<{ key: string; pid: number }> {
    return [...this.pids.entries()].map(([key, pid]) => ({ key, pid }));
  }
}
