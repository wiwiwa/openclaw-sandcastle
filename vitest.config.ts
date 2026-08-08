import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    api: false,
    server: {
      host: "127.0.0.1",
    },
  },
});
