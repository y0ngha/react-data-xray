import { QueryClient, QueryClientProvider, QueryObserver, useQuery } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { flush, jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import { buildReactQuerySection } from '../../report/reactQuerySection.js';
import { getRecords } from '../../requests/store.js';
import type { RequestRecord } from '../../requests/types.js';
import { fetchCauseDetail, findQueryClients, overlapCancelOf } from '../cacheAudit.js';
import { describeFetchCause } from '../fetchCause.js';

const fetchCause = (r: RequestRecord) => fetchCauseDetail(r)?.cause;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;

const setup = () => {
  mockFetch.mockImplementation(async () => jsonResponse({ ok: true }));
  const client = new QueryClient();
  const url = `/api/t30-${++n}`;
  const key = ['t30', n];
  const queryFn = () => fetch(url).then((r) => r.json());
  const lastRequest = async (): Promise<RequestRecord> => {
    await flush();
    const list = getRecords().filter((r) => r.url === url);
    const r = list[list.length - 1];
    r.duplicateOf = undefined;
    return r;
  };
  // 감시는 화면의 QueryClientProvider 를 찾을 때 시작한다.
  const watch = () => {
    render(<QueryClientProvider client={client}>{null}</QueryClientProvider>);
    findQueryClients();
  };
  return { client, url, key, queryFn, lastRequest, watch };
};

// 모달: 늘 마운트돼 있고 enabled 만 켜진다.
const Modal = ({ open, queryFn, queryKey }: { open: boolean; queryFn: () => Promise<unknown>; queryKey: unknown[] }) => {
  useQuery({ queryKey, queryFn, enabled: open, staleTime: 0 });
  return <p>modal</p>;
};
const App = (p: { client: QueryClient; open: boolean; queryFn: () => Promise<unknown>; queryKey: unknown[] }) => (
  <QueryClientProvider client={p.client}>
    <Modal open={p.open} queryFn={p.queryFn} queryKey={p.queryKey} />
  </QueryClientProvider>
);

describe('이슈 30: fetch 원인', () => {
  it('enabled_toggle: 늘 마운트된 관찰자의 enabled false→true 는 enabled, 관찰자와 처방이 붙는다', async () => {
    const { client, key, queryFn, lastRequest, watch } = setup();
    watch();
    await client.fetchQuery({ queryKey: key, queryFn });
    const view = render(<App client={client} open={false} queryFn={queryFn} queryKey={key} />);
    findQueryClients();
    view.rerender(<App client={client} open queryFn={queryFn} queryKey={key} />);
    await sleep(20);
    const r = await lastRequest();
    expect(r.sameResponseAs).toBeDefined();
    expect(fetchCause(r)).toBe('enabled');
    const d = describeFetchCause(r, true)!;
    expect(d.observer).toBe('Modal');
    expect(d.queryKey).toBe(JSON.stringify(key));
    expect(d.evidence).toContain('staleTime 0');
    expect(d.fix).toContain('staleTime');
    expect(d.fix).toContain('enabled');
    // 낭비가 아니면(의도된 재조회) 처방은 붙지 않는다
    expect(describeFetchCause(r, false)!.fix).toBeUndefined();
  });

  it('initial: 캐시 없이 처음 받은 조회', async () => {
    const { client, key, queryFn, lastRequest, watch } = setup();
    watch();
    await client.fetchQuery({ queryKey: key, queryFn });
    expect(fetchCause(await lastRequest())).toBe('initial');
  });

  it('mount: 데이터가 있는 쿼리에 관찰자가 새로 붙으면 mount', async () => {
    const { client, key, queryFn, lastRequest, watch } = setup();
    watch();
    await client.fetchQuery({ queryKey: key, queryFn });
    new QueryObserver(client, { queryKey: key, queryFn }).subscribe(() => {});
    await sleep(20);
    expect(fetchCause(await lastRequest())).toBe('mount');
  });

  it('key-change: 이미 붙은 관찰자의 queryKey 가 바뀌면 mount 가 아니라 key-change', async () => {
    const { client, key, queryFn, lastRequest, watch } = setup();
    watch();
    const a = [...key, 'a'];
    const b = [...key, 'b'];
    await client.fetchQuery({ queryKey: b, queryFn });
    const o = new QueryObserver(client, {
      queryKey: a,
      queryFn,
      staleTime: 60_000,
    });
    o.subscribe(() => {});
    await sleep(20);
    o.setOptions({ queryKey: b, queryFn, staleTime: 0 });
    await sleep(20);
    expect(fetchCause(await lastRequest())).toBe('key-change');
  });

  it('invalidate: 무효화로 다시 받으면 invalidate', async () => {
    const { client, key, queryFn, lastRequest, watch } = setup();
    watch();
    new QueryObserver(client, {
      queryKey: key,
      queryFn,
      staleTime: 60_000,
    }).subscribe(() => {});
    await sleep(20);
    await client.invalidateQueries({ queryKey: key });
    expect(fetchCause(await lastRequest())).toBe('invalidate');
  });

  it('interval: refetchInterval 로 다시 받으면 interval', async () => {
    const { client, key, queryFn, lastRequest, watch } = setup();
    watch();
    const o = new QueryObserver(client, {
      queryKey: key,
      queryFn,
      staleTime: 60_000,
      refetchInterval: 30,
    });
    const off = o.subscribe(() => {});
    await sleep(90);
    off();
    expect(fetchCause(await lastRequest())).toBe('interval');
  });

  it('원인을 맞추지 못한 요청(수동 refetch)은 manual 로 단정하지 않고 undefined', async () => {
    const { client, key, queryFn, lastRequest, watch } = setup();
    watch();
    const o = new QueryObserver(client, {
      queryKey: key,
      queryFn,
      staleTime: 60_000,
    });
    o.subscribe(() => {});
    await sleep(20);
    await o.refetch();
    expect(fetchCause(await lastRequest())).toBeUndefined();
  });

  it('React Query 를 거치지 않은 요청은 원인이 없다', async () => {
    const { url } = setup();
    await fetch(url);
    await flush();
    expect(fetchCause(getRecords().find((r) => r.url === url)!)).toBeUndefined();
  });
});

describe('이슈 30: 겹친 무효화로 취소된 요청', () => {
  it('overlapCancelOf: 취소된 요청에 두 무효화의 호출 위치가 나온다', async () => {
    const { client, key, queryFn, watch } = setup();
    watch();
    new QueryObserver(client, {
      queryKey: [...key, 1],
      queryFn,
      staleTime: 60_000,
    }).subscribe(() => {});
    await sleep(20);
    await Promise.all([client.invalidateQueries({ queryKey: [...key, 1] }), client.invalidateQueries({ queryKey: key })]);
    // 두 번째 무효화 시각에 진행 중이다가 abort 로 끝난 요청
    const cancelled = {
      id: 99999,
      error: 'The operation was aborted',
      startedAt: Date.now() - 20,
      durationMs: 40,
    } as RequestRecord;
    expect(overlapCancelOf(cancelled)).toHaveLength(2);
    expect(overlapCancelOf({ ...cancelled, error: undefined })).toBeUndefined();
    // abort 가 아닌 오류, 무효화 전에 이미 끝난 요청은 취소가 아니다
    expect(overlapCancelOf({ ...cancelled, error: 'Failed to fetch' })).toBeUndefined();
    expect(overlapCancelOf({ ...cancelled, durationMs: 5 })).toBeUndefined();
  });
});

describe('이슈 30: 보고서 fetchCauses', () => {
  it('cause 별로 묶고 처방은 낭비 분류에만 붙는다', async () => {
    const { client, key, queryFn, lastRequest, watch } = setup();
    watch();
    await client.fetchQuery({ queryKey: key, queryFn });
    const r = await lastRequest();
    const section = buildReactQuerySection([r], new Map([[r.id, 'ok' as const]]));
    expect(section.fetchCauses).toHaveLength(1);
    expect(section.fetchCauses?.[0]).toMatchObject({
      cause: 'initial',
      count: 1,
      queryKey: JSON.stringify(key),
    });
    expect(section.fetchCauses?.[0].fix).toBeUndefined();
  });
});

describe('describeFetchCause 언어', () => {
  it('기본값(en)은 영어 라벨·근거를 돌려준다', async () => {
    const { client, key, queryFn, lastRequest, watch } = setup();
    watch();
    await client.fetchQuery({ queryKey: key, queryFn });
    const r = await lastRequest();
    const info = describeFetchCause(r, false);
    expect(info?.label).toBe('no cache (initial fetch)');
    expect(info).toBeDefined();
  });

  it('ko 는 한국어 라벨을 돌려준다', async () => {
    const { client, key, queryFn, lastRequest, watch } = setup();
    watch();
    await client.fetchQuery({ queryKey: key, queryFn });
    const r = await lastRequest();
    const info = describeFetchCause(r, false, 'ko');
    expect(info?.label).toBe('캐시 없음(첫 조회)');
  });
});
