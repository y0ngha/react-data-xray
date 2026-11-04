import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { StrictMode, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { flush, jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import { auditQueryCache, findQueryClients, resetCacheAudit } from '../../reactQuery/cacheAudit.js';
import { noteOverlapCancel } from '../../reactQuery/overlapCancel.js';
import { classifyRecords } from '../classify.js';
import { getRecords } from '../store.js';
import type { RequestRecord } from '../types.js';

let id = 0;
const rec = (startedAt: number, extra: Partial<RequestRecord> = {}): RequestRecord => ({
  id: ++id,
  kind: 'fetch',
  method: 'GET',
  url: '/api/x',
  status: 200,
  startedAt,
  durationMs: 10,
  body: undefined,
  ...extra,
});
const ABORTED = 'AbortError: The operation was aborted.';
const classOf = (list: RequestRecord[], r: RequestRecord) => classifyRecords(list, new Set()).get(r.id);

afterEach(() => resetCacheAudit());

describe('이슈 63: 앞 요청의 취소만으로 StrictMode 로 보지 않는다 (기록 단위)', () => {
  it('같은 commit 에서 곧바로 다시 나간 요청(cleanup 이 취소)은 StrictMode 다', () => {
    const a = rec(1_000, { error: ABORTED, commitSeq: 7 });
    const b = rec(1_002, { duplicateOf: a.id, commitSeq: 7 });
    expect(classOf([a, b], b)).toBe('strict-mode');
  });

  it('await 뒤에 보내 commit 이 달라도, 다시 마운트되지 않았고 곧바로 나갔으면 StrictMode 다', () => {
    const a = rec(2_000, { error: ABORTED, commitSeq: 7 });
    const b = rec(2_004, { duplicateOf: a.id, commitSeq: 8 });
    expect(classOf([a, b], b)).toBe('strict-mode');
  });

  it('호출 스택의 재실행 근거는 취소·간격과 상관없이 StrictMode 다', () => {
    const a = rec(3_000, { commitSeq: 7 });
    const b = rec(3_900, { duplicateOf: a.id, commitSeq: 9, strictModeReplay: true });
    expect(classOf([a, b], b)).toBe('strict-mode');
  });

  it('화면을 나갔다 돌아와 다시 마운트된 중복은 StrictMode 가 아니다', () => {
    const a = rec(4_000, { error: ABORTED, commitSeq: 7 });
    const later = rec(4_800, { duplicateOf: a.id, commitSeq: 9 });
    expect(classOf([a, later], later)).toBe('duplicate');
    // 곧바로 돌아왔어도 그 사이 재마운트·의존성 변경이 있었으면 StrictMode 가 아니다
    const quick = rec(4_050, { duplicateOf: a.id, commitSeq: 9, repeatCause: { kind: 'remount', detail: '' } });
    const deps = rec(4_060, { duplicateOf: a.id, commitSeq: 9, repeatCause: { kind: 'deps', detail: '' } });
    expect(classOf([a, quick, deps], quick)).toBe('duplicate');
    expect(classOf([a, quick, deps], deps)).toBe('duplicate');
  });

  it('겹친 무효화가 취소한 요청의 중복은 같은 commit 이라도 StrictMode 가 아니다', () => {
    const a = rec(5_000, { error: ABORTED, commitSeq: 7, durationMs: 5 });
    const b = rec(5_003, { duplicateOf: a.id, commitSeq: 7 });
    noteOverlapCancel(5_003);
    expect(classOf([a, b], b)).toBe('duplicate');
  });
});

// 가짜 fetch 가 signal 을 따르게 한다(취소되면 AbortError 로 끝난다).
const abortableFetch = (ms: number) =>
  mockFetch.mockImplementation(
    (_input, init) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(jsonResponse({ ok: true })), ms);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      }),
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const classesFor = (url: string) => {
  const records = getRecords();
  const classes = classifyRecords(records, new Set());
  return records.filter((r) => r.url === url).map((r) => ({ record: r, cls: classes.get(r.id) }));
};

// effect 에서 보내고 cleanup 에서 취소하는 흔한 모양
const Profile = ({ url }: { url: string }) => {
  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { signal: controller.signal }).catch(() => undefined);
    return () => controller.abort();
  }, [url]);
  return <p>profile</p>;
};

describe('이슈 63: 실제 React·React Query', () => {
  it('StrictMode 재실행(cleanup 이 abort)은 지금처럼 회색이다', async () => {
    abortableFetch(30);
    render(
      <StrictMode>
        <Profile url="/api/i63-strict" />
      </StrictMode>,
    );
    await sleep(50);
    await flush();
    const list = classesFor('/api/i63-strict');
    expect(list).toHaveLength(2);
    expect(list[0].record.error).toMatch(/abort/i);
    expect(list[1].cls).toBe('strict-mode');
  });

  it('화면을 나갔다 2초 안에 돌아와 생긴 재마운트 중복은 회색이 아니다', async () => {
    abortableFetch(100);
    const App = ({ page }: { page: 'profile' | 'home' }) => (page === 'profile' ? <Profile url="/api/i63-remount" /> : <p>home</p>);
    const { rerender } = render(<App page="profile" />);
    await sleep(20);
    rerender(<App page="home" />); // 진행 중인 요청이 cleanup 에서 취소된다
    await sleep(300);
    rerender(<App page="profile" />);
    await sleep(150);
    await flush();
    const list = classesFor('/api/i63-remount');
    expect(list).toHaveLength(2);
    expect(list[0].record.error).toMatch(/abort/i);
    expect(list[1].record.duplicateOf).toBe(list[0].record.id);
    expect(list[1].cls).toBe('duplicate');
  });

  it('겹친 무효화로 생긴 중복은 회색이 아니고, React Query 점검의 double-invalidate 와 같은 요청을 가리킨다', async () => {
    abortableFetch(30);
    const url = '/api/i63-invalidate';
    const client = new QueryClient();
    const Member = () => {
      const { data } = useQuery({
        queryKey: ['i63', 'list', 1],
        queryFn: ({ signal }) => fetch(url, { signal }).then((r) => r.json()),
        staleTime: 60_000,
      });
      return <p>{data ? 'loaded' : ''}</p>;
    };
    render(
      <QueryClientProvider client={client}>
        <Member />
      </QueryClientProvider>,
    );
    findQueryClients();
    await screen.findByText('loaded');
    await Promise.all([
      client.invalidateQueries({ queryKey: ['i63', 'list', 1] }),
      client.invalidateQueries({ queryKey: ['i63', 'list'] }),
    ]);
    await flush();
    const list = classesFor(url);
    const cancelled = list.find((x) => x.record.error);
    const again = list.find((x) => cancelled && x.record.duplicateOf === cancelled.record.id);
    expect(cancelled?.record.error).toMatch(/abort/i);
    expect(again?.cls).not.toBe('strict-mode');
    const finding = auditQueryCache(() => 'ok', getRecords()).find((f) => f.kind === 'double-invalidate');
    expect(finding?.requests).toEqual([`GET ${url} (cancelled by overlapping invalidation)`]);
  });
});
