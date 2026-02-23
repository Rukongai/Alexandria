import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Run all tests in a single process serially — avoids database conflicts
    // in integration tests and matches how the app runs.
    singleThread: true,
    exclude: ['dist/**', 'node_modules/**'],
    env: {
      DATABASE_URL: 'postgresql://alexandria:alexandria@localhost:5433/alexandria_test',
    },
  },
  resolve: {
    // Support .js extension imports in ESM TypeScript source
    extensions: ['.ts', '.js'],
  },
});
