import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests talk to a real Overleaf server; give network calls room.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
