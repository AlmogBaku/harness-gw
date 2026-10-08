import { configDefaults, defineConfig } from "vitest/config"

/**
 * Checks that run a build or an external tool. They change only with the
 * build or the package, so `bun run test` skips them and `bun run test:gate`
 * runs them.
 */
const gateTests = ["test/architecture/adapter-boundaries.test.ts"]

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "dist/**"],
    restoreMocks: true,
    // The budget bounds a hung test, not a slow one: a passing test never
    // waits for it, and a loaded machine slows the socket tests several times.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Half the cores keeps a sweep beside another one, or beside a live
    // deployment on the same host, survivable; a machine running one sweep
    // alone can raise it.
    maxWorkers: Number(process.env.HARNESS_GW_TEST_WORKERS) || "50%",
    // Lists the slowest tests past their project's budget after every run.
    reporters: ["default", "./test/support/slow-tests-reporter.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["**/*.test.ts"],
          exclude: gateTests,
        },
      },
      {
        extends: true,
        test: { name: "gate", environment: "node", include: gateTests },
      },
    ],
  },
})
