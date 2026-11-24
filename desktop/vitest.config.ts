import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    dir: "./src",
    environment: "node",
    include: ["**/*.test.ts"],
    passWithNoTests: true,
  },
});
