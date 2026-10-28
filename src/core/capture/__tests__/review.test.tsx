import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { flush, jsonResponse, mockFetch } from '../../../testing/fetchMock.js';
import { getRecords } from '../../requests/store.js';
import { componentOfStack } from '../callerComponent.js';
import { queryContextOf } from '../queryContext.js';

const Profile = ({ wrap = false }: { wrap?: boolean }) => {
  useQuery({
    queryKey: ['user', 1],
    queryFn: () =>
      fetch('/api/user')
        .then((r) => r.json())
        .then((j: { items: unknown[] }) => (wrap ? { copy: j.items } : j)),
  });
  return <p>profile</p>;
};

const userRecords = () => getRecords().filter((r) => r.url === '/api/user');

describe('queryContextOf: 구조적 공유 재조회 (PR2-1)', () => {
  it('useQuery → invalidate → 두 번째 기록도 queryKey 와 observer 를 돌려준다', async () => {
    mockFetch.mockImplementation(async () => jsonResponse({ items: [{ id: 1 }] }));
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <Profile />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(userRecords()).toHaveLength(1));
    await flush();
    await client.invalidateQueries({ queryKey: ['user', 1] });
    await waitFor(() => expect(userRecords()).toHaveLength(2));
    await flush();
    const [first, second] = userRecords();
    expect(second.id).not.toBe(first.id);
    await waitFor(() => expect(queryContextOf(second)).toEqual({ queryKey: '["user",1]', observer: 'Profile' }));
  });

  it('데이터를 가공해 감싸도 출처가 있는 하위 객체로 쿼리를 찾는다', async () => {
    mockFetch.mockImplementation(async () => jsonResponse({ items: [{ id: 1 }] }));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Profile wrap />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(userRecords()).toHaveLength(1));
    await flush();
    await waitFor(() => expect(queryContextOf(userRecords()[0])?.queryKey).toBe('["user",1]'));
  });
});

describe('Request 출처 map 은 모듈이 다시 평가돼도 이어진다 (PR2-10)', () => {
  it('옛 모듈이 설치한 Proxy 가 쓴 스택을 새 모듈이 읽는다', async () => {
    const first = await import('../requestOrigins.js');
    first.interceptRequestOrigins();
    vi.resetModules();
    const second = await import('../requestOrigins.js');
    expect(second).not.toBe(first);
    const request = new Request('http://localhost/api/x');
    expect(second.requestOrigin(request)).toBeInstanceOf(Error);
  });
});

describe('componentOfStack (PR2-9)', () => {
  it('내장 객체 메서드는 컴포넌트가 아니다', () => {
    const at = (name: string) => `at ${name} (http://l/a.ts:1:2)`;
    [
      'IntersectionObserver.callback',
      'Set.forEach',
      'Map.forEach',
      'FileReader.onload',
      'AbortSignal.onabort',
      'AsyncGenerator.next',
    ].forEach((name) => expect(componentOfStack(at(name))).toBeUndefined());
  });

  it('Firefox 의 async*Name@ 프레임을 읽는다', () => {
    expect(componentOfStack('async*Profile@http://l/src/a.ts:1:2')).toBe('Profile');
  });

  it('이름 없는 화살표면 첫 앱 프레임의 대문자 파일 이름을 쓴다', () => {
    const stack = 'at http://l/src/ItemCard.tsx?t=1:12:5\nat commit (http://l/node_modules/react-dom/x.js:1:1)';
    expect(componentOfStack(stack)).toBe('ItemCard');
    expect(componentOfStack('at http://l/src/api.ts:1:2')).toBeUndefined();
  });
});
