import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Per-test timeout bumped because golden snapshot tests parse EPUBs
    // (P&P illustrated is ~25 MB) and run the full pipeline end to end.
    testTimeout: 60_000,
    // Run fixture tests sequentially to keep memory / network usage sane.
    fileParallelism: false,
    // Skip the whole fixture test file if fixtures are not downloaded.
    // This keeps `pnpm test` friendly when someone hasn't run the
    // download script yet, without polluting test output with errors.
    passWithNoTests: false,
  },
});
