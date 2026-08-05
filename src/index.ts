/**
 * openclaw-sandcastle — plugin entry.
 *
 * Registers the "bwrap" sandbox backend (Architecture.md §2, §5).
 * Any agent can opt in via `sandbox: { backend: "bwrap", ... }`.
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

    registerSandboxBackend("bwrap", {
      factory: createBwrapSandboxBackendFactory(() => storedPluginConfig),
      manager: bwrapSandboxBackendManager,
    });
  },
});

export default plugin;
