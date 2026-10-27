import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['src/testing/setup.ts'],
    // .superlite/audit 의 감사 실험은 감사 당시 동작을 고정한 참고용이라 기본 실행에서 뺀다.
    exclude: [...configDefaults.exclude, '.superlite/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/__tests__/**', 'src/**/types.ts', 'src/testing/**'],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 75 },
    },
  },
});
