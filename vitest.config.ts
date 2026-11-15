import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // DB integration tests share one database; run files serially.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
