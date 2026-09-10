import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { GALAXY_STATE_DB: ":memory:" },
    setupFiles: ["./tests/state-setup.ts"],
    testTimeout: 10000,
  },
});
