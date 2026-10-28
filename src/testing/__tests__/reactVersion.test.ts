import { version } from 'react';
import { version as domVersion } from 'react-dom';
import { expect, it } from 'vitest';

// pnpm test:react19 가 정말 19 로 도는지(별칭이 빠지면 18 로 조용히 통과한다).
it('테스트가 의도한 React 주 버전으로 돈다', () => {
  const major = process.env.RDX_REACT_MAJOR ?? '18';
  expect(version.split('.')[0]).toBe(major);
  expect(domVersion.split('.')[0]).toBe(major);
});
