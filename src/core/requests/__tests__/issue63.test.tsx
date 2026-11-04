import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { flush, jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import { auditQueryCache, findQueryClients, resetCacheAudit } from '../../reactQuery/cacheAudit.js';
import { noteOverlap } from '../../reactQuery/overlapCancel.js';
import { resetRenderStats, setRenderMonitoring } from '../../render/monitor.js';
import { classifyRecords } from '../classify.js';
import { repeatCauseStep } from '../repeatCause.js';
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
  // 마운트한 commit 의 effect 가 보냈고 곧바로 다시 나간 요청(StrictMode 재실행의 모양)
  const onMount = { commitSeq: 7, component: 'Profile', sentOnMount: true };

  it('마운트한 commit 에서 곧바로 다시 나간 요청(cleanup 이 취소)은 StrictMode 다', () => {
    const a = rec(1_000, { error: ABORTED, commitSeq: 7 });
    const b = rec(1_002, { duplicateOf: a.id, ...onMount });
    expect(classOf([a, b], b)).toBe('strict-mode');
  });

  it('이벤트 핸들러가 연달아 보낸 요청(다시 받기를 두 번 누름)은 같은 commit 순번이어도 StrictMode 가 아니다', () => {
    const a = rec(2_000, { error: ABORTED, commitSeq: 7 });
    const b = rec(2_090, { duplicateOf: a.id, commitSeq: 7, component: 'Profile' });
    expect(classOf([a, b], b)).toBe('duplicate');
  });

  it('보낸 컴포넌트·commit 순번·마운트 기록을 모르면 StrictMode 가 아니다', () => {
    const a = rec(2_500, { error: ABORTED, commitSeq: 7 });
    const unknownComponent = rec(2_502, { duplicateOf: a.id, commitSeq: 7, sentOnMount: true });
    const unknownSeq = rec(2_503, { duplicateOf: a.id, component: 'Profile', sentOnMount: true });
    const otherCommit = rec(2_504, { duplicateOf: a.id, ...onMount, commitSeq: 8 });
    const list = [a, unknownComponent, unknownSeq, otherCommit];
    expect([unknownComponent, unknownSeq, otherCommit].map((r) => classOf(list, r))).toEqual(['duplicate', 'duplicate', 'duplicate']);
  });

  it('호출 스택의 재실행 근거는 취소·간격과 상관없이 StrictMode 다', () => {
    const a = rec(3_000, { commitSeq: 7 });
    const b = rec(3_900, { duplicateOf: a.id, commitSeq: 9, strictModeReplay: true });
    expect(classOf([a, b], b)).toBe('strict-mode');
  });

  it('화면을 나갔다 돌아와 다시 마운트된 중복은 StrictMode 가 아니다', () => {
    const a = rec(4_000, { error: ABORTED, commitSeq: 7 });
    const later = rec(4_800, { duplicateOf: a.id, ...onMount, commitSeq: 9 });
    expect(classOf([a, later], later)).toBe('duplicate');
  });

  it('간격이 벌어지면 마운트한 commit 이어도 StrictMode 가 아니다', () => {
    const a = rec(4_500, { error: ABORTED, commitSeq: 7 });
    const b = rec(4_750, { duplicateOf: a.id, ...onMount });
    expect(classOf([a, b], b)).toBe('duplicate');
  });

  it('겹친 무효화가 취소한 요청의 중복은 마운트한 commit 이라도 StrictMode 가 아니다', () => {
    const a = rec(5_000, { error: ABORTED, commitSeq: 7, durationMs: 5 });
    const b = rec(5_003, { duplicateOf: a.id, ...onMount });
    noteOverlap({ at: 5_003, fetchStarts: [4_999] });
    expect(classOf([a, b], b)).toBe('duplicate');
  });

  it('다른 쿼리의 겹친 무효화는 StrictMode 취소를 막지 않는다', () => {
    const a = rec(6_000, { error: ABORTED, commitSeq: 7, durationMs: 5 });
    const b = rec(6_003, { duplicateOf: a.id, ...onMount });
    // 같은 시각에 진행 중이었지만 그 겹침이 덮은 쿼리의 fetch 는 이 요청보다 한참 앞에 시작했다
    noteOverlap({ at: 6_003, fetchStarts: [3_000] });
    expect(classOf([a, b], b)).toBe('strict-mode');
  });
});

