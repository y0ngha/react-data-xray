import { fileURLToPath } from 'node:url';

import { defineConfig, mergeConfig } from 'vitest/config';

import base from './vitest.config.ts';

// 개발 의존성의 react 는 18 이다. 같은 테스트를 tests/react19 에 따로 설치한 React 19 로 다시 돌린다.
// React 를 쓰는 테스트 라이브러리도 그쪽 것을 써야 react·react-dom 이 한 벌로 맞는다.
const react19 = (name: string) => fileURLToPath(new URL(`./tests/react19/node_modules/${name}`, import.meta.url));
const PACKAGES = ['react-dom', 'react', '@testing-library/react', '@tanstack/react-query'];

export default mergeConfig(
  base,
  defineConfig({
    resolve: {
      alias: PACKAGES.flatMap((name) => [
        { find: new RegExp(`^${name}$`), replacement: react19(name) },
        { find: new RegExp(`^${name}/(.*)$`), replacement: `${react19(name)}/$1` },
      ]),
    },
    test: { env: { RDX_REACT_MAJOR: '19' } },
  }),
);
