import { configDefaults, defineConfig } from 'vitest/config';

// .superlite/audit 의 감사 실험은 감사 당시 동작을 고정한 참고용이라 기본 실행에서 뺀다.
export default defineConfig({ test: { environment: 'jsdom', exclude: [...configDefaults.exclude, '.superlite/**'] } });
