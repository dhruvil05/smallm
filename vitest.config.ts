import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keeps tests from ever reading/writing the developer's real smallm cache.
    setupFiles: ["./test/setup-isolated-cache.ts"],
  },
});
