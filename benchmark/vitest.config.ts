import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['benchmark/setup.ts'],
    benchmark: {
      include: ['benchmark/**/*.bench.ts'],
    },
  },
});
