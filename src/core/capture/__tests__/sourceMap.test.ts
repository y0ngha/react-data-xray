import { describe, expect, it, vi } from 'vitest';

import { mockFetch } from '../../../testing/fetchMock.js';
import { configure } from '../../config.js';
import { enqueue, flushQueue, isQueuePending } from '../../scheduler/idleQueue.js';
import { parseMappings, parseMappingsStepped, resolveStack, sourceMapFailures } from '../sourceMap.js';

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

  it('원본 경로는 프로젝트 기준으로 남긴다: 상대 경로는 서버 경로 그대로, 파일 시스템 절대 경로는 마지막 src/ 와 그 앞 폴더부터', async () => {
    const moduleWith = (sources: string[]) =>
      `a\nb\nload()\n//# sourceMappingURL=${inlineMap({ version: 3, sources, mappings: MAPPINGS })}`;
    mockFetch.mockImplementation(
      async (input) =>
        new Response(String(input).includes('Button') ? moduleWith(['Button.tsx']) : moduleWith(['/Users/me/app/web/src/pages/Home.tsx'])),
    );
    expect(await resolveStack('at B (http://localhost:3000/src/components/Button.tsx:3:1)')).toBe('at B (src/components/Button.tsx:10:3)');
    expect(await resolveStack('at H (http://localhost:3000/src/pages/Home.tsx:3:1)')).toBe('at H (web/src/pages/Home.tsx:10:3)');
  });

  it('앱과 라이브러리를 묶은 큰 번들은 소스맵을 받지 않는다', async () => {
    mockFetch.mockImplementation(async () => new Response(`${'x'.repeat(1_000_001)}\n//# sourceMappingURL=bundle.js.map`));
    const frame = 'at f (http://localhost:3000/static/js/bundle.js:3:1)';
    expect(await resolveStack(frame)).toBe(frame);
    expect(mockFetch.mock.calls.some(([u]) => String(u).endsWith('.map'))).toBe(false);
  });

  // Next.js Turbopack dev 의 청크: 모듈마다 offset 을 둔 index map(sections), 경로의 / 는 _ 로 바꾼 이름 (#118)
  const CHUNKS = 'http://localhost:3000/_next/static/chunks';

  it('index map(sections)은 섹션의 offset 만큼 옮겨 그 섹션의 원본 위치로 바꾼다 (#118)', async () => {
    const map = {
      version: 3,
      sources: [],
      sections: [
        // 0번째 줄(0 부터)부터: 그 섹션의 3번째 줄 → a.ts 10번째 줄
        { offset: { line: 0, column: 0 }, map: { version: 3, sources: ['file:///Users/me/app/src/a.ts'], mappings: MAPPINGS } },
        // 10번째 줄 5열부터: 섹션 첫 줄의 열은 offset.column 만큼 밀린다(AASE: 0열 → 10번째 줄 3열)
        { offset: { line: 10, column: 5 }, map: { version: 3, sources: ['file:///Users/me/app/src/b.ts'], mappings: 'AASE;AACC' } },
      ],
    };
    mockFetch.mockImplementation(async (input) =>
      String(input).endsWith('.map') ? new Response(JSON.stringify(map)) : new Response('code\n//# sourceMappingURL=src_x._.js.map'),
    );
    const frame = (line: number, column: number) => `at f (${CHUNKS}/src_x._.js:${line}:${column})`;
    const failuresBefore = sourceMapFailures();
    expect(await resolveStack(frame(3, 1))).toBe('at f (app/src/a.ts:10:3)');
    expect(sourceMapFailures()).toBe(failuresBefore); // 읽을 수 있는 index map 은 실패로 세지 않는다(#76)
    expect(await resolveStack(frame(11, 6))).toBe('at f (app/src/b.ts:10:3)');
    // 다음 줄은 offset.column 이 붙지 않는다(AACC: 0열 → 11번째 줄 4열)
    expect(await resolveStack(frame(12, 1))).toBe('at f (app/src/b.ts:11:4)');
  });

  it('Turbopack 앱 청크는 1MB 를 넘어도 소스맵을 받고, node_modules_… 청크는 받지 않는다 (#118)', async () => {
    const code = `${'x'.repeat(1_200_000)}\nb\nload()\n//# sourceMappingURL=${inlineMap({ version: 3, sources: ['/Users/me/app/src/page.tsx'], mappings: MAPPINGS })}`;
    mockFetch.mockImplementation(async () => new Response(code));
    expect(await resolveStack(`at Page (${CHUNKS}/src_07-h1l2e_fir4._.js:3:1)`)).toBe('at Page (app/src/page.tsx:10:3)');
    const lib = `at jsxDEV (${CHUNKS}/node_modules_next_0xwmtz0bm-kxf._.js:3:1)`;
    expect(await resolveStack(lib)).toBe(lib);
    expect(mockFetch.mock.calls.some(([u]) => String(u).includes('node_modules_'))).toBe(false);
  });

  // Next.js 서버 컴포넌트가 만든 element 의 프레임: about://React/Server/<서버 청크 file URL>?<환경 번호>:줄:열 (#120)
  const SERVER_CHUNK = 'file:///Users/me/app/.next/dev/server/chunks/ssr/%5Broot-of-the-server%5D__0magscunfp0sa._.js';
  const serverFrame = (fn: string, chunk = SERVER_CHUNK) => `at ${fn} (about://React/Server/${chunk}?227:3:1)`;
  const serverMap = { version: 3, sources: ['file:///Users/me/app/src/app/[locale]/page.tsx'], mappings: MAPPINGS };

  it('서버 컴포넌트 프레임은 dev 서버의 /__nextjs_source-map 으로 소스맵을 받아 원본 위치로 바꾼다 (#120)', async () => {
    mockFetch.mockImplementation(async () => new Response(JSON.stringify(serverMap)));
    const failuresBefore = sourceMapFailures();
    expect(await resolveStack(serverFrame('Page'))).toBe('at Page (app/src/app/[locale]/page.tsx:10:3)');
    // 환경 번호(?227)는 떼고, 모듈 코드는 받지 않고 소스맵만 받는다.
    expect(mockFetch.mock.calls.map(([u]) => String(u))).toEqual([`/__nextjs_source-map?filename=${encodeURIComponent(SERVER_CHUNK)}`]);
    expect(sourceMapFailures()).toBe(failuresBefore);
  });

  it('basePath 가 있으면(configure({ reportPath })) 그 밑의 /__nextjs_source-map 으로 받는다 (#120)', async () => {
    configure({ reportPath: '/docs/__rdx/report' });
    mockFetch.mockImplementation(async () => new Response(JSON.stringify(serverMap)));
    const chunk = SERVER_CHUNK.replace('0magscunfp0sa', 'basepath0001');
    expect(await resolveStack(serverFrame('Page', chunk))).toBe('at Page (app/src/app/[locale]/page.tsx:10:3)');
    expect(String(mockFetch.mock.calls[0]?.[0])).toMatch(/^\/docs\/__nextjs_source-map\?filename=/);
  });

  it('소스맵 경로가 없으면(404·204) 서버 프레임을 그대로 두고 실패로 세지 않으며, 서버의 node_modules_… 청크는 받지 않는다 (#120)', async () => {
    const failuresBefore = sourceMapFailures();
    mockFetch.mockImplementation(async (input) =>
      String(input).includes('nomap0001') ? new Response(null, { status: 204 }) : new Response('not found', { status: 404 }),
    );
    const missing = serverFrame('Page', SERVER_CHUNK.replace('0magscunfp0sa', 'missing0001'));
    const empty = serverFrame('Page', SERVER_CHUNK.replace('0magscunfp0sa', 'nomap0001'));
    expect(await resolveStack(missing)).toBe(missing);
    expect(await resolveStack(empty)).toBe(empty);
    expect(sourceMapFailures()).toBe(failuresBefore);
    mockFetch.mockClear();
    const lib = serverFrame('Router', 'file:///Users/me/app/.next/dev/server/chunks/ssr/node_modules_next_dist_0abc._.js');
    expect(await resolveStack(lib)).toBe(lib);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('mappings_parsed_in_steps: 2000줄 mappings 는 flush 전에는 끝나지 않고, flush 뒤 원본 위치로 끝난다', async () => {
    const code = `a\n//# sourceMappingURL=${inlineMap({ version: 3, sources: ['big.ts'], mappings: `${';'.repeat(1999)}AASE` })}`;
    mockFetch.mockImplementation(async () => new Response(code));
    vi.useFakeTimers(); // 배경 구동이 먼저 비우지 못하게
    let done = false;
    const result = resolveStack('at f (http://localhost:3000/src/big.ts:2000:1)').then((r) => ((done = true), r));
    try {
      // 맵을 받아 해석 step 이 큐에 오를 때까지 마이크로태스크를 넘긴다.
      for (let i = 0; i < 50; i++) {
        if (isQueuePending()) break;
        await Promise.resolve();
      }
      expect(isQueuePending()).toBe(true);
      expect(done).toBe(false);
      flushQueue();
      expect(await result).toBe('at f (src/big.ts:10:3)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('parse_yields_to_other_steps: 긴 소스맵 해석은 다음 조각을 큐 뒤에 넣어, 뒤에 넣은 step 이 해석이 끝나기 전에 돈다', async () => {
    vi.useFakeTimers(); // 배경 구동이 먼저 비우지 못하게
    try {
      let parsed = false;
      const parse = parseMappingsStepped(';'.repeat(1999)).then(() => (parsed = true));
      let markerRan = false;
      enqueue(() => (markerRan = true));
      // 한 번에 step 하나씩
      for (let i = 0; i < 3; i++) {
        if (markerRan) break;
        flushQueue(0);
      }
      expect(markerRan).toBe(true);
      await Promise.resolve();
      expect(parsed).toBe(false);
      flushQueue();
      await parse;
    } finally {
      vi.useRealTimers();
    }
  });

  it('parse_result_same: 나눠 푼 결과가 parseMappings 와 같다', async () => {
    const mappings = Array.from({ length: 1200 }, (_, i) => (i % 3 ? 'AASE,EACC' : '')).join(';');
    const stepped = parseMappingsStepped(mappings);
    flushQueue();
    expect(await stepped).toEqual(parseMappings(mappings));
  });

  it('parse_chunk_throw: 조각이 던지면 약속이 거부된다(영영 대기하지 않는다)', async () => {
    const bad = { split: () => [null] } as unknown as string; // group.split 이 던진다
    const stepped = parseMappingsStepped(bad);
    flushQueue();
    await expect(stepped).rejects.toThrow(TypeError);
  });
});
