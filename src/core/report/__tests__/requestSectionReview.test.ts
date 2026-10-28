import { describe, expect, it, vi } from 'vitest';

import type { RequestRecord } from '../../requests/types.js';
import { buildRequestSection } from '../requestSection.js';

const FRAME = 'at load (http://l/src/api.ts:3:4)';
let id = 0;
const rec = (extra: Partial<RequestRecord>): RequestRecord => ({
  id: ++id,
  kind: 'fetch',
  method: 'GET',
  url: '/api/a',
  status: 200,
  startedAt: 0,
  durationMs: 1,
  body: undefined,
  stack: FRAME,
  ...extra,
});

const callersOf = (records: RequestRecord[], queryOf: (r: RequestRecord) => { queryKey: string } | undefined = () => undefined) =>
  buildRequestSection(records, new Map(), new Set(), queryOf).endpoints[0].callers;

describe('보고서 callers (PR2-5, PR2-4)', () => {
  it('같은 frame 은 경로·컴포넌트가 달라도 하나로 세어 순위가 왜곡되지 않는다', () => {
    const records = [
      rec({ route: '/a', component: 'A' }),
      rec({ route: '/b', component: 'B' }),
      rec({ route: '/c', component: 'C' }),
      rec({ stack: 'at other (http://l/src/o.ts:1:1)', route: '/a' }),
      rec({ stack: 'at other (http://l/src/o.ts:1:1)', route: '/a' }),
    ];
    const callers = callersOf(records);
    expect(callers.map((c) => c.count)).toEqual([3, 2]);
    expect(callers[0].frame).toContain('api.ts');
  });

  it('스택이 끊긴 요청은 호출한 queryKey 별로 가른다', () => {
    const ky = 'at timeout (http://l/node_modules/.vite/deps/ky.js:204:9)';
    const a = rec({ stack: ky, noAppFrame: true });
    const b = rec({ stack: ky, noAppFrame: true });
    const queryOf = (r: RequestRecord) => ({ queryKey: r === a ? '["a"]' : '["b"]' });
    expect(callersOf([a, b], queryOf).map((c) => c.queryKey)).toEqual(['["a"]', '["b"]']);
  });

  it('주어진 queryOf 만 쓴다(주기 업로드는 이미 찾아 둔 것만 넘긴다)', () => {
    const queryOf = vi.fn<(r: RequestRecord) => { queryKey: string } | undefined>();
    callersOf([rec({})], queryOf);
    expect(queryOf).toHaveBeenCalledTimes(1);
  });
});
