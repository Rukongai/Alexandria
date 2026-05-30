import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Run all tests in a single process serially — avoids database conflicts
    // in integration tests (every integration test shares one Postgres DB and
    // relies on the DB containing only its own fixtures) and matches how the
    // app runs. `singleThread` alone is insufficient: Vitest still executes
    // test FILES in parallel, so two files' fixtures can coexist in the shared
    // DB and break count/ordering-sensitive queries. `fileParallelism: false`
    // forces files to run one after another.
    fileParallelism: false,
    exclude: ['dist/**', 'node_modules/**'],
    env: {
      DATABASE_URL: 'postgresql://alexandria:alexandria@localhost:5433/alexandria_test',
    },
  },
  // Vitest 4 moved poolOptions to the top level. Pin to a single fork so the
  // serialized files also share one process (belt-and-suspenders with
  // fileParallelism for the shared-DB integration tests).
  poolOptions: {
    forks: { singleFork: true },
  },
  resolve: {
    // Support .js extension imports in ESM TypeScript source
    extensions: ['.ts', '.js'],
  },
});
