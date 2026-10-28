// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { RequestRecord } from '../../../core/requests/types.js';

vi.mock('../../contexts.js', () => ({ useRequestActions: () => ({ classOf: () => 'duplicate' }) }));

const { ClassBadge } = await import('../ClassBadge.js');

const rec = (status: number): RequestRecord => ({
  id: 1,
  kind: 'fetch',
  method: 'GET',
  url: '/a',
  status,
  startedAt: 0,
  durationMs: 1,
  body: undefined,
});

describe('ClassBadge 실패 응답', () => {
  it('503_vs_200: 503 중복은 실패 응답이 붙고 200 중복은 그대로', () => {
    expect(renderToStaticMarkup(<ClassBadge record={rec(503)} />)).toContain('중복 요청 · 실패 응답');
    const ok = renderToStaticMarkup(<ClassBadge record={rec(200)} />);
    expect(ok).toContain('중복 요청');
    expect(ok).not.toContain('실패 응답');
  });
});
