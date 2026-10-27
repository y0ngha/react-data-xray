import { describe, expect, it } from 'vitest';

import { mockFetch } from '../../../testing/fetchMock.js';
import { parseMappings, resolveStack } from '../sourceMap.js';

// 변환된 3번째 줄 0열 → 원본 0번 소스의 10번째 줄(0 부터 9) 3번째 열(0 부터 2). VLQ: 0=A, 9→18=S, 2→4=E
const MAPPINGS = ';;AASE';
const inlineMap = (map: object) => `data:application/json;base64,${btoa(JSON.stringify(map))}`;

describe('소스맵', () => {
  it('mappings 를 줄별 구간으로 풀고 앞 구간 기준 차이를 누적한다', () => {
    expect(parseMappings(MAPPINGS)).toEqual([[], [], [{ column: 0, source: 0, line: 9, sourceColumn: 2 }]]);
    // 두 번째 구간은 앞 구간에서 열 +2, 줄 +1 (C=1, C=1 은 +1, E=+2)
    expect(parseMappings('AASE,EACC')[0][1]).toEqual({ column: 2, source: 0, line: 10, sourceColumn: 3 });
  });

  it('스택의 위치를 원본 위치로 바꾸고, 라이브러리 프레임과 소스맵이 없는 모듈은 그대로 둔다', async () => {
    // Vite 처럼 sources 가 모듈 위치 기준 상대 경로(파일 이름만)여도 모듈 주소로 풀어 경로를 살린다.
    const code = `a\nb\nload()\n//# sourceMappingURL=${inlineMap({ version: 3, sources: ['api.ts'], mappings: MAPPINGS })}`;
    mockFetch.mockImplementation(async (input) =>
      String(input).includes('/src/api.ts') ? new Response(code) : new Response('no map here'),
    );
    const stack = [
      'at load (http://localhost:3000/src/api.ts?t=1:3:5)',
      'at Plain (http://localhost:3000/src/plain.ts:1:1)',
      'at lib (http://localhost:3000/node_modules/.vite/deps/react.js:9:9)',
    ].join('\n');
    expect(await resolveStack(stack)).toBe(
      [
        'at load (src/api.ts:10:3)',
        'at Plain (http://localhost:3000/src/plain.ts:1:1)',
        'at lib (http://localhost:3000/node_modules/.vite/deps/react.js:9:9)',
      ].join('\n'),
    );
    expect(mockFetch.mock.calls.map(([u]) => String(u)).some((u) => u.includes('node_modules'))).toBe(false);
  });

  it('원본 경로는 프로젝트 기준으로 남긴다: 상대 경로는 서버 경로 그대로, 파일 시스템 절대 경로는 마지막 src/ 부터', async () => {
    const moduleWith = (sources: string[]) =>
      `a\nb\nload()\n//# sourceMappingURL=${inlineMap({ version: 3, sources, mappings: MAPPINGS })}`;
    mockFetch.mockImplementation(
      async (input) =>
        new Response(String(input).includes('Button') ? moduleWith(['Button.tsx']) : moduleWith(['/Users/me/app/web/src/pages/Home.tsx'])),
    );
    expect(await resolveStack('at B (http://localhost:3000/src/components/Button.tsx:3:1)')).toBe('at B (src/components/Button.tsx:10:3)');
    expect(await resolveStack('at H (http://localhost:3000/src/pages/Home.tsx:3:1)')).toBe('at H (src/pages/Home.tsx:10:3)');
  });

  it('앱과 라이브러리를 묶은 큰 번들은 소스맵을 받지 않는다', async () => {
    mockFetch.mockImplementation(async () => new Response(`${'x'.repeat(1_000_001)}\n//# sourceMappingURL=bundle.js.map`));
    const frame = 'at f (http://localhost:3000/static/js/bundle.js:3:1)';
    expect(await resolveStack(frame)).toBe(frame);
    expect(mockFetch.mock.calls.some(([u]) => String(u).endsWith('.map'))).toBe(false);
  });
});
