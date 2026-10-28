// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { RequestRecord } from '../../../core/requests/types.js';

const mocks = vi.hoisted(() => ({
  describeFetchCause: vi.fn<(r: RequestRecord, w: boolean) => unknown>(),
  overlapCancelOf: vi.fn<(r: RequestRecord) => string[] | undefined>(),
}));
vi.mock('../../contexts.js', () => ({ useRequestActions: () => ({ classOf: () => 'same-response' }) }));
vi.mock('../../../core/reactQuery/fetchCause.js', () => ({ describeFetchCause: mocks.describeFetchCause }));
vi.mock('../../../core/reactQuery/cacheAudit.js', () => ({ overlapCancelOf: mocks.overlapCancelOf }));

const { FetchCause } = await import('../FetchCause.js');
const rec = { id: 1, kind: 'fetch', method: 'GET', url: '/a', startedAt: 0, durationMs: 1 } as RequestRecord;

describe('요청 상세 fetch 원인', () => {
  it('관찰자·원인·근거·처방을 보인다', () => {
    mocks.describeFetchCause.mockReturnValue({
      cause: 'enabled',
      label: '관찰자의 enabled 가 켜져 stale 이라 받음',
      queryKey: '["a"]',
      observer: 'InviteModal',
      evidence: 'staleTime 0ms',
      fix: 'staleTime 을 주세요',
    });
    mocks.overlapCancelOf.mockReturnValue(undefined);
    const html = renderToStaticMarkup(<FetchCause record={rec} />);
    expect(html).toContain('InviteModal');
    expect(html).toContain('enabled');
    expect(html).toContain('staleTime 을 주세요');
  });

  it('겹친 무효화로 취소된 요청은 원인과 두 호출 위치를 보인다', () => {
    mocks.describeFetchCause.mockReturnValue(undefined);
    mocks.overlapCancelOf.mockReturnValue(['at a (a.ts:1:1)', 'at b (b.ts:2:2)']);
    const html = renderToStaticMarkup(<FetchCause record={rec} />);
    expect(html).toContain('무효화가 겹쳐 취소됨');
    expect(html).toContain('a.ts:1:1');
    expect(html).toContain('b.ts:2:2');
  });

  it('둘 다 없으면 그리지 않는다', () => {
    mocks.describeFetchCause.mockReturnValue(undefined);
    mocks.overlapCancelOf.mockReturnValue(undefined);
    expect(renderToStaticMarkup(<FetchCause record={rec} />)).toBe('');
  });
});
