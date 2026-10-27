import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { install } from './capture.js';
import { RequestDetail } from './Devtools.js';
import { clearRecords, getRecords } from './registry.js';

const mockFetch = vi.fn(async (_input?: unknown, _init?: unknown) =>
  new Response(JSON.stringify({ data: { id: 7, name: 'cpu' } }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-trace': 'abc' },
  }),
);

beforeAll(() => {
  window.fetch = mockFetch as typeof fetch;
  install();
});
beforeEach(() => clearRecords());
afterEach(() => cleanup());

describe('요청 상세', () => {
  it('요청·응답 헤더와 응답 원문을 기록한다', async () => {
    await fetch('/api/item?id=7', { method: 'POST', headers: { 'X-Token': 't1' }, body: '{"id":7}' });
    await new Promise((r) => setTimeout(r, 0));

    const [record] = getRecords();
    expect(record.requestHeaders).toEqual({ 'x-token': 't1' });
    expect(record.responseHeaders).toMatchObject({ 'x-trace': 'abc' });
    expect(record.responseText).toBe('{"data":{"id":7,"name":"cpu"}}');
  });

  it('실패한 요청도 목록에 남기고 앱에는 원래 에러를 던진다', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(fetch('/api/down')).rejects.toThrow('Failed to fetch');
    expect(getRecords()[0]).toMatchObject({ url: '/api/down', status: 0, error: 'TypeError: Failed to fetch' });
  });

  it('상세 화면에 query, 헤더, 본문, 컴포넌트가 쓰는 값을 보여 준다', async () => {
    await fetch('/api/item?id=7', { method: 'POST', headers: { 'X-Token': 't1' }, body: '{"id":7}' });
    await fetch('/api/item?id=7', { method: 'POST', headers: { 'X-Token': 't1' }, body: '{"id":7}' }).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 0));
    const record = getRecords()[1];

    render(<RequestDetail record={record} focus={{ path: '$.data', via: 'props.item' }} onBack={() => undefined} />);

    expect(screen.getByText(/이 컴포넌트가 쓰는 데이터: \$\.data ← props\.item/)).toBeTruthy();
    expect(screen.getByText('id:')).toBeTruthy();
    expect(screen.getByText('x-token:')).toBeTruthy();
    expect(screen.getAllByText(/"name": "cpu"/).length).toBeGreaterThan(0);
    expect(screen.getByText(/중복 요청/)).toBeTruthy();
  });
});