// 가짜 fetch 가 signal 을 따르게 한다(취소되면 AbortError 로 끝난다).
const abortableFetch = (ms: number) =>
  mockFetch.mockImplementation(
    (_input, init) =>
      new Promise<Response>((resolve, reject) => {
        const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
        // 실제 fetch 처럼 이미 취소된 signal 이면 곧바로 실패한다
        if (init?.signal?.aborted) return abort();
        const timer = setTimeout(() => resolve(jsonResponse({ ok: true })), ms);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          abort();
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
  // 마운트 기록(commit 원인)은 렌더 감시가 켜져 있을 때 남는다(RDX 버튼이 붙어 있는 동안)
  beforeEach(() => {
    setRenderMonitoring(true);
    resetRenderStats();
  });
  afterEach(() => setRenderMonitoring(false));

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

  it('await 뒤에 보낸 StrictMode 재실행(스택으로 못 잡음)은 보낸 컴포넌트를 알면 cleanup 취소로 회색이다', async () => {
    abortableFetch(30);
    const url = '/api/i63-await';
    const Later = () => {
      useEffect(() => {
        const controller = new AbortController();
        void (async () => {
          await Promise.resolve();
          await fetch(url, { signal: controller.signal }).catch(() => undefined);
        })();
        return () => controller.abort();
      }, []);
      return <p>later</p>;
    };
    render(
      <StrictMode>
        <Later />
      </StrictMode>,
    );
    await sleep(50);
    await flush();
    const list = classesFor(url);
    expect(list).toHaveLength(2);
    expect(list[0].record.error).toMatch(/abort/i);
    expect(list[1].record.strictModeReplay).toBeFalsy();
    // 재실행은 같은 passive effect 비우기 안이라 await 뒤에 보내도 두 요청이 마운트한 commit 의 순번에 남는다
    expect(list[1].record.commitSeq).toBe(list[0].record.commitSeq);
    // 이 테스트 파일은 소문자 이름이라 스택으로 보낸 컴포넌트를 못 정한다. 모르면 근거가 아니다(빨강).
    expect(list[1].record.component).toBeUndefined();
    expect(list[1].cls).toBe('duplicate');
    // 컴포넌트 파일(Later.tsx)이면 첫 앱 프레임의 파일 이름으로 정해진다. 그러면 마운트 기록으로 회색이 된다.
    list[1].record.component = 'Later';
    repeatCauseStep(list[1].record)();
    expect(list[1].record.sentOnMount).toBe(true);
    expect(classesFor(url)[1].cls).toBe('strict-mode');
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

  it('다시 받기 버튼을 두 번 눌러 앞 요청을 취소한 중복은 회색이 아니다', async () => {
    abortableFetch(100);
    const url = '/api/i63-reload';
    let controller: AbortController | undefined;
    const reload = () => {
      controller?.abort();
      controller = new AbortController();
      fetch(url, { signal: controller.signal }).catch(() => undefined);
    };
    const Toolbar = () => (
      <button type="button" onClick={reload}>
        reload
      </button>
    );
    render(<Toolbar />);
    await sleep(20);
    fireEvent.click(screen.getByText('reload'));
    fireEvent.click(screen.getByText('reload'));
    await sleep(150);
    await flush();
    const list = classesFor(url);
    expect(list).toHaveLength(2);
    expect(list[0].record.error).toMatch(/abort/i);
    expect(list[1].record.commitSeq).toBe(list[0].record.commitSeq);
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
