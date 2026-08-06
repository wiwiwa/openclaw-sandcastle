/**
 * openclaw-sandcastle — plugin entry.
 *
 * Registers the "sandcastle" sandbox backend (Architecture.md §2, §5).
 * The alias "bwrap" is registered as a deprecated alias for backwards
 * compatibility and will be removed in 1.0.
 *
 * Any agent can opt in via `sandbox: { backend: "sandcastle", ... }`.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import type { SandcastlePluginConfig } from "./config.js";
import { createBwrapSandboxBackendFactory, bwrapSandboxBackendManager } from "./bwrap-backend.js";

let storedPluginConfig: SandcastlePluginConfig = {};

const plugin: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: "openclaw-sandcastle",
  name: "Sandcastle",
  description: "Lightweight ephemeral bwrap filesystem sandbox for OpenClaw agents (secret-path isolation, no Docker).",

  register(api) {
    storedPluginConfig = (api.pluginConfig as SandcastlePluginConfig) ?? {};

    const factory = createBwrapSandboxBackendFactory(() => storedPluginConfig);

    // Primary backend name (Architecture.md §8).
    registerSandboxBackend("sandcastle", {
      factory,
      manager: bwrapSandboxBackendManager,
    });

    // Deprecated alias — same factory, removed in 1.0.
    registerSandboxBackend("bwrap", {
      factory,
      manager: bwrapSandboxBackendManager,
    });
  },
});

export default plugin;
