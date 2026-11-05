import { defineConfig } from 'vitest/config';

// The built-in database takes a few seconds to start, and longer on a busy
// cloud machine, so the first test in each file gets more than the default 5s.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
