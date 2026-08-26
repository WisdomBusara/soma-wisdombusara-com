import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Runs before any test module is imported, so config/env can validate.
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts'],
    // Network-touching modules are never exercised by these unit tests, but a
    // hung socket should still fail loudly rather than stall CI.
    testTimeout: 15_000
  }
});
